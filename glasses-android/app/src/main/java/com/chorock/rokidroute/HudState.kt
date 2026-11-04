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
    /** 탈 정류장 근처면 그곳의 실시간 도착 (간소 화면 오른쪽) */
    val stop: StopBoard? = null,
    /** 지금 단계 번호(0부터)·전체 단계 수. 경로가 없으면 null */
    val index: Int? = null,
    val total: Int? = null,
    /** 단계별 문구 (연결이 끊겨도 링으로 넘겨 볼 수 있게 map-route 로 받아 둔다) */
    val steps: List<Pair<String, String>> = emptyList(),
    /** 아직 안 탄 버스·지하철의 실시간 도착 (안경에서 남은 시간을 줄여 첫 줄을 다시 만든다) */
    val waiting: Waiting? = null,
    /** 마지막 step 메시지를 받은 시각 (남은 시간 줄이기 기준) */
    val stepAt: Long = 0,
    /** 연결이 끊겨 안경 혼자 단계를 넘겨 보는 중 */
    val offlinePreview: Boolean = false,
    /** 앱을 다시 켜며 캐시에서 되살린 화면이면 그 저장 시각 (서버에서 새로 받으면 null) */
    val cachedAt: Long? = null,
    /** 하차 알림: "soon"(다음 정류장) / "now"(이번 정류장) / null */
    val alight: String? = null,
    /** 하차 알림이 처음 뜬(또는 바뀐) 시각 → 처음 몇 초 테두리를 깜빡인다 */
    val alightSince: Long = 0,
) {
    /** 대기 중인 탑승: [버스]/[지하철], 도착 (노선, 남은 초 또는 null, 원문) */
    data class Waiting(val icon: String, val arrivals: List<Triple<String, Int?, String>>)

    /** 연결이 끊겼을 때 안경 혼자 i 단계 문구·지도를 보여 준다 (다시 연결되면 서버 상태로 덮인다) */
    fun previewStep(i: Int): HudState {
        val n = total ?: return this
        if (steps.size != n) return this
        val k = i.coerceIn(0, n)
        val (l1, l2) = if (k == n) "도착" to destination.removePrefix("→ ") else steps[k]
        val turn = route?.turns?.getOrNull(k.coerceAtMost(n - 1))
        return copy(
            line1 = l1, line2 = l2, index = k, progress = if (k < n) "${k + 1}/$n" else "", remaining = null, waiting = null, stop = null,
            pos = pos?.copy(focus = turn, next = if (k + 1 < n) k + 1 else null), offlinePreview = true,
        )
    }
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
            stop = m.optJSONObject("stop")?.let { StopBoard.fromJson(it) },
            index = m.optInt("index"),
            total = m.optInt("total"),
            waiting = m.optJSONObject("ride")?.let { r ->
                val a = r.optJSONArray("arrivals")
                if (r.optBoolean("boarded") || a == null || a.length() == 0) null
                else Waiting(
                    if (r.optString("kind") == "bus") "[버스]" else "[지하철]",
                    List(a.length()) { i -> a.getJSONObject(i).let { x -> Triple(x.optString("line"), if (x.isNull("etaSec")) null else x.optInt("etaSec"), x.optString("message")) } },
                )
            },
            stepAt = now,
            offlinePreview = false,
            cachedAt = null,
        ).let { st ->
            val a = m.optJSONObject("ride")?.optString("alightAlert")?.takeIf { it.isNotEmpty() }
            st.copy(alight = a, alightSince = if (a == null) 0 else if (a != alight) now else alightSince)
        }
        "arrived" -> copy(line1 = "도착", line2 = m.optString("destination"), progress = "", destination = "", warn = false, idle = false, etaAt = null, remaining = null, riding = false, stop = null, index = null, total = null, waiting = null, offlinePreview = false, cachedAt = null, alight = null)
        "idle" -> copy(line1 = m.optString("text", "경로 없음"), line2 = "폰에서 길안내를 시작하세요", progress = "", destination = "", warn = false, idle = true, route = null, pos = null, etaAt = null, remaining = null, riding = false, stop = null, index = null, total = null, steps = emptyList(), waiting = null, offlinePreview = false, cachedAt = null, alight = null)
        "map-route" -> {
            val segs = m.getJSONArray("segments")
            copy(route = MapRoute(
                segments = List(segs.length()) { i -> segs.getJSONObject(i).let { Segment(it.getString("kind"), points(it.getJSONArray("points"))) } },
                turns = points(m.getJSONArray("turns")),
            ), steps = m.optJSONArray("steps")?.let { a -> List(a.length()) { i -> a.getJSONObject(i).let { it.optString("line1") to it.optString("line2") } } } ?: emptyList())
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

    /** 대기 중이면 남은 시간을 지금 기준으로 줄여 만든 첫 줄 ("[버스] 273 2분 · 9분 후"). 아니면 서버가 준 첫 줄 */
    fun line1At(now: Long): String {
        val w = waiting ?: return line1
        if (warn) return line1
        val age = now - stepAt
        val list = w.arrivals.map { (line, eta, msg) -> Triple(line, eta?.let { it - (age / 1000).toInt() }, msg) }
            .sortedBy { it.second ?: Int.MAX_VALUE }
        val a = list.getOrNull(0) ?: return line1
        val b = list.getOrNull(1)
        // 1분 넘게 새로 못 받았으면 시간마다 "~" (어림값)
        val z = if (age > 60_000) "~" else ""
        val min = { sec: Int -> "$z${(sec + 59) / 60}분" }
        val one = { x: Triple<String, Int?, String> -> if (x.second == null) "${x.first} ${x.third}" else if (x.second!! <= 60) "${x.first} ${z}곧 도착" else "${x.first} ${min(x.second!!)} 후" }
        val text = when {
            b == null -> one(a)
            a.first == b.first && a.second != null && b.second != null && a.second!! > 60 -> "${a.first} ${min(a.second!!)} · ${min(b.second!!)} 후"
            a.first == b.first -> "${one(a)} · ${one(b).removePrefix("${b.first} ")}"
            else -> "${one(a)} · ${one(b)}"
        }
        return "${w.icon} $text"
    }

    companion object {
        /**
         * 받은 지 ageMs 지난 도착 남은 시간 문구. eta(초)를 모르면 받은 문구 그대로.
         * 1분 넘게 새로 못 받았으면 "~" 를 붙여 어림값임을 보인다 (연결이 끊겨도 시간은 계속 줄어든다)
         */
        fun etaText(eta: Int?, fallback: String, ageMs: Long): String {
            if (eta == null) return fallback
            val left = eta - (ageMs / 1000).toInt()
            val t = if (left <= 60) "곧 도착" else "${(left + 59) / 60}분"
            return if (ageMs > 60_000) "~$t" else t
        }

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

/** 정류장 보드: 내가 탈 노선(노선별 도착 두 개까지)과 나머지 노선(첫 도착) */
data class StopBoard(val kind: String, val name: String, val mine: List<Line>, val others: List<Line>, val error: String? = null) {
    /** times = 받은 시점 문구, etas = 남은 초 (모르면 null) */
    data class Line(val line: String, val times: List<String>, val etas: List<Int?> = emptyList()) {
        /** 받은 지 ageMs 지난 지금의 문구들 */
        fun timesAt(ageMs: Long): List<String> = times.mapIndexed { i, t -> HudState.etaText(etas.getOrNull(i), t, ageMs) }
    }

    companion object {
        fun lineOf(o: JSONObject) = Line(
            o.optString("line"),
            o.optJSONArray("times")?.let { t -> List(t.length()) { t.getString(it) } } ?: emptyList(),
            o.optJSONArray("etas")?.let { t -> List(t.length()) { if (t.isNull(it)) null else t.getInt(it) } } ?: emptyList(),
        )
        private fun lines(a: JSONArray?) = if (a == null) emptyList() else List(a.length()) { i -> lineOf(a.getJSONObject(i)) }
        fun fromJson(o: JSONObject) = StopBoard(o.optString("kind"), o.optString("name"), lines(o.optJSONArray("mine")), lines(o.optJSONArray("others")), if (o.has("error")) o.optString("error") else null)
    }
}
