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
    }

    @get:Rule
    val paparazzi = Paparazzi(
        deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 480, screenHeight = 282, xdpi = 160, ydpi = 160, density = Density.MEDIUM, orientation = ScreenOrientation.LANDSCAPE),
        theme = "android:Theme.Black.NoTitleBar.Fullscreen",
    )

    private fun fixture(): JSONObject =
        JSONObject(javaClass.classLoader!!.getResource("flow.json")!!.readText())

    @Test
    fun pairing() {
        val v = HudView(paparazzi.context) { null }
        v.pairCode = "6567"
        paparazzi.snapshot(v, "00_pairing")
    }

    @Test
    fun transitFlow() {
        val f = fixture()
        val msgs = f.getJSONArray("messages")
        val cps = f.getJSONArray("checkpoints")
        for (c in 0 until cps.length()) {
            val cp = cps.getJSONObject(c)
            var state = HudState()
            for (i in 0 until cp.getInt("upto")) state = state.apply(msgs.getJSONObject(i))
            val v = HudView(paparazzi.context) { null }
            v.state = state
            // 파일 이름은 영문 (한글은 깨짐). 라벨은 flow.json 의 checkpoints 순서와 같다
            paparazzi.snapshot(v, "%02d_%s".format(c + 1, NAMES.getOrElse(c) { "step" }))
        }
    }
}
