package com.openbitfun.mobile.core.feature.remotedesktop

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class RemoteDesktopControlSessionTest {
    @Test fun acquireUsesFreshStreamingStateAndTapKeepsItsExactAuthority() = runTest {
        val f = Fixture(); f.acquire()
        assertEquals(1, f.reads)
        assertEquals(RemoteDesktopControlRendererIntent.Acquire(BINDING, 1, "boot:9"), f.commands.single())
        f.report(generation = "18446744073709551615")
        val held = f.session.state
        assertEquals(RemoteDesktopControlMode.CONTROLLING, held.mode)
        f.session.dispatch(RemoteDesktopControlIntent.Tap(BINDING, held.intentEpoch, held.generation!!, 0.25, 0.75))
        assertEquals(RemoteDesktopControlRendererIntent.Tap(BINDING, held.intentEpoch, held.generation, 0.25, 0.75), f.commands.last())
        assertEquals(1, f.reads); assertTrue(f.failures.isEmpty())
    }

    @Test fun pointerAndWheelUseTheSameCapturedLeaseAndKeepButtonEdges() = runTest {
        val f = Fixture(); f.acquire(); f.report(generation = "3")
        val state = f.session.state; val epoch = state.intentEpoch
        f.session.dispatch(RemoteDesktopControlIntent.Tap(BINDING, epoch, "3", 0.2, 0.3, RemoteDesktopPointerButton.RIGHT))
        f.session.dispatch(RemoteDesktopControlIntent.PointerButton(BINDING, epoch, "3", 0.2, 0.3, RemoteDesktopPointerButton.LEFT, true))
        f.session.dispatch(RemoteDesktopControlIntent.PointerMove(BINDING, epoch, "3", 0.4, 0.5))
        f.session.dispatch(RemoteDesktopControlIntent.PointerButton(BINDING, epoch, "3", 0.4, 0.5, RemoteDesktopPointerButton.LEFT, false))
        f.session.dispatch(RemoteDesktopControlIntent.Wheel(BINDING, epoch, "3", 0.5, 0.5, -12.0, 34.0))
        assertEquals(listOf(
            RemoteDesktopControlRendererIntent.Tap(BINDING, epoch, "3", 0.2, 0.3, RemoteDesktopPointerButton.RIGHT),
            RemoteDesktopControlRendererIntent.PointerButton(BINDING, epoch, "3", 0.2, 0.3, RemoteDesktopPointerButton.LEFT, true),
            RemoteDesktopControlRendererIntent.PointerMove(BINDING, epoch, "3", 0.4, 0.5),
            RemoteDesktopControlRendererIntent.PointerButton(BINDING, epoch, "3", 0.4, 0.5, RemoteDesktopPointerButton.LEFT, false),
            RemoteDesktopControlRendererIntent.Wheel(BINDING, epoch, "3", 0.5, 0.5, -12.0, 34.0)), f.commands.drop(1))
    }

    @Test fun staleMalformedAndUnhealthyGestureInputCannotPassAdmission() = runTest {
        val f = Fixture(); f.acquire(); f.report(generation = "3")
        val epoch = f.session.state.intentEpoch; val count = f.commands.size
        val bad = listOf(
            RemoteDesktopControlIntent.PointerMove(BINDING, epoch - 1, "3", 0.5, 0.5),
            RemoteDesktopControlIntent.PointerMove(BINDING, epoch, "2", 0.5, 0.5),
            RemoteDesktopControlIntent.PointerMove(BINDING, epoch, "3", Double.NaN, 0.5),
            RemoteDesktopControlIntent.PointerButton(BINDING, epoch, "3", -0.1, 0.5, RemoteDesktopPointerButton.LEFT, false),
            RemoteDesktopControlIntent.Wheel(BINDING, epoch, "3", 0.5, 0.5, Double.POSITIVE_INFINITY, 0.0),
            RemoteDesktopControlIntent.Wheel(BINDING, epoch, "3", 0.5, 0.5, 0.0, 0.0),
            RemoteDesktopControlIntent.Wheel(BINDING.copy(connectionId = "old"), epoch, "3", 0.5, 0.5, 1.0, 2.0))
        bad.forEach { f.session.dispatch(it) }; assertEquals(count, f.commands.size)
        f.ready = false
        f.session.dispatch(RemoteDesktopControlIntent.PointerMove(BINDING, epoch, "3", 0.5, 0.5))
        assertIs<RemoteDesktopControlRendererIntent.Release>(f.commands.last())
        assertNull(f.session.state.generation)
        f.session.dispatch(RemoteDesktopControlIntent.Wheel(BINDING, epoch, "3", 0.5, 0.5, 1.0, 2.0))
        assertEquals(count + 1, f.commands.size)
    }

    @Test fun unsupportedUnpresentedOrInterruptedMediaCannotAskForControl() = runTest {
        for (supported in listOf(false, true)) {
            val f = Fixture(supported); if (supported) f.ready = false
            f.acquire(); assertEquals(0, f.reads); assertTrue(f.commands.isEmpty())
            assertEquals(RemoteDesktopControlMode.VIEWING, f.session.state.mode)
        }
    }

    @Test fun staleUiIntentsCannotActOnANewBindingOrControlAttempt() = runTest {
        val f = Fixture()
        f.session.dispatch(RemoteDesktopControlIntent.Acquire(BINDING.copy(connectionId = "old"), 0))
        assertEquals(0, f.reads)
        f.acquire(); f.report(generation = "1")
        val held = f.session.state
        val old = RemoteDesktopControlIntent.Tap(BINDING, held.intentEpoch, "1", 0.5, 0.5)
        f.session.release()
        f.releaseAck()
        f.acquire(); f.report(generation = "2")
        val count = f.commands.size
        f.session.dispatch(old)
        f.session.dispatch(RemoteDesktopControlIntent.Release(BINDING, held.intentEpoch))
        f.session.dispatch(RemoteDesktopControlIntent.Acquire(BINDING, held.intentEpoch))
        assertEquals(count, f.commands.size); assertEquals("2", f.session.state.generation)
    }

    @Test fun aFreshCasReadMustStillDescribeTheExactStreamingAttachmentAndDisplay() = runTest {
        val invalid = listOf(
            SNAPSHOT.copy(attachment = null), SNAPSHOT.copy(attachment = ATTACHMENT.copy(attachment = "foreign")),
            SNAPSHOT.copy(attachment = ATTACHMENT.copy(connection = "foreign")), SNAPSHOT.copy(attachment = ATTACHMENT.copy(display = "foreign")),
            SNAPSHOT.copy(suspended = true), SNAPSHOT.copy(cleanupPending = true), SNAPSHOT.copy(streaming = false))
        for (snapshot in invalid) {
            val f = Fixture(); f.snapshot = snapshot; f.acquire()
            assertTrue(f.commands.isEmpty()); assertEquals(RemoteDesktopControlMode.VIEWING, f.session.state.mode)
            assertEquals(RemoteDesktopControlFailure.INPUT_SUSPENDED, f.session.state.failure)
        }
    }

    @Test fun pauseOrCloseDuringCasReadCannotSendALateAcquire() = runTest {
        for (close in listOf(false, true)) {
            val f = Fixture(); val gate = CompletableDeferred<Unit>(); f.beforeRead = { gate.await() }
            val acquire = backgroundScope.launch { f.acquire() }; runCurrent()
            if (close) f.session.close() else f.session.release()
            gate.complete(Unit); runCurrent(); acquire.join()
            assertTrue(f.commands.isEmpty()); assertNull(f.session.state.generation)
            assertEquals(RemoteDesktopControlMode.VIEWING, f.session.state.mode)
        }
    }

    @Test fun cancellingAnUnsentAcquireRestoresViewingWithoutReplayingTheRead() = runTest {
        val f = Fixture(); val gate = CompletableDeferred<Unit>(); f.beforeRead = { gate.await() }
        val acquire = backgroundScope.launch { f.acquire() }; runCurrent(); acquire.cancelAndJoin()
        assertEquals(1, f.reads); assertTrue(f.commands.isEmpty())
        assertEquals(RemoteDesktopControlMode.VIEWING, f.session.state.mode)
    }

    @Test fun repeatedAcquireWhileReadingOrWaitingForAGrantNeverSubmitsAgain() = runTest {
        val f = Fixture(); val gate = CompletableDeferred<Unit>(); f.beforeRead = { gate.await() }
        val first = backgroundScope.launch { f.acquire() }; runCurrent(); f.acquire()
        assertEquals(1, f.reads)
        gate.complete(Unit); runCurrent(); first.join(); f.acquire()
        assertEquals(1, f.commands.size); assertEquals(1, f.reads)
    }

    @Test fun releasingAnIssuedButUnknownAcquireClosesInsteadOfGuessingALease() = runTest {
        val f = Fixture(); f.acquire(); f.session.release()
        assertEquals(listOf(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN), f.failures)
        assertEquals(1, f.commands.size); assertFalse(f.session.state.supported)
        f.report(generation = "1", epoch = 1)
        assertNull(f.session.state.generation)
    }

    @Test fun releaseRetiresImmediatelyButItsFirstLocalReportCannotReopenAcquisition() = runTest {
        val f = Fixture(); f.acquire(); f.report(generation = "1")
        val held = f.session.state
        f.session.release(); val release = f.commands.last()
        assertIs<RemoteDesktopControlRendererIntent.Release>(release)
        assertTrue(f.session.state.releasePending); assertNull(f.session.state.generation)
        f.report() // JS local retirement precedes issuing release_control.
        assertTrue(f.session.state.releasePending); f.acquire()
        assertEquals(release, f.commands.last()); assertEquals(2, f.commands.size)
        f.report(generation = "1", epoch = held.intentEpoch)
        assertNull(f.session.state.generation)
        f.report(pending = RemoteDesktopControlPending.RELEASE)
        f.session.release(); assertEquals(2, f.commands.size)
        f.report(); assertFalse(f.session.state.releasePending)
        assertTrue(f.failures.isEmpty())
    }

    @Test fun nativeHealthReleaseAndHostRevocationDoNotRestoreControlAutomatically() = runTest {
        for (revoked in listOf(false, true)) {
            val f = Fixture(); f.acquire(); f.report(generation = "1")
            val epoch = f.session.state.intentEpoch
            f.report(failure = if (revoked) RemoteDesktopControlFailure.REVOKED else null)
            assertNull(f.session.state.generation); assertEquals(RemoteDesktopControlMode.VIEWING, f.session.state.mode)
            if (!revoked) {
                assertTrue(f.session.state.releasePending); f.acquire(); assertEquals(1, f.commands.size)
                f.report(pending = RemoteDesktopControlPending.RELEASE); f.report()
            }
            f.report(generation = "1", epoch = epoch)
            assertNull(f.session.state.generation); assertTrue(f.failures.isEmpty())
        }
    }

    @Test fun releaseCrossingAnInflightRenewalKeepsItsAckBarrierInsteadOfMisreadingLocalRetirement() = runTest {
        for (automatic in listOf(false, true)) {
            val f = Fixture(); f.acquire(); f.report(generation = "1")
            f.report(generation = "1", pending = RemoteDesktopControlPending.RENEW)
            if (!automatic) f.session.release()
            // Existing JS release() first emits retired generation + its old
            // pending renewal, then replaces that request with release_control.
            f.report(pending = RemoteDesktopControlPending.RENEW)
            assertTrue(f.failures.isEmpty()); assertNull(f.session.state.generation)
            assertTrue(f.session.state.releasePending)
            val before = f.commands.size; f.acquire(); assertEquals(before, f.commands.size)
            f.report(pending = RemoteDesktopControlPending.RELEASE); f.report()
            assertFalse(f.session.state.releasePending); assertTrue(f.failures.isEmpty())
        }
    }

    @Test fun anOldGrantCannotReturnAfterMultipleSubsequentLeases() = runTest {
        val f = Fixture(); f.acquire(); val old = f.session.state.intentEpoch; f.report(generation = "1")
        f.session.release(); f.releaseAck(); f.acquire(); f.report(generation = "2")
        f.session.release(); f.releaseAck(); f.acquire()
        f.report(generation = "1", epoch = old)
        assertEquals(RemoteDesktopControlMode.ACQUIRING, f.session.state.mode); assertNull(f.session.state.generation)
        f.report(generation = "3"); assertEquals("3", f.session.state.generation)
    }

    @Test fun invalidOrUnexpectedGrantCannotBecomeLocalAuthority() = runTest {
        for (generation in listOf("0", "01", "-1", "18446744073709551616", "x")) {
            val f = Fixture(); f.acquire(); f.report(generation = generation)
            assertEquals(listOf(RemoteDesktopSetupFailure.INVALID_RESPONSE), f.failures)
        }
        val f = Fixture(); f.report(generation = "1")
        assertEquals(listOf(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN), f.failures)
    }

    @Test fun deniedAcquireKeepsVideoViewingAndRequiresAnotherExplicitIntent() = runTest {
        for (failure in listOf(RemoteDesktopControlFailure.BUSY, RemoteDesktopControlFailure.DEVICE_APPROVAL_REQUIRED,
            RemoteDesktopControlFailure.PERMISSION_REQUIRED, RemoteDesktopControlFailure.STALE_REVISION)) {
            val f = Fixture(); f.acquire(); f.report(failure = failure)
            assertEquals(RemoteDesktopControlMode.VIEWING, f.session.state.mode); assertEquals(failure, f.session.state.failure)
            assertEquals(1, f.commands.size); assertTrue(f.failures.isEmpty())
        }
    }

    @Test fun inputRejectsOutOfImageCoordinatesStaleGenerationAndAnUnhealthyPc() = runTest {
        val f = Fixture(); f.acquire(); f.report(generation = "1"); val epoch = f.session.state.intentEpoch
        for ((x, y) in listOf(-0.1 to 0.5, 1.1 to 0.5, Double.NaN to 0.0, 0.0 to Double.POSITIVE_INFINITY)) {
            f.session.dispatch(RemoteDesktopControlIntent.Tap(BINDING, epoch, "1", x, y))
        }
        f.session.dispatch(RemoteDesktopControlIntent.Tap(BINDING, epoch, "old", 0.5, 0.5))
        assertEquals(1, f.commands.size)
        f.ready = false
        f.session.dispatch(RemoteDesktopControlIntent.Tap(BINDING, epoch, "1", 0.5, 0.5))
        assertIs<RemoteDesktopControlRendererIntent.Release>(f.commands.last()); assertNull(f.session.state.generation)
    }

    @Test fun boundedRendererBackpressureOrThrowEndsThePcWithoutRetry() = runTest {
        for (throws in listOf(false, true)) {
            val f = Fixture(); f.throwSubmit = throws; f.acceptSubmit = false; f.acquire()
            assertEquals(1, f.commands.size); assertEquals(listOf(RemoteDesktopSetupFailure.MEDIA_UNREACHABLE), f.failures)
            f.acquire(); assertEquals(1, f.commands.size)
        }
    }

    @Test fun transientCasReadFailureNeverSubmitsOrReplaysAndExplicitIdentityOrViewLossEndsMedia() = runTest {
        val f = Fixture(); f.beforeRead = { throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.NETWORK) }
        f.acquire(); assertEquals(1, f.reads); assertTrue(f.commands.isEmpty()); assertTrue(f.failures.isEmpty())
        assertEquals(RemoteDesktopControlMode.VIEWING, f.session.state.mode)
        for (failure in listOf(RemoteDesktopSetupFailure.DEVICE_IDENTITY_CHANGED, RemoteDesktopSetupFailure.ACCOUNT_CHANGED,
            RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED, RemoteDesktopSetupFailure.PERMISSION_REQUIRED,
            RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED)) {
            val revoked = Fixture(); revoked.beforeRead = { throw RemoteDesktopSetupException(failure) }; revoked.acquire()
            assertEquals(listOf(failure), revoked.failures); assertTrue(revoked.commands.isEmpty())
        }
    }

    @Test fun aGrantCrossingSignalOrForegroundLossCannotEnableInput() = runTest {
        val f = Fixture(); f.acquire(); f.ready = false; f.report(generation = "1")
        assertEquals(listOf(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN), f.failures)
        assertNull(f.session.state.generation)
        val retired = Fixture(); retired.acquire(); retired.session.close(); retired.report(generation = "1")
        assertNull(retired.session.state.generation); assertFalse(retired.session.state.supported)
    }

    @Test fun textRequiresItsNegotiatedCapabilityButPairedKeysDoNot() = runTest {
        for (textSupported in listOf(false, true)) {
            val f = Fixture(textSupported = textSupported); f.acquire(); f.report(generation = "1")
            val state = f.session.state
            f.session.dispatch(RemoteDesktopControlIntent.TextCommit(BINDING, state.intentEpoch, "1", "\u4f60\u597d"))
            assertEquals(if (textSupported) 1 else 0, f.commands.filterIsInstance<RemoteDesktopControlRendererIntent.TextCommit>().size)
            f.session.dispatch(RemoteDesktopControlIntent.KeyTap(BINDING, state.intentEpoch, "1", RemoteDesktopKeyboardKey.ENTER))
            assertEquals(RemoteDesktopControlRendererIntent.KeyTap(BINDING, state.intentEpoch, "1", RemoteDesktopKeyboardKey.ENTER), f.commands.last())
            assertFalse(f.commands.last().toString().contains("ENTER"))
        }
    }

    @Test fun textValidationUsesUtf8AndNeverReplacesMalformedSurrogates() = runTest {
        val f = Fixture(textSupported = true); f.acquire(); f.report(generation = "1")
        for (text in listOf("", "bad\u0000text", "\ud800", "\udc00", "\u597d".repeat(1366))) {
            f.session.dispatch(RemoteDesktopControlIntent.TextCommit(BINDING, 1, "1", text))
        }
        assertEquals(1, f.commands.size)
        for (text in listOf("\u597d".repeat(1365), "x".repeat(4096), "\ud83d\ude00")) {
            f.session.dispatch(RemoteDesktopControlIntent.TextCommit(BINDING, 1, "1", text))
            assertEquals(text, (f.commands.last() as RemoteDesktopControlRendererIntent.TextCommit).text)
            assertFalse(f.commands.last().toString().contains(text))
        }
    }

    @Test fun textAndKeysCannotCrossReleaseOrAReplacementLease() = runTest {
        val f = Fixture(textSupported = true); f.acquire(); f.report(generation = "1")
        val oldText = RemoteDesktopControlIntent.TextCommit(BINDING, 1, "1", "private text")
        val oldKey = RemoteDesktopControlIntent.KeyTap(BINDING, 1, "1", RemoteDesktopKeyboardKey.BACKSPACE)
        f.session.release(); f.releaseAck(); f.acquire(); f.report(generation = "2")
        val count = f.commands.size
        f.session.dispatch(oldText); f.session.dispatch(oldKey)
        assertEquals(count, f.commands.size); assertEquals("2", f.session.state.generation)
        assertFalse(oldText.toString().contains("private text"))
        assertFalse(oldKey.toString().contains("BACKSPACE"))
        f.session.close(); assertFalse(f.session.state.textSupported)
    }

    @Test fun keyboardInputWithLostReadinessReleasesAndDoesNotQueueInput() = runTest {
        for (text in listOf(false, true)) {
            val f = Fixture(textSupported = true); f.acquire(); f.report(generation = "1"); f.ready = false
            f.session.dispatch(if (text) RemoteDesktopControlIntent.TextCommit(BINDING, 1, "1", "hello")
                else RemoteDesktopControlIntent.KeyTap(BINDING, 1, "1", RemoteDesktopKeyboardKey.ENTER))
            assertTrue(f.commands.last() is RemoteDesktopControlRendererIntent.Release)
            assertEquals(2, f.commands.size); assertNull(f.session.state.generation)
        }
    }

    private class Fixture(supported: Boolean = true, textSupported: Boolean = false) {
        var ready = true; var current = true; var reads = 0; var snapshot = SNAPSHOT
        var beforeRead: suspend () -> Unit = {}; var acceptSubmit = true; var throwSubmit = false
        val commands = mutableListOf<RemoteDesktopControlRendererIntent>()
        val failures = mutableListOf<RemoteDesktopSetupFailure>()
        val states = mutableListOf<RemoteDesktopControlUiState>()
        val session = RemoteDesktopControlSession(BINDING, ATTACHMENT.display, supported, { current }, { ready },
            { reads++; beforeRead(); snapshot },
            { commands += it; if (throwSubmit) throw IllegalStateException("Fixture send failed"); acceptSubmit },
            states::add, failures::add, textSupported)
        suspend fun acquire() { session.dispatch(RemoteDesktopControlIntent.Acquire(BINDING, session.state.intentEpoch)) }
        fun report(generation: String? = null, pending: RemoteDesktopControlPending? = null,
            failure: RemoteDesktopControlFailure? = null, epoch: Long = session.state.intentEpoch) {
            session.report(RemoteDesktopControlReportIntent(BINDING, epoch, generation, pending, failure))
        }
        fun releaseAck() { report(pending = RemoteDesktopControlPending.RELEASE); report() }
    }

    companion object {
        private val BINDING = RemoteDesktopMediaBindingUi("renderer", "attachment", "connection")
        private val ATTACHMENT = RemoteDesktopAttachment("attachment", "connection", "opaque:display")
        private val SNAPSHOT = RemoteDesktopSourceState("boot:9", ATTACHMENT, false, false, true)
    }
}
