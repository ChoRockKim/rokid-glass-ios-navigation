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
    var state = HudState()
        set(value) {
            val old = field.pos
            field = value
            if (value.pos != null && value.pos != old) startGlide(old, value.pos)
            invalidate()
        }

    var pairCode: String? = null
        set(value) { field = value; invalidate() }

    /** 오른쪽 아래 기기 상태: 배터리 %(null 이면 모름), 충전 중, 네트워크 이름, 서버 연결 */
    data class Device(val battery: Int? = null, val charging: Boolean = false, val network: String = "", val server: Boolean = false)
    var device = Device()
        set(value) { field = value; invalidate() }

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
    // 도로: 종류별 굵기의 아주 얕은 띠 (투과형 안경에서 칠한 면이 넓으면 앞을 가리므로 최소한으로)
    // 보행로·철도: 점선. 서버 /viewer 와 같은 값
    private val roadStyle = mapOf(
        "major" to stroke(green, 7f, 51),
        "road" to stroke(green, 4.5f, 38),
        "service" to stroke(green, 2.5f, 31),
        "path" to stroke(pathColor, 1.2f, 204, floatArrayOf(2f, 3f)),
        "rail" to stroke(pathColor, 1f, 153, floatArrayOf(6f, 3f)),
    )
    private val roadOrder = listOf("service", "road", "major", "path", "rail")
    // 건물: 아주 흐린 면 + 얇은 윤곽
    private val bldgFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = green; alpha = 8 }
    private val bldgLine = stroke(road, 0.8f, 115)
    private val routePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = green; alpha = 140; strokeWidth = 4f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val ridePaint = Paint(routePaint).apply { strokeWidth = 4.5f; pathEffect = DashPathEffect(floatArrayOf(2f, 7f), 0f) }
    private val markStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = green; strokeWidth = 2f }
    private val meFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = green }

    companion object {
        const val W = 480f
        const val H = 282f
        private const val CX = 240f
        private const val CY = 205f
        private const val K = 0.75f
        private const val GLIDE_MS = 1500L
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

        val pos = shownPos()
        val sensor = headingProvider()
        if (pos != null && pairCode == null) drawMap(canvas, pos, sensor ?: pos.heading, sensor != null)

        // 위 줄
        val s = state
        if (pairCode == null) {
            canvas.drawText(s.progress, 18f, 14f + 13f, small)
            canvas.drawText(s.destination, W - 18f - small.measureText(s.destination), 14f + 13f, small)
        }

        // 안내 두 줄
        val line1 = pairCode?.let { "연결 코드 $it" } ?: s.line1
        val line2 = if (pairCode != null) "폰 단축어 \"안경 연결\"에 입력" else s.line2
        big.color = if (s.warn && pairCode == null) Color.WHITE else if (s.idle && pairCode == null) dim else green
        mid.color = if (s.idle && pairCode == null) dim else green
        var y = 14f + 18f + 14f
        y += drawWrapped(canvas, line1, big, y, 2) + 6f
        drawWrapped(canvas, line2, mid, y, 2)

        // 아래 줄
        val bottom = H - 10f
        val left = debug ?: if (s.roads != null && pairCode == null) "© OpenStreetMap" else ""
        canvas.drawText(left, 18f, bottom, tiny)
        drawDeviceStatus(canvas, bottom, s.status)
        canvas.restore()

        // 위치가 미끄러지는 중이거나 센서 방향을 쓰면 계속 다시 그림
        if (glideFrom != null || (sensor != null && pos != null)) postInvalidateOnAnimation()
    }

    /** 오른쪽 아래: [연결 오류 문구]  Wi-Fi ●  ▭82% (오른쪽에서 왼쪽으로 쌓는다) */
    private fun drawDeviceStatus(canvas: Canvas, baseline: Float, status: String) {
        var x = W - 18f
        val dv = device
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
        if (status.isNotEmpty()) canvas.drawText(status, x - tiny.measureText(status), baseline, tiny)
    }

    private fun drawWrapped(canvas: Canvas, text: String, paint: TextPaint, top: Float, maxLines: Int): Float {
        if (text.isEmpty()) return 0f
        val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, (W - 36f).toInt())
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setMaxLines(maxLines)
            .setEllipsize(TextUtils.TruncateAt.END)
            .build()
        canvas.save()
        canvas.translate(18f, top)
        layout.draw(canvas)
        canvas.restore()
        return layout.height.toFloat()
    }

    private fun drawMap(canvas: Canvas, pos: MapPos, heading: Float, fromSensor: Boolean) {
        val lat0 = Math.toRadians(pos.lat)
        val kx = cos(lat0) * 111_320
        val ky = 110_540.0
        val h = Math.toRadians(heading.toDouble())
        val c = cos(h); val sn = sin(h)
        fun px(p: DoubleArray): Pair<Float, Float> {
            val dx = (p[0] - pos.lon) * kx
            val dy = (p[1] - pos.lat) * ky
            val x = dx * c - dy * sn
            val yy = dx * sn + dy * c
            return Pair((CX + x * K).toFloat(), (CY - yy * K).toFloat())
        }
        fun path(points: List<DoubleArray>): Path {
            val p = Path()
            points.forEachIndexed { i, pt -> val (x, y) = px(pt); if (i == 0) p.moveTo(x, y) else p.lineTo(x, y) }
            return p
        }

        canvas.save()
        canvas.clipRect(1f, 1f, W - 1f, H - 1f)
        state.roads?.let { r ->
            for (b in r.buildings) {
                val p = path(b).apply { close() }
                canvas.drawPath(p, bldgFill)
                canvas.drawPath(p, bldgLine)
            }
            val kinds = r.kinds.ifEmpty { r.major.map { if (it) "major" else "road" } }
            for (k in roadOrder) {
                val paint = roadStyle.getValue(k)
                r.lines.forEachIndexed { i, line -> if (kinds.getOrNull(i) == k) canvas.drawPath(path(line), paint) }
            }
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
        // 나: 위를 향한 삼각형. 경로를 벗어났으면 속이 빈 삼각형
        val me = Path().apply {
            moveTo(CX, CY - 11f); lineTo(CX - 7f, CY + 7f); lineTo(CX, CY + 3f); lineTo(CX + 7f, CY + 7f); close()
        }
        canvas.drawPath(me, if (pos.snapped) meFill else markStroke)
        canvas.restore()
    }
}
