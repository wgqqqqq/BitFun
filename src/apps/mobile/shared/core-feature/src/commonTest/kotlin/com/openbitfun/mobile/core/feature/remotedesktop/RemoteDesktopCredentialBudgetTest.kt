package com.openbitfun.mobile.core.feature.remotedesktop

import kotlin.test.*

class RemoteDesktopCredentialBudgetTest {
    @Test fun requestTimeAndAllLaterSnapshotsCanOnlyShortenTheOriginalDeadline() {
        val budget = RemoteDesktopCredentialBudget()
        budget.host(10_000, 100, 900)
        assertEquals(9_200, budget.remaining(900, 100_000))
        budget.host(30_000, 1000, 1100)
        assertEquals(9_000, budget.remaining(1100, 100_000))
        budget.host(3000, 2000, 2100)
        assertEquals(2900, budget.remaining(2100, 100_000))
    }

    @Test fun turnWallClockAndMonotonicBudgetBothApplyAndExpirationIsTerminal() {
        val budget = RemoteDesktopCredentialBudget()
        budget.turn(110, 0, 100, 100_000)
        assertEquals(9900, budget.remaining(100, 100_000))
        assertEquals(1000, budget.remaining(200, 109_000))
        assertEquals(0, budget.remaining(300, 110_000))
        assertEquals(0, budget.remaining(400, 90_000))
    }

    @Test fun clockRollbackCannotExtendAStillLiveConnection() {
        val budget = RemoteDesktopCredentialBudget()
        budget.turn(110, 0, 0, 100_000)
        assertEquals(9000, budget.remaining(1000, 90_000))
        assertEquals(0, budget.remaining(10_001, 90_000))
    }

    @Test fun malformedBudgetsAreRefusedAndMissingHostBudgetDoesNotInventExpiration() {
        val budget = RemoteDesktopCredentialBudget()
        assertEquals(Long.MAX_VALUE, budget.remaining(0, 100_000))
        for (operation in listOf<() -> Unit>({ budget.host(-1, 0, 0) }, { budget.host(660_001, 0, 0) },
            { budget.host(1000, 2, 1) }, { budget.turn(Long.MAX_VALUE, 0, 0, 0) }, { budget.turn(1000, 0, 0, 0) })) {
            assertEquals(RemoteDesktopSetupFailure.INVALID_RESPONSE, assertFailsWith<RemoteDesktopSetupException>(block = operation).reason)
        }
    }
}
