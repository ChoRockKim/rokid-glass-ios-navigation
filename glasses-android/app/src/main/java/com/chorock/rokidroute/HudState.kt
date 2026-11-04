package com.chorock.rokidroute

import org.json.JSONArray
import org.json.JSONObject

/** 화면에 그릴 상태. 서버 메시지(step/arrived/idle, map-route/map-pos/map-roads)를 모은 것 */
data class HudState(
    val line1: String = "연결 중…",
    val line2: String = "",
    val progress: String = "",
    val destination: String = "",
    val status: String = "",
    val warn: Boolean = false,
    val idle: Boolean = true,
    val route: MapRoute? = null,
    val pos: MapPos? = null,
    val roads: MapRoads? = null,
) {
    /** 서버 메시지 하나를 반영한 새 상태 */
    fun apply(m: JSONObject): HudState = when (m.optString("type")) {
        "step" -> copy(
            line1 = m.optString("line1", m.optString("text")),
            line2 = m.optString("line2"),
            progress = "${m.optInt("index") + 1}/${m.optInt("total")}",
            destination = m.optString("destination").let { if (it.isEmpty()) "" else "→ $it" },
            warn = m.optBoolean("offRoute"),
            idle = false,
        )
        "arrived" -> copy(line1 = "도착", line2 = m.optString("destination"), progress = "", destination = "", warn = false, idle = false)
        "idle" -> copy(line1 = m.optString("text", "경로 없음"), line2 = "폰에서 길안내를 시작하세요", progress = "", destination = "", warn = false, idle = true, route = null, pos = null)
        "map-route" -> {
            val segs = m.getJSONArray("segments")
            copy(route = MapRoute(
                segments = List(segs.length()) { i -> segs.getJSONObject(i).let { Segment(it.getString("kind"), points(it.getJSONArray("points"))) } },
                turns = points(m.getJSONArray("turns")),
            ))
        }
        "map-pos" -> copy(pos = MapPos(
            lon = m.getDouble("lon"), lat = m.getDouble("lat"), heading = m.getDouble("heading").toFloat(),
            snapped = m.optBoolean("snapped"), next = if (m.isNull("next")) null else m.optInt("next"),
        ))
        "map-roads" -> {
            val lines = m.getJSONArray("lines")
            val major = m.getJSONArray("major")
            copy(roads = MapRoads(List(lines.length()) { i -> points(lines.getJSONArray(i)) }, List(major.length()) { major.getBoolean(it) }))
        }
        else -> this
    }

    companion object {
        /** JSON 배열 [lon, lat] 들 → List<DoubleArray> */
        fun points(a: JSONArray): List<DoubleArray> =
            List(a.length()) { i -> a.getJSONArray(i).let { doubleArrayOf(it.getDouble(0), it.getDouble(1)) } }
    }
}

data class Segment(val kind: String, val points: List<DoubleArray>) // [lon, lat]
data class MapRoute(val segments: List<Segment>, val turns: List<DoubleArray>)
data class MapPos(val lon: Double, val lat: Double, val heading: Float, val snapped: Boolean, val next: Int?)
data class MapRoads(val lines: List<List<DoubleArray>>, val major: List<Boolean>)
