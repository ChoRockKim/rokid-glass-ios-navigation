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
    private lateinit var updater: Updater
    private var lastCalib: MapPos? = null

    private fun distM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val dy = (lat2 - lat1) * 110_540
        val dx = (lon2 - lon1) * 111_320 * Math.cos(Math.toRadians(lat1))
        return Math.hypot(dx, dy)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE

        heading = HeadingProvider(this)
        hud = HudView(this) { heading.heading() }
        hud.onInput = ::handle
        // 화면 전체는 검정(= 안경에서 투명), 안내는 480x282 dp 를 아래 가운데에
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(hud, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
        setContentView(root)

        val prefs = getSharedPreferences("route", Context.MODE_PRIVATE)
        client = ServerClient(
            base = BuildConfig.SERVER_BASE,
            tokenStore = object : ServerClient.TokenStore {
                // 페어링으로 받은 토큰이 있으면 그것, 없으면 APK 에 넣은 안경 전용 토큰 (서버가 거절하면 페어링으로)
                override fun get() = prefs.getString("glassToken", null)
                    ?: BuildConfig.DEVICE_TOKEN.takeIf { it.isNotEmpty() && !prefs.getBoolean("deviceTokenRejected", false) }
                override fun set(token: String?) {
                    val e = prefs.edit().putString("glassToken", token)
                    // 저장된 토큰 없이 null 로 지우는 건 APK 토큰이 거절됐다는 뜻 → 페어링으로 넘어간다
                    if (token == null && prefs.getString("glassToken", null) == null) e.putBoolean("deviceTokenRejected", true)
                    if (token != null) e.putBoolean("deviceTokenRejected", false)
                    e.apply()
                }
            },
            onMessage = ::onServerMessage,
            onStatus = {
                hud.state = hud.state.copy(status = it)
                // 상태 문구가 비면 서버와 연결된 것 (ServerClient.onOpen 에서 "" 를 보낸다)
                hud.device = hud.device.copy(server = it.isEmpty() && hud.pairCode == null)
            },
            onPairCode = { hud.pairCode = it },
        )
        updater = Updater(this, BuildConfig.SERVER_BASE, token = { prefs.getString("glassToken", null) ?: BuildConfig.DEVICE_TOKEN.takeIf { it.isNotEmpty() } }) { note ->
            hud.menu = hud.menu?.copy(note = note)
        }
        val dm = resources.displayMetrics
        val screen = "${dm.widthPixels}x${dm.heightPixels} d${dm.density}"
        Log.i("Route", "server=${BuildConfig.SERVER_BASE} heading=${heading.mode} screen=$screen")
        // 화면 크기·센서 모드를 처음 10초 왼쪽 아래에 보여 준다 (실기 확인용)
        hud.debug = "화면 $screen · 방향 ${heading.describe}"
        hud.postDelayed({ hud.debug = null }, 10_000)
    }

    // ── 배터리 · 네트워크 (오른쪽 아래 표시) ──
    private val batteryReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: Context, i: android.content.Intent) {
            val level = i.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1)
            val scale = i.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100)
            val st = i.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1)
            val charging = st == android.os.BatteryManager.BATTERY_STATUS_CHARGING || st == android.os.BatteryManager.BATTERY_STATUS_FULL
            if (level >= 0) hud.device = hud.device.copy(battery = level * 100 / scale.coerceAtLeast(1), charging = charging)
        }
    }
    private val connectivity by lazy { getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager }
    private val netCallback = object : android.net.ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(n: android.net.Network, caps: android.net.NetworkCapabilities) = updateNetwork()
        override fun onLost(n: android.net.Network) = updateNetwork()
    }

    private fun updateNetwork() {
        val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        val name = when {
            caps == null -> "연결 없음"
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "블루투스"
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "셀룰러"
            else -> "네트워크"
        }
        hud.post { hud.device = hud.device.copy(network = name) }
    }

    override fun onResume() {
        super.onResume()
        registerReceiver(batteryReceiver, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
        runCatching { connectivity.registerDefaultNetworkCallback(netCallback) }
        updateNetwork()
        heading.start()
        client.start()
        // R08 브리지가 처음 링 조작부터 이 화면을 "현재 포커스"로 보도록 미리 포커스를 잡는다
        hud.requestFocus()
    }

    override fun onPause() {
        runCatching { unregisterReceiver(batteryReceiver) }
        runCatching { connectivity.unregisterNetworkCallback(netCallback) }
        client.stop()
        heading.stop()
        super.onPause()
    }

    private fun onServerMessage(m: JSONObject) {
        val s = hud.state
        val next = s.apply(m)
        // 경로 위를 실제로 걷는 중(직전 보정 위치에서 3m+)일 때만 상대 방향 센서의 0°를 경로 방향에 맞춘다.
        // 서서 두리번거릴 때 맞추면 보는 방향이 경로 방향으로 끌려간다
        val p = next.pos
        if (m.optString("type") == "map-pos" && p != null && p.snapped && !next.idle) {
            val last = lastCalib
            val moved = last == null || distM(last.lat, last.lon, p.lat, p.lon) >= 3.0
            if (moved) {
                heading.calibrateFromRoute(p.heading)
                lastCalib = p
            }
        }
        hud.state = next
    }

    /** 안경 터치·R08 링 등 모든 입력을 이 네 동작으로 바꿔서 처리한다 */
    enum class Input { NEXT, PREV, SELECT, BACK }

    private val menuItems = listOf("길안내 화면으로", "업데이트 확인", "앱 종료")

    fun handle(input: Input) {
        val m = hud.menu
        if (m == null) {
            // 길안내 화면: 탭·앞으로 = 다음 단계, 뒤로 쓸기 = 이전, 뒤로가기 = 메인 화면
            when (input) {
                Input.SELECT, Input.NEXT -> client.send(JSONObject().put("type", "next"))
                Input.PREV -> client.send(JSONObject().put("type", "prev"))
                Input.BACK -> hud.menu = HudView.Menu(menuItems)
            }
            return
        }
        when (input) {
            Input.NEXT -> hud.menu = m.copy(selected = (m.selected + 1) % m.items.size)
            Input.PREV -> hud.menu = m.copy(selected = (m.selected - 1 + m.items.size) % m.items.size)
            Input.BACK -> hud.menu = null
            Input.SELECT -> when (m.selected) {
                0 -> hud.menu = null
                1 -> if (updater.available != null) updater.install() else updater.check()
                2 -> finishAndRemoveTask()
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val input = when (keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER -> Input.SELECT
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_DOWN -> Input.NEXT
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_UP -> Input.PREV
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> Input.BACK
            // R08 링이 미디어 키 모드(Stable, appType 1)로 브리지 없이 바로 들어올 때
            KeyEvent.KEYCODE_MEDIA_NEXT -> Input.NEXT
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> Input.PREV
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> Input.SELECT
            else -> null
        } ?: return super.onKeyDown(keyCode, event)
        handle(input)
        return true
    }
}
