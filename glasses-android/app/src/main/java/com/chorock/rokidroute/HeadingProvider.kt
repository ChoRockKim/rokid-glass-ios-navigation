package com.chorock.rokidroute

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.util.Log

/**
 * 안경이 보고 있는 방향(북=0°, 시계방향).
 *
 * - TYPE_ROTATION_VECTOR(지자기 포함)가 있으면 북쪽 기준 절대 방위를 그대로 쓴다.
 * - 없으면 TYPE_GAME_ROTATION_VECTOR(지자기 없음, 상대 각도)로 머리 회전만 따라가고,
 *   걷는 동안 경로 진행 방향으로 0°를 조금씩 맞춘다 ([calibrate]).
 *   Rokid 공식 예제(glass3_sdk_demo HeadPoseTracker)가 GAME_ROTATION_VECTOR 를 쓰고 지자기 유무를 로그로만 확인한다.
 * - 둘 다 없으면 null → 화면은 경로 진행 방향을 위로 쓴다.
 *
 * 방위는 기기 -Z 축(화면 너머 정면)의 수평 투영으로 구한다. 고개 끄덕임(피치)에 흔들리지 않게.
 * ⚠ 실기 확인 필요: 안경의 정면이 정말 -Z 인지 (아니면 +Y 등).
 */
class HeadingProvider(context: Context) : SensorEventListener {
    enum class Mode { ABSOLUTE, RELATIVE, NONE }

    private val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val absolute = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val game = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
    val mode: Mode = when {
        absolute != null -> Mode.ABSOLUTE
        game != null -> Mode.RELATIVE
        else -> Mode.NONE
    }

    private val rot = FloatArray(9)
    private var yaw: Float? = null // 센서 원값 (도)
    private var offset = 0f // RELATIVE 일 때 yaw + offset = 북 기준 추정
    private var calibrated = false

    init {
        Log.i(TAG, "heading mode=$mode rotationVector=${absolute != null} game=${game != null} magnetic=${sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD) != null}")
    }

    fun start() {
        val s = absolute ?: game ?: return
        sm.registerListener(this, s, SensorManager.SENSOR_DELAY_GAME)
    }

    fun stop() = sm.unregisterListener(this)

    /** 북 기준 방위. 아직 모르면 null */
    fun heading(): Float? {
        val y = yaw ?: return null
        return when (mode) {
            Mode.ABSOLUTE -> norm(y)
            Mode.RELATIVE -> if (calibrated) norm(y + offset) else null
            Mode.NONE -> null
        }
    }

    /**
     * 걷는 중(경로 위) 받은 경로 진행 방향으로 상대 센서의 0°를 맞춘다. 고개를 잠깐 돌린 것에 끌려가지 않게 조금씩(10%).
     * 처음 한 번은 바로 맞춘다.
     */
    fun calibrate(routeHeading: Float) {
        if (mode != Mode.RELATIVE) return
        val y = yaw ?: return
        val target = norm(routeHeading - y)
        if (!calibrated) {
            offset = target
            calibrated = true
            return
        }
        val d = ((target - offset + 540f) % 360f) - 180f
        offset = norm(offset + d * 0.1f)
    }

    override fun onSensorChanged(event: SensorEvent) {
        SensorManager.getRotationMatrixFromVector(rot, event.values)
        // 안경은 화면이 눈앞에 세워진 자세라 getOrientation(바닥에 눕힌 자세 기준)을 쓰면
        // 고개를 끄덕일 때 기울기가 방위로 섞인다 (0.2.x 실기에서 확인).
        // 대신 "화면 너머 정면" = 기기 -Z 축을 세계 좌표로 돌려 수평면에 투영한 방향을 방위로 쓴다.
        // rot 는 기기→세계(동, 북, 위) 행렬. 기기 (0,0,-1) → 세계 (-r[2], -r[5], -r[8])
        val east = -rot[2]
        val north = -rot[5]
        val up = -rot[8]
        val horiz = kotlin.math.sqrt(east * east + north * north)
        // 고개를 60° 넘게 숙이거나 들면 수평 성분이 작아 방위가 흔들린다 → 마지막 값 유지
        if (horiz < 0.5f || kotlin.math.abs(up) > 0.87f) return
        val deg = norm(Math.toDegrees(kotlin.math.atan2(east, north).toDouble()).toFloat())
        val prev = yaw
        if (prev == null) {
            yaw = deg
            return
        }
        val d = ((deg - prev + 540f) % 360f) - 180f
        if (kotlin.math.abs(d) < 2f) return // 작은 떨림 무시
        // 저역 통과로 부드럽게 (각도라 최단 방향으로)
        yaw = norm(prev + d * 0.25f)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun norm(a: Float) = ((a % 360f) + 360f) % 360f

    companion object { private const val TAG = "Heading" }
}
