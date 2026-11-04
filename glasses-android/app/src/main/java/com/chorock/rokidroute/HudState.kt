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
    /** 도착 예정 시각 (안경 시계, epoch ms). 서버가 준 남은 초를 받은 시각에 더한다 */
    val etaAt: Long? = null,
    /** 마지막으로 실제 위치(폰 GPS)가 반영된 시각 (안경 시계). 모르면 null */
    val lastFixAt: Long? = null,
    /** 지금 단계 끝(다음 회전)까지 남은 거리 m. 위치를 모르면 null */
    val remaining: Double? = null,
    /** 버스·지하철에 타고 있는 중 */
    val riding: Boolean = false,
) {
    /** 서버 메시지 하나를 반영한 새 상태. now 는 받은 시각 */
    fun apply(m: JSONObject, now: Long = System.currentTimeMillis()): HudState = when (m.optString("type")) {
        "step" -> copy(
            line1 = m.optString("line1", m.optString("text")),
            line2 = m.optString("line2"),
            progress = "${m.optInt("index") + 1}/${m.optInt("total")}",
            destination = m.optString("destination").let { if (it.isEmpty()) "" else "→ $it" },
            warn = m.optBoolean("offRoute"),
            idle = false,
            etaAt = if (m.has("etaSec")) now + m.optLong("etaSec") * 1000 else null,
            remaining = if (m.isNull("remaining")) null else m.optDouble("remaining"),
            riding = m.optJSONObject("ride")?.optBoolean("boarded") == true,
        )
        "arrived" -> copy(line1 = "도착", line2 = m.optString("destination"), progress = "", destination = "", warn = false, idle = false, etaAt = null, remaining = null, riding = false)
        "idle" -> copy(line1 = m.optString("text", "경로 없음"), line2 = "폰에서 길안내를 시작하세요", progress = "", destination = "", warn = false, idle = true, route = null, pos = null, etaAt = null, remaining = null, riding = false)
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
            estimated = m.optBoolean("estimated"),
            focus = m.optJSONArray("focus")?.let { doubleArrayOf(it.getDouble(0), it.getDouble(1)) },
        )).let { if (m.has("fixAge")) it.copy(lastFixAt = now - m.optLong("fixAge")) else it }
        "map-roads" -> {
            val lines = m.getJSONArray("lines")
            val major = m.getJSONArray("major")
            val kinds = m.optJSONArray("kinds")
            val bl = m.optJSONArray("buildings")
            copy(roads = MapRoads(
                lines = List(lines.length()) { i -> points(lines.getJSONArray(i)) },
                major = List(major.length()) { major.getBoolean(it) },
                kinds = if (kinds != null) List(kinds.length()) { kinds.getString(it) } else List(major.length()) { if (major.getBoolean(it)) "major" else "road" },
                buildings = if (bl != null) List(bl.length()) { i -> points(bl.getJSONArray(i)) } else emptyList(),
            ))
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
/**
 * estimated: 실제 위치가 아닌 경로 위 추정 지점 (시작점 등) → "나"를 그리지 않음.
 * focus: 다른 단계를 미리 보는 중이면 그 단계 시작점 [lon, lat] → 지도만 거기로, "나"는 실제 위치에.
 */
data class MapPos(
    val lon: Double, val lat: Double, val heading: Float, val snapped: Boolean, val next: Int?,
    val estimated: Boolean = false, val focus: DoubleArray? = null,
) {
    // DoubleArray 는 내용 비교가 안 돼서 직접 (같은 위치를 다시 받으면 미끄러지기를 다시 시작하지 않게)
    override fun equals(other: Any?) = other is MapPos && lon == other.lon && lat == other.lat && heading == other.heading &&
        snapped == other.snapped && next == other.next && estimated == other.estimated && focus.contentEquals(other.focus)
    override fun hashCode() = arrayOf<Any?>(lon, lat, heading, snapped, next, estimated, focus?.contentHashCode()).contentHashCode()
}
/** kinds: major · road · service · path · rail. buildings: 건물 바깥 윤곽 */
data class MapRoads(val lines: List<List<DoubleArray>>, val major: List<Boolean>, val kinds: List<String> = emptyList(), val buildings: List<List<DoubleArray>> = emptyList())
