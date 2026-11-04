package com.chorock.rokidroute

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import org.json.JSONObject

/**
 * 안경 길안내 화면.
 * 서버(route-server)의 WebSocket /glass?map=1 에 붙어 안내 문구와 미니맵을 그린다.
 * 입력: 탭(ENTER/DPAD_CENTER)·앞으로(DPAD_RIGHT/DOWN) = 다음, 뒤로(DPAD_LEFT/UP) = 이전. BACK 은 기본 동작.
 *       (Rokid_Claude 주석: 탭=ENTER, 쓸기=DPAD_LEFT/RIGHT, 더블탭=BACK. 쓸기 방향과 다음/이전 대응은 실기 확인 필요)
 */
class MainActivity : Activity() {
    private lateinit var hud: HudView
    private lateinit var client: ServerClient
    private lateinit var heading: HeadingProvider

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE

        heading = HeadingProvider(this)
        hud = HudView(this) { heading.heading() }
        // 화면 전체는 검정(= 안경에서 투명), 안내는 480x282 dp 를 아래 가운데에
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(hud, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
        setContentView(root)

        val prefs = getSharedPreferences("route", Context.MODE_PRIVATE)
        client = ServerClient(
            base = BuildConfig.SERVER_BASE,
            tokenStore = object : ServerClient.TokenStore {
                override fun get() = prefs.getString("glassToken", null)
                override fun set(token: String?) { prefs.edit().putString("glassToken", token).apply() }
            },
            onMessage = ::onServerMessage,
            onStatus = { hud.state = hud.state.copy(status = it) },
            onPairCode = { hud.pairCode = it },
        )
        Log.i("Route", "server=${BuildConfig.SERVER_BASE} heading=${heading.mode}")
    }

    override fun onResume() {
        super.onResume()
        heading.start()
        client.start()
    }

    override fun onPause() {
        client.stop()
        heading.stop()
        super.onPause()
    }

    private fun onServerMessage(m: JSONObject) {
        val s = hud.state
        val next = s.apply(m)
        // 경로 위를 걷는 중이면 상대 방향 센서의 0°를 경로 방향에 맞춘다
        val p = next.pos
        if (m.optString("type") == "map-pos" && p != null && p.snapped && !next.idle) heading.calibrate(p.heading)
        hud.state = next
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val action = when (keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_DOWN -> "next"
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_UP -> "prev"
            else -> null
        } ?: return super.onKeyDown(keyCode, event)
        client.send(JSONObject().put("type", action))
        return true
    }
}
