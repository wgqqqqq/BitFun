package com.openbitfun.mobile.app.ui.remote

import com.openbitfun.mobile.core.feature.remotedesktop.*
import kotlin.math.hypot

/** Native direct-touch classification. No timers, Android APIs, account IO or wire state.
 * Every remote gesture keeps its starting authority; local zoom never grants one. */
internal class RemoteDesktopGesturePolicy(
    private val slop: Double,
    private val doubleTapSlop: Double,
    private val longPressMs: Long,
    private val doubleTapMs: Long,
    private val density: Double,
    private val emit: (RemoteDesktopControlIntent) -> Unit,
    private val transformed: (Transform) -> Unit,
) {
    data class Point(val id: Int, val x: Double, val y: Double)
    data class Transform(val scale: Double = 1.0, val x: Double = 0.0, val y: Double = 0.0)
    private enum class Kind { PENDING, DRAG, WHEEL, PINCH, WAIT }
    private data class Single(val start: Point, var last: Point, val at: Long,
        val authority: RemoteDesktopControlUiState?, val second: Boolean, var kind: Kind = Kind.PENDING)
    private data class Two(val ids: Pair<Int, Int>, val center: Point, val distance: Double,
        val initial: Transform, val authority: RemoteDesktopControlUiState?, var previous: Point = center, var kind: Kind = Kind.PENDING)
    private data class Tap(val at: Long, val point: Point, val authority: RemoteDesktopControlUiState)
    private var single: Single? = null
    private var two: Two? = null
    private var lastTap: Tap? = null
    private var width = 0.0
    private var height = 0.0
    private var videoWidth = 0
    private var videoHeight = 0
    var transform = Transform()
        private set
    val deadline: Long? get() = single?.takeIf { it.kind == Kind.PENDING }?.let { it.at + longPressMs }

    fun configure(w: Int, h: Int, vw: Int, vh: Int, resetZoom: Boolean = false) {
        if (width != w.toDouble() || height != h.toDouble() || videoWidth != vw || videoHeight != vh || resetZoom) cancel()
        width = w.toDouble(); height = h.toDouble(); videoWidth = vw; videoHeight = vh
        if (resetZoom) update(Transform()) else update(transform)
    }

    fun down(points: List<Point>, at: Long, authority: RemoteDesktopControlUiState?) {
        if (points.any { !it.x.isFinite() || !it.y.isFinite() } || points.size !in 1..2) { cancel(); return }
        if (points.size == 1) {
            cancel(keepTap = true)
            val p = points.single()
            if (!inside(p)) return
            val previous = lastTap
            val second = previous != null && previous.authority == authority && at >= previous.at
                && at - previous.at <= doubleTapMs && distance(previous.point, p) <= doubleTapSlop
            single = Single(p, p, at, authority, second)
            lastTap = null
        } else {
            // A second finger must never leave a remote button held. The release
            // may synchronously retire this authority; subsequent wheel input is fenced.
            cancel()
            if (points.all(::inside)) two = Two(points[0].id to points[1].id, center(points), distance(points[0], points[1]), transform, authority)
        }
    }

    fun move(points: List<Point>) {
        val one = single
        if (one != null) {
            val p = points.singleOrNull()?.takeIf { it.id == one.start.id } ?: run { cancel(); return }
            if (!p.x.isFinite() || !p.y.isFinite()) { cancel(); return }
            one.last = p
            if (one.kind == Kind.PENDING && distance(one.start, p) > slop) {
                if (one.second && one.authority != null) {
                    button(one, one.start, true); one.kind = Kind.DRAG
                } else one.kind = Kind.WAIT
            }
            if (one.kind == Kind.DRAG) projected(one.authority, p, true)?.let { emit(it) }
            return
        }
        val pair = two ?: return
        if (points.size != 2 || points.map { it.id }.toSet() != setOf(pair.ids.first, pair.ids.second)
            || points.any { !it.x.isFinite() || !it.y.isFinite() }) { cancel(); return }
        val c = center(points)
        val d = distance(points[0], points[1])
        if (pair.kind == Kind.PENDING) {
            val travel = distance(c, pair.center)
            val spread = kotlin.math.abs(d - pair.distance)
            if (spread > slop && spread > travel) pair.kind = Kind.PINCH
            else if (travel > slop) pair.kind = Kind.WHEEL
        }
        when (pair.kind) {
            Kind.PINCH -> if (pair.distance > 0) {
                val scale = (pair.initial.scale * d / pair.distance).coerceIn(1.0, 3.0)
                val anchorX = (pair.center.x - width / 2 - pair.initial.x) / pair.initial.scale
                val anchorY = (pair.center.y - height / 2 - pair.initial.y) / pair.initial.scale
                update(Transform(scale, c.x - width / 2 - anchorX * scale, c.y - height / 2 - anchorY * scale))
            }
            Kind.WHEEL -> projected(pair.authority, c, false)?.let { p ->
                val dx = -(c.x - pair.previous.x) / density * 2
                val dy = -(c.y - pair.previous.y) / density * 2
                if (dx != 0.0 || dy != 0.0) emit(RemoteDesktopControlIntent.Wheel(p.binding, p.intentEpoch, p.generation, p.x, p.y, dx, dy))
            }
            else -> Unit
        }
        pair.previous = c
    }

    fun longPress(at: Long) {
        val one = single ?: return
        if (one.kind != Kind.PENDING || at < one.at + longPressMs) return
        if (one.second && one.authority != null) {
            button(one, one.start, true); one.kind = Kind.DRAG
        } else {
            tap(one.authority, one.start)?.copy(button = RemoteDesktopPointerButton.RIGHT)?.let(emit)
            one.kind = Kind.WAIT
        }
    }

    fun up(points: List<Point>, at: Long, remaining: Int) {
        val one = single
        if (one != null) {
            val p = points.singleOrNull()?.takeIf { it.id == one.start.id }
            if (p == null) { cancel(); return }
            move(points)
            longPress(at)
            if (one.kind == Kind.DRAG) button(one, p, false)
            else if (one.kind == Kind.PENDING) tap(one.authority, p)?.let {
                emit(it)
                lastTap = Tap(at, p, one.authority!!)
            }
            single = null
        }
        if (two != null) {
            // Do not reinterpret the remaining finger as a fresh tap/drag.
            two!!.kind = Kind.WAIT
            if (remaining == 0) two = null
        }
    }

    fun cancel(keepTap: Boolean = false) {
        val held = single?.takeIf { it.kind == Kind.DRAG }?.authority
        single = null; two = null
        if (!keepTap) lastTap = null
        // Release is authoritative cleanup even when geometry or focus is no
        // longer valid for an ordinary button-up. Never stamp a successor lease.
        held?.binding?.let { emit(RemoteDesktopControlIntent.Release(it, held.intentEpoch)) }
    }

    private fun button(one: Single, p: Point, down: Boolean) {
        projected(one.authority, p, true)?.let {
            emit(RemoteDesktopControlIntent.PointerButton(it.binding, it.intentEpoch, it.generation, it.x, it.y, RemoteDesktopPointerButton.LEFT, down))
        }
    }
    private fun projected(state: RemoteDesktopControlUiState?, p: Point, clamp: Boolean): RemoteDesktopControlIntent.PointerMove? {
        state ?: return null
        val x = (p.x - width / 2 - transform.x) / transform.scale + width / 2
        val y = (p.y - height / 2 - transform.y) / transform.scale + height / 2
        if (clamp) return remoteDesktopPointerMoveIntent(state, width, height, videoWidth, videoHeight, x, y)
        return remoteDesktopTapIntent(state, width, height, videoWidth, videoHeight, x, y)?.let {
            RemoteDesktopControlIntent.PointerMove(it.binding, it.intentEpoch, it.generation, it.x, it.y)
        }
    }
    private fun tap(state: RemoteDesktopControlUiState?, p: Point): RemoteDesktopControlIntent.Tap? = projected(state, p, false)?.let {
        RemoteDesktopControlIntent.Tap(it.binding, it.intentEpoch, it.generation, it.x, it.y)
    }
    private fun inside(p: Point): Boolean {
        if (width <= 0 || height <= 0 || videoWidth !in 1..32768 || videoHeight !in 1..32768) return false
        val fit = minOf(width / videoWidth, height / videoHeight)
        return kotlin.math.abs(p.x - width / 2 - transform.x) <= videoWidth * fit * transform.scale / 2
            && kotlin.math.abs(p.y - height / 2 - transform.y) <= videoHeight * fit * transform.scale / 2
            && p.x in 0.0..width && p.y in 0.0..height
    }
    private fun update(value: Transform) {
        val fit = if (videoWidth > 0 && videoHeight > 0) minOf(width / videoWidth, height / videoHeight) else 0.0
        val limitX = maxOf(0.0, (videoWidth * fit * value.scale - width) / 2)
        val limitY = maxOf(0.0, (videoHeight * fit * value.scale - height) / 2)
        transform = value.copy(x = value.x.coerceIn(-limitX, limitX), y = value.y.coerceIn(-limitY, limitY))
        transformed(transform)
    }
    private fun center(p: List<Point>) = Point(-1, (p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2)
    private fun distance(a: Point, b: Point) = hypot(a.x - b.x, a.y - b.y)
}
