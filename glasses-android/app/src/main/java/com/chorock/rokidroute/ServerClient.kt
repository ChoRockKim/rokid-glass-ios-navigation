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
 * - 토큰이 있으면 wss://…/glass?map=1&choose=1 로 연결 (choose=1: 목적지 후보 선택지를 받는다), 끊기면 2~30초 백오프 재연결 (±20% 흔들기)
 * - 네트워크가 다시 잡히면 [kick] 으로 기다리지 않고 바로 재연결
 * - 끊긴 동안 보낸 요청(즐겨찾기 안내·경로 다시 찾기 등)은 [sendWhenConnected] 로 모아 두었다가 연결되면 보낸다 (30초 지난 것은 버리고 알림)
 * 콜백은 모두 메인 스레드에서 부른다.
 */
class ServerClient(
    private val base: String,
    private val tokenStore: TokenStore,
    private val onMessage: (JSONObject) -> Unit,
    private val onStatus: (String) -> Unit,
    private val onPairCode: (String?) -> Unit,
    /** 끊긴 동안 모아 둔 요청을 버렸을 때 등 짧은 알림 */
    private val onNotice: (String) -> Unit = {},
    /** 연결됨/끊김이 바뀔 때 (끊긴 시각, 연결되면 null) */
    private val onConnection: (Long?) -> Unit = {},
) {
    interface TokenStore {
        fun get(): String?
        fun set(token: String?)
    }

    private val http = OkHttpClient.Builder()
        // 핫스팟·프록시에서 유휴 연결 유지 + 죽은 연결 알아채기. 10초 → 25초 (배터리: Wi-Fi 를 덜 깨움, 서버 ping 은 30초)
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var running = false
    private var waitMs = 2000L
    private var pairId: String? = null
    /** 서버와 열려 있는가 (onOpen ~ onFailure/onClosed) */
    var connected = false
        private set
    /** 대기 중인 재시도 (kick 으로 앞당긴다) */
    private var pendingRetry: Runnable? = null

    private data class Queued(val json: JSONObject, val label: String, val at: Long)
    private val queue = mutableListOf<Queued>()

    fun start() {
        running = true
        if (tokenStore.get().isNullOrEmpty()) requestPair() else connect()
    }

    fun stop() {
        running = false
        connected = false
        pendingRetry = null
        main.removeCallbacksAndMessages(null)
        ws?.close(1000, "stop")
        ws = null
    }

    /** 열려 있으면 보내고 true. 끊겨 있으면 버리고 false */
    fun send(obj: JSONObject): Boolean = connected && ws?.send(obj.toString()) == true

    /** 끊겨 있으면 모아 두었다가 연결되면 보낸다. 바로 보냈으면 true */
    fun sendWhenConnected(obj: JSONObject, label: String): Boolean {
        if (send(obj)) return true
        queue.removeAll { it.label == label } // 같은 요청은 마지막 것만
        queue += Queued(obj, label, System.currentTimeMillis())
        return false
    }

    /** 네트워크가 다시 잡혔을 때: 기다리던 재시도를 지금 바로 */
    fun kick() {
        if (!running || connected) return
        val r = pendingRetry ?: return
        main.removeCallbacks(r)
        pendingRetry = null
        waitMs = 2000
        onStatus("네트워크 다시 잡힘 · 연결 중…")
        r.run()
    }

    private fun flushQueue() {
        val now = System.currentTimeMillis()
        val items = queue.toList()
        queue.clear()
        for (q in items) {
            if (now - q.at > QUEUE_MAX_AGE_MS) onNotice("연결이 늦어 취소: ${q.label}")
            else if (send(q.json)) onNotice("연결됨 · 보냄: ${q.label}")
        }
    }

    // ── 페어링 ──
    private fun requestPair() {
        if (!running) return
        onStatus("연결 코드 요청 중…")
        val req = Request.Builder().url("$base/pair/request").post(ByteArray(0).toRequestBody()).build()
        http.newCall(req).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) = main.post { lastError = reason(e); retry { requestPair() } }.let {}
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
        val req = Request.Builder().url("$wsBase/glass?map=1&choose=1").header("Authorization", "Bearer $token").build()
        onStatus("연결 중…")
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = main.post {
                waitMs = 2000
                lastError = ""
                connected = true
                onConnection(null)
                onStatus("")
                send(JSONObject().put("type", "sync"))
                flushQueue()
            }.let {}

            override fun onMessage(webSocket: WebSocket, text: String) = main.post {
                runCatching { JSONObject(text) }.getOrNull()?.let(onMessage)
            }.let {}

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = main.post {
                if (webSocket !== ws) return@post
                ws = null
                if (connected) onConnection(System.currentTimeMillis())
                connected = false
                lastError = if (response != null) "서버 거절 ${response.code}" else reason(t)
                android.util.Log.w("Route", "ws failure: $lastError", t)
                if (response?.code == 401) {
                    // 토큰이 바뀌었으면 다시 페어링
                    tokenStore.set(null)
                    requestPair()
                } else retry { connect() }
            }.let {}

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = main.post {
                if (webSocket !== ws) return@post
                ws = null
                if (connected) onConnection(System.currentTimeMillis())
                connected = false
                retry { connect() }
            }.let {}
        })
    }

    private var lastError: String = ""

    /** 실패 원인을 사람이 읽을 말로 (안경 화면에 보여 준다) */
    private fun reason(t: Throwable?): String = when (t) {
        null -> ""
        is java.net.UnknownHostException -> "인터넷 없음(주소 못 찾음)"
        is java.net.SocketTimeoutException -> "서버 응답 없음"
        is java.net.ConnectException -> "연결 거부"
        is javax.net.ssl.SSLException -> "보안 연결 실패(시계?)"
        else -> t.javaClass.simpleName
    }

    private fun retry(action: () -> Unit) {
        if (!running) return
        // 여러 기기가 같은 순간에 몰리지 않게 ±20% 흔든다 (흔한 재연결 방식)
        val w = (waitMs * (0.8 + Math.random() * 0.4)).toLong()
        waitMs = (waitMs * 2).coerceAtMost(30_000)
        onStatus("${lastError.ifEmpty { "끊김" }} · ${(w + 999) / 1000}초 뒤 재연결")
        val r = Runnable { pendingRetry = null; action() }
        pendingRetry?.let { main.removeCallbacks(it) }
        pendingRetry = r
        main.postDelayed(r, w)
    }

    companion object {
        /** 끊긴 동안 모아 둔 요청을 이보다 오래되면 버린다 */
        const val QUEUE_MAX_AGE_MS = 30_000L

        /** JSON 배열 [lon, lat] 들 → List<DoubleArray> */
        fun points(a: JSONArray): List<DoubleArray> =
            List(a.length()) { i -> a.getJSONArray(i).let { doubleArrayOf(it.getDouble(0), it.getDouble(1)) } }
    }
}
