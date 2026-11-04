package com.chorock.rokidroute

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 연결이 끊겼을 때 안경 혼자 하는 일: 남은 시간 줄이기, 단계 미리보기 */
class HudStateTest {
    @Test
    fun etaCountsDownAndMarksStale() {
        assertEquals("3분", HudState.etaText(170, "3분", 0))
        assertEquals("2분", HudState.etaText(170, "3분", 50_000))          // 50초 지나면 2분
        assertEquals("~곧 도착", HudState.etaText(170, "3분", 130_000))   // 1분 넘게 못 받았으면 ~
        assertEquals("2역 전", HudState.etaText(null, "2역 전", 90_000))  // 초를 모르면 받은 문구 그대로
    }

    @Test
    fun waitingLine1RecomputedLocally() {
        val step = JSONObject("""{"type":"step","index":2,"total":5,"line1":"[버스] 273 3분 · 10분 후","line2":"x","destination":"왕십리",
            "ride":{"kind":"bus","boarded":false,"arrivals":[{"line":"273","etaSec":170,"message":""},{"line":"273","etaSec":590,"message":""}]}}""")
        val s = HudState().apply(step, 1_000_000)
        assertEquals("[버스] 273 3분 · 10분 후", s.line1At(1_000_000))
        assertEquals("[버스] 273 2분 · 9분 후", s.line1At(1_000_000 + 60_000))
        assertEquals("[버스] 273 ~곧 도착 · ~8분 후", s.line1At(1_000_000 + 125_000))
    }

    @Test
    fun offlinePreviewUsesCachedSteps() {
        val route = JSONObject("""{"type":"map-route","segments":[],"turns":[[127.0,37.5],[127.001,37.5],[127.002,37.5]],
            "steps":[{"line1":"A","line2":"a"},{"line1":"B","line2":"b"},{"line1":"C","line2":"c"}]}""")
        val pos = JSONObject("""{"type":"map-pos","lon":127.0,"lat":37.5,"heading":0,"snapped":true,"next":1,"fixAge":0}""")
        val step = JSONObject("""{"type":"step","index":0,"total":3,"line1":"A","line2":"a 120m","destination":"왕십리"}""")
        var s = HudState().apply(route, 0).apply(pos, 0).apply(step, 0)
        s = s.previewStep(1)
        assertEquals("B", s.line1)
        assertEquals("2/3", s.progress)
        assertTrue(s.offlinePreview)
        assertEquals(127.001, s.pos!!.focus!![0], 1e-9)   // 지도만 그 단계로
        assertEquals(127.0, s.pos!!.lon, 1e-9)            // 나는 그대로
        assertEquals("도착", s.previewStep(9).line1)
        // 다시 연결되면 서버 step 이 미리보기를 덮는다
        assertTrue(!s.apply(step, 0).offlinePreview)
    }
}
