package com.chorock.rokidroute

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.util.Base64
import android.graphics.Color
import android.os.Build
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
 * 입력: 탭(ENTER/DPAD_CENTER)·앞으로(DPAD_RIGHT/DOWN) = 다음, 뒤로(DPAD_LEFT/UP) = 이전, BACK = 메뉴.
 *       (Rokid_Claude 주석: 탭=ENTER, 쓸기=DPAD_LEFT/RIGHT, 더블탭=BACK. 쓸기 방향과 다음/이전 대응은 실기 확인 필요)
 */
class MainActivity : Activity() {
    private lateinit var hud: HudView
    private lateinit var client: ServerClient
    private lateinit var heading: HeadingProvider
    private lateinit var updater: Updater
    private var lastCalib: MapPos? = null
    private lateinit var prefs: android.content.SharedPreferences
    private lateinit var cache: GlassCache
    private lateinit var wifi: WifiEnabler
    private var wifiStatus: WifiEnabler.Status? = null
    /** 자동 설치를 이미 시도한 버전 (실패해도 같은 버전을 계속 시도하지 않게) */
    private var autoInstallTried: Int? = null
    private var checkedUpdate = false

    private fun distM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val dy = (lat2 - lat1) * 110_540
        val dx = (lon2 - lon1) * 111_320 * Math.cos(Math.toRadians(lat1))
        return Math.hypot(dx, dy)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashLog.install(filesDir)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE

        heading = HeadingProvider(this)
        hud = HudView(this) { heading.heading() }
        hud.onInput = ::handle
        // 방향이 바뀌면 다시 그리기: 초당 20번까지로 묶고, 1° 넘게 바뀐 경우만 (예전엔 센서가 있으면 초당 60번 계속 그림)
        var redrawQueued = false
        heading.onChange = {
            if (!redrawQueued) {
                redrawQueued = true
                hud.postDelayed({ redrawQueued = false; hud.headingMoved() }, 50)
            }
        }
        // 화면 전체는 검정(= 안경에서 투명), 안내는 480x282 dp 를 아래 가운데에
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(hud, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
        setContentView(root)

        prefs = getSharedPreferences("route", Context.MODE_PRIVATE)
        // 캐시: 진행 중이던 경로가 있으면 연결 전이라도 마지막 화면을 바로 (서버에서 새로 받으면 덮는다)
        cache = GlassCache(java.io.File(filesDir, "glass-cache"))
        cache.routeMessages().takeIf { it.isNotEmpty() }?.let { saved ->
            var st = HudState()
            for (m in saved) st = st.apply(m.json, m.at)
            hud.state = st.copy(cachedAt = saved.last().at, status = "연결 중…")
        }
        hud.viewStyle = runCatching { HudView.ViewStyle.valueOf(prefs.getString("viewStyle", "FULL")!!) }.getOrDefault(HudView.ViewStyle.FULL)
        hud.mapMode = runCatching { HudView.MapMode.valueOf(prefs.getString("mapMode", "AUTO")!!) }.getOrDefault(HudView.MapMode.AUTO)
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
                // 앱을 켜고 처음 연결되면 새 버전을 한 번 확인하고, 있으면 바로 자동 설치 (안내 중이어도: 경로는 서버에 저장돼 재시작 후 이어짐)
                if (it.isEmpty() && hud.pairCode == null && !checkedUpdate) {
                    checkedUpdate = true
                    hud.postDelayed({ updater.check { maybeAutoInstall(atLaunch = true) } }, 1_000)
                }
            },
            onPairCode = { hud.pairCode = it },
            onNotice = { showNotice(it) },
            onConnection = {
                hud.offlineSince = it
                // 연결되면 지난번에 남은 오류 기록을 서버로 (서버 로그에서 원인 확인)
                if (it == null) CrashLog.take()?.let { text ->
                    if (!client.send(JSONObject().put("type", "crash").put("version", BuildConfig.VERSION_NAME).put("text", text))) CrashLog.record(text)
                }
            },
        )
        updater = Updater(this, BuildConfig.SERVER_BASE, token = { prefs.getString("glassToken", null) ?: BuildConfig.DEVICE_TOKEN.takeIf { it.isNotEmpty() } }) { note ->
            hud.update = updater.available?.versionName
            maybeAutoInstall()
            // 메인 메뉴·설정 화면이면 "업데이트 설치 (…)"·"설정 ●" 를 바로 바꾸고 알림
            if (sub == null || sub is Sub.Group) hud.menu = hud.menu?.let { it.copy(items = menuLabels(), note = note) }
        }
        // 켜 둔 채로 오래 쓰면 6시간마다 다시 확인
        val recheck = object : Runnable {
            override fun run() { updater.check(); hud.postDelayed(this, 6 * 3600_000L) }
        }
        hud.postDelayed(recheck, 6 * 3600_000L)
        // Wi-Fi 자동 켜기 (rokid-conversate 와 같은 방식): 꺼져 있으면 10초마다 켜 보고, 상태는 왼쪽 아래에
        wifi = WifiEnabler(this) { status, detail ->
            hud.post {
                val was = wifiStatus
                wifiStatus = status
                hud.wifiNote = when (status) {
                    WifiEnabler.Status.ENABLING -> "Wi-Fi 켜는 중…"
                    WifiEnabler.Status.WAITING_FOR_NETWORK -> "Wi-Fi 연결 기다리는 중 · 핫스팟을 켜 두세요"
                    WifiEnabler.Status.CANNOT_ENABLE -> "Wi-Fi 못 켬${detail?.let { " · $it" } ?: ""} · 탭하면 설정"
                    WifiEnabler.Status.CONNECTED -> null
                }
                // 꺼져 있어 켜는·기다리는 중이면 가운데 작은 모달로 알린다
                hud.wifiModal = when (status) {
                    WifiEnabler.Status.ENABLING -> HudView.WifiModal("Wi-Fi 켜는 중", "Wi-Fi 가 꺼져 있어 자동으로 켜고 있습니다")
                    WifiEnabler.Status.WAITING_FOR_NETWORK -> HudView.WifiModal("Wi-Fi 연결 중", "iPhone 핫스팟을 켜 두면 자동으로 연결돼요")
                    WifiEnabler.Status.CANNOT_ENABLE -> HudView.WifiModal("Wi-Fi 를 켜지 못했습니다", "${detail ?: ""} · 계속 다시 시도 · 탭하면 Wi-Fi 설정".trimStart(' ', '·'))
                    WifiEnabler.Status.CONNECTED -> null
                }
                hud.wifiNote = null
                if (status == WifiEnabler.Status.CONNECTED && was != status) client.kick()
            }
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
        val internet = caps?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        hud.post {
            hud.device = hud.device.copy(network = name)
            // 네트워크가 다시 잡히면 재연결 대기(최대 30초)를 건너뛰고 바로 연결
            if (internet) client.kick()
        }
    }

    override fun onResume() {
        super.onResume()
        registerReceiver(batteryReceiver, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
        runCatching { connectivity.registerDefaultNetworkCallback(netCallback) }
        updateNetwork()
        heading.start()
        wifi.start()
        client.start()
        // R08 브리지가 처음 링 조작부터 이 화면을 "현재 포커스"로 보도록 미리 포커스를 잡는다
        hud.requestFocus()
    }

    override fun onPause() {
        if (voice.active) { voice.cancel(); hud.voiceModal = null }
        runCatching { unregisterReceiver(batteryReceiver) }
        runCatching { connectivity.unregisterNetworkCallback(netCallback) }
        client.stop()
        wifi.stop()
        heading.stop()
        super.onPause()
    }

    /** 서버 메시지 하나가 잘못돼도 앱이 죽지 않게: 그 메시지만 버리고 기록해 둔다 (다음 연결 때 서버로) */
    private fun onServerMessage(m: JSONObject) {
        try {
            handleServerMessage(m)
        } catch (e: Exception) {
            Log.w("Route", "message ${m.optString("type")} 처리 실패", e)
            CrashLog.record("메시지 ${m.optString("type")} 처리 실패: ${Log.getStackTraceString(e).take(1500)} | ${m.toString().take(300)}")
        }
    }

    private fun handleServerMessage(m: JSONObject) {
        cache.record(m)
        val s = hud.state
        var next = s.apply(m)
        // 주변 도로가 없거나 멀어졌으면, 1일 안에 받아 둔 그 동네 도로를 먼저 깔아 둔다 (서버가 새로 보내면 바뀜)
        val np = next.pos
        if (m.optString("type") == "map-pos" && np != null) {
            val center = next.roads?.lines?.firstOrNull()?.firstOrNull()
            val far = center == null || GlassCache.distM(np.lon, np.lat, center[0], center[1]) > GlassCache.ROADS_NEAR_M * 2
            if (far) cache.roadsNear(np.lon, np.lat)?.let { next = next.apply(it) }
        }
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
        if (m.optString("type") == "idle" || m.optString("type") == "arrived") hud.post { maybeAutoInstall() }
        if (voiceWaiting && m.optString("type") in setOf("choose", "notice")) endVoiceWait()
        when (m.optString("type")) {
            // 메뉴 "경로 다시 찾기" 결과 (이 안경에만 온다)
            "notice" -> showNotice(m.optString("text"))
            // 폰에서 길안내를 시작했는데 목적지 후보가 여럿 (예: 맥도날드 지점들), 또는 그다음 대중교통 경로 후보. 폰 단축어는 이미 끝났다
            "choose" -> {
                val items = m.getJSONArray("items").let { a -> List(a.length()) { a.getString(it) } }
                choosing = m.getInt("id")
                sub = null
                val routes = m.optJSONArray("routes")?.let { r -> List(r.length()) { HudView.RouteCard.fromJson(r.getJSONObject(it)) } }
                hud.menu = HudView.Menu(
                    items, title = m.optString("title", "선택"),
                    note = "${m.optInt("timeoutSec", 60)}초 안에 안 고르면 맨 위 항목",
                    hint = if (routes != null) "쓸기 이동 · 탭 선택 · 뒤로 취소 · ${m.optInt("timeoutSec", 60)}초 뒤 맨 위" else "쓸기 이동 · 탭 선택 · 뒤로 취소",
                    routes = routes,
                )
            }
            // 시간이 지났거나 다른 화면에서 골랐다
            "choose-done" -> if (choosing == m.optInt("id")) { choosing = null; hud.menu = null }
            // 버스·지하철 시간 (메뉴에서 열었을 때만 반영, 20초 뒤 다시 요청)
            "nearby" -> if (sub is Sub.Nearby) {
                showSub(Sub.Nearby(parseBoards(m), m.optString("note"), System.currentTimeMillis()), 0)
                hud.removeCallbacks(refreshNearby)
                hud.postDelayed(refreshNearby, 20_000)
            }
            // 즐겨찾기 목록 (메뉴 → 즐겨찾기 를 열 때 요청)
            // 열려 있는 첫 화면(불러오는 중·카테고리)이면 새 목록으로. 더 들어가 있으면 그대로 둔다
            "favorites" -> when (val cur = sub) {
                Sub.Loading -> showSub(Sub.Categories(parseFavorites(m)), 0)
                is Sub.Categories -> showSub(Sub.Categories(parseFavorites(m)), hud.menu?.selected ?: 0)
                else -> {}
            }
        }
    }

    private fun parseFavorites(m: JSONObject): FavData {
        val a = m.optJSONArray("items") ?: org.json.JSONArray()
        val items = List(a.length()) { i ->
            a.getJSONObject(i).let { Fav(it.getString("id"), it.getString("name"), it.optString("category", "기타"), it.optString("address"), if (it.isNull("distance")) null else it.optInt("distance")) }
        }
        val cats = m.optJSONArray("categories")?.let { c -> List(c.length()) { c.getString(it) } } ?: items.map { it.category }.distinct()
        val r = m.optJSONArray("recent") ?: org.json.JSONArray()
        val recent = List(r.length()) { i -> r.getJSONObject(i).let { Fav(it.getString("id"), it.getString("name"), RECENT, it.optString("address"), if (it.isNull("distance")) null else it.optInt("distance")) } }
        return FavData(cats, items, recent)
    }

    private fun parseBoards(m: JSONObject): List<HudView.Board> {
        val a = m.optJSONArray("boards") ?: org.json.JSONArray()
        return List(a.length()) { i ->
            a.getJSONObject(i).let { o ->
                val ls = o.optJSONArray("lines") ?: org.json.JSONArray()
                HudView.Board(
                    o.optString("kind"), o.optString("name"), if (o.isNull("distance")) null else o.optInt("distance"),
                    List(ls.length()) { j -> StopBoard.lineOf(ls.getJSONObject(j)) },
                    if (o.has("error")) o.optString("error") else null,
                )
            }
        }
    }

    // ── 즐겨찾기: 메뉴 → 즐겨찾기 → 카테고리 → 장소 → 바로 안내 (가까우면 도보, 멀면 대중교통 후보를 안경에서 고름) ──
    data class Fav(val id: String, val name: String, val category: String, val address: String, val distance: Int?)
    /** recent = 최근 목적지 (목적지 화면에서 "최근" 카테고리로 맨 앞) */
    data class FavData(val categories: List<String>, val items: List<Fav>, val recent: List<Fav> = emptyList()) {
        /** 화면에 보이는 카테고리 순서 (최근이 있으면 맨 앞) */
        val keys: List<String> get() = (if (recent.isNotEmpty()) listOf(RECENT) else emptyList()) + categories
        fun placesOf(key: String) = if (key == RECENT) recent else items.filter { it.category == key }
    }

    private sealed class Sub {
        object Loading : Sub()
        /** 버스·지하철 시간 (주변 정류장·역 실시간 도착). 열려 있는 동안 20초마다 새로 받는다 */
        data class Nearby(val boards: List<HudView.Board>?, val note: String, val at: Long?) : Sub()
        data class Categories(val data: FavData) : Sub()
        data class Places(val data: FavData, val category: String, val parentSel: Int) : Sub() {
            val items get() = data.placesOf(category)
        }
        /** 메뉴 묶음 (안내 ▸, 설정 ▸) */
        data class Group(val kind: Item, val items: List<Item>) : Sub()
    }

    // 끊겨 있으면 이번 갱신은 건너뛰고(남은 시간은 안경이 줄여 보여 줌) 다음 20초에 다시
    private val refreshNearby = Runnable {
        if (sub is Sub.Nearby && hud.menu != null) {
            if (!client.send(JSONObject().put("type", "nearby"))) hud.postDelayed(refreshNearbyAgain, 20_000)
        }
    }
    private val refreshNearbyAgain: Runnable get() = refreshNearby

    /** 메인 메뉴 아래 화면. null 이면 메인 메뉴 */
    private var sub: Sub? = null

    private fun distText(m: Int?) = when {
        m == null -> ""
        m < 1000 -> " · ${m}m"
        else -> " · ${"%.1f".format(m / 1000.0)}km"
    }

    private fun showSub(s: Sub, selected: Int) {
        sub = s
        val hint = "쓸기 이동 · 탭 선택 · 뒤로 이전"
        hud.menu = when (s) {
            Sub.Loading -> HudView.Menu(listOf("불러오는 중…"), title = "목적지", hint = hint)
            is Sub.Group -> HudView.Menu(s.items.map(::label), selected, title = "설정", hint = hint)
            is Sub.Nearby -> HudView.Menu(
                emptyList(), title = "버스·지하철 시간" + (s.at?.let { " · ${HudView.clockText(it)} 기준" } ?: ""),
                note = s.note, hint = "탭 새로고침 · 20초마다 갱신 · 뒤로 이전", boards = s.boards ?: emptyList(), boardsAt = s.at,
            )
            is Sub.Categories ->
                if (s.data.keys.isEmpty()) HudView.Menu(listOf("등록된 장소 없음"), title = "목적지", note = "폰 브라우저 /places 에서 즐겨찾기 추가", hint = hint)
                else HudView.Menu(s.data.keys.map { c -> "$c (${s.data.placesOf(c).size})" }, selected, title = "목적지", hint = hint)
            is Sub.Places -> s.items.let { list ->
                HudView.Menu(list.map { it.name + distText(it.distance) }, selected, title = "목적지 · ${s.category}", note = list.getOrNull(selected)?.address ?: "", hint = hint)
            }
        }
    }

    private fun handleSub(s: Sub, input: Input, m: HudView.Menu) {
        if (s is Sub.Nearby) {
            when (input) {
                Input.BACK -> { hud.removeCallbacks(refreshNearby); openMain(Item.NEARBY) }
                else -> request(JSONObject().put("type", "nearby"), "버스·지하철 시간")
            }
            return
        }
        val n = m.items.size.coerceAtLeast(1)
        when (input) {
            Input.NEXT, Input.PREV -> showSub(s, (m.selected + (if (input == Input.NEXT) 1 else -1) + n) % n)
            Input.BACK -> when (s) {
                Sub.Loading, is Sub.Categories -> openMain(Item.DEST)
                is Sub.Group -> openMain(s.kind)
                is Sub.Nearby -> {}
                is Sub.Places -> showSub(Sub.Categories(s.data), s.parentSel)
            }
            Input.SELECT -> when (s) {
                Sub.Loading, is Sub.Nearby -> {}
                is Sub.Group -> s.items.getOrNull(m.selected)?.let { select(it, m) }
                is Sub.Categories -> s.data.keys.getOrNull(m.selected)?.let { showSub(Sub.Places(s.data, it, m.selected), 0) }
                // 서버가 기존 길찾기와 같은 규칙으로: 직선 800m 안이면 도보, 아니면 대중교통 후보(안경에서 고름), 대중교통이 없으면 도보
                is Sub.Places -> s.items.getOrNull(m.selected)?.let { fav ->
                    sub = null
                    hud.menu = null
                    showNotice("${fav.name} 경로 찾는 중…")
                    request(JSONObject().put("type", "go").put("id", fav.id).put("mode", "auto"), "${fav.name} 안내")
                }
            }
        }
    }

    // ── 말해서 찾기: 안경 마이크 → 서버(CLOVA Speech) → "들은 말" 제목의 후보를 안경에서 고름 ──
    private val voice by lazy {
        VoiceRecorder(
            onLevel = { lv -> hud.voiceModal?.takeIf { it.level != null }?.let { hud.voiceModal = it.copy(level = lv) } },
            onDone = ::onVoiceRecorded,
        )
    }
    /** 녹음을 보내고 서버 답(후보 또는 알림)을 기다리는 중 */
    private var voiceWaiting = false
    private val voiceTimeout = Runnable { if (voiceWaiting) { endVoiceWait(); showNotice("음성 검색 응답 없음 · 다시 시도") } }

    private fun startVoice() {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            hud.menu = hud.menu?.copy(note = "마이크 권한을 허용해 주세요")
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), REQ_MIC)
            return
        }
        if (!client.connected) { hud.menu = hud.menu?.copy(note = "연결 끊김 · 음성 검색은 연결돼 있어야 함"); return }
        sub = null
        hud.menu = null
        if (!voice.start()) { showNotice("마이크를 열지 못함"); return }
        hud.voiceModal = HudView.WifiModal("듣는 중", "목적지를 말하세요 · 탭 = 끝 · 뒤로 = 취소", level = 0f)
    }

    private fun onVoiceRecorded(wav: ByteArray?) {
        if (wav == null) { hud.voiceModal = null; showNotice("말소리를 못 들었어요 · 다시 시도"); return }
        val json = JSONObject().put("type", "voice").put("audio", Base64.encodeToString(wav, Base64.NO_WRAP))
        if (!client.send(json)) { hud.voiceModal = null; showNotice("연결 끊김 · 다시 시도"); return }
        voiceWaiting = true
        hud.voiceModal = HudView.WifiModal("알아듣는 중", "잠시만요 · 후보가 뜨면 골라 주세요")
        hud.removeCallbacks(voiceTimeout)
        hud.postDelayed(voiceTimeout, 25_000)
    }

    private fun endVoiceWait() {
        voiceWaiting = false
        hud.removeCallbacks(voiceTimeout)
        hud.voiceModal = null
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startVoice()
        else showNotice("마이크 권한이 없어 말해서 찾기를 못 씀")
    }

    /** 지금 띄운 선택지 번호 (서버 choose id). null 이면 일반 메뉴 */
    private var choosing: Int? = null

    companion object {
        /** 목적지 화면의 "최근" 카테고리 이름 */
        const val RECENT = "최근"
        private const val REQ_MIC = 7
    }

    /** 끊겨 있으면 모아 두었다가 연결되면 보낸다 (30초 지나면 버림). 바로 못 보냈으면 알림 */
    private fun request(json: JSONObject, label: String) {
        if (!client.sendWhenConnected(json, label)) showNotice("연결 끊김 · 연결되면 보냄: $label")
    }

    private fun answerChoice(id: Int, index: Int, label: String?) {
        client.send(JSONObject().put("type", "chosen").put("id", id).put("index", index))
        choosing = null
        hud.menu = null
        showNotice(if (label == null) "목적지 선택 취소" else "선택: $label")
    }

    /**
     * 자동 업데이트 (rokid-conversate 와 같은 방식): 새 버전이 있으면 확인 없이 설치하고 앱이 다시 켜진다.
     * 앱을 켜고 처음 확인할 때는 바로 설치. 그 뒤(6시간마다 확인)에는 길안내 중이면 미루고 안내가 끝나면(경로 없음·도착) 설치. '이 출처 허용'이 꺼져 있으면 설정 화면을 갑자기 띄우지 않고
     * 메뉴 > 설정 > 업데이트에서 직접 (그때 허용 화면으로 안내)
     */
    private fun maybeAutoInstall(atLaunch: Boolean = false) {
        val l = updater.available ?: return
        if (autoInstallTried == l.versionCode) return
        // 앱을 막 켰을 때는 안내 중·메뉴 열림이어도 바로 설치. 그 밖에는 안내가 끝나고 메뉴가 닫혀 있을 때만
        if (!atLaunch && (navigating || hud.menu != null)) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
            if (atLaunch) showNotice("새 버전 ${l.versionName} · 자동 설치하려면 설정 > 업데이트에서 '이 출처 허용'")
            return
        }
        autoInstallTried = l.versionCode
        showNotice("새 버전 ${l.versionName} 자동 설치 중…")
        updater.install()
    }

    private val clearNotice = Runnable { hud.notice = null }

    /** 메뉴가 열려 있으면 메뉴 아래 문구로, 닫혀 있으면 왼쪽 아래에 5초 */
    private fun showNotice(text: String) {
        val menu = hud.menu
        if (menu != null) {
            hud.menu = menu.copy(note = text)
            return
        }
        hud.notice = text
        hud.removeCallbacks(clearNotice)
        hud.postDelayed(clearNotice, 5_000)
    }

    /** 안경 터치·R08 링 등 모든 입력을 이 네 동작으로 바꿔서 처리한다 */
    enum class Input { NEXT, PREV, SELECT, BACK }

    /**
     * 메뉴 항목. 안내 중일 때만 "경로 다시 찾기"(맨 위 바로 아래)·"안내 종료"가 보이고, 드물게 쓰는 것은 "설정 ▸" 아래로
     *   메인: 길안내 화면으로 / 경로 다시 찾기 / 목적지 ▸ / 버스·지하철 시간 / 안내 종료 / 설정 ▸ / 앱 종료
     *   설정 ▸: 지도 표시 / 방향 다시 맞추기 / 업데이트
     *   목적지 ▸: 최근 (n) / 즐겨찾기 카테고리들 → 장소 → 바로 안내
     */
    enum class Item { BACK_TO_NAV, DEST, VOICE, NEARBY, SETTINGS, STOP, REROUTE, RECALIBRATE, MAP_MODE, UPDATE, EXIT }

    private val navigating get() = !hud.state.idle && hud.state.progress.isNotEmpty()

    private fun mainItems() = listOfNotNull(
        Item.BACK_TO_NAV, Item.REROUTE.takeIf { navigating }, Item.VOICE, Item.DEST, Item.NEARBY,
        Item.STOP.takeIf { navigating }, Item.SETTINGS, Item.EXIT,
    )

    /** 메인 메뉴가 열릴 때의 항목 (안내 중인지에 따라 다름) */
    private var mainList: List<Item> = emptyList()

    /** 메인 메뉴 열기. focus 가 있으면 그 항목에 커서 (하위 화면에서 돌아올 때) */
    private fun openMain(focus: Item? = null) {
        sub = null
        stopArmed = false
        mainList = mainItems()
        hud.menu = HudView.Menu(mainList.map(::label), focus?.let { mainList.indexOf(it).coerceAtLeast(0) } ?: 0)
    }

    private fun label(item: Item): String = when (item) {
        Item.BACK_TO_NAV -> if (navigating) "길안내 화면으로" else "화면 닫기"
        Item.DEST -> "목적지 ▸"
        Item.VOICE -> "말해서 찾기"
        Item.SETTINGS -> "설정 ▸" + if (updater.available != null) "  ●" else ""
        Item.NEARBY -> "버스·지하철 시간"
        Item.STOP -> "안내 종료"
        Item.REROUTE -> "경로 다시 찾기"
        Item.RECALIBRATE -> "방향 다시 맞추기"
        Item.MAP_MODE -> "지도: ${hud.mapMode.label}"
        Item.UPDATE -> updater.available?.let { "업데이트 설치 (${it.versionName})" } ?: "업데이트 확인"
        Item.EXIT -> "앱 종료"
    }

    /** 지금 화면(메인 또는 묶음)의 항목 이름. 다른 화면이면 그대로 */
    private fun menuLabels(): List<String> = when (val s = sub) {
        null -> mainList.map(::label)
        is Sub.Group -> s.items.map(::label)
        else -> hud.menu?.items ?: emptyList()
    }

    /** 안내 종료는 실수로 누르지 않게 두 번 선택해야 한다 */
    private var stopArmed = false

    fun handle(input: Input) {
        if (voice.active) {
            // 듣는 중: 탭 = 끝내고 보내기, 뒤로 = 취소
            when (input) {
                Input.SELECT -> voice.stop()
                Input.BACK -> { voice.cancel(); hud.voiceModal = null; showNotice("말해서 찾기 취소") }
                else -> {}
            }
            return
        }
        if (voiceWaiting && input == Input.BACK) { endVoiceWait(); return }
        val m = hud.menu
        val chooseId = choosing
        if (m != null && chooseId != null) {
            val n = m.items.size
            when (input) {
                Input.NEXT -> hud.menu = m.copy(selected = (m.selected + 1) % n)
                Input.PREV -> hud.menu = m.copy(selected = (m.selected - 1 + n) % n)
                Input.SELECT -> answerChoice(chooseId, m.selected, m.routes?.getOrNull(m.selected)?.let { "${it.minutes}분 경로" } ?: m.items[m.selected].substringBefore(" · "))
                Input.BACK -> answerChoice(chooseId, -1, null)
            }
            return
        }
        val s = sub
        if (m != null && s != null) return handleSub(s, input, m)
        if (m == null) {
            // 길안내 화면: 탭 = 화면 모양 바꾸기(전체 지도 ↔ 간소), 앞으로 = 다음 단계 미리보기, 뒤로 쓸기 = 이전, 뒤로가기 = 메인 화면
            when (input) {
                Input.SELECT -> if (wifiStatus == WifiEnabler.Status.CANNOT_ENABLE) wifi.openSystemSettings() else {
                    hud.viewStyle = if (hud.viewStyle == HudView.ViewStyle.FULL) HudView.ViewStyle.COMPACT else HudView.ViewStyle.FULL
                    prefs.edit().putString("viewStyle", hud.viewStyle.name).apply()
                }
                // 연결돼 있으면 서버에 (내 위치는 그대로, 지도만 그 단계로). 끊겨 있으면 받아 둔 단계 문구로 안경 혼자 미리보기
                Input.NEXT, Input.PREV -> {
                    val type = if (input == Input.NEXT) "next" else "prev"
                    if (!client.send(JSONObject().put("type", type))) {
                        val st = hud.state
                        val i = st.index
                        if (i != null && st.steps.isNotEmpty()) hud.state = st.previewStep(i + if (input == Input.NEXT) 1 else -1)
                        else showNotice("연결 끊김 · 단계 정보 없음")
                    }
                }
                Input.BACK -> openMain()
            }
            return
        }
        val n = m.items.size
        when (input) {
            Input.NEXT -> { stopArmed = false; hud.menu = m.copy(selected = (m.selected + 1) % n, note = "") }
            Input.PREV -> { stopArmed = false; hud.menu = m.copy(selected = (m.selected - 1 + n) % n, note = "") }
            // 메인 화면(메뉴)에서 뒤로 = 앱 종료 (길안내 화면 → 뒤로 → 메뉴 → 뒤로 → 종료)
            Input.BACK -> finishAndRemoveTask()
            Input.SELECT -> mainList.getOrNull(m.selected)?.let { select(it, m) }
        }
    }

    private fun select(item: Item, m: HudView.Menu) {
        when (item) {
            Item.BACK_TO_NAV -> { sub = null; hud.menu = null }
            Item.SETTINGS -> showSub(Sub.Group(Item.SETTINGS, listOf(Item.MAP_MODE, Item.RECALIBRATE, Item.UPDATE)), 0)
            Item.VOICE -> startVoice()
            Item.DEST -> {
                // 저장해 둔 목록이 있으면 바로 보여 주고, 새 목록을 받으면 바꾼다
                val saved = cache.favorites()
                if (saved != null) showSub(Sub.Categories(parseFavorites(saved.json)), 0) else showSub(Sub.Loading, 0)
                if (!client.send(JSONObject().put("type", "favorites")) && saved == null) showNotice("연결 끊김 · 저장된 목록 없음")
            }
            Item.NEARBY -> {
                // 10분 안에 받은 결과가 있으면 바로 (남은 시간은 줄여서), 새 결과를 받으면 바꾼다
                val saved = cache.nearby()
                if (saved != null) showSub(Sub.Nearby(parseBoards(saved.json), saved.json.optString("note"), saved.at), 0)
                else showSub(Sub.Nearby(null, if (client.connected) "주변 정류장·역 찾는 중…" else "연결 끊김 · 연결되면 불러옴", null), 0)
                request(JSONObject().put("type", "nearby"), "버스·지하철 시간")
            }
            Item.STOP -> when {
                !navigating -> hud.menu = m.copy(note = "진행 중인 경로 없음")
                !stopArmed -> { stopArmed = true; hud.menu = m.copy(note = "한 번 더 누르면 안내를 끝냅니다") }
                else -> {
                    stopArmed = false
                    request(JSONObject().put("type", "stop"), "안내 종료")
                    sub = null
                    hud.menu = null
                }
            }
            Item.REROUTE -> {
                if (!navigating) { hud.menu = m.copy(note = "진행 중인 경로 없음"); return }
                hud.menu = m.copy(note = "다시 찾는 중…")
                request(JSONObject().put("type", "reroute"), "경로 다시 찾기")
            }
            Item.RECALIBRATE -> {
                heading.reset()
                lastCalib = null
                val note = when (heading.mode) {
                    HeadingProvider.Mode.ABSOLUTE -> "북쪽 기준 센서라 맞출 필요 없음"
                    HeadingProvider.Mode.RELATIVE_MAG -> "지자기로 다시 맞췄습니다"
                    HeadingProvider.Mode.RELATIVE -> "걷기 시작하면 경로 방향으로 다시 맞춥니다"
                    HeadingProvider.Mode.NONE -> "방향 센서 없음 (진행 방향이 위)"
                }
                hud.menu = m.copy(note = note)
            }
            Item.MAP_MODE -> {
                val modes = HudView.MapMode.values()
                hud.mapMode = modes[(hud.mapMode.ordinal + 1) % modes.size]
                prefs.edit().putString("mapMode", hud.mapMode.name).apply()
                val note = when (hud.mapMode) {
                    HudView.MapMode.AUTO -> "회전까지 ${HudView.FAINT_FROM_M.toInt()}m 넘게 남으면 흐리게"
                    HudView.MapMode.ALWAYS -> "지도를 항상 또렷하게"
                    HudView.MapMode.OFF -> "지도 없이 글자만"
                }
                hud.menu = m.copy(items = menuLabels(), note = note)
            }
            Item.UPDATE -> if (updater.available != null) updater.install() else updater.check()
            Item.EXIT -> finishAndRemoveTask()
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
