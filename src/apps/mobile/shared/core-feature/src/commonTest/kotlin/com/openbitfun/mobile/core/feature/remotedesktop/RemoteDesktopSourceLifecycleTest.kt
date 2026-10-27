package com.openbitfun.mobile.core.feature.remotedesktop

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.coroutines.flow.collect
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class RemoteDesktopSourceLifecycleTest {
    @Test fun controlNeedsBothTheHostCapabilityAndExactNativeReadinessThenSourceChangeRetiresIt() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.controlSupported = true; view(f)
        val media = f.store.media.value!!; val binding = media.binding()
        val commands = mutableListOf<RemoteDesktopControlRendererIntent>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { f.store.rendererControlIntents.collect { commands += it } }
        assertTrue(media.controlSupported); assertFalse(f.store.control.value.supported)
        f.store.dispatchControl(RemoteDesktopControlIntent.Acquire(binding, 0)); runCurrent()
        assertEquals(0, f.channel.reads); assertTrue(commands.isEmpty())
        f.store.dispatchMedia(RemoteDesktopMediaIntent.ControlReady(binding.copy(rendererId = "old")))
        assertFalse(f.store.control.value.supported)
        f.store.dispatchMedia(RemoteDesktopMediaIntent.ControlReady(binding))
        assertTrue(f.store.control.value.supported)
        f.store.dispatchControl(RemoteDesktopControlIntent.Acquire(binding, 0)); runCurrent()
        val acquire = assertIs<RemoteDesktopControlRendererIntent.Acquire>(commands.single())
        assertEquals(1, f.channel.reads)
        f.store.reportControl(RemoteDesktopControlReportIntent(binding, acquire.intentEpoch, "1", null, null))
        assertEquals(RemoteDesktopControlMode.CONTROLLING, f.store.control.value.mode)
        f.store.dispatchControl(RemoteDesktopControlIntent.Tap(binding, acquire.intentEpoch, "1", 0.5, 0.5)); runCurrent()
        assertIs<RemoteDesktopControlRendererIntent.Tap>(commands.last())
        pause(f)
        assertNull(f.store.control.value.binding); assertFalse(f.store.control.value.supported)
        f.store.dispatchMedia(RemoteDesktopMediaIntent.ControlReady(binding))
        f.store.reportControl(RemoteDesktopControlReportIntent(binding, acquire.intentEpoch, "1", null, null))
        assertNull(f.store.control.value.generation)
        f.store.dispatch(RemoteDesktopSetupIntent.Resume); runCurrent()
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Prepare); runCurrent(); present(f)
        assertFalse(f.store.control.value.supported); assertNull(f.store.control.value.generation)
        f.store.close(); advanceTimeBy(500); runCurrent()
    }

    @Test fun rendererReadinessAloneCannotEnableAnUnsupportedHostAndControlPressureClosesWithoutReplay() = runTest {
        val unsupported = Fixture(backgroundScope) { testScheduler.currentTime }; view(unsupported)
        unsupported.store.dispatchMedia(RemoteDesktopMediaIntent.ControlReady(unsupported.store.media.value!!.binding()))
        assertFalse(unsupported.store.control.value.supported); unsupported.store.close(); advanceTimeBy(500); runCurrent()
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.controlSupported = true; view(f)
        val binding = f.store.media.value!!.binding()
        f.store.dispatchMedia(RemoteDesktopMediaIntent.ControlReady(binding))
        f.store.dispatchControl(RemoteDesktopControlIntent.Acquire(binding, 0)); runCurrent()
        val epoch = f.store.control.value.intentEpoch
        f.store.reportControl(RemoteDesktopControlReportIntent(binding, epoch, "1", null, null))
        // An absent/stalled native consumer must fail instead of dropping taps.
        repeat(64) { f.store.dispatchControl(RemoteDesktopControlIntent.Tap(binding, epoch, "1", 0.5, 0.5)) }
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.MEDIA_UNREACHABLE), f.store.state.value)
        assertNull(f.store.media.value); assertNull(f.store.control.value.generation)
        advanceTimeBy(500); runCurrent(); assertEquals(1, f.channel.detaches)
    }

    @Test fun aNewPresentedGeometryRetiresLocalInputWithoutClosingViewing() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.controlSupported = true; view(f)
        val binding = f.store.media.value!!.binding(); val commands = mutableListOf<RemoteDesktopControlRendererIntent>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { f.store.rendererControlIntents.collect { commands += it } }
        f.store.dispatchMedia(RemoteDesktopMediaIntent.ControlReady(binding))
        f.store.dispatchControl(RemoteDesktopControlIntent.Acquire(binding, 0)); runCurrent()
        f.store.reportControl(RemoteDesktopControlReportIntent(binding, f.store.control.value.intentEpoch, "1", null, null))
        f.store.dispatchMedia(RemoteDesktopMediaIntent.FramePresented(binding, 640, 360)); runCurrent()
        assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value)
        assertNull(f.store.control.value.generation); assertTrue(f.store.control.value.releasePending)
        assertIs<RemoteDesktopControlRendererIntent.Release>(commands.last())
        f.store.close(); advanceTimeBy(500); runCurrent()
    }
    @Test fun pausedDisplayChoiceRefreshesTheCatalogUsesFreshCasAndWaitsForNewPresentation() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f)
        val old = f.store.media.value!!; pause(f)
        f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent()
        val choice = assertIs<RemoteDesktopSetupUiState.ChoosePausedDisplay>(f.store.state.value)
        assertEquals(listOf(DISPLAY, SECOND), choice.displays); assertEquals(DISPLAY, choice.display)
        f.channel.revision += 2 // Catalog CAS is deliberately stale now.
        f.store.dispatch(RemoteDesktopSetupIntent.SelectPausedDisplay("not-an-authorized-id")); runCurrent()
        assertEquals(0, f.channel.selects)
        f.store.dispatch(RemoteDesktopSetupIntent.SelectPausedDisplay(SECOND.id)); runCurrent()
        val attached = assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value)
        assertEquals(SECOND, attached.display); assertEquals(old.attachmentId, attached.attachmentId)
        assertNotEquals(old.connectionId, attached.connectionId)
        assertEquals(1, f.channel.selects); assertEquals(1, f.channel.resumes); assertEquals(1, f.channel.attaches)
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Prepare); runCurrent()
        assertTrue(f.store.media.value!!.forceRelay)
        f.store.dispatchMedia(RemoteDesktopMediaIntent.FramePresented(old.binding(), 1, 1))
        assertIs<RemoteDesktopSetupUiState.AwaitingFrame>(f.store.state.value)
        present(f); assertEquals(SECOND, assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value).display)
        f.store.close(); advanceTimeBy(500); runCurrent()
    }

    @Test fun cancellingAPendingCatalogDiscardsItsLateResultWithoutResumingOrExtendingRetention() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f); pause(f)
        val gate = CompletableDeferred<Unit>(); f.channel.catalogGate = gate
        f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent()
        assertIs<RemoteDesktopSetupUiState.LoadingDisplayChoices>(f.store.state.value)
        advanceTimeBy(40_000); runCurrent()
        f.store.dispatch(RemoteDesktopSetupIntent.CancelDisplayChange); runCurrent()
        assertIs<RemoteDesktopSetupUiState.Paused>(f.store.state.value)
        gate.complete(Unit); runCurrent(); assertIs<RemoteDesktopSetupUiState.Paused>(f.store.state.value)
        assertEquals(0, f.channel.selects); assertEquals(0, f.channel.resumes)
        advanceTimeBy(20_000); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.CONNECTION_TIMEOUT), f.store.state.value)
        assertEquals(1, f.channel.detaches)
    }

    @Test fun aCancelledCatalogCannotOverrideANewerChoiceOrItsFailure() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f); pause(f)
        val gate = CompletableDeferred<Unit>(); f.channel.catalogGate = gate
        f.channel.catalogFailure = RemoteDesktopSetupFailure.PERMISSION_REQUIRED
        f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent()
        f.store.dispatch(RemoteDesktopSetupIntent.CancelDisplayChange)
        f.channel.catalogFailure = null
        f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent()
        gate.complete(Unit); runCurrent()
        assertIs<RemoteDesktopSetupUiState.ChoosePausedDisplay>(f.store.state.value)
        assertEquals(2, f.channel.catalogReads)
        f.store.dispatch(RemoteDesktopSetupIntent.CancelDisplayChange)
        f.channel.catalogFailure = RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED
        f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED), f.store.state.value)
        assertEquals(0, f.channel.selects); assertEquals(0, f.channel.resumes)
    }

    @Test fun selectionUnknownAckGetsOneReadWithoutReplayOrFallingBackToTheOldDisplay() = runTest {
        for (applied in listOf(false, true)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f); pause(f)
            f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent()
            f.channel.unknownSelect = true; f.channel.applySelection = applied
            val reads = f.channel.reads
            f.store.dispatch(RemoteDesktopSetupIntent.SelectPausedDisplay(SECOND.id)); runCurrent()
            assertEquals(1, f.channel.selects)
            if (applied) {
                assertEquals(3, f.channel.reads - reads) // pre-select, confirmation, fresh pre-resume
                assertEquals(SECOND, assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value).display)
                assertEquals(1, f.channel.resumes)
            } else {
                assertEquals(2, f.channel.reads - reads)
                assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN), f.store.state.value)
                assertEquals(0, f.channel.resumes); assertEquals(1, f.channel.detaches)
            }
            f.store.close(); runCurrent()
        }
    }

    @Test fun closeAccountRetirementOrRetentionExpiryDuringAChoiceCannotResurrectMedia() = runTest {
        for (stage in listOf("catalog", "selection")) for (exit in listOf("close", "account", "expiry")) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f); pause(f)
            val gate = CompletableDeferred<Unit>()
            if (stage == "catalog") f.channel.catalogGate = gate
            f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent()
            if (stage == "selection") {
                f.channel.selectGate = gate
                f.store.dispatch(RemoteDesktopSetupIntent.SelectPausedDisplay(SECOND.id)); runCurrent()
            }
            when (exit) {
                "close" -> f.store.close()
                "account" -> { f.account = false; advanceTimeBy(250); runCurrent() }
                else -> { advanceTimeBy(60_000); runCurrent() }
            }
            assertNull(f.store.media.value); assertEquals(0, f.channel.detaches)
            val ended = f.store.state.value
            gate.complete(Unit); runCurrent()
            assertEquals(ended, f.store.state.value); assertEquals(0, f.channel.resumes)
            assertEquals(1, f.channel.detaches)
        }
    }

    @Test fun pauseWhileSelectingKeepsTheNewTargetPausedUntilExplicitResume() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f); pause(f)
        f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent()
        val gate = CompletableDeferred<Unit>(); f.channel.selectGate = gate
        f.store.dispatch(RemoteDesktopSetupIntent.SelectPausedDisplay(SECOND.id)); runCurrent()
        f.store.dispatch(RemoteDesktopSetupIntent.Pause); gate.complete(Unit); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Paused(SECOND), f.store.state.value)
        assertNull(f.store.media.value); assertEquals(0, f.channel.resumes)
        f.store.dispatch(RemoteDesktopSetupIntent.Resume); runCurrent()
        assertEquals(SECOND, assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value).display)
        f.store.close(); runCurrent()
    }

    @Test fun reselectingTheCurrentDisplayStillRequiresAFreshConnectionAndFirstFrame() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f); pause(f)
        f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent()
        f.store.dispatch(RemoteDesktopSetupIntent.SelectPausedDisplay(DISPLAY.id)); runCurrent()
        assertEquals(DISPLAY, assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value).display)
        assertEquals(1, f.channel.selects); assertEquals(1, f.channel.resumes); assertNull(f.store.media.value)
        f.store.close(); runCurrent()
    }

    @Test fun aDeclinedSelectionNeverRefreshesCasOrRetriesTheMutation() = runTest {
        for (failure in listOf(RemoteDesktopSetupFailure.STALE_REVISION, RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f); pause(f)
            f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent()
            val reads = f.channel.reads; f.channel.selectFailure = failure
            f.store.dispatch(RemoteDesktopSetupIntent.SelectPausedDisplay(SECOND.id)); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Failed(failure), f.store.state.value)
            assertEquals(1, f.channel.reads - reads); assertEquals(1, f.channel.selects)
            assertEquals(0, f.channel.resumes); assertEquals(1, f.channel.detaches)
        }
    }

    @Test fun selectionCannotAdoptAForeignConnectionTargetOrAttachmentOrUndrainedSource() = runTest {
        val changes: List<(RemoteDesktopSourceState) -> RemoteDesktopSourceState> = listOf(
            { it.copy(attachment = it.attachment!!.copy(connection = "foreign")) },
            { it.copy(attachment = it.attachment!!.copy(attachment = "foreign")) },
            { it.copy(attachment = it.attachment!!.copy(display = DISPLAY.id)) },
            { it.copy(suspended = false) }, { it.copy(cleanupPending = true) })
        for (change in changes) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f); pause(f)
            f.store.dispatch(RemoteDesktopSetupIntent.ChangeDisplay); runCurrent(); f.channel.selectReply = change
            f.store.dispatch(RemoteDesktopSetupIntent.SelectPausedDisplay(SECOND.id)); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN), f.store.state.value)
            assertEquals(0, f.channel.resumes); assertNull(f.store.media.value); assertEquals(1, f.channel.detaches)
        }
    }

    @Test fun renewalReusesAttachmentWaitsForDrainAndRequiresAFreshRendererAndFrame() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.renewalSupported = true; view(f)
        val old = f.store.media.value!!
        val ack = CompletableDeferred<Unit>(); f.channel.suspendGate = ack; f.channel.pendingOnSuspend = true
        renew(f)
        assertIs<RemoteDesktopSetupUiState.Suspending>(f.store.state.value)
        assertEquals(old, f.store.media.value); assertEquals(1, f.channel.suspends)
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Failed(old.binding()))
        ack.complete(Unit); runCurrent()
        assertNull(f.store.media.value); assertEquals(0, f.channel.resumes)
        f.channel.pending = false; advanceTimeBy(250); runCurrent()
        val next = assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value)
        assertEquals(old.attachmentId, next.attachmentId); assertNotEquals(old.connectionId, next.connectionId)
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Prepare); runCurrent()
        assertNotEquals(old.rendererId, f.store.media.value!!.rendererId)
        f.store.dispatchMedia(RemoteDesktopMediaIntent.FramePresented(old.binding(), 320, 180))
        assertIs<RemoteDesktopSetupUiState.AwaitingFrame>(f.store.state.value)
        present(f); advanceTimeBy(2_000); runCurrent()
        assertEquals(1, f.channel.attaches); assertEquals(1, f.channel.resumes); assertEquals(1, f.channel.suspends)
        assertEquals(0, f.channel.detaches); f.store.close(); advanceTimeBy(500); runCurrent()
    }

    @Test fun manualPauseCancelsRenewalDuringSuspendDrainOrAnAlreadySentResume() = runTest {
        for (stage in listOf("suspend", "drain", "resume")) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.renewalSupported = true; view(f)
            val ack = CompletableDeferred<Unit>()
            if (stage == "suspend") f.channel.suspendGate = ack
            if (stage == "drain") f.channel.pendingOnSuspend = true
            if (stage == "resume") f.channel.resumeGate = ack
            renew(f)
            if (stage == "resume") assertIs<RemoteDesktopSetupUiState.Resuming>(f.store.state.value)
            else assertIs<RemoteDesktopSetupUiState.Suspending>(f.store.state.value)
            f.store.dispatch(RemoteDesktopSetupIntent.Pause)
            ack.complete(Unit); f.channel.pending = false; advanceTimeBy(500); runCurrent()
            assertIs<RemoteDesktopSetupUiState.Paused>(f.store.state.value)
            assertNull(f.store.media.value)
            assertEquals(if (stage == "resume") 1 else 0, f.channel.resumes)
            assertEquals(if (stage == "resume") 2 else 1, f.channel.suspends)
            advanceTimeBy(1_000); runCurrent(); assertIs<RemoteDesktopSetupUiState.Paused>(f.store.state.value)
            f.store.close(); runCurrent()
        }
    }

    @Test fun closeOrAccountRetirementDuringRenewalCannotResurrectALateResume() = runTest {
        for (accountRetired in listOf(false, true)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.renewalSupported = true; view(f)
            val ack = CompletableDeferred<Unit>(); f.channel.resumeGate = ack; renew(f)
            assertIs<RemoteDesktopSetupUiState.Resuming>(f.store.state.value)
            if (accountRetired) { f.account = false; advanceTimeBy(250); runCurrent() } else f.store.close()
            assertNull(f.store.media.value); assertEquals(0, f.channel.detaches)
            ack.complete(Unit); runCurrent()
            if (accountRetired) assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.ACCOUNT_CHANGED), f.store.state.value)
            else assertEquals(RemoteDesktopSetupUiState.Closed, f.store.state.value)
            assertEquals(1, f.channel.detaches); assertTrue(f.channel.closed)
        }
    }

    @Test fun renewalNeedsBothCapabilitiesAndNeverRenewsAnExpiredOrUnpresentedPc() = runTest {
        for ((source, renewal) in listOf(true to false, false to true)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }
            f.channel.supported = source; f.channel.renewalSupported = renewal; view(f)
            renew(f); assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value)
            assertEquals(0, f.channel.suspends); assertEquals(0, f.channel.resumes)
            f.store.close(); advanceTimeBy(500); runCurrent()
        }
        for (presented in listOf(false, true)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.renewalSupported = true
            if (presented) view(f) else {
                f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
                f.store.dispatch(RemoteDesktopSetupIntent.SelectDisplay(DISPLAY.id, true)); runCurrent()
                f.store.dispatchMedia(RemoteDesktopMediaIntent.Prepare); runCurrent()
            }
            f.channel.hostExpiresAt = testScheduler.currentTime + if (presented) 0 else 61_000
            advanceTimeBy(2_000); runCurrent()
            if (presented) assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED), f.store.state.value)
            else assertIs<RemoteDesktopSetupUiState.AwaitingFrame>(f.store.state.value)
            assertEquals(0, f.channel.suspends); f.store.close(); advanceTimeBy(500); runCurrent()
        }
    }

    @Test fun uncertainRenewalMutationsAreReadOnceWithoutReplayAndShortNewCredentialsEndTheRebuild() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.renewalSupported = true; view(f)
        f.channel.unknownAfterApply = true; renew(f)
        assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value)
        assertEquals(1, f.channel.suspends); assertEquals(1, f.channel.resumes); assertEquals(4, f.channel.reads)
        f.channel.hostExpiresAt = testScheduler.currentTime + 60_000
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Prepare); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED), f.store.state.value)
        assertNull(f.store.media.value); assertEquals(1, f.channel.resumes); assertEquals(1, f.channel.detaches)
    }

    @Test fun renewalDrainHasAFixedDeadlineAndCannotBeExtendedByPolling() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.renewalSupported = true; view(f)
        f.channel.pendingOnSuspend = true; renew(f)
        advanceTimeBy(60_000); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.CONNECTION_TIMEOUT), f.store.state.value)
        assertNull(f.store.media.value); assertEquals(0, f.channel.resumes); assertEquals(1, f.channel.detaches)
    }

    @Test fun signalingLossInsideTheRenewalMarginCannotSendSourceMutations() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.renewalSupported = true; view(f)
        f.channel.hostExpiresAt = testScheduler.currentTime + 61_000
        advanceTimeBy(500); runCurrent() // Observe the shorter host deadline before disconnecting.
        f.channel.live = false
        f.beforeOpen = { throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.NETWORK) }
        advanceTimeBy(2_000); runCurrent()
        assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value)
        assertTrue(f.store.media.value!!.signalingInterrupted)
        assertEquals(0, f.channel.suspends); assertEquals(0, f.channel.resumes)
        f.store.close(); advanceTimeBy(500); runCurrent()
    }

    @Test fun revokedAuthorizationDuringRenewalEndsInsteadOfRetryingOrResuming() = runTest {
        for (failure in listOf(RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED, RemoteDesktopSetupFailure.PERMISSION_REQUIRED)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.renewalSupported = true; view(f)
            f.channel.sourceFailure = failure; renew(f)
            assertEquals(RemoteDesktopSetupUiState.Failed(failure), f.store.state.value)
            assertNull(f.store.media.value); assertEquals(1, f.channel.suspends); assertEquals(0, f.channel.resumes)
            assertEquals(1, f.channel.detaches)
        }
    }

    @Test fun pauseKeepsThePcUntilHostConfirmationThenWaitsForDrainAndRequiresANewFrameOnResume() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f)
        advanceTimeBy(70_000); runCurrent() // Initial setup budget must not end a later pause.
        val old = f.store.media.value!!
        val ack = CompletableDeferred<Unit>(); f.channel.suspendGate = ack; f.channel.pendingOnSuspend = true
        f.store.dispatch(RemoteDesktopSetupIntent.Pause); advanceTimeBy(500); runCurrent()
        assertIs<RemoteDesktopSetupUiState.Suspending>(f.store.state.value)
        assertNotNull(f.store.media.value)
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Failed(old.binding()))
        assertIs<RemoteDesktopSetupUiState.Suspending>(f.store.state.value)
        ack.complete(Unit); runCurrent()
        assertNull(f.store.media.value); assertIs<RemoteDesktopSetupUiState.Suspending>(f.store.state.value)
        f.store.dispatch(RemoteDesktopSetupIntent.Resume); runCurrent(); assertEquals(0, f.channel.resumes)
        f.channel.pending = false; advanceTimeBy(250); runCurrent()
        assertIs<RemoteDesktopSetupUiState.Paused>(f.store.state.value)
        f.store.dispatch(RemoteDesktopSetupIntent.Resume); runCurrent()
        val next = assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value)
        assertEquals(old.attachmentId, next.attachmentId); assertNotEquals(old.connectionId, next.connectionId)
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Prepare); runCurrent()
        f.store.dispatchMedia(RemoteDesktopMediaIntent.FramePresented(old.binding(), 10, 10))
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Failed(old.binding()))
        assertIs<RemoteDesktopSetupUiState.AwaitingFrame>(f.store.state.value)
        present(f)
        assertEquals(1, f.channel.attaches); assertEquals(1, f.channel.resumes); assertEquals(0, f.channel.detaches)
        f.store.close(); assertNull(f.store.media.value)
        advanceTimeBy(500); runCurrent(); assertEquals(1, f.channel.detaches)
    }

    @Test fun lostMutationAcksUseOneReadAndNeverReplaySuspendOrResume() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f)
        f.channel.unknownAfterApply = true
        pause(f); assertIs<RemoteDesktopSetupUiState.Paused>(f.store.state.value)
        assertEquals(2, f.channel.reads)
        f.store.dispatch(RemoteDesktopSetupIntent.Resume); runCurrent()
        assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value)
        assertEquals(4, f.channel.reads); assertEquals(1, f.channel.suspends); assertEquals(1, f.channel.resumes)
        f.store.close(); runCurrent()
    }

    @Test fun unconfirmedSourceMutationEndsInsteadOfRefreshingCasAndReplaying() = runTest {
        for (resume in listOf(false, true)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f)
            if (resume) pause(f)
            f.channel.unknownBeforeApply = true
            if (resume) { f.store.dispatch(RemoteDesktopSetupIntent.Resume); runCurrent() } else pause(f)
            assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN), f.store.state.value)
            assertEquals(1, f.channel.suspends); assertEquals(if (resume) 1 else 0, f.channel.resumes)
            assertEquals(1, f.channel.detaches); assertNull(f.store.media.value)
        }
    }

    @Test fun closeWaitsForThePendingSourceMutationAndItsLateReplyCannotReopenThePage() = runTest {
        for (resume in listOf(false, true)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f)
            val ack = CompletableDeferred<Unit>()
            if (resume) { pause(f); f.channel.resumeGate = ack; f.store.dispatch(RemoteDesktopSetupIntent.Resume); runCurrent() }
            else { f.channel.suspendGate = ack; pause(f) }
            f.store.close(); runCurrent()
            assertNull(f.store.media.value); assertEquals(0, f.channel.detaches)
            ack.complete(Unit); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Closed, f.store.state.value)
            assertEquals(1, f.channel.detaches); assertTrue(f.channel.closed)
        }
    }

    @Test fun anUnadvertisedSourceCapabilityNeverSendsTheNewOperations() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.supported = false; view(f)
        assertFalse(assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value).sourceLifecycleSupported)
        pause(f)
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.UNSUPPORTED), f.store.state.value)
        assertEquals(0, f.channel.reads); assertEquals(0, f.channel.suspends)
    }

    @Test fun pausedOrDrainingSourcesExpireWithoutAutomaticResume() = runTest {
        for (pending in listOf(false, true)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f)
            f.channel.pendingOnSuspend = pending; pause(f)
            advanceTimeBy(60_000); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.CONNECTION_TIMEOUT), f.store.state.value)
            assertNull(f.store.media.value); assertEquals(0, f.channel.resumes); assertEquals(1, f.channel.detaches)
        }
    }

    @Test fun resumeCannotReuseTheOldConnectionOrAcceptAnotherAttachment() = runTest {
        for (foreign in listOf(false, true)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; view(f); pause(f)
            f.channel.badResume = if (foreign) "foreign" else "same"
            f.store.dispatch(RemoteDesktopSetupIntent.Resume); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN), f.store.state.value)
            assertNull(f.store.media.value); assertEquals(1, f.channel.resumes); assertEquals(1, f.channel.detaches)
        }
    }

    private fun TestScope.view(f: Fixture) {
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        f.store.dispatch(RemoteDesktopSetupIntent.SelectDisplay(DISPLAY.id, true)); runCurrent()
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Prepare); runCurrent(); present(f)
    }
    private fun TestScope.pause(f: Fixture) {
        f.store.dispatch(RemoteDesktopSetupIntent.Pause); advanceTimeBy(500); runCurrent()
    }
    private fun TestScope.renew(f: Fixture) {
        f.channel.hostExpiresAt = testScheduler.currentTime + 61_000
        advanceTimeBy(2_000); runCurrent()
    }
    private fun TestScope.present(f: Fixture) {
        val media = f.store.media.value!!
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Answer(media.binding(), "answer"))
        f.store.dispatchMedia(RemoteDesktopMediaIntent.FramePresented(media.binding(), 320, 180))
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Health(media.binding(), "relay", "relay"))
        advanceTimeBy(1_000); runCurrent()
        assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value)
    }

    private class Fixture(scope: CoroutineScope, now: () -> Long) {
        var ids = 0
        var account = true
        var beforeOpen: suspend () -> Unit = {}
        val channel = Channel(now)
        val store = RemoteDesktopSetupStore(scope, { beforeOpen(); channel }, { account }, { "id-${++ids}" }, now, { 1_000_000 + now() })
    }
    private class Channel(val now: () -> Long) : RemoteDesktopSetupChannel {
        var supported = true; var closed = false; var attaches = 0; var detaches = 0
        var renewalSupported = false; var hostExpiresAt = now() + 300_000
        var controlSupported = false
        var live = true; var sourceFailure: RemoteDesktopSetupFailure? = null
        var selects = 0; var catalogReads = 0; var applySelection = true; var unknownSelect = false
        var catalogGate: CompletableDeferred<Unit>? = null; var selectGate: CompletableDeferred<Unit>? = null
        var catalogFailure: RemoteDesktopSetupFailure? = null
        var selectFailure: RemoteDesktopSetupFailure? = null
        var selectReply: (RemoteDesktopSourceState) -> RemoteDesktopSourceState = { it }
        var suspends = 0; var resumes = 0; var reads = 0; var revision = 1
        var suspended = false; var pending = false; var pendingOnSuspend = false; var answered = false
        var unknownAfterApply = false; var unknownBeforeApply = false; var badResume = ""
        var suspendGate: CompletableDeferred<Unit>? = null; var resumeGate: CompletableDeferred<Unit>? = null
        var attachment = RemoteDesktopAttachment("", "connection-1", DISPLAY.id)
        var ownedAttachment = ""
        override fun current(): Boolean = !closed && live
        override fun close() { closed = true }
        override suspend fun discover(): RemoteDesktopDirectory = RemoteDesktopDirectory("boot:1", listOf(DISPLAY),
            buildSet { if (supported) add("source_lifecycle_v1"); if (renewalSupported) add("credential_rebuild_v1"); if (controlSupported) add("ordered_control_v1") })
        override suspend fun refreshDisplays(): RemoteDesktopDirectory {
            catalogReads++; val failure = catalogFailure; catalogGate?.await(); failure?.let { throw RemoteDesktopSetupException(it) }
            return RemoteDesktopDirectory("boot:$revision", listOf(DISPLAY, SECOND))
        }
        override suspend fun attach(id: String, revision: String, display: String, forceRelay: Boolean): RemoteDesktopAttachment {
            attaches++; ownedAttachment = id; attachment = attachment.copy(attachment = id); return attachment
        }
        override suspend fun state(id: String): RemoteDesktopAttachment = attachment
        override suspend fun media(id: String): RemoteDesktopHostMedia {
            if (!current()) throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.NETWORK)
            return RemoteDesktopHostMedia(attachment, "offer-${attachment.connection}", answered, answered, true,
                if (renewalSupported) (hostExpiresAt - now()).coerceAtLeast(0) else null, answered)
        }
        override suspend fun turn(id: String): RemoteDesktopReceiverCredentials = RemoteDesktopReceiverCredentials((1_000_000 + now()) / 1000 + 300,
            listOf(RemoteDesktopIceServerUi(listOf("turn:localhost:3478"), "temporary", "temporary")))
        override suspend fun answer(id: String, connection: String, sdp: String) { assertEquals(attachment.connection, connection); answered = true }
        override fun sameIdentityAs(other: RemoteDesktopSetupChannel): Boolean = other === this
        override suspend fun sourceState(id: String): RemoteDesktopSourceState { reads++; return snapshot() }
        private fun snapshot(): RemoteDesktopSourceState = RemoteDesktopSourceState("boot:$revision", attachment, suspended, pending, answered && !suspended)
        override suspend fun selectSource(id: String, revision: String, display: String): RemoteDesktopSourceState {
            selects++; assertEquals("boot:${this.revision}", revision); assertEquals(ownedAttachment, id); selectGate?.await()
            selectFailure?.let { throw RemoteDesktopSetupException(it) }
            if (applySelection) { this.revision++; attachment = attachment.copy(display = display) }
            if (unknownSelect) throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
            return selectReply(snapshot())
        }
        override suspend fun suspendSource(id: String, revision: String): RemoteDesktopSourceState {
            suspends++; assertEquals("boot:${this.revision}", revision); suspendGate?.await()
            sourceFailure?.let { throw RemoteDesktopSetupException(it) }
            if (unknownBeforeApply) throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
            this.revision++; suspended = true; pending = pendingOnSuspend
            if (unknownAfterApply) throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
            return snapshot()
        }
        override suspend fun resumeSource(id: String, revision: String): RemoteDesktopSourceState {
            resumes++; assertEquals("boot:${this.revision}", revision); resumeGate?.await()
            if (unknownBeforeApply) throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
            this.revision++; suspended = false; answered = false
            hostExpiresAt = now() + 300_000
            attachment = when (badResume) {
                "same" -> attachment
                "foreign" -> attachment.copy(attachment = "foreign", connection = "connection-new")
                else -> attachment.copy(connection = "connection-${resumes + 1}")
            }
            if (unknownAfterApply) throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
            return snapshot()
        }
        override suspend fun detach(id: String) { assertEquals(ownedAttachment, id); detaches++ }
    }
    private fun RemoteDesktopMediaUiState.binding(): RemoteDesktopMediaBindingUi = RemoteDesktopMediaBindingUi(rendererId, attachmentId, connectionId)
    companion object {
        private val DISPLAY = RemoteDesktopDisplayUi("display", 320, 180)
        private val SECOND = RemoteDesktopDisplayUi("opaque:second/source", 640, 360)
    }
}
