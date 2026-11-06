package com.chorock.rokidroute

import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import com.android.resources.ScreenOrientation
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test

/**
 * 안경 화면(HudView)을 실제 안드로이드 그리기 엔진(layoutlib)으로 480x282 dp 에 렌더링한다.
 * 입력은 서버 코드를 돌려 안경 WebSocket(map=1)이 받은 메시지를 저장한 것 (src/test/resources/flow.json).
 * 주변 도로는 가짜 바둑판 (개발 세션에서 지도 타일 접속 불가).
 *
 * 화면 다시 만들기: ./gradlew recordPaparazziDebug → src/test/snapshots/images/
 */
class HudViewSnapshotTest {
    private companion object {
        val NAMES = listOf("idle", "start", "walking", "turn", "bus_stop_live", "bus_riding", "subway_live", "arrived")
        /** 화면 시각 고정: 2026-11-04 14:00 KST (도착 예정 시각이 매번 같게) */
        const val T0 = 1_793_768_400_000L
        init { java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("Asia/Seoul")) }

        fun stateUpto(f: JSONObject, upto: Int): HudState {
            val msgs = f.getJSONArray("messages")
            var state = HudState()
            for (i in 0 until upto) state = state.apply(msgs.getJSONObject(i), T0)
            return state
        }
    }

    @get:Rule
    val paparazzi = Paparazzi(
        deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 480, screenHeight = 282, xdpi = 160, ydpi = 160, density = Density.MEDIUM, orientation = ScreenOrientation.LANDSCAPE),
        theme = "android:Theme.Black.NoTitleBar.Fullscreen",
    )

    private fun fixture(): JSONObject =
        JSONObject(javaClass.classLoader!!.getResource("flow.json")!!.readText())

    @Test
    fun menu() {
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 }
        v.device = HudView.Device(battery = 64, network = "Wi-Fi", server = true)
        v.update = "0.3.3"
        v.menu = HudView.Menu(listOf("길안내 화면으로", "목적지 ▸", "버스·지하철 시간", "안내 ▸", "설정 ▸  ●", "앱 종료"), selected = 1)
        paparazzi.snapshot(v, "09_menu")
    }

    /** 지도 화면 탭 → 간소 화면 (왼쪽에 경로·나만, 배경선 없음). 걷는 중 / 버스 정류장 */
    @Test
    fun compactStyle() {
        val f = fixture()
        for ((c, name) in listOf(2 to "walking", 4 to "bus_stop", 6 to "subway_station")) {
            val v = HudView(paparazzi.context) { null }
            v.clock = { T0 + 5_000 }
            v.viewStyle = HudView.ViewStyle.COMPACT
            v.state = stateUpto(f, f.getJSONArray("checkpoints").getJSONObject(c).getInt("upto"))
            v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = true)
            paparazzi.snapshot(v, "12_compact_$name")
        }
    }

    /** 걷는 중에 링으로 다음 단계를 미리 봄: 지도는 다음 회전 지점으로, 나는 실제 위치 그대로 */
    @Test
    fun previewNextStep() {
        val f = fixture()
        var state = stateUpto(f, f.getJSONArray("checkpoints").getJSONObject(2).getInt("upto"))
        val pos = state.pos!!
        val turn = state.route!!.turns[2]
        val m = JSONObject().put("type", "map-pos").put("lon", pos.lon).put("lat", pos.lat).put("heading", pos.heading.toDouble())
            .put("snapped", true).put("next", 2).put("focus", org.json.JSONArray().put(turn[0]).put(turn[1]))
        state = state.apply(m, T0)
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 + 5_000 }
        v.state = state
        v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = true)
        paparazzi.snapshot(v, "13_preview_next_step")
    }

    /** 메뉴 → 즐겨찾기 → 카테고리 */
    @Test
    fun favorites() {
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 }
        v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = true)
        v.menu = HudView.Menu(listOf("집 (1)", "회사 (2)", "맛집 (4)", "기타 (1)"), selected = 2, title = "즐겨찾기", hint = "쓸기 이동 · 탭 선택 · 뒤로 이전")
        paparazzi.snapshot(v, "14_favorites_categories")
        v.menu = HudView.Menu(listOf("단골 국밥 · 320m", "맥도날드 외대점 · 768m", "회기 파전골목 · 1.1km", "을지로 노가리 · 9.4km"), selected = 0,
            title = "즐겨찾기 · 맛집", note = "서울 동대문구 회기로 123", hint = "쓸기 이동 · 탭 선택 · 뒤로 이전")
        paparazzi.snapshot(v, "15_favorites_places")
    }

    /** 대중교통 경로 후보 카드 (회기역 → 왕십리역, 실제 카카오 결과로 만든 routes.json). 1번 / 3번 선택 */
    @Test
    fun routeCards() {
        val j = JSONObject(javaClass.classLoader!!.getResource("routes.json")!!.readText())
        val items = j.getJSONArray("items").let { a -> List(a.length()) { a.getString(it) } }
        val routes = j.getJSONArray("routes").let { a -> List(a.length()) { HudView.RouteCard.fromJson(a.getJSONObject(it)) } }
        for (sel in listOf(0, 3)) {
            val v = HudView(paparazzi.context) { null }
            v.clock = { T0 }
            v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = true)
            v.menu = HudView.Menu(items, sel, title = j.getString("title"), hint = "쓸기 이동 · 탭 선택 · 뒤로 취소 · 60초 뒤 맨 위", routes = routes)
            paparazzi.snapshot(v, "16_route_cards_$sel")
        }
    }

    /** 메뉴 → 버스·지하철 시간: 가까운 버스 정류장과 지하철역을 나란히 */
    @Test
    fun nearbyBoards() {
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 }
        v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = true)
        fun l(line: String, vararg t: String) = StopBoard.Line(line, t.toList())
        v.menu = HudView.Menu(emptyList(), title = "버스·지하철 시간 · 14:00 기준", hint = "탭 새로고침 · 20초마다 갱신 · 뒤로 이전", boards = listOf(
            HudView.Board("bus", "회기역.경희의료원", 40, listOf(l("1215", "곧 도착"), l("273", "6분", "12분"), l("120", "8분", "21분"), l("147", "9분"), l("201", "14분"), l("N62", "운행대기")), null),
            HudView.Board("subway", "회기역", 30, listOf(l("1호선 청량리행", "2역 전", "7분"), l("경의중앙선 문산행", "곧 도착"), l("1호선 소요산행", "4분", "11분"), l("경춘선 춘천행", "18분")), null),
        ))
        paparazzi.snapshot(v, "17_nearby_boards")
        v.menu = v.menu!!.copy(boards = listOf(HudView.Board("bus", "버스", null, emptyList(), "버스 키 확인 필요 (401)"), HudView.Board("subway", "회기역", 30, listOf(l("1호선 청량리행", "2역 전", "7분")), null)))
        paparazzi.snapshot(v, "18_nearby_bus_error")
    }

    /** 연결 끊김: 화면은 그대로, 오른쪽 위에 "연결 끊김 · 15초". 링으로 다음 단계를 넘기면 받아 둔 문구로 미리보기 */
    @Test
    fun offline() {
        val f = fixture()
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 + 20_000 }
        v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = false)
        v.offlineSince = T0 + 5_000
        val s = stateUpto(f, f.getJSONArray("checkpoints").getJSONObject(2).getInt("upto"))
        v.state = s
        v.state = v.state.copy(status = "서버 응답 없음 · 8초 뒤 재연결")
        paparazzi.snapshot(v, "19_offline")
        v.state = s.previewStep((s.index ?: 0) + 1).copy(status = "서버 응답 없음 · 8초 뒤 재연결")
        paparazzi.snapshot(v, "20_offline_preview")
        // 앱을 다시 켰는데 아직 연결 전: 캐시에서 되살린 3분 전 화면
        v.offlineSince = null
        v.state = s.copy(cachedAt = T0 + 20_000 - 180_000, status = "연결 중…")
        paparazzi.snapshot(v, "23_cached_screen")
    }

    /** 정류장 보드: 75초째 새로 못 받음 → 남은 시간을 줄이고 "~" / 실시간 실패 이유 */
    @Test
    fun staleStopBoard() {
        val f = fixture()
        val v = HudView(paparazzi.context) { null }
        v.viewStyle = HudView.ViewStyle.COMPACT
        v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = false)
        v.offlineSince = T0
        v.clock = { T0 + 75_000 }
        val s = stateUpto(f, f.getJSONArray("checkpoints").getJSONObject(4).getInt("upto"))
        v.state = s
        paparazzi.snapshot(v, "21_stop_board_stale")
        v.offlineSince = null
        v.clock = { T0 }
        v.state = s.copy(stop = StopBoard("bus", "외대역앞", emptyList(), emptyList(), "실시간 정보 없음 (API 키 확인 필요)"), waiting = null, line1 = "[버스] 273 탑승 · 외대역앞")
        paparazzi.snapshot(v, "22_stop_board_error")
    }

    /** 메뉴 정리: 목적지(최근 + 즐겨찾기 카테고리), 설정 묶음 */
    @Test
    fun menuGroups() {
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 }
        v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = true)
        v.menu = HudView.Menu(listOf("최근 (5)", "집 (1)", "회사 (2)", "맛집 (4)"), selected = 0, title = "목적지", hint = "쓸기 이동 · 탭 선택 · 뒤로 이전")
        paparazzi.snapshot(v, "24_menu_destinations")
        v.menu = HudView.Menu(listOf("왕십리역 경의중앙선 · 3.6km", "맥도날드 외대점 · 768m", "경희대학교 서울캠퍼스 · 351m", "회사 · 9.4km", "단골 국밥 · 320m"), selected = 0,
            title = "목적지 · 최근", note = "서울 성동구 왕십리로 지하 300", hint = "쓸기 이동 · 탭 선택 · 뒤로 이전")
        paparazzi.snapshot(v, "25_menu_recent")
        v.menu = HudView.Menu(listOf("지도: 자동", "방향 다시 맞추기", "업데이트 설치 (0.3.20)"), selected = 2, title = "설정", hint = "쓸기 이동 · 탭 선택 · 뒤로 이전")
        paparazzi.snapshot(v, "26_menu_settings")
    }

    /** 하차 알림: 버스 탑승 중 다음 정류장 → 테두리 깜빡임 (소리 없음), 간소 화면에서도 */
    @Test
    fun alightAlert() {
        val f = fixture()
        val base = stateUpto(f, f.getJSONArray("checkpoints").getJSONObject(5).getInt("upto"))
        for ((name, kind, style) in listOf(Triple("soon", "soon", HudView.ViewStyle.FULL), Triple("now_compact", "now", HudView.ViewStyle.COMPACT))) {
            val v = HudView(paparazzi.context) { null }
            v.clock = { T0 + 150 }
            v.viewStyle = style
            v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = true)
            v.state = base.copy(alight = kind, alightSince = T0, line1 = if (kind == "now") "[버스] 이번 정류장에서 하차" else "[버스] 다음 정류장에서 하차", line2 = "회기시장 하차 · 약 1정거장")
            paparazzi.snapshot(v, "27_alight_$name")
        }
    }

    /** Wi-Fi 가 꺼져 자동으로 켜는 중: 가운데 작은 모달 (길안내 화면 위) */
    @Test
    fun wifiModal() {
        val f = fixture()
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 }
        v.device = HudView.Device(battery = 82, network = "연결 없음", server = false)
        v.state = stateUpto(f, f.getJSONArray("checkpoints").getJSONObject(2).getInt("upto"))
        v.wifiModal = HudView.WifiModal("Wi-Fi 켜는 중", "Wi-Fi 가 꺼져 있어 자동으로 켜고 있습니다")
        paparazzi.snapshot(v, "28_wifi_enabling")
        v.wifiModal = HudView.WifiModal("Wi-Fi 연결 중", "iPhone 핫스팟을 켜 두면 자동으로 연결돼요")
        v.state = HudState()
        paparazzi.snapshot(v, "29_wifi_waiting_idle")
    }

    /** 폰에서 "맥도날드"로 시작 → 안경에서 지점 고르기 (서버 /route 를 실제 카카오로 돌려 받은 목록) */
    @Test
    fun chooseDestination() {
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 }
        v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = true)
        v.menu = HudView.Menu(
            listOf("맥도날드 외대점 · 768m", "맥도날드 전농점 · 1.3km", "맥도날드 중랑점 · 1.6km", "맥도날드 종암SK DT점 · 2.0km", "맥도날드 장안사거리점 · 2.3km"),
            selected = 1, title = "목적지 선택 · 맥도날드", note = "40초 안에 안 고르면 가장 가까운 곳", hint = "쓸기 이동 · 탭 선택 · 뒤로 취소",
        )
        paparazzi.snapshot(v, "11_choose_destination")
    }

    /** 폰 위치가 1분 넘게 안 옴 + 지도 끄기 + 새 버전 표시 */
    @Test
    fun staleLocationTextOnly() {
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 + 75_000 }
        v.state = stateUpto(fixture(), fixture().getJSONArray("checkpoints").getJSONObject(2).getInt("upto"))
        v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = true)
        v.update = "0.3.3"
        v.mapMode = HudView.MapMode.OFF
        paparazzi.snapshot(v, "10_stale_location_text_only")
    }

    /** R08 Access Bridge 용: 클릭·포커스 가능, 접근성 스크롤 앞/뒤·클릭이 다음·이전·선택으로 */
    @Test
    fun r08RingAccessibility() {
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 }
        val got = mutableListOf<MainActivity.Input>()
        v.onInput = { got += it }
        // layoutlib 은 AccessibilityNodeInfo 가 스텁이라 노드 속성은 실기에서만 확인 가능. 여기서는 뷰 속성과 동작 전달만 본다
        org.junit.Assert.assertTrue(v.isClickable)
        org.junit.Assert.assertTrue(v.isFocusable)
        v.performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null)
        v.performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD, null)
        v.performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK, null)
        org.junit.Assert.assertEquals(listOf(MainActivity.Input.NEXT, MainActivity.Input.PREV, MainActivity.Input.SELECT), got)
    }

    @Test
    fun pairing() {
        val v = HudView(paparazzi.context) { null }
        v.clock = { T0 }
        v.pairCode = "6567"
        paparazzi.snapshot(v, "00_pairing")
    }

    @Test
    fun transitFlow() {
        val f = fixture()
        val cps = f.getJSONArray("checkpoints")
        for (c in 0 until cps.length()) {
            val cp = cps.getJSONObject(c)
            val v = HudView(paparazzi.context) { null }
            v.clock = { T0 + 5_000 }
            v.state = stateUpto(f, cp.getInt("upto"))
            v.device = HudView.Device(battery = 82, network = "Wi-Fi", server = true)
            // 파일 이름은 영문 (한글은 깨짐). 라벨은 flow.json 의 checkpoints 순서와 같다
            paparazzi.snapshot(v, "%02d_%s".format(c + 1, NAMES.getOrElse(c) { "step" }))
        }
    }

    /** 안경과 같은 조건: 480x640 px 세로 화면, 밀도 1.5 (다른 Rokid 앱 테스트가 480x640 을 가정). 앱과 같은 레이아웃 */
    class OnGlassesScreen {
        @get:Rule
        val paparazzi = Paparazzi(
            deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 480, screenHeight = 640, xdpi = 240, ydpi = 240, density = Density.HIGH, orientation = ScreenOrientation.PORTRAIT),
            theme = "android:Theme.Black.NoTitleBar.Fullscreen",
        )

        @Test
        fun fitsInside() {
            val f = JSONObject(javaClass.classLoader!!.getResource("flow.json")!!.readText())
            val upto = f.getJSONArray("checkpoints").getJSONObject(4).getInt("upto")
            val hud = HudView(paparazzi.context) { null }
            hud.clock = { T0 + 5_000 }
            hud.state = stateUpto(f, upto)
            hud.device = HudView.Device(battery = 12, charging = false, network = "Wi-Fi", server = false)
            val root = android.widget.FrameLayout(paparazzi.context).apply { setBackgroundColor(android.graphics.Color.BLACK) }
            root.addView(hud, android.widget.FrameLayout.LayoutParams(-2, -2, android.view.Gravity.BOTTOM or android.view.Gravity.CENTER_HORIZONTAL))
            paparazzi.snapshot(root, "glasses_480x640_hdpi")
        }
    }
}
