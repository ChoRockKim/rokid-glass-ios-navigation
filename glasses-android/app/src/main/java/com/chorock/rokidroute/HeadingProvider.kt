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
 * ⚠ 안경 실기 미확인: 어떤 센서가 있는지, getOrientation 의 yaw 축이 안경 착용 자세에서 맞는지.
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
    private val ori = FloatArray(3)
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
        SensorManager.getOrientation(rot, ori)
        val deg = Math.toDegrees(ori[0].toDouble()).toFloat()
        // 저역 통과로 흔들림 줄이기 (각도라 최단 방향으로)
        yaw = yaw?.let { prev -> norm(prev + (((deg - prev + 540f) % 360f) - 180f) * 0.2f) } ?: norm(deg)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun norm(a: Float) = ((a % 360f) + 360f) % 360f

    companion object { private const val TAG = "Heading" }
}
