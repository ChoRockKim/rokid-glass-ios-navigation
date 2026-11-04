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
 * - 배경은 칠하지 않는다 (투과형 안경에서 검정 = 안 보임). 얇은 테두리만.
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
    )

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

    /** 시계 (테스트에서 바꿈) */
    var clock: () -> Long = System::currentTimeMillis

    /** 실기 확인용 한 줄 (왼쪽 아래) */
    var debug: String? = null
        set(value) { field = value; invalidate() }

    private val green = Color.parseColor("#00ff66")
    private val dim = Color.parseColor("#4da86c")
    private val road = Color.parseColor("#2b7a45")

    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1f; color = dim }
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
        "major" to stroke(dim, 1.8f, 170),
        "road" to stroke(dim, 1.1f, 130),
        "service" to stroke(dim, 0.7f, 90),
        "path" to stroke(pathColor, 0.7f, 120, floatArrayOf(1.5f, 2.5f)),
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
        /** 간소 화면: 왼쪽 150x150 에 기본 지도를 작게 (앞쪽 약 300m), 주변 도로는 가는 선만 */
        private val COMPACT_VIEW = Viewport(14f, 90f, 164f, 240f, 89f, 212f, 0.4f, simple = true, me = 0.8f)
        /** 간소 화면 글자 칸 왼쪽 끝 (오른쪽 정렬이라 실제 글자는 오른쪽 아래에 붙는다) */
        private const val COMPACT_TEXT_X = 176f

        /** 자동 모드: 다음 회전까지 이보다 멀면 도로·건물을 흐리게 */
        const val FAINT_FROM_M = 80.0
        /** 실제 위치를 이보다 오래 못 받으면 "위치 N초 전" 표시 */
        const val STALE_MS = 30_000L

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

    override fun onDraw(canvas: Canvas) {
        canvas.save()
        canvas.scale(k, k)
        canvas.drawRoundRect(RectF(0.5f, 0.5f, W - 0.5f, H - 0.5f), 12f, 12f, border)

        menu?.let { m ->
            drawMenu(canvas, m)
            canvas.restore()
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
            canvas.drawText(s.destination, W - 18f - small.measureText(s.destination), 14f + 13f, small)
        }

        // 안내 두 줄
        val line1 = pairCode?.let { "연결 코드 $it" } ?: s.line1
        val line2 = if (pairCode != null) "폰 단축어 \"안경 연결\"에 입력" else s.line2
        big.color = if (s.warn && pairCode == null) Color.WHITE else if (s.idle && pairCode == null) dim else green
        mid.color = if (s.idle && pairCode == null) dim else green
        if (compact) {
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
        val left = debug ?: notice ?: stale
        if (left != null) canvas.drawText(left, 18f, bottom, if (debug == null) small else tiny)
        else if (s.roads != null && pairCode == null && mapMode != MapMode.OFF) canvas.drawText("© OpenStreetMap", 18f, bottom, tiny)
        drawDeviceStatus(canvas, bottom, s.status)
        canvas.restore()

        // 위치가 미끄러지는 중이거나 센서 방향을 쓰면 계속 다시 그림. 길안내 중이면 1초마다 (위치 경과 시간 갱신)
        if (glideFrom != null || (sensor != null && pos != null && mapMode != MapMode.OFF)) postInvalidateOnAnimation()
        else if (navigating) postInvalidateDelayed(1000)
    }

    /** 메인 화면: 제목·버전, 항목(선택된 것만 밝게, ▶ 표시), 아래 안내 문구 */
    private fun drawMenu(canvas: Canvas, m: Menu) {
        if (m.routes != null) return drawRouteCards(canvas, m, m.routes)
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
     *   [▬ 경의중앙선 (8분) ▬]·····[▬ 273번 (5분) ▬]   ← 구간 시간 비율 막대. 버스 = 채운 막대, 지하철 = 테두리 막대, 도보 = 점선
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
            val widths = card.legs.map { (avail * it.minutes / total).coerceAtLeast(if (it.kind == "walk") 6f else minW * 2) }
            val scale = avail / widths.sum().coerceAtLeast(1f)
            var bx = left + 4f
            card.legs.forEachIndexed { j, leg ->
                val w = widths[j] * scale
                val r = RectF(bx, barTop, bx + w, barTop + barH)
                val alpha = if (sel) 255 else 150
                when (leg.kind) {
                    "walk" -> canvas.drawLine(bx + 1f, barTop + barH / 2, bx + w - 1f, barTop + barH / 2, walkDots.apply { this.alpha = alpha })
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

    private val cardBorder = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.2f; color = green }
    private val cardTime = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 20f; typeface = Typeface.DEFAULT_BOLD }
    private val cardInfo = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f }
    private val walkDots = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f; color = dim; strokeCap = Paint.Cap.ROUND; pathEffect = DashPathEffect(floatArrayOf(0.1f, 4f), 0f) }
    private val busFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = green }
    private val subwayLine = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.6f; color = green }
    private val busLabel = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f; typeface = Typeface.DEFAULT_BOLD; color = Color.BLACK }
    private val subwayLabel = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f; typeface = Typeface.DEFAULT_BOLD }

    /** 오른쪽 아래: [연결 오류 문구]  Wi-Fi ●  ▭82% (오른쪽에서 왼쪽으로 쌓는다) */
    private fun drawDeviceStatus(canvas: Canvas, baseline: Float, status: String) {
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
        update?.let {
            val label = "새 버전 $it"
            x -= updatePaint.measureText(label)
            canvas.drawText(label, x, baseline, updatePaint)
            x -= 8f
        }
        if (status.isNotEmpty()) canvas.drawText(status, x - tiny.measureText(status), baseline, tiny)
    }

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
     * faint: 도로·건물을 흐리게 (경로선·내 위치는 그대로).
     * 카메라는 내 위치, 다른 단계를 미리 보는 중이면(pos.focus) 그 단계 시작점. "나"는 항상 실제 위치에 (추정 위치면 안 그림).
     */
    private fun drawMap(canvas: Canvas, pos: MapPos, heading: Float, fromSensor: Boolean, faint: Boolean, v: Viewport) {
        val camLon = pos.focus?.get(0) ?: pos.lon
        val camLat = pos.focus?.get(1) ?: pos.lat
        val lat0 = Math.toRadians(camLat)
        val kx = cos(lat0) * 111_320
        val ky = 110_540.0
        val h = Math.toRadians(heading.toDouble())
        val c = cos(h); val sn = sin(h)
        fun px(p: DoubleArray): Pair<Float, Float> {
            val dx = (p[0] - camLon) * kx
            val dy = (p[1] - camLat) * ky
            val x = dx * c - dy * sn
            val yy = dx * sn + dy * c
            return Pair((v.cx + x * v.k).toFloat(), (v.cy - yy * v.k).toFloat())
        }
        fun path(points: List<DoubleArray>): Path {
            val p = Path()
            points.forEachIndexed { i, pt -> val (x, y) = px(pt); if (i == 0) p.moveTo(x, y) else p.lineTo(x, y) }
            return p
        }

        canvas.save()
        canvas.clipRect(v.left, v.top, v.right, v.bottom)
        if (v.simple) state.roads?.let { r ->
            if (faint) canvas.saveLayerAlpha(v.left, v.top, v.right, v.bottom, 110)
            val kinds = r.kinds.ifEmpty { r.major.map { if (it) "major" else "road" } }
            for (k in listOf("service", "path", "road", "major")) {
                val paint = simpleRoad.getValue(k)
                r.lines.forEachIndexed { i, line -> if (kinds.getOrNull(i) == k) canvas.drawPath(path(line), paint) }
            }
            if (faint) canvas.restore()
        } else state.roads?.let { r ->
            if (faint) canvas.saveLayerAlpha(0f, 0f, W, H, 70)
            for (b in r.buildings) canvas.drawPath(path(b).apply { close() }, bldgLine)
            val kinds = r.kinds.ifEmpty { r.major.map { if (it) "major" else "road" } }
            val paths = r.lines.map { path(it) }
            fun each(k: String, paint: Paint) = paths.forEachIndexed { i, p -> if (kinds.getOrNull(i) == k) canvas.drawPath(p, paint) }
            each("service", lineStyle.getValue("service"))
            for ((k, b) in bands) each(k, b.edge)
            for ((k, b) in bands) each(k, b.hole)
            for ((k, b) in bands) each(k, b.fill)
            each("path", lineStyle.getValue("path"))
            each("rail", lineStyle.getValue("rail"))
            if (faint) canvas.restore()
        }
        state.route?.let { r ->
            for (seg in r.segments) canvas.drawPath(path(seg.points), if (seg.kind == "walk") routePaint else ridePaint)
            val n = pos.next
            if (n != null && n < r.turns.size) {
                val (x, y) = px(r.turns[n])
                canvas.save(); canvas.rotate(45f, x, y)
                canvas.drawRect(x - 5f, y - 5f, x + 5f, y + 5f, markStroke)
                canvas.restore()
            }
        }
        // 나: 위를 향한 삼각형 (실제 위치). 경로를 벗어났으면 속이 빈 삼각형
        if (!pos.estimated) {
            val (mx, my) = px(doubleArrayOf(pos.lon, pos.lat))
            val z = v.me
            val me = Path().apply {
                moveTo(mx, my - 11f * z); lineTo(mx - 7f * z, my + 7f * z); lineTo(mx, my + 3f * z); lineTo(mx + 7f * z, my + 7f * z); close()
            }
            canvas.drawPath(me, if (pos.snapped) meFill else markStroke)
        }
        canvas.restore()
    }
}
