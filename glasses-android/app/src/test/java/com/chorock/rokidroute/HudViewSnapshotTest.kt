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
        v.menu = HudView.Menu(
            listOf("길안내 화면으로", "안내 종료", "여기서 경로 다시 찾기", "방향 다시 맞추기", "지도: 자동", "업데이트 설치 (0.3.3)", "앱 종료"),
            selected = 4, note = "회전까지 80m 넘게 남으면 흐리게",
        )
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
