package com.chorock.rokidroute

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** 앱을 다시 켰을 때 캐시에서 되살리기 (파일에 쓰고 새 GlassCache 로 읽는다) */
class GlassCacheTest {
    @get:Rule val tmp = TemporaryFolder()

    private var t = 1_000_000L
    private fun cache() = GlassCache(tmp.root, { t }, { it.run() }, { r, _ -> r.run() })
    private fun j(s: String) = JSONObject(s)

    private val route = j("""{"type":"map-route","segments":[],"turns":[[127.0,37.5],[127.001,37.5]],"steps":[{"line1":"A","line2":"a"},{"line1":"B","line2":"b"}]}""")
    private val roads = j("""{"type":"map-roads","lines":[[[127.0,37.5],[127.001,37.5]]],"major":[false],"kinds":["road"],"buildings":[]}""")
    private val pos = j("""{"type":"map-pos","lon":127.0,"lat":37.5,"heading":0,"snapped":true,"next":1,"fixAge":0}""")
    private val step = j("""{"type":"step","index":0,"total":2,"line1":"A","line2":"a 80m","destination":"왕십리",
        "ride":{"kind":"bus","boarded":false,"arrivals":[{"line":"273","etaSec":300,"message":""}]}}""")

    @Test
    fun routeSurvivesRestartWithAges() {
        val c = cache()
        for (m in listOf(route, roads, pos)) c.record(m)
        c.record(step)
        t += 120_000 // 2분 뒤 앱을 다시 켬
        val saved = cache().routeMessages()
        assertEquals(listOf("map-route", "map-roads", "map-pos", "step"), saved.map { it.json.optString("type") })
        var s = HudState()
        for (m in saved) s = s.apply(m.json, m.at)
        assertEquals("A", s.line1)
        assertNotNull(s.roads)
        assertEquals("[버스] 273 ~3분 후", s.line1At(t)) // 받은 지 2분 → 5분이 3분, 어림 표시
        assertEquals(1_000_000L, s.lastFixAt)                                     // 위치는 2분 전 것
    }

    @Test
    fun idleClearsRouteAndOldRouteIgnored() {
        val c = cache()
        c.record(route); c.record(step)
        c.record(j("""{"type":"idle","text":"경로 없음"}"""))
        assertTrue(cache().routeMessages().isEmpty())
        c.record(route); c.record(step)
        t += 13 * 3600_000L // 12시간 지남
        assertTrue(cache().routeMessages().isEmpty())
    }

    @Test
    fun favoritesNearbyRoads() {
        val c = cache()
        c.record(j("""{"type":"favorites","categories":["맛집"],"items":[{"id":"a","name":"단골 국밥","category":"맛집","address":"x","distance":320}]}"""))
        c.record(j("""{"type":"nearby","boards":[{"kind":"bus","name":"회기역","distance":40,"lines":[{"line":"273","times":["6분"],"etas":[360]}]}]}"""))
        c.record(roads)
        t += 5 * 60_000
        val d = cache()
        assertEquals("단골 국밥", d.favorites()!!.json.getJSONArray("items").getJSONObject(0).getString("name"))
        assertNotNull(d.nearby())
        assertNotNull(d.roadsNear(127.0005, 37.5001))     // 같은 동네
        assertNull(d.roadsNear(127.05, 37.5))              // 4km 떨어진 곳
        t += 6 * 60_000                                    // 버스·지하철 결과는 10분까지만
        assertNull(cache().nearby())
    }
}
