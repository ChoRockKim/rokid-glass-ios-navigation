package com.chorock.rokidroute

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * 서버 연결.
 * - 토큰이 없으면 페어링: POST /pair/request → 화면에 코드 → GET /pair/status 를 2초마다 → 토큰 저장
 * - 토큰이 있으면 wss://…/glass?map=1&token=… 로 연결, 끊기면 2~30초 백오프 재연결
 * 콜백은 모두 메인 스레드에서 부른다.
 */
class ServerClient(
    private val base: String,
    private val tokenStore: TokenStore,
    private val onMessage: (JSONObject) -> Unit,
    private val onStatus: (String) -> Unit,
    private val onPairCode: (String?) -> Unit,
) {
    interface TokenStore {
        fun get(): String?
        fun set(token: String?)
    }

    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS) // 핫스팟·프록시에서 유휴 연결 유지
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var running = false
    private var waitMs = 2000L
    private var pairId: String? = null

    fun start() {
        running = true
        if (tokenStore.get().isNullOrEmpty()) requestPair() else connect()
    }

    fun stop() {
        running = false
        main.removeCallbacksAndMessages(null)
        ws?.close(1000, "stop")
        ws = null
    }

    fun send(obj: JSONObject) {
        ws?.send(obj.toString())
    }

    // ── 페어링 ──
    private fun requestPair() {
        if (!running) return
        onStatus("연결 코드 요청 중…")
        val req = Request.Builder().url("$base/pair/request").post(ByteArray(0).toRequestBody()).build()
        http.newCall(req).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) = main.post { retry { requestPair() } }.let {}
            override fun onResponse(call: okhttp3.Call, response: Response) {
                val body = response.body?.string().orEmpty()
                main.post {
                    if (!response.isSuccessful) return@post retry { requestPair() }
                    val j = JSONObject(body)
                    pairId = j.getString("id")
                    onPairCode(j.getString("code"))
                    onStatus("")
                    pollPair(System.currentTimeMillis() + j.optLong("expiresInSec", 300) * 1000)
                }
            }
        })
    }

    private fun pollPair(deadline: Long) {
        if (!running) return
        if (System.currentTimeMillis() > deadline) return requestPair() // 만료되면 새 코드
        val id = pairId ?: return requestPair()
        val req = Request.Builder().url("$base/pair/status?id=$id").get().build()
        http.newCall(req).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) {
                main.postDelayed({ pollPair(deadline) }, 2000)
            }
            override fun onResponse(call: okhttp3.Call, response: Response) {
                val body = response.body?.string().orEmpty()
                main.post {
                    val j = runCatching { JSONObject(body) }.getOrNull()
                    when (j?.optString("status")) {
                        "approved" -> {
                            tokenStore.set(j.getString("token"))
                            onPairCode(null)
                            connect()
                        }
                        "expired" -> requestPair()
                        else -> main.postDelayed({ pollPair(deadline) }, 2000)
                    }
                }
            }
        })
    }

    // ── WebSocket ──
    private fun connect() {
        if (!running) return
        val token = tokenStore.get() ?: return requestPair()
        val wsBase = base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        val req = Request.Builder().url("$wsBase/glass?map=1").header("Authorization", "Bearer $token").build()
        onStatus("연결 중…")
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = main.post {
                waitMs = 2000
                onStatus("")
                send(JSONObject().put("type", "sync"))
            }.let {}

            override fun onMessage(webSocket: WebSocket, text: String) = main.post {
                runCatching { JSONObject(text) }.getOrNull()?.let(onMessage)
            }.let {}

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = main.post {
                if (webSocket !== ws) return@post
                ws = null
                if (response?.code == 401) {
                    // 토큰이 바뀌었으면 다시 페어링
                    tokenStore.set(null)
                    requestPair()
                } else retry { connect() }
            }.let {}

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = main.post {
                if (webSocket !== ws) return@post
                ws = null
                retry { connect() }
            }.let {}
        })
    }

    private fun retry(action: () -> Unit) {
        if (!running) return
        val w = waitMs
        waitMs = (waitMs * 2).coerceAtMost(30_000)
        onStatus("끊김 · ${w / 1000}초 뒤 재연결")
        main.postDelayed(action, w)
    }

    companion object {
        /** JSON 배열 [lon, lat] 들 → List<DoubleArray> */
        fun points(a: JSONArray): List<DoubleArray> =
            List(a.length()) { i -> a.getJSONArray(i).let { doubleArrayOf(it.getDouble(0), it.getDouble(1)) } }
    }
}
