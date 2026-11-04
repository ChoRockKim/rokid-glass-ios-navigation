package com.chorock.rokidroute

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
)

data class Segment(val kind: String, val points: List<DoubleArray>) // [lon, lat]
data class MapRoute(val segments: List<Segment>, val turns: List<DoubleArray>)
data class MapPos(val lon: Double, val lat: Double, val heading: Float, val snapped: Boolean, val next: Int?)
data class MapRoads(val lines: List<List<DoubleArray>>, val major: List<Boolean>)
