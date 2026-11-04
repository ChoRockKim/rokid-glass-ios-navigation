package com.chorock.rokidroute

import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.cos
import kotlin.math.hypot

/**
 * 안경 앱 캐시: 서버에서 받은 메시지를 작은 파일로 남겨, 앱을 다시 켰을 때 연결 전이라도 바로 보여 준다.
 * 다시 연결되면 서버가 보낸 것으로 덮는다 (캐시는 "마지막으로 받은 것" 일 뿐).
 *
 * | 무엇 | 파일 | 보관 |
 * | 진행 중인 경로 (step·map-route·map-pos·map-roads) | route.json | 12시간 (서버 경로 저장과 같게) |
 * | 즐겨찾기 목록 | favorites.json | 다음에 새로 받을 때까지 |
 * | 버스·지하철 시간 마지막 결과 | nearby.json | 10분 |
 * | 최근 주변 도로 3곳 | roads.json | 1일 |
 *
 * 메시지는 받은 시각과 함께 저장하고, 되살릴 때 그 시각으로 HudState.apply 한다 → 남은 시간·위치 경과가 맞게 나온다.
 * 파일 쓰기는 백그라운드 한 줄에서, 경로는 1.5초 모아서 쓴다 (위치가 2초마다 오므로).
 */
class GlassCache(
    private val dir: File,
    private val now: () -> Long = System::currentTimeMillis,
    /** 파일 쓰기를 돌릴 곳 (테스트에서는 바로 실행) */
    private val io: java.util.concurrent.Executor = Executors.newSingleThreadExecutor(),
    /** 경로 저장을 미루는 방법. null 이면 메인 스레드에서 1.5초 모아서 (테스트에서는 바로 실행) */
    private val later: ((Runnable, Long) -> Unit)? = null,
) {
    private val main by lazy { Handler(Looper.getMainLooper()) }

    data class Stamped(val json: JSONObject, val at: Long)

    companion object {
        const val ROUTE_MAX_AGE_MS = 12 * 3600_000L
        const val NEARBY_MAX_AGE_MS = 10 * 60_000L
        const val ROADS_MAX_AGE_MS = 24 * 3600_000L
        const val ROADS_KEEP = 3
        /** 내 위치가 저장된 도로 묶음 가운데서 이 안이면 그 도로를 쓴다 */
        const val ROADS_NEAR_M = 250.0

        fun distM(lon1: Double, lat1: Double, lon2: Double, lat2: Double): Double =
            hypot((lon2 - lon1) * 111_320 * cos(Math.toRadians(lat1)), (lat2 - lat1) * 110_540)

        /** 도로 묶음의 가운데 (선들의 첫 점 평균) */
        fun centerOf(roads: JSONObject): Pair<Double, Double>? {
            val lines = roads.optJSONArray("lines") ?: return null
            var lon = 0.0; var lat = 0.0; var n = 0
            for (i in 0 until lines.length()) {
                val p = lines.optJSONArray(i)?.optJSONArray(0) ?: continue
                lon += p.getDouble(0); lat += p.getDouble(1); n++
            }
            return if (n == 0) null else (lon / n) to (lat / n)
        }
    }


    // 진행 중인 경로: 종류별 마지막 메시지
    private var nav: Stamped? = null
    private var route: Stamped? = null
    private var pos: Stamped? = null
    private var roads: Stamped? = null
    private val roadsRing = ArrayDeque<Stamped>()
    private var favorites: Stamped? = null
    private var nearby: Stamped? = null

    init {
        dir.mkdirs()
        read("route.json")?.let { o ->
            nav = stamped(o.optJSONObject("nav")); route = stamped(o.optJSONObject("route"))
            pos = stamped(o.optJSONObject("pos")); roads = stamped(o.optJSONObject("roads"))
        }
        read("roads.json")?.optJSONArray("items")?.let { a -> for (i in 0 until a.length()) stamped(a.optJSONObject(i))?.let(roadsRing::addLast) }
        favorites = stamped(read("favorites.json"))
        nearby = stamped(read("nearby.json"))
    }

    /** 서버 메시지 하나를 기록 (받은 순서대로 부른다) */
    fun record(m: JSONObject) {
        val s = Stamped(m, now())
        when (m.optString("type")) {
            "step", "arrived" -> { nav = s; saveRouteSoon() }
            "idle" -> { nav = null; route = null; pos = null; roads = null; saveRouteSoon() }
            "map-route" -> { route = s; pos = null; saveRouteSoon() }
            "map-pos" -> { pos = s; saveRouteSoon() }
            "map-roads" -> {
                roads = s
                saveRouteSoon()
                rememberRoads(s)
            }
            "favorites" -> { favorites = s; write("favorites.json", wrap(s)) }
            "nearby" -> if ((m.optJSONArray("boards")?.length() ?: 0) > 0) { nearby = s; write("nearby.json", wrap(s)) }
        }
    }

    /** 앱을 켰을 때: 12시간 안의 진행 중인 경로면 되살릴 메시지들(받은 순서), 아니면 빈 목록 */
    fun routeMessages(): List<Stamped> {
        val n = nav ?: return emptyList()
        if (n.json.optString("type") != "step" || now() - n.at > ROUTE_MAX_AGE_MS) return emptyList()
        return listOfNotNull(route, roads, pos, n).sortedBy { it.at }
    }

    fun favorites(): Stamped? = favorites

    fun nearby(): Stamped? = nearby?.takeIf { now() - it.at < NEARBY_MAX_AGE_MS }

    /** 지금 위치에서 가까운, 1일 안에 받은 도로 묶음 */
    fun roadsNear(lon: Double, lat: Double): JSONObject? = roadsRing
        .filter { now() - it.at < ROADS_MAX_AGE_MS }
        .mapNotNull { s -> centerOf(s.json)?.let { c -> s to distM(lon, lat, c.first, c.second) } }
        .filter { it.second < ROADS_NEAR_M }
        .minByOrNull { it.second }?.first?.json

    private fun rememberRoads(s: Stamped) {
        val c = centerOf(s.json) ?: return
        // 거의 같은 곳이면 바꿔 끼운다
        roadsRing.removeAll { o -> centerOf(o.json)?.let { distM(c.first, c.second, it.first, it.second) < 100 } ?: true }
        roadsRing.addFirst(s)
        while (roadsRing.size > ROADS_KEEP) roadsRing.removeLast()
        write("roads.json", JSONObject().put("items", JSONArray(roadsRing.map(::wrap))))
    }

    private val saveRoute = Runnable {
        val o = JSONObject()
        nav?.let { o.put("nav", wrap(it)) }; route?.let { o.put("route", wrap(it)) }
        pos?.let { o.put("pos", wrap(it)) }; roads?.let { o.put("roads", wrap(it)) }
        write("route.json", o)
    }

    private fun saveRouteSoon() {
        val l = later
        if (l != null) return l(saveRoute, 1500)
        main.removeCallbacks(saveRoute)
        main.postDelayed(saveRoute, 1500)
    }

    private fun wrap(s: Stamped) = JSONObject().put("at", s.at).put("json", s.json)
    private fun stamped(o: JSONObject?): Stamped? = o?.optJSONObject("json")?.let { Stamped(it, o.optLong("at")) }

    private fun read(name: String): JSONObject? = runCatching { JSONObject(File(dir, name).readText()) }.getOrNull()

    private fun write(name: String, o: JSONObject) {
        val text = o.toString()
        io.execute {
            runCatching {
                val tmp = File(dir, "$name.tmp")
                tmp.writeText(text)
                tmp.renameTo(File(dir, name))
            }
        }
    }
}
