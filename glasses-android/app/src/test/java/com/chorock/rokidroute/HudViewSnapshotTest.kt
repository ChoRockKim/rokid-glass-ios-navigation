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
        v.device = HudView.Device(battery = 64, network = "Wi-Fi", server = true)
        v.update = "0.3.3"
        v.menu = HudView.Menu(
            listOf("길안내 화면으로", "안내 종료", "여기서 경로 다시 찾기", "방향 다시 맞추기", "지도: 자동", "업데이트 설치 (0.3.3)", "앱 종료"),
            selected = 4, note = "회전까지 80m 넘게 남으면 흐리게",
        )
        paparazzi.snapshot(v, "09_menu")
    }

    /** 폰에서 "맥도날드"로 시작 → 안경에서 지점 고르기 (서버 /route 를 실제 카카오로 돌려 받은 목록) */
    @Test
    fun chooseDestination() {
        val v = HudView(paparazzi.context) { null }
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
