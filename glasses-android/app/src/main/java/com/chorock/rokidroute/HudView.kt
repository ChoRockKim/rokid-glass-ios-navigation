package com.chorock.rokidroute

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.View
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * 안경 화면. 480x282 논리 단위로 그리고, 실제 화면에 비율을 유지한 채 가장 크게 들어가도록 줄인다.
 * (0.2.0 까지는 480x282 dp 로 고정해 밀도>1 인 안경에서 화면 밖으로 넘쳤다. 다른 Rokid 앱들은 화면을 480x640 px 로 가정)
 * - 배경은 칠하지 않는다 (투과형 안경에서 검정 = 안 보임). 바깥 테두리도 없음 (0.3.11 부터).
 * - 미니맵: 나는 (240, 205), 1m = 0.75dp. [headingProvider] 가 방위를 주면 그 방향이 위, 아니면 경로 진행 방향이 위.
 */
class HudView(context: Context, private val headingProvider: () -> Float?) : View(context) {
    /**
     * R08 링(R08 Access Bridge) 지원.
     * 브리지는 접근성 서비스로 ① 포커스 후보 사이 이동 → ② 포커스된 요소 스크롤 → ③ 위아래 스와이프 주입 순으로 링 앞/뒤를 처리하고,
     * 탭은 포커스된 요소 클릭, 더블탭은 뒤로가기다 (Anezium/R08-Access-Bridge AccessibilityNavigator.java).
     * 그래서 이 뷰를 "포커스·클릭·앞뒤 스크롤 가능한 요소 하나"로 알리고, 스크롤 앞/뒤 = 다음/이전, 클릭 = 선택, 스와이프도 같은 뜻으로 받는다.
     */
    var onInput: ((MainActivity.Input) -> Unit)? = null

    private val swipe = android.view.GestureDetector(context, object : android.view.GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: android.view.MotionEvent) = true
        override fun onFling(e1: android.view.MotionEvent?, e2: android.view.MotionEvent, vx: Float, vy: Float): Boolean {
            if (abs(vy) < abs(vx)) return false
            onInput?.invoke(if (vy < 0) MainActivity.Input.NEXT else MainActivity.Input.PREV) // 위로 쓸기 = 앞으로
            return true
        }
        override fun onSingleTapUp(e: android.view.MotionEvent): Boolean { performClick(); return true }
    })

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        isClickable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        contentDescription = "길안내"
        setOnClickListener { onInput?.invoke(MainActivity.Input.SELECT) }
    }

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: android.view.MotionEvent): Boolean = swipe.onTouchEvent(event) || super.onTouchEvent(event)

    override fun onInitializeAccessibilityNodeInfo(info: android.view.accessibility.AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(info)
        info.isScrollable = true
        info.addAction(android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD)
        info.addAction(android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD)
    }

    override fun performAccessibilityAction(action: Int, arguments: android.os.Bundle?): Boolean = when (action) {
        android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> { onInput?.invoke(MainActivity.Input.NEXT); true }
        android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> { onInput?.invoke(MainActivity.Input.PREV); true }
        else -> super.performAccessibilityAction(action, arguments)
    }

    var state = HudState()
        set(value) {
            val old = field.pos
            field = value
            if (value.pos != null && value.pos != old) startGlide(old, value.pos)
            contentDescription = value.line1.ifEmpty { "길안내" }
            invalidate()
        }

    var pairCode: String? = null
        set(value) { field = value; invalidate() }

    /** 오른쪽 아래 기기 상태: 배터리 %(null 이면 모름), 충전 중, 네트워크 이름, 서버 연결 */
    data class Device(val battery: Int? = null, val charging: Boolean = false, val network: String = "", val server: Boolean = false)
    var device = Device()
        set(value) { field = value; invalidate() }

    /** 메인 화면(메뉴). null 이면 길안내 화면 */
    data class Menu(
        val items: List<String>,
        val selected: Int = 0,
        val note: String = "",
        /** 위 줄 (없으면 "길안내 · v버전") */
        val title: String? = null,
        val hint: String = "쓸기 이동 · 탭 선택 · 뒤로 앱 종료",
        /** 대중교통 후보면 카드로 그린다 (items 와 같은 순서) */
        val routes: List<RouteCard>? = null,
        /** "버스·지하철 시간" 화면이면 주변 정류장·역 보드 (null 이 아니면 items 대신 그린다) */
        val boards: List<Board>? = null,
        /** boards 를 받은 시각 (남은 시간 줄이기 기준) */
        val boardsAt: Long? = null,
    )

    /** 주변 정류장·역 하나 */
    data class Board(val kind: String, val name: String, val distance: Int?, val lines: List<StopBoard.Line>, val error: String?)

    /** 대중교통 후보 카드: 총 시간, 환승, 요금, 걷는 시간, 구간(도보·버스·지하철) */
    data class RouteCard(val minutes: Int, val transfers: Int, val fare: Int?, val walkMinutes: Int, val legs: List<Leg>) {
        data class Leg(val kind: String, val minutes: Int, val label: String, val board: String)

        companion object {
            fun fromJson(o: org.json.JSONObject): RouteCard {
                val legs = o.optJSONArray("legs") ?: org.json.JSONArray()
                return RouteCard(
                    o.optInt("minutes"), o.optInt("transfers"), if (o.isNull("fare")) null else o.optInt("fare"), o.optInt("walkMinutes"),
                    List(legs.length()) { i -> legs.getJSONObject(i).let { Leg(it.optString("kind"), it.optInt("minutes"), it.optString("label"), it.optString("board")) } },
                )
            }
        }
    }
    var menu: Menu? = null
        set(value) { field = value; invalidate() }

    /** 지도 표시: 자동(회전까지 멀거나 타고 가는 중이면 도로·건물을 흐리게) / 항상 / 끄기(글자만) */
    enum class MapMode(val label: String) { AUTO("자동"), ALWAYS("항상"), OFF("끄기") }
    var mapMode = MapMode.AUTO
        set(value) { field = value; invalidate() }

    /** 길안내 화면 모양 (지도 화면에서 탭하면 바뀜): 전체 지도 / 왼쪽에 작은 경로만 + 오른쪽 글자 */
    enum class ViewStyle { FULL, COMPACT }
    var viewStyle = ViewStyle.FULL
        set(value) { field = value; invalidate() }

    /** 서버에 올라온 새 버전 이름 (오른쪽 아래 작은 표시). 없으면 null */
    var update: String? = null
        set(value) { field = value; invalidate() }

    /** 잠깐 보여 줄 알림 (왼쪽 아래). 예: "다시 찾음 · 320m" */
    var notice: String? = null
        set(value) { field = value; invalidate() }

    /** 서버 연결이 끊긴 시각 (연결돼 있으면 null). 길안내 화면 오른쪽 위에 "연결 끊김 · 15초" */
    var offlineSince: Long? = null
        set(value) { field = value; invalidate() }

    /** Wi-Fi 가 아직 안 붙었을 때 왼쪽 아래 문구 ("Wi-Fi 켜는 중…" 등). 붙어 있으면 null */
    var wifiNote: String? = null
        set(value) { field = value; invalidate() }

    /** Wi-Fi 를 켜는·기다리는 중이면 가운데 작은 모달 (제목, 설명). 붙으면 null */
    /** level: 0~1 이면 아래에 마이크 음량 막대 (말해서 찾기) */
    data class WifiModal(val title: String, val detail: String, val level: Float? = null)
    var wifiModal: WifiModal? = null
        set(value) { field = value; invalidate() }

    /** 말해서 찾기: 듣는 중·알아듣는 중 모달 (Wi-Fi 모달보다 위) */
    var voiceModal: WifiModal? = null
        set(value) { field = value; invalidate() }

    /** 시계 (테스트에서 바꿈) */
    var clock: () -> Long = System::currentTimeMillis

    /** 실기 확인용 한 줄 (왼쪽 아래) */
    var debug: String? = null
        set(value) { field = value; invalidate() }

    private val green = Color.parseColor("#00ff66")
    private val dim = Color.parseColor("#4da86c")
    private val road = Color.parseColor("#2b7a45")

    private val small = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = dim; textSize = 13f; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    private val tiny = TextPaint(small).apply { textSize = 12f }
    private val big = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = green; textSize = 22f; typeface = Typeface.DEFAULT_BOLD; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    private val mid = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = green; textSize = 17f; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    private val pathColor = Color.parseColor("#3a9a5c")
    private fun stroke(c: Int, w: Float, a: Int, dash: FloatArray? = null) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; color = c; alpha = a; strokeWidth = w; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
        if (dash != null) pathEffect = DashPathEffect(dash, 0f)
    }
    // 도로가 주인공: 큰길·일반 도로는 양쪽 가장자리 선(케이싱) + 속은 아주 얕게. 교차로에서 선이 이어지도록
    // 모든 가장자리를 먼저 그리고 그 위에 검정(안경에서는 투명)으로 속을 지운다. 서버 /viewer 와 같은 값
    private class Band(val edge: Paint, val hole: Paint, val fill: Paint)
    private fun band(w: Float, edgeA: Int, fillA: Int) = Band(
        stroke(dim, w + 2.4f, edgeA),
        stroke(Color.BLACK, w, 255),
        stroke(green, w, fillA),
    )
    private val bands = linkedMapOf("road" to band(5f, 170, 18), "major" to band(8f, 215, 26))
    private val lineStyle = mapOf(
        "service" to stroke(dim, 1.4f, 150),
        "path" to stroke(pathColor, 1.2f, 204, floatArrayOf(2f, 3f)),
        "rail" to stroke(pathColor, 1f, 153, floatArrayOf(6f, 3f)),
    )
    // 간소 화면용 주변 도로: 종류별 굵기만 다른 흐린 선 하나
    private val simpleRoad = mapOf(
        "major" to stroke(dim, 2.4f, 180),
        "road" to stroke(dim, 1.5f, 145),
        "service" to stroke(dim, 0.9f, 100),
        "path" to stroke(pathColor, 0.9f, 130, floatArrayOf(1.5f, 2.5f)),
    )
    // 건물: 서버가 감싸는 직사각형으로 줄여 보낸다. 면 없이 아주 흐린 윤곽만 (도로가 지나가는 부분은 지워진다)
    private val bldgLine = stroke(road, 0.7f, 90)
    private val routePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = green; alpha = 140; strokeWidth = 4f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val ridePaint = Paint(routePaint).apply { strokeWidth = 4.5f; pathEffect = DashPathEffect(floatArrayOf(2f, 7f), 0f) }
    // 간소 화면 글자 (오른쪽 아래, 작게)
    private val smallBig = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 15f; typeface = Typeface.DEFAULT_BOLD; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    private val smallMid = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    private val updatePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = green; textSize = 12f; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    private val markStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = green; strokeWidth = 2f }
    private val meFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = green }

    companion object {
        const val W = 480f
        const val H = 282f
        private const val CX = 240f
        private const val CY = 205f
        private const val K = 0.75f
        private const val GLIDE_MS = 1500L
        /**
         * 지도를 그릴 자리: 화면 안 사각형, 카메라 점, 1m 당 크기, 내 표시 크기.
         * simple = 주변 도로를 가는 선 하나씩만 (건물 없음)
         */
        private data class Viewport(val left: Float, val top: Float, val right: Float, val bottom: Float, val cx: Float, val cy: Float, val k: Float, val simple: Boolean, val me: Float = 1f)
        private val FULL_VIEW = Viewport(1f, 1f, W - 1f, H - 1f, CX, CY, K, simple = false)
        /** 간소 화면: 왼쪽 150x150 에 기본 지도를 작게 (앞쪽 약 200m), 주변 도로는 가는 선만 */
        private val COMPACT_VIEW = Viewport(14f, 90f, 164f, 240f, 89f, 210f, 0.6f, simple = true, me = 0.85f)
        /** 간소 화면 글자 칸 왼쪽 끝 (오른쪽 정렬이라 실제 글자는 오른쪽 아래에 붙는다) */
        private const val COMPACT_TEXT_X = 176f

        /** 하차 알림 테두리를 깜빡이는 시간 */
        const val ALIGHT_PULSE_MS = 8_000L

        /** 자동 모드: 다음 회전까지 이보다 멀면 도로·건물을 흐리게 */
        const val FAINT_FROM_M = 80.0
        /** 실제 위치를 이보다 오래 못 받으면 "위치 N초 전" 표시 */
        const val STALE_MS = 30_000L

        /** 다음 정각 분까지 ms (+50ms 여유). 시각 표시는 분 단위라 그때만 다시 그린다 */
        fun untilNextMinute(now: Long): Long = 60_000 - now % 60_000 + 50

        fun ageText(ms: Long): String = if (ms < 60_000) "${ms / 1000}초 전" else "${ms / 60_000}분 전"
        fun clockText(epochMs: Long): String = java.text.SimpleDateFormat("HH:mm", java.util.Locale.KOREA).format(java.util.Date(epochMs))
    }

    /** 논리 단위 → 실제 픽셀 배율 (가로 480px 화면이면 1) */
    private var k = 1f

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val dm = resources.displayMetrics
        val availW = MeasureSpec.getSize(widthMeasureSpec).takeIf { it > 0 } ?: dm.widthPixels
        val availH = MeasureSpec.getSize(heightMeasureSpec).takeIf { it > 0 } ?: dm.heightPixels
        k = minOf(availW / W, availH / H)
        setMeasuredDimension((W * k).toInt(), (H * k).toInt())
    }

    // ── 위치를 부드럽게 이어 그리기 ──
    private var glideFrom: MapPos? = null
    private var glideTo: MapPos? = null
    private var glideStart = 0L

    private fun startGlide(from: MapPos?, to: MapPos) {
        if (from == null || abs(to.lat - from.lat) * 110_540 + abs(to.lon - from.lon) * 88_000 > 150) {
            glideFrom = null; glideTo = to; return
        }
        glideFrom = shownPos() ?: from
        glideTo = to
        glideStart = System.currentTimeMillis()
    }

    private fun shownPos(): MapPos? {
        val to = glideTo ?: return state.pos
        val from = glideFrom ?: return to
        val k = ((System.currentTimeMillis() - glideStart).toFloat() / GLIDE_MS).coerceIn(0f, 1f)
        val e = if (k < 0.5f) 2 * k * k else 1 - (-2 * k + 2) * (-2 * k + 2) / 2
        val dh = ((to.heading - from.heading + 540f) % 360f) - 180f
        if (k >= 1f) glideFrom = null
        return to.copy(
            lon = from.lon + (to.lon - from.lon) * e,
            lat = from.lat + (to.lat - from.lat) * e,
            heading = (from.heading + dh * e + 360f) % 360f,
        )
    }

    /** 그리다 오류가 나도 앱이 죽지 않게 (한 번만 기록) */
    private var drawErrorLogged = false

    override fun onDraw(canvas: Canvas) {
        val saved = canvas.saveCount
        try {
            drawAll(canvas)
        } catch (e: Exception) {
            canvas.restoreToCount(saved)
            if (!drawErrorLogged) {
                drawErrorLogged = true
                android.util.Log.w("Route", "draw failed", e)
                CrashLog.record("그리기 실패: ${android.util.Log.getStackTraceString(e).take(1500)}")
            }
        }
    }

    private fun drawAll(canvas: Canvas) {
        canvas.save()
        canvas.scale(k, k)

        menu?.let { m ->
            drawMenu(canvas, m)
            canvas.restore()
            if (m.boards == null) postInvalidateDelayed(untilNextMinute(clock())) // 오른쪽 아래 시각 (분이 바뀔 때만)
            return
        }

        val s = state
        val now = clock()
        val pos = shownPos()
        val sensor = headingProvider()
        val faint = mapMode == MapMode.AUTO && !s.warn && (s.riding || (s.remaining ?: 0.0) > FAINT_FROM_M)
        val compact = viewStyle == ViewStyle.COMPACT && pairCode == null && !s.idle
        if (pos != null && pairCode == null && mapMode != MapMode.OFF) {
            drawMap(canvas, pos, sensor ?: pos.heading, sensor != null, faint, if (compact) COMPACT_VIEW else FULL_VIEW)
        }

        // 위 줄: 진행 · 도착 예정 시각 / 목적지
        if (pairCode == null) {
            val top = if (s.progress.isNotEmpty() && s.etaAt != null) "${s.progress} · ${clockText(s.etaAt)} 도착" else s.progress
            canvas.drawText(top, 18f, 14f + 13f, small)
            val off = offlineSince
            if (s.cachedAt != null && !s.idle) {
                // 앱을 다시 켰는데 아직 서버와 연결 전: 캐시에서 되살린 마지막 화면
                val t = "저장된 화면 · ${ageText(now - s.cachedAt)}" + if (s.offlinePreview) " · 미리보기" else ""
                canvas.drawText(t, W - 18f - offlinePaint.measureText(t), 14f + 13f, offlinePaint)
            } else if (off != null && !s.idle) {
                // 연결이 끊겨도 화면은 그대로 두고 오른쪽 위에만 알린다 (일반 지도 앱의 오프라인 배너처럼)
                val t = "연결 끊김 · ${ageText(now - off).removeSuffix(" 전")}" + if (s.offlinePreview) " · 미리보기" else ""
                canvas.drawText(t, W - 18f - offlinePaint.measureText(t), 14f + 13f, offlinePaint)
            } else canvas.drawText(s.destination, W - 18f - small.measureText(s.destination), 14f + 13f, small)
        }

        // 하차 알림 (소리 없이): 화면 테두리. 처음 ALIGHT_PULSE_MS 동안 깜빡이고 그다음은 얇게 켜 둔다. 이번 정류장 = 흰색
        if (s.alight != null && pairCode == null) {
            val t = now - s.alightSince
            val pulsing = t in 0 until ALIGHT_PULSE_MS
            alightBorder.color = if (s.alight == "now") Color.WHITE else green
            alightBorder.strokeWidth = if (pulsing) 4f else 2f
            alightBorder.alpha = if (pulsing) (90 + 165 * abs(sin(t / 300.0 * Math.PI))).toInt() else 170
            canvas.drawRoundRect(RectF(2f, 2f, W - 2f, H - 2f), 10f, 10f, alightBorder)
            if (pulsing) postInvalidateDelayed(50)
        }

        // 안내 두 줄
        val line1 = pairCode?.let { "연결 코드 $it" } ?: s.line1At(now)
        val line2 = if (pairCode != null) "폰 단축어 \"안경 연결\"에 입력" else s.line2
        big.color = if ((s.warn || s.alight == "now") && pairCode == null) Color.WHITE else if (s.idle && pairCode == null) dim else green
        mid.color = if (s.idle && pairCode == null) dim else green
        if (compact && s.stop != null && (s.stop.mine.isNotEmpty() || s.stop.others.isNotEmpty() || s.stop.error != null)) {
            drawStopBoard(canvas, s.stop, now - s.stepAt)
        } else if (compact) {
            // 간소 화면: 오른쪽 아래에 작은 글자 (오른쪽 정렬, 아래 상태 줄 바로 위에서 끝나게)
            smallBig.color = big.color
            smallMid.color = mid.color
            val width = (W - 18f - COMPACT_TEXT_X).toInt()
            val l1 = layoutOf(line1, smallBig, width, 2, Layout.Alignment.ALIGN_OPPOSITE)
            val l2 = layoutOf(line2, smallMid, width, 2, Layout.Alignment.ALIGN_OPPOSITE)
            var y = H - 28f - (l2?.height ?: 0) - (l1?.height ?: 0) - (if (l1 != null && l2 != null) 3f else 0f)
            for (l in listOf(l1, l2)) {
                if (l == null) continue
                canvas.save(); canvas.translate(COMPACT_TEXT_X, y); l.draw(canvas); canvas.restore()
                y += l.height + 3f
            }
        } else {
            var y = 14f + 18f + 14f
            y += drawWrapped(canvas, line1, big, y, 2) + 6f
            drawWrapped(canvas, line2, mid, y, 2)
        }

        // 아래 줄
        val bottom = H - 10f
        // 왼쪽 아래: 알림 > 위치 끊김 > 출처. 위치 끊김은 길안내 중에만 (폰 Overland 가 멈췄는지 알 수 있게)
        val navigating = pairCode == null && s.progress.isNotEmpty()
        val stale = when {
            !navigating -> null
            s.lastFixAt == null -> "위치 없음"
            now - s.lastFixAt > STALE_MS -> "위치 ${ageText(now - s.lastFixAt)}"
            else -> null
        }
        val left = debug ?: notice ?: wifiNote ?: stale
        var leftEnd = 18f
        if (left != null) {
            val p = if (debug == null) small else tiny
            canvas.drawText(left, 18f, bottom, p)
            leftEnd += p.measureText(left)
        } else if (s.roads != null && pairCode == null && mapMode != MapMode.OFF) {
            canvas.drawText("© OpenStreetMap", 18f, bottom, tiny)
            leftEnd += tiny.measureText("© OpenStreetMap")
        }
        drawDeviceStatus(canvas, bottom, s.status, leftEnd + 12f)
        (voiceModal ?: wifiModal)?.let { drawWifiModal(canvas, it, now) }
        canvas.restore()

        // 위치가 미끄러지는 중이거나 센서 방향을 쓰면 계속 다시 그림. 길안내 중이면 1초마다 (위치 경과 시간 갱신)
        // 위치가 미끄러지는 동안만 매 프레임. 방향 센서는 바뀔 때 headingMoved() 로 (계속 60번씩 그리지 않음)
        // 배터리: 초 단위로 바뀌는 글자(연결 끊김 · N초, 위치 N초 전)가 있을 때만 1초마다.
        // 그 밖에는 분이 바뀔 때(시각·도착 시각), 버스 대기 중이면 10초마다, 위치가 오래돼 표시가 생길 때
        if (glideFrom != null) postInvalidateOnAnimation()
        else if (offlineSince != null || stale != null) postInvalidateDelayed(1000)
        else if (navigating && s.waiting != null) postInvalidateDelayed(10_000)
        else {
            val toStale = if (navigating) s.lastFixAt?.let { it + STALE_MS + 50 - now }?.takeIf { it > 0 } else null
            postInvalidateDelayed(minOf(untilNextMinute(now), toStale ?: Long.MAX_VALUE))
        }
    }

    /** 메인 화면: 제목·버전, 항목(선택된 것만 밝게, ▶ 표시), 아래 안내 문구 */
    private fun drawMenu(canvas: Canvas, m: Menu) {
        if (m.routes != null) return drawRouteCards(canvas, m, m.routes)
        if (m.boards != null) {
            postInvalidateDelayed(10_000) // 남은 시간 줄이기 (분 단위 표시라 10초면 충분)
            return drawBoards(canvas, m, m.boards)
        }
        canvas.drawText(m.title ?: "길안내 · v${BuildConfig.VERSION_NAME}", 18f, 14f + 13f, small)
        // 안내 글씨(17)로 27 간격, 한 화면에 7개까지. 더 많으면 선택한 항목이 보이게 넘기고 오른쪽에 ▲▼
        val visible = 7
        val first = (m.selected - visible + 1).coerceAtLeast(0).coerceAtMost((m.items.size - visible).coerceAtLeast(0))
        var y = 14f + 13f + 31f
        val top = y
        m.items.drop(first).take(visible).forEachIndexed { k, item ->
            val i = first + k
            val sel = i == m.selected
            mid.color = if (sel) green else dim
            mid.typeface = if (sel) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            // 대중교통 후보처럼 긴 항목은 한 줄로 자른다
            val text = TextUtils.ellipsize((if (sel) "▶ " else "   ") + item, mid, W - 56f, TextUtils.TruncateAt.END)
            canvas.drawText(text, 0, text.length, 18f, y, mid)
            y += 27f
        }
        if (first > 0) canvas.drawText("▲", W - 30f, top, small)
        if (first + visible < m.items.size) canvas.drawText("▼", W - 30f, y - 27f, small)
        mid.typeface = Typeface.DEFAULT
        if (m.note.isNotEmpty()) drawWrapped(canvas, m.note, small.let { TextPaint(it).apply { color = green; textSize = 15f } }, y - 14f, 1)
        val bottom = H - 10f
        canvas.drawText(m.hint, 18f, bottom, tiny)
        drawDeviceStatus(canvas, bottom, "")
    }

    /**
     * 대중교통 후보 (네이버 지도 앱처럼): 카드마다
     *   [12분]  환승 0 · 1,550원 · 도보 6분                  회기 승차
     *   [▬ 경의중앙선 (8분) ▬]··도보 6분··[▬ 273번 (5분) ▬]   ← 구간 시간 비율 막대. 버스 = 채운 막대, 지하철 = 테두리 막대, 도보 = 점선
     * 한 화면에 3장, 선택한 카드는 테두리. 글자가 칸보다 길면 자른다 (화면 밖으로 안 넘침)
     */
    private fun drawRouteCards(canvas: Canvas, m: Menu, cards: List<RouteCard>) {
        val title = TextUtils.ellipsize(m.title ?: "경로 선택", small, W - 60f, TextUtils.TruncateAt.END)
        canvas.drawText(title, 0, title.length, 18f, 14f + 13f, small)
        val visible = 3
        val cardH = 64f
        val first = (m.selected - visible + 1).coerceAtLeast(0).coerceAtMost((cards.size - visible).coerceAtLeast(0))
        val left = 18f
        val right = W - 18f
        var top = 38f
        cards.drop(first).take(visible).forEachIndexed { k, card ->
            val i = first + k
            val sel = i == m.selected
            if (sel) canvas.drawRoundRect(RectF(left - 4f, top - 2f, right + 4f, top + cardH - 6f), 8f, 8f, cardBorder)
            // 1줄: 총 시간(크게) + 환승·요금·도보(작게) + 첫 승차 정류장(오른쪽)
            cardTime.color = if (sel) green else dim
            val time = "${card.minutes}분"
            canvas.drawText(time, left + 4f, top + 22f, cardTime)
            var x = left + 4f + cardTime.measureText(time) + 10f
            val detail = listOfNotNull("환승 ${card.transfers}", card.fare?.let { "%,d원".format(it) }, if (card.walkMinutes > 0) "도보 ${card.walkMinutes}분" else null).joinToString(" · ")
            cardInfo.color = if (sel) green else dim
            canvas.drawText(detail, x, top + 21f, cardInfo)
            x += cardInfo.measureText(detail) + 12f
            card.legs.firstOrNull { it.kind != "walk" }?.let { ride ->
                val board = TextUtils.ellipsize("${ride.board} 승차", cardInfo, (right - 4f - x).coerceAtLeast(0f), TextUtils.TruncateAt.END)
                if (board.isNotEmpty()) canvas.drawText(board, 0, board.length, right - 4f - cardInfo.measureText(board, 0, board.length), top + 21f, cardInfo)
            }
            // 2줄: 구간 막대 (시간 비율, 짧은 구간도 보이게 최소 폭)
            val barTop = top + 31f
            val barH = 16f
            val total = card.legs.sumOf { it.minutes }.coerceAtLeast(1)
            val minW = 10f
            val avail = (right - 4f) - (left + 4f) - (card.legs.size - 1) * 3f
            // 도보도 "6분" 이 들어갈 만큼은 폭을 준다
            val widths = card.legs.map { (avail * it.minutes / total).coerceAtLeast(if (it.kind == "walk") 26f else minW * 2) }
            val scale = avail / widths.sum().coerceAtLeast(1f)
            var bx = left + 4f
            card.legs.forEachIndexed { j, leg ->
                val w = widths[j] * scale
                val r = RectF(bx, barTop, bx + w, barTop + barH)
                val alpha = if (sel) 255 else 150
                when (leg.kind) {
                    "walk" -> {
                        // 점선 가운데에 "도보 6분" (좁으면 "6분"), 글자 양옆만 점선
                        val dots = walkDots.apply { this.alpha = alpha }
                        walkLabel.color = if (sel) green else dim
                        val text = listOf("도보 ${leg.minutes}분", "${leg.minutes}분").firstOrNull { walkLabel.measureText(it) <= w - 6f }
                        val mid = barTop + barH / 2
                        if (text == null) canvas.drawLine(bx + 1f, mid, bx + w - 1f, mid, dots)
                        else {
                            val tw = walkLabel.measureText(text)
                            val tx = bx + (w - tw) / 2
                            if (tx - 3f > bx + 1f) canvas.drawLine(bx + 1f, mid, tx - 3f, mid, dots)
                            if (tx + tw + 3f < bx + w - 1f) canvas.drawLine(tx + tw + 3f, mid, bx + w - 1f, mid, dots)
                            canvas.drawText(text, tx, barTop + barH - 4f, walkLabel)
                        }
                    }
                    "bus" -> canvas.drawRoundRect(r, 4f, 4f, busFill.apply { this.alpha = if (sel) 230 else 120 })
                    else -> canvas.drawRoundRect(r, 4f, 4f, subwayLine.apply { this.alpha = alpha })
                }
                if (leg.kind != "walk" && w > 18f) {
                    val p = if (leg.kind == "bus") busLabel else subwayLabel.apply { color = if (sel) green else dim }
                    // "120번 (5분)". 칸이 좁으면 시간부터 빼고, 그래도 넘치면 노선 이름을 자른다
                    val full = "${leg.label} (${leg.minutes}분)"
                    val label = if (p.measureText(full) <= w - 8f) full else TextUtils.ellipsize(leg.label, p, w - 8f, TextUtils.TruncateAt.END)
                    val tw = p.measureText(label, 0, label.length)
                    canvas.drawText(label, 0, label.length, bx + (w - tw) / 2, barTop + barH - 4f, p)
                }
                bx += w + 3f
            }
            top += cardH + 2f
        }
        if (first > 0) canvas.drawText("▲", W - 30f, 14f + 13f, small)
        if (first + visible < cards.size) canvas.drawText("▼", W - 30f, H - 10f - 14f, small)
        val bottom = H - 10f
        canvas.drawText(m.hint, 18f, bottom, tiny)
        drawDeviceStatus(canvas, bottom, "")
    }

    /**
     * "버스·지하철 시간": 가까운 버스 정류장 / 지하철역을 나란히 (하나면 한 칸)
     *   [버스] 회기역 · 40m          [지하철] 회기역 · 30m
     *   1215번        곧 도착         1호선 청량리행   2역 전 · 7분
     *   273번       6분 · 12분        경의중앙선 문산행     곧 도착
     */
    private fun drawBoards(canvas: Canvas, m: Menu, boards: List<Board>) {
        canvas.drawText(m.title ?: "버스·지하철 시간", 18f, 14f + 13f, small)
        val bottom = H - 10f
        if (boards.isEmpty()) {
            drawWrapped(canvas, m.note.ifEmpty { "불러오는 중…" }, mid.apply { color = dim }, 60f, 3)
        } else {
            val gapX = 18f
            val colW = (W - 36f - gapX * (boards.size - 1)) / boards.size
            boards.take(2).forEachIndexed { c, b ->
                val left = 18f + c * (colW + gapX)
                val right = left + colW
                var y = 56f
                val head = TextUtils.ellipsize("${if (b.kind == "bus") "[버스]" else "[지하철]"} ${b.name}${b.distance?.let { " · ${it}m" } ?: ""}", boardHead, colW, TextUtils.TruncateAt.END)
                canvas.drawText(head, 0, head.length, left, y, boardHead)
                y += 22f
                if (b.error != null || b.lines.isEmpty()) {
                    val t = TextUtils.ellipsize(b.error ?: "도착 정보 없음", boardOther, colW, TextUtils.TruncateAt.END)
                    canvas.drawText(t, 0, t.length, left, y, boardOther)
                }
                val age = clock() - (m.boardsAt ?: clock())
                for (l in b.lines) {
                    if (y > bottom - 22f) break
                    val times = l.timesAt(age).joinToString(" · ")
                    val tw = boardLineTime.measureText(times)
                    canvas.drawText(times, right - tw, y, boardLineTime)
                    val label = if (b.kind == "bus" && l.line.isNotEmpty() && l.line.last().isDigit()) "${l.line}번" else l.line
                    val lt = TextUtils.ellipsize(label, boardLine, (colW - tw - 8f).coerceAtLeast(0f), TextUtils.TruncateAt.END)
                    canvas.drawText(lt, 0, lt.length, left, y, boardLine)
                    y += 18f
                }
            }
        }
        canvas.drawText(m.hint, 18f, bottom, tiny)
        drawDeviceStatus(canvas, bottom, "")
    }

    private val alightBorder = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val offlinePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f; color = Color.WHITE; alpha = 220; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    /** 가운데 작은 모달: 검정 판(안경에서 투명, 뒤 지도선만 가림) + 얇은 테두리 + 돌아가는 점 */
    private fun drawWifiModal(canvas: Canvas, m: WifiModal, now: Long) {
        val w = 300f; val h = 76f
        val r = RectF((W - w) / 2, (H - h) / 2 - 10f, (W + w) / 2, (H + h) / 2 - 10f)
        canvas.drawRoundRect(r, 10f, 10f, modalFill)
        canvas.drawRoundRect(r, 10f, 10f, modalBorder)
        // 진행 중 표시: 점 세 개가 차례로 밝아짐
        val k = ((now / 400) % 3).toInt()
        for (i in 0..2) {
            modalDot.alpha = if (i == k) 255 else 90
            canvas.drawCircle(r.left + 22f + i * 10f, r.top + 26f, 3f, modalDot)
        }
        val title = TextUtils.ellipsize(m.title, modalTitle, w - 70f, TextUtils.TruncateAt.END)
        canvas.drawText(title, 0, title.length, r.left + 56f, r.top + 31f, modalTitle)
        val l = layoutOf(m.detail, modalText, (w - 36f).toInt(), 2, Layout.Alignment.ALIGN_NORMAL)
        if (l != null) { canvas.save(); canvas.translate(r.left + 18f, r.top + 42f); l.draw(canvas); canvas.restore() }
        m.level?.let { lv ->
            // 마이크 음량: 아래 테두리 안쪽에 얇은 막대
            val x0 = r.left + 18f; val x1 = r.right - 18f; val y = r.bottom - 9f
            modalDot.alpha = 60
            canvas.drawRect(x0, y - 1.5f, x1, y + 1.5f, modalDot)
            modalDot.alpha = 255
            canvas.drawRect(x0, y - 1.5f, x0 + (x1 - x0) * lv.coerceIn(0f, 1f), y + 1.5f, modalDot)
        }
        postInvalidateDelayed(400)
    }

    private val modalFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = Color.BLACK }
    private val modalBorder = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f; color = green }
    private val modalDot = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = green }
    private val modalTitle = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 16f; typeface = Typeface.DEFAULT_BOLD; color = green }
    private val modalText = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f; color = dim }

    private val boardLine = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f; typeface = Typeface.DEFAULT_BOLD; color = green; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    private val boardLineTime = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f; color = green; setShadowLayer(3f, 0f, 0f, Color.BLACK) }

    private val cardBorder = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.2f; color = green }
    private val cardTime = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 20f; typeface = Typeface.DEFAULT_BOLD }
    private val cardInfo = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f }
    private val walkDots = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f; color = dim; strokeCap = Paint.Cap.ROUND; pathEffect = DashPathEffect(floatArrayOf(0.1f, 4f), 0f) }
    private val walkLabel = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f }
    private val busFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = green }
    private val subwayLine = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.6f; color = green }
    private val busLabel = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f; typeface = Typeface.DEFAULT_BOLD; color = Color.BLACK }
    private val subwayLabel = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f; typeface = Typeface.DEFAULT_BOLD }

    /** 오른쪽 아래: [연결 오류 문구]  Wi-Fi ●  ▭82% (오른쪽에서 왼쪽으로 쌓는다) */
    /** leftLimit: 이보다 왼쪽으로는 안 그린다 (왼쪽 아래 글자와 겹치지 않게 연결 상태 문구를 자른다) */
    private fun drawDeviceStatus(canvas: Canvas, baseline: Float, status: String, leftLimit: Float = 18f) {
        var x = W - 18f
        val dv = device
        // 오른쪽 끝부터: 배터리 → 네트워크 → 새 버전 → 연결 오류
        // 배터리: 테두리 + 남은 만큼 채움 + 꼭지, 오른쪽에 %
        dv.battery?.let { pct ->
            val label = "$pct%" + if (dv.charging) "+" else ""
            x -= tiny.measureText(label)
            canvas.drawText(label, x, baseline, tiny)
            x -= 4f
            val bw = 16f; val bh = 8f; val top = baseline - bh - 1f
            val body = RectF(x - bw - 2f, top, x - 2f, top + bh)
            val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1f; color = dim }
            val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = if (pct <= 15) Color.WHITE else dim }
            canvas.drawRoundRect(body, 1.5f, 1.5f, outline)
            canvas.drawRect(body.left + 1.5f, body.top + 1.5f, body.left + 1.5f + (bw - 3f) * pct / 100f, body.bottom - 1.5f, fill)
            canvas.drawRect(body.right, body.top + 2.5f, body.right + 2f, body.bottom - 2.5f, fill.apply { color = dim })
            x = body.left - 8f
        }
        // 네트워크 이름 + 서버 연결 점
        if (dv.network.isNotEmpty()) {
            val dot = if (dv.server) "●" else "○"
            val label = "${dv.network} $dot"
            x -= tiny.measureText(label)
            canvas.drawText(label, x, baseline, tiny)
            x -= 8f
        }
        // 현재 시각 (네트워크 왼쪽)
        val time = clockText(clock())
        x -= tiny.measureText(time)
        canvas.drawText(time, x, baseline, tiny)
        x -= 8f
        update?.let {
            val label = "새 버전 $it"
            x -= updatePaint.measureText(label)
            canvas.drawText(label, x, baseline, updatePaint)
            x -= 8f
        }
        if (status.isNotEmpty() && x - leftLimit > 20f) {
            val t = TextUtils.ellipsize(status, tiny, x - leftLimit, TextUtils.TruncateAt.END)
            canvas.drawText(t, 0, t.length, x - tiny.measureText(t, 0, t.length), baseline, tiny)
        }
    }

    /**
     * 간소 화면 + 탈 정류장 근처: 오른쪽 가운데에 정류장 보드 (세로 목록, 오른쪽 정렬, 시간은 오른쪽 끝에 맞춤)
     *                    [버스] 외대역앞
     *              273번   3분 · 10분     ← 내가 탈 노선: 조금 크고 굵게, 밝은 초록
     *                     1215번  곧 도착  ← 나머지: 작고 흐리게, 한 줄에 하나
     *                        120번  5분
     */
    private fun drawStopBoard(canvas: Canvas, b: StopBoard, ageMs: Long) {
        val right = W - 18f
        val width = right - COMPACT_TEXT_X
        val name = { l: String -> if (b.kind == "bus" && l.isNotEmpty() && l.last().isDigit()) "${l}번" else l }
        val headH = 17f; val mineH = 19f; val otherH = 16f; val gap = 4f
        val top = 40f; val bottom = H - 26f
        val mine = b.mine.take(3)
        val errorRow = if (b.error != null && mine.isEmpty() && b.others.isEmpty()) 1 else 0
        // 들어가는 만큼만 (위아래 줄과 겹치지 않게)
        val fixed = headH + mine.size * mineH + errorRow * otherH + (if (b.others.isNotEmpty()) gap else 0f)
        val others = b.others.take(((bottom - top - fixed) / otherH).toInt().coerceAtLeast(0))
        val total = fixed + others.size * otherH
        var y = top + ((bottom - top) - total) / 2   // 세로 가운데

        fun row(label: String, time: String, lp: TextPaint, tp: TextPaint, h: Float) {
            val baseline = y + h - 5f
            val tw = tp.measureText(time)
            canvas.drawText(time, right - tw, baseline, tp)
            val l = TextUtils.ellipsize(label, lp, (width - tw - 10f).coerceAtLeast(0f), TextUtils.TruncateAt.END)
            canvas.drawText(l, 0, l.length, right - tw - 10f - lp.measureText(l, 0, l.length), baseline, lp)
            y += h
        }

        val head = TextUtils.ellipsize("${if (b.kind == "bus") "[버스]" else "[지하철]"} ${b.name}", boardHead, width, TextUtils.TruncateAt.END)
        canvas.drawText(head, 0, head.length, right - boardHead.measureText(head, 0, head.length), y + headH - 5f, boardHead)
        y += headH
        if (errorRow == 1) row("", b.error ?: "", boardOther, boardOther, otherH)
        for (r in mine) row(name(r.line), r.timesAt(ageMs).joinToString(" · "), boardMine, boardMineTime, mineH)
        if (others.isNotEmpty()) y += gap
        for (r in others) row(name(r.line), r.timesAt(ageMs).firstOrNull() ?: "", boardOther, boardOther, otherH)
    }

    private val boardHead = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f; color = dim; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    private val boardMine = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 14f; typeface = Typeface.DEFAULT_BOLD; color = green; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    private val boardMineTime = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f; color = green; setShadowLayer(3f, 0f, 0f, Color.BLACK) }
    private val boardOther = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f; color = dim; alpha = 210; setShadowLayer(3f, 0f, 0f, Color.BLACK) }

    private fun layoutOf(text: String, paint: TextPaint, width: Int, maxLines: Int, align: Layout.Alignment): StaticLayout? =
        if (text.isEmpty()) null
        else StaticLayout.Builder.obtain(text, 0, text.length, paint, width)
            .setAlignment(align).setMaxLines(maxLines).setEllipsize(TextUtils.TruncateAt.END).build()

    private fun drawWrapped(canvas: Canvas, text: String, paint: TextPaint, top: Float, maxLines: Int, x: Float = 18f): Float {
        if (text.isEmpty()) return 0f
        val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, (W - 18f - x).toInt())
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setMaxLines(maxLines)
            .setEllipsize(TextUtils.TruncateAt.END)
            .build()
        canvas.save()
        canvas.translate(x, top)
        layout.draw(canvas)
        canvas.restore()
        return layout.height.toFloat()
    }

    /**
     * 지도 도형을 미터 단위로 한 번만 만들어 둔다 (도로·경로를 새로 받을 때만).
     * 그릴 때는 행렬 하나로 옮기고·돌리고·줄인다 → 방향이 바뀔 때마다 좌표 수천 개를 다시 계산하지 않음 (배터리·발열)
     */
    private class Geom(val roads: MapRoads?, val route: MapRoute?, val lon0: Double, val lat0: Double) {
        private val kx = cos(Math.toRadians(lat0)) * 111_320
        private val ky = 110_540.0
        fun mx(lon: Double) = ((lon - lon0) * kx).toFloat()
        fun my(lat: Double) = ((lat - lat0) * ky).toFloat()
        private fun path(points: List<DoubleArray>, close: Boolean = false) = Path().apply {
            points.forEachIndexed { i, p -> if (i == 0) moveTo(mx(p[0]), my(p[1])) else lineTo(mx(p[0]), my(p[1])) }
            if (close) close()
        }
        val buildings: List<Path> = roads?.buildings?.map { path(it, close = true) } ?: emptyList()
        /** 종류별 도로 (major · road · service · path · rail) */
        val roadsByKind: Map<String, List<Path>> = roads?.let { r ->
            val kinds = r.kinds.ifEmpty { r.major.map { if (it) "major" else "road" } }
            r.lines.indices.groupBy({ kinds.getOrNull(it) ?: "road" }, { path(r.lines[it]) })
        } ?: emptyMap()
        val routeSegs: List<Pair<String, Path>> = route?.segments?.map { it.kind to path(it.points) } ?: emptyList()
    }

    /**
     * 버스·지하철 정류장 점. 지금 단계의 정류장: 지난 것은 흐리게, 남은 것은 또렷하게.
     * 타고 있으면 다음에 설 정류장과 내릴 정류장 옆에 이름 (다른 단계 정류장은 작은 흐린 점만)
     */
    private fun drawStops(canvas: Canvas, r: MapRoute, v: Viewport, screen: (Double, Double) -> Pair<Float, Float>) {
        if (r.stops.isEmpty()) return
        val cur = state.index
        val mine = r.stops.filter { it.step == cur }
        val nextAt = state.nextStop?.let { n -> mine.indexOfFirst { it.name == n } } ?: -1
        val z = if (v.simple) 0.8f else 1f
        for (s in r.stops) {
            if (s.step == cur) continue
            val (x, y) = screen(s.lon, s.lat)
            stopDot.alpha = 70
            canvas.drawCircle(x, y, 2.2f * z, stopDot)
        }
        mine.forEachIndexed { i, s ->
            val (x, y) = screen(s.lon, s.lat)
            val passed = state.riding && nextAt >= 0 && i < nextAt
            stopDot.alpha = if (passed) 80 else 255
            canvas.drawCircle(x, y, 3.2f * z, stopFill)
            canvas.drawCircle(x, y, 3.2f * z, stopDot)
            val label = when {
                !state.riding -> null
                i == nextAt -> s.name
                i == mine.lastIndex -> "${s.name} (하차)"
                else -> null
            } ?: return@forEachIndexed
            stopLabel.textSize = if (v.simple) 10f else 11.5f
            stopLabel.alpha = if (i == nextAt) 255 else 170
            val t = TextUtils.ellipsize(label, stopLabel, if (v.simple) 90f else 130f, TextUtils.TruncateAt.END)
            canvas.drawText(t, 0, t.length, x + 6f * z, y + 4f, stopLabel)
        }
    }
    /** 정류장 점: 검정 속(경로선을 가림) + 초록 테두리 */
    private val stopFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = Color.BLACK }
    private val stopDot = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.6f; color = green }
    private val stopLabel = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = green; typeface = Typeface.DEFAULT_BOLD; setShadowLayer(3f, 0f, 0f, Color.BLACK) }

    private var geom: Geom? = null
    private val mat = android.graphics.Matrix()
    private val tmpPath = Path()
    private val pt = FloatArray(2)
    /** 마지막으로 그린 지도 방향 (방향이 1° 넘게 바뀌었을 때만 다시 그린다) */
    private var drawnHeading: Float? = null

    /** 방향 센서가 바뀌었다고 알려 올 때: 1° 넘게 달라졌으면 다시 그림 (MainActivity 가 초당 20번까지로 묶어 부른다) */
    fun headingMoved() {
        val h = headingProvider() ?: return
        val last = drawnHeading
        if (last == null || abs(((h - last + 540f) % 360f) - 180f) >= 1f) invalidate()
    }

    /**
     * faint: 도로·건물을 흐리게 (경로선·내 위치는 그대로).
     * 카메라는 내 위치, 다른 단계를 미리 보는 중이면(pos.focus) 그 단계 시작점. "나"는 항상 실제 위치에 (추정 위치면 안 그림).
     */
    private fun drawMap(canvas: Canvas, pos: MapPos, heading: Float, fromSensor: Boolean, faint: Boolean, v: Viewport) {
        val camLon = pos.focus?.get(0) ?: pos.lon
        val camLat = pos.focus?.get(1) ?: pos.lat
        val g = geom?.takeIf { it.roads === state.roads && it.route === state.route }
            ?: Geom(state.roads, state.route, camLon, camLat).also { geom = it }
        // 미터 좌표 → 화면: 카메라를 원점으로, 방향만큼 돌리고, 1m 당 v.k 로 줄이고(위가 +), 카메라 점으로
        mat.setTranslate(-g.mx(camLon), -g.my(camLat))
        mat.postRotate(heading)
        mat.postScale(v.k, -v.k)
        mat.postTranslate(v.cx, v.cy)
        drawnHeading = heading
        fun draw(p: Path, paint: Paint) {
            p.transform(mat, tmpPath)
            canvas.drawPath(tmpPath, paint)
        }
        fun screen(lon: Double, lat: Double): Pair<Float, Float> {
            pt[0] = g.mx(lon); pt[1] = g.my(lat)
            mat.mapPoints(pt)
            return pt[0] to pt[1]
        }

        canvas.save()
        canvas.clipRect(v.left, v.top, v.right, v.bottom)
        if (state.roads != null) {
            if (v.simple) {
                if (faint) canvas.saveLayerAlpha(v.left, v.top, v.right, v.bottom, 110)
                for (k in listOf("service", "path", "road", "major")) g.roadsByKind[k]?.forEach { draw(it, simpleRoad.getValue(k)) }
                if (faint) canvas.restore()
            } else {
                if (faint) canvas.saveLayerAlpha(0f, 0f, W, H, 70)
                for (b in g.buildings) draw(b, bldgLine)
                fun each(k: String, paint: Paint) = g.roadsByKind[k]?.forEach { draw(it, paint) }
                each("service", lineStyle.getValue("service"))
                for ((k, b) in bands) each(k, b.edge)
                for ((k, b) in bands) each(k, b.hole)
                for ((k, b) in bands) each(k, b.fill)
                each("path", lineStyle.getValue("path"))
                each("rail", lineStyle.getValue("rail"))
                if (faint) canvas.restore()
            }
        }
        state.route?.let { r ->
            for ((kind, p) in g.routeSegs) draw(p, if (kind == "walk") routePaint else ridePaint)
            drawStops(canvas, r, v, ::screen)
            val n = pos.next
            if (n != null && n < r.turns.size) {
                val (x, y) = screen(r.turns[n][0], r.turns[n][1])
                canvas.save(); canvas.rotate(45f, x, y)
                canvas.drawRect(x - 5f, y - 5f, x + 5f, y + 5f, markStroke)
                canvas.restore()
            }
        }
        // 나: 위를 향한 삼각형 (실제 위치). 경로를 벗어났으면 속이 빈 삼각형
        if (!pos.estimated) {
            val (mx, my) = screen(pos.lon, pos.lat)
            val z = v.me
            tmpPath.reset()
            tmpPath.moveTo(mx, my - 11f * z); tmpPath.lineTo(mx - 7f * z, my + 7f * z); tmpPath.lineTo(mx, my + 3f * z); tmpPath.lineTo(mx + 7f * z, my + 7f * z); tmpPath.close()
            canvas.drawPath(tmpPath, if (pos.snapped) meFill else markStroke)
        }
        canvas.restore()
    }
}
