package com.openbitfun.mobile.app.ui.remote

import com.openbitfun.mobile.core.feature.remotedesktop.*
import org.junit.Assert.*
import org.junit.Test

class RemoteDesktopGesturePolicyTest {
    private val authority = RemoteDesktopControlUiState(RemoteDesktopMediaBindingUi("r", "a", "c"), true,
        RemoteDesktopControlMode.CONTROLLING, "9", 7, false, null)
    private fun point(x: Double = 200.0, y: Double = 400.0, id: Int = 0) = RemoteDesktopGesturePolicy.Point(id, x, y)
    private inner class Fixture {
        val inputs = mutableListOf<RemoteDesktopControlIntent>()
        val policy = RemoteDesktopGesturePolicy(8.0, 40.0, 500, 300, 2.0, inputs::add, {})
        init { policy.configure(400, 800, 1600, 900) }
        fun down(at: Long = 0, p: RemoteDesktopGesturePolicy.Point = point(), state: RemoteDesktopControlUiState? = authority) = policy.down(listOf(p), at, state)
        fun up(at: Long = 20, p: RemoteDesktopGesturePolicy.Point = point()) = policy.up(listOf(p), at, 0)
        fun drag() { down(); up(); down(100); policy.move(listOf(point(220.0))); inputs.clear() }
    }
    @Test fun singleAndDoubleTapKeepCoordinatesAndAuthority() {
        val f = Fixture(); f.down(); assertTrue(f.inputs.isEmpty()); f.up()
        f.down(100); f.up(120)
        assertEquals(2, f.inputs.size)
        f.inputs.forEach { val t = it as RemoteDesktopControlIntent.Tap
            assertEquals(authority.binding, t.binding); assertEquals(7L, t.intentEpoch); assertEquals("9", t.generation)
            assertEquals(0.5, t.x, 0.00001); assertEquals(0.5, t.y, 0.00001) }
    }
    @Test fun longPressIsRightClickAndNeverAddsLeftClickOnUp() {
        val f = Fixture(); f.down(); f.policy.longPress(499); assertTrue(f.inputs.isEmpty())
        f.policy.longPress(500); f.up(600)
        assertEquals(RemoteDesktopPointerButton.RIGHT, (f.inputs.single() as RemoteDesktopControlIntent.Tap).button)
        val late = Fixture(); late.down(); late.up(600)
        assertEquals(RemoteDesktopPointerButton.RIGHT, (late.inputs.single() as RemoteDesktopControlIntent.Tap).button)
    }
    @Test fun ordinarySwipeOrBarTouchCannotBecomeClickOrDrag() {
        val f = Fixture(); f.down(); f.policy.move(listOf(point(220.0))); f.policy.longPress(600); f.up(700, point(220.0))
        assertTrue(f.inputs.isEmpty())
        f.down(800, point(y = 20.0)); f.up(900, point(y = 20.0)); assertTrue(f.inputs.isEmpty())
    }
    @Test fun doubleTapHoldDragHasOneDownMovesAndClampedUp() {
        val f = Fixture(); f.down(); f.up(); f.down(100); f.policy.longPress(600)
        f.policy.move(listOf(point(500.0, 900.0))); f.up(700, point(500.0, 900.0))
        val buttons = f.inputs.filterIsInstance<RemoteDesktopControlIntent.PointerButton>()
        assertEquals(listOf(true, false), buttons.map { it.down })
        assertEquals(1.0, buttons.last().x, 0.0); assertEquals(1.0, buttons.last().y, 0.0)
        assertEquals(1, f.inputs.filterIsInstance<RemoteDesktopControlIntent.Tap>().size)
        assertTrue(f.inputs.any { it is RemoteDesktopControlIntent.PointerMove })
    }
    @Test fun secondTapMovementStartsDragWithoutWaitingForLongPress() {
        val f = Fixture(); f.down(); f.up(); f.down(100); f.policy.move(listOf(point(220.0))); f.up(150, point(230.0))
        assertEquals(listOf(true, false), f.inputs.filterIsInstance<RemoteDesktopControlIntent.PointerButton>().map { it.down })
    }
    @Test fun timeoutDistanceAndLeaseChangesPreventSecondTapDrag() {
        for ((at, p, state) in listOf(Triple(400L, point(), authority), Triple(100L, point(280.0), authority),
            Triple(100L, point(), authority.copy(generation = "10", intentEpoch = 8)))) {
            val f = Fixture(); f.down(); f.up(); f.down(at, p, state); f.policy.move(listOf(point(p.x + 20))); f.up(at + 20, point(p.x + 20))
            assertEquals(1, f.inputs.size)
        }
    }
    @Test fun cancelOrViewportChangeReleasesOnlyCapturedDragLeaseOnce() {
        for (resize in listOf(false, true)) {
            val f = Fixture(); f.drag()
            if (resize) f.policy.configure(800, 400, 1600, 900) else f.policy.cancel()
            f.policy.cancel()
            assertEquals(listOf(RemoteDesktopControlIntent.Release(authority.binding!!, 7)), f.inputs)
        }
    }
    @Test fun secondFingerRetiresDragAndRemainingFingerNeverClicks() {
        val f = Fixture(); f.drag()
        f.policy.down(listOf(point(220.0), point(260.0, id = 1)), 200, authority)
        f.policy.up(listOf(point(220.0), point(260.0, id = 1)), 210, 1)
        f.policy.move(listOf(point(240.0))); f.up(250, point(240.0))
        assertEquals(listOf(RemoteDesktopControlIntent.Release(authority.binding!!, 7)), f.inputs)
    }
    @Test fun parallelTwoFingerSwipeLocksWheelAndPreservesBothAxes() {
        val f = Fixture()
        f.policy.down(listOf(point(160.0), point(240.0, id = 1)), 0, authority)
        f.policy.move(listOf(point(162.0, 402.0), point(242.0, 402.0, 1))); assertTrue(f.inputs.isEmpty())
        f.policy.move(listOf(point(180.0, 430.0), point(260.0, 430.0, 1)))
        val wheel = f.inputs.single() as RemoteDesktopControlIntent.Wheel
        assertEquals(-18.0, wheel.dx, 0.0); assertEquals(-28.0, wheel.dy, 0.0)
        f.policy.move(listOf(point(100.0, 440.0), point(340.0, 440.0, 1)))
        assertEquals(1.0, f.policy.transform.scale, 0.0); assertTrue(f.inputs.all { it is RemoteDesktopControlIntent.Wheel })
    }
    @Test fun pinchIsLocalInViewingModeAndNeverReclassifiedAsWheel() {
        val f = Fixture()
        f.policy.down(listOf(point(160.0), point(240.0, id = 1)), 0, null)
        f.policy.move(listOf(point(120.0), point(280.0, id = 1)))
        assertEquals(2.0, f.policy.transform.scale, 0.0)
        f.policy.move(listOf(point(130.0, 430.0), point(290.0, 430.0, 1)))
        assertTrue(f.inputs.isEmpty())
    }
    @Test fun zoomedTapUsesInverseTransformAndSourceChangeResetsZoom() {
        val f = Fixture()
        f.policy.down(listOf(point(160.0), point(240.0, id = 1)), 0, null)
        f.policy.move(listOf(point(120.0), point(280.0, id = 1))); f.policy.up(listOf(point(120.0), point(280.0, id = 1)), 40, 0)
        f.down(100, point(300.0)); f.up(120, point(300.0))
        assertEquals(0.625, (f.inputs.single() as RemoteDesktopControlIntent.Tap).x, 0.00001)
        f.policy.configure(400, 800, 900, 1600, resetZoom = true)
        assertEquals(1.0, f.policy.transform.scale, 0.0)
    }
    @Test fun thirdFingerOrChangedPointerIdentityCancelsHeldDrag() {
        for (points in listOf(listOf(point(id = 5)), listOf(point(), point(id = 1), point(id = 2)))) {
            val f = Fixture(); f.drag(); f.policy.move(points)
            assertEquals(listOf(RemoteDesktopControlIntent.Release(authority.binding!!, 7)), f.inputs)
        }
    }
}
