package com.chorock.rokidroute

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.util.Log
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * 안경이 보고 있는 방향(북=0°, 시계방향).
 *
 * 모드 (있는 센서에 따라)
 * - ABSOLUTE: TYPE_ROTATION_VECTOR(지자기 포함) → 북 기준 방위를 그대로.
 * - RELATIVE_MAG: GAME_ROTATION_VECTOR(빠르고 부드러운 상대 회전) + 가속도·지자기로 구한 북 기준 방위로 0°를 천천히 보정.
 * - RELATIVE: GAME_ROTATION_VECTOR 만. 걸을 때(3m+ 이동) 경로 진행 방향으로 0°를 보정. 서서 두리번거릴 때는 보정 안 함.
 * - NONE: null → 화면은 경로 진행 방향을 위로.
 * 2026-11-04 사용자 안경 실기: RELATIVE 로 뜸 (TYPE_ROTATION_VECTOR 없음). 지자기 단독 센서 유무는 0.2.4 화면 표시로 확인.
 *
 * 방위는 기기 -Z 축(화면 너머 정면)의 수평 투영. getOrientation(눕힌 자세 기준)은 고개 끄덕임이 방위로 섞여서 쓰지 않는다.
 */
class HeadingProvider(context: Context) : SensorEventListener {
    enum class Mode { ABSOLUTE, RELATIVE_MAG, RELATIVE, NONE }

    private val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val absolute = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val game = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
    private val accel = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val magnetic = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)
    val mode: Mode = when {
        absolute != null -> Mode.ABSOLUTE
        game != null && accel != null && magnetic != null -> Mode.RELATIVE_MAG
        game != null -> Mode.RELATIVE
        else -> Mode.NONE
    }

    /** 방향이 바뀌었을 때 (화면이 다시 그릴지 정한다) */
    var onChange: (() -> Unit)? = null

    /** 화면 표시용: "RELATIVE_MAG · 지자기 Y" */
    val describe = "$mode · 지자기 ${if (magnetic != null) "Y" else "N"}"

    private val rot = FloatArray(9)
    private val magRot = FloatArray(9)
    private val gravity = FloatArray(3)
    private val geomag = FloatArray(3)
    private var haveGravity = false
    private var haveGeomag = false

    private var yaw: Float? = null // 회전 센서 원값 (도)
    private var offset = 0f // yaw + offset = 북 기준 추정
    private var calibrated = false

    init {
        Log.i(TAG, "heading mode=$mode rotationVector=${absolute != null} game=${game != null} accel=${accel != null} magnetic=${magnetic != null}")
    }

    /** 센서를 듣고 있는지 (길안내 지도가 없으면 꺼서 배터리 절약) */
    var running = false
        private set

    /**
     * 배터리: 게임용(약 50Hz) 대신 UI 용(약 15Hz). 지도 회전은 화면을 초당 10번까지만 다시 그리므로 충분하다.
     * 이미 켜져 있으면 아무것도 안 함
     */
    fun start() {
        if (running) return
        running = true
        when (mode) {
            Mode.ABSOLUTE -> sm.registerListener(this, absolute, SensorManager.SENSOR_DELAY_UI)
            Mode.RELATIVE_MAG -> {
                sm.registerListener(this, game, SensorManager.SENSOR_DELAY_UI)
                sm.registerListener(this, accel, SensorManager.SENSOR_DELAY_UI)
                sm.registerListener(this, magnetic, SensorManager.SENSOR_DELAY_UI)
            }
            Mode.RELATIVE -> sm.registerListener(this, game, SensorManager.SENSOR_DELAY_UI)
            Mode.NONE -> {}
        }
    }

    fun stop() {
        if (!running) return
        running = false
        sm.unregisterListener(this)
    }

    /** 북 기준 방위. 아직 모르면 null */
    fun heading(): Float? {
        val y = yaw ?: return null
        return when (mode) {
            Mode.ABSOLUTE -> y
            Mode.RELATIVE_MAG, Mode.RELATIVE -> if (calibrated) norm(y + offset) else null
            Mode.NONE -> null
        }
    }

    /**
     * RELATIVE 전용: 걷는 중(경로 위, 직전 보정 위치에서 3m+ 이동) 경로 진행 방향으로 0°를 맞춘다.
     * 서서 두리번거릴 때는 부르지 않는다. 처음 한 번은 바로, 이후는 10%씩.
     */
    fun calibrateFromRoute(routeHeading: Float) {
        if (mode != Mode.RELATIVE) return
        nudge(routeHeading, rate = 0.1f)
    }

    /** 메뉴 "방향 다시 맞추기": 0° 보정을 버린다. 다음 지자기 값(RELATIVE_MAG) 또는 걷기 시작(RELATIVE)에 바로 다시 맞춘다 */
    fun reset() {
        calibrated = false
        offset = 0f
    }

    private fun nudge(trueHeading: Float, rate: Float) {
        val y = yaw ?: return
        val target = norm(trueHeading - y)
        if (!calibrated) {
            offset = target
            calibrated = true
            onChange?.invoke()
            return
        }
        val d = ((target - offset + 540f) % 360f) - 180f
        offset = norm(offset + d * rate)
        if (abs(d * rate) >= 0.5f) onChange?.invoke()
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_ROTATION_VECTOR, Sensor.TYPE_GAME_ROTATION_VECTOR -> {
                SensorManager.getRotationMatrixFromVector(rot, event.values)
                val deg = forwardHeading(rot) ?: return
                val prev = yaw
                if (prev == null) {
                    yaw = deg
                    onChange?.invoke()
                    return
                }
                val d = ((deg - prev + 540f) % 360f) - 180f
                if (abs(d) < 2f) return // 작은 떨림 무시
                yaw = norm(prev + d * 0.25f) // 부드럽게 (최단 방향)
                onChange?.invoke()
            }
            Sensor.TYPE_ACCELEROMETER -> {
                lowPass(event.values, gravity, haveGravity)
                haveGravity = true
            }
            Sensor.TYPE_MAGNETIC_FIELD -> {
                lowPass(event.values, geomag, haveGeomag)
                haveGeomag = true
                if (!haveGravity || !SensorManager.getRotationMatrix(magRot, null, gravity, geomag)) return
                val north = forwardHeading(magRot) ?: return
                // 지자기는 건물·차량 근처에서 흔들리므로 아주 천천히(2%) 0°를 맞춘다. 처음 한 번은 바로
                nudge(north, rate = 0.02f)
            }
        }
    }

    /** 회전 행렬(기기→세계 동·북·위)에서 기기 -Z(화면 너머 정면)의 수평 방위. 고개를 60°+ 숙이거나 들면 null */
    private fun forwardHeading(r: FloatArray): Float? {
        val east = -r[2]
        val north = -r[5]
        val up = -r[8]
        if (sqrt(east * east + north * north) < 0.5f || abs(up) > 0.87f) return null
        return norm(Math.toDegrees(atan2(east, north).toDouble()).toFloat())
    }

    private fun lowPass(input: FloatArray, out: FloatArray, have: Boolean) {
        for (i in 0..2) out[i] = if (have) out[i] + 0.2f * (input[i] - out[i]) else input[i]
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun norm(a: Float) = ((a % 360f) + 360f) % 360f

    companion object { private const val TAG = "Heading" }
}
