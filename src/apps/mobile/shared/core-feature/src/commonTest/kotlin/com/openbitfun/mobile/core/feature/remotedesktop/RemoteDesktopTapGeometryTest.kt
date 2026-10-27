package com.openbitfun.mobile.core.feature.remotedesktop

import kotlin.test.*

class RemoteDesktopTapGeometryTest {
    private val control = RemoteDesktopControlUiState(RemoteDesktopMediaBindingUi("renderer", "attachment", "connection"), true,
        RemoteDesktopControlMode.CONTROLLING, "9", 7, false, null)

    @Test fun portraitAndLandscapeContainTheImageWithoutTurningBarsIntoDesktopClicks() {
        for ((width, height) in listOf(400.0 to 800.0, 800.0 to 400.0)) {
            val tap = assertNotNull(remoteDesktopTapIntent(control, width, height, 1600, 900, width / 2, height / 2))
            assertEquals(0.5, tap.x, 0.000001); assertEquals(0.5, tap.y, 0.000001)
            assertEquals(control.binding, tap.binding); assertEquals("9", tap.generation); assertEquals(7, tap.intentEpoch)
        }
        assertNull(remoteDesktopTapIntent(control, 400.0, 800.0, 1600, 900, 200.0, 1.0))
        assertNull(remoteDesktopTapIntent(control, 800.0, 400.0, 900, 1600, 1.0, 200.0))
    }

    @Test fun edgesMapToTheirActualImageCoordinatesAndInvalidGeometryNeverProducesInput() {
        val tap = assertNotNull(remoteDesktopTapIntent(control, 800.0, 600.0, 800, 600, 0.0, 600.0))
        assertEquals(0.0, tap.x); assertEquals(1.0, tap.y)
        for ((w, h) in listOf(0.0 to 800.0, Double.NaN to 800.0, 400.0 to Double.POSITIVE_INFINITY)) {
            assertNull(remoteDesktopTapIntent(control, w, h, 1600, 900, 10.0, 10.0))
        }
        assertNull(remoteDesktopTapIntent(control, 400.0, 800.0, 0, 900, 200.0, 400.0))
        assertNull(remoteDesktopTapIntent(control, 400.0, 800.0, 1600, 900, Double.NaN, 400.0))
    }

    @Test fun onlyActiveMovementMayClampToVideoEdges() {
        val move = assertNotNull(remoteDesktopPointerMoveIntent(control, 400.0, 800.0, 1600, 900, -10.0, 900.0))
        assertEquals(0.0, move.x); assertEquals(1.0, move.y)
        assertEquals(control.binding, move.binding); assertEquals(control.intentEpoch, move.intentEpoch)
        assertNull(remoteDesktopTapIntent(control, 400.0, 800.0, 1600, 900, -10.0, 900.0))
        assertNull(remoteDesktopPointerMoveIntent(control, 400.0, 800.0, 1600, 900, Double.NaN, 900.0))
    }

    @Test fun aGestureKeepsItsOriginalAuthorityAndViewingHasNoTapIntent() {
        val held = assertNotNull(remoteDesktopTapIntent(control, 400.0, 800.0, 1600, 900, 200.0, 400.0))
        val changed = control.copy(generation = "10", intentEpoch = 8)
        assertEquals("9", held.generation); assertNotEquals(changed.intentEpoch, held.intentEpoch)
        assertNull(remoteDesktopTapIntent(control.copy(mode = RemoteDesktopControlMode.VIEWING, generation = null),
            400.0, 800.0, 1600, 900, 200.0, 400.0))
    }
}
