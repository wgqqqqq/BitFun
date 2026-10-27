package com.openbitfun.mobile.core.feature.remotedesktop

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class RemoteDesktopMediaSessionTest {
    @Test fun hostSourceAndActualPresentationMayArriveInEitherOrder() = runTest {
        for (frameFirst in listOf(true, false)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }
            f.start(); runCurrent(); prepare(f); runCurrent()
            assertIs<RemoteDesktopSetupUiState.AwaitingFrame>(f.store.state.value)
            val config = assertNotNull(f.store.media.value)
            assertFalse(config.toString().contains("private-offer"))
            assertFalse(config.iceServers.single().toString().contains("private-secret"))
            f.answer(); advanceTimeBy(500); runCurrent()
            if (frameFirst) f.frame()
            f.channel.snapshot = f.channel.snapshot.copy(sourceFirstFrame = true)
            advanceTimeBy(500); runCurrent()
            if (!frameFirst) assertIs<RemoteDesktopSetupUiState.AwaitingFrame>(f.store.state.value)
            if (!frameFirst) f.frame()
            assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value)
            assertTrue(f.store.media.value!!.sourceReady)
            f.store.close(); runCurrent()
        }
    }

    @Test fun forcedTurnWaitsForVerifiedRelayAndRejectsExplicitDirectCandidates() = runTest {
        for (candidate in listOf("relay", "host", "unknown")) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.forceRelay = true
            f.start(); runCurrent(); prepare(f); runCurrent(); f.answer()
            f.channel.snapshot = f.channel.snapshot.copy(sourceFirstFrame = true)
            advanceTimeBy(500); runCurrent(); f.frame()
            assertIs<RemoteDesktopSetupUiState.AwaitingFrame>(f.store.state.value)
            f.store.dispatchMedia(RemoteDesktopMediaIntent.Health(f.binding(), candidate, "relay")); runCurrent()
            if (candidate == "relay") assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value)
            else if (candidate == "unknown") {
                assertIs<RemoteDesktopSetupUiState.AwaitingFrame>(f.store.state.value)
                assertNotNull(f.store.media.value)
                f.store.dispatchMedia(RemoteDesktopMediaIntent.Health(f.binding(), "relay", "relay"))
                assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value)
            }
            else {
                assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.RELAY_NOT_SELECTED), f.store.state.value)
                assertNull(f.store.media.value)
            }
            f.store.close(); runCurrent()
        }
    }

    @Test fun closeDuringTurnNeverPublishesLateCredentialsOrStartsARenderer() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; val release = CompletableDeferred<Unit>()
        f.channel.beforeTurn = { release.await() }
        f.start(); runCurrent(); prepare(f); runCurrent(); f.store.close()
        assertNull(f.store.media.value); assertEquals(0, f.channel.detaches)
        release.complete(Unit); runCurrent()
        assertNull(f.store.media.value); assertTrue(f.channel.closed); assertEquals(1, f.channel.detaches)
    }

    @Test fun closingDuringAnswerClearsMediaImmediatelyAndWaitsBeforeDetach() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; val release = CompletableDeferred<Unit>()
        f.channel.beforeAnswer = { release.await() }
        f.start(); runCurrent(); prepare(f); runCurrent(); f.answer(); advanceTimeBy(500); runCurrent()
        assertEquals(1, f.channel.answers)
        f.store.close(); assertNull(f.store.media.value); runCurrent()
        assertEquals(0, f.channel.detaches)
        release.complete(Unit); runCurrent()
        assertEquals(listOf("answer-finished", "detach", "close"), f.channel.events.takeLast(3))
    }

    @Test fun oldRendererEventsAndConflictingAnswersCannotChangeTheCurrentConnection() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.start(); runCurrent(); prepare(f); runCurrent()
        val old = f.binding().copy(rendererId = "old-renderer")
        f.store.dispatchMedia(RemoteDesktopMediaIntent.FramePresented(old, 100, 100))
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Failed(old))
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Answer(old, "old answer"))
        advanceTimeBy(500); runCurrent(); assertEquals(0, f.channel.answers)
        f.answer(); f.answer(); advanceTimeBy(500); runCurrent(); assertEquals(1, f.channel.answers)
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Answer(f.binding(), "different answer")); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.INVALID_RESPONSE), f.store.state.value)
        assertNull(f.store.media.value)
    }

    @Test fun lostAnswerAckReadsAuthoritativeStateWithoutResendingSdp() = runTest {
        for (accepted in listOf(true, false)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }
            f.channel.answerUnknown = true; f.channel.acceptAnswer = accepted
            f.start(); runCurrent(); prepare(f); runCurrent(); f.answer()
            advanceTimeBy(500); runCurrent()
            assertEquals(1, f.channel.answers)
            if (accepted) assertIs<RemoteDesktopSetupUiState.AwaitingFrame>(f.store.state.value)
            else assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN), f.store.state.value)
            f.store.close(); runCurrent()
        }
    }

    @Test fun credentialExpirationClosesMediaEvenWhileAStateReadIsBlocked() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.start(); runCurrent(); prepare(f); runCurrent()
        f.channel.snapshot = f.channel.snapshot.copy(remainingMs = 1000)
        advanceTimeBy(500); runCurrent()
        val release = CompletableDeferred<Unit>(); f.channel.beforePoll = { release.await() }
        advanceTimeBy(500); runCurrent(); advanceTimeBy(500); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED), f.store.state.value)
        assertNull(f.store.media.value); assertEquals(0, f.channel.detaches)
        release.complete(Unit); runCurrent(); assertTrue(f.channel.closed)
    }

    @Test fun presentedVideoHasAFixedThirtySecondRelayGraceAndNeverReattachesAutomatically() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.start(); runCurrent(); prepare(f); runCurrent(); f.answer()
        f.channel.snapshot = f.channel.snapshot.copy(sourceFirstFrame = true)
        advanceTimeBy(500); runCurrent(); f.frame()
        val old = f.channel; old.epochLive = false
        f.beforeOpen = { throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.NETWORK) }
        advanceTimeBy(250); runCurrent(); assertTrue(f.store.media.value!!.signalingInterrupted)
        assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value)
        advanceTimeBy(29_999); runCurrent(); assertNotNull(f.store.media.value)
        advanceTimeBy(1); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.NETWORK), f.store.state.value)
        assertNull(f.store.media.value); assertEquals(1, old.attaches)
    }

    @Test fun relayRecoveryRevalidatesIdentityAndAttachmentWhileKeepingTheSamePcAndDeadline() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.channel.snapshot = f.channel.snapshot.copy(remainingMs = 120_000)
        f.start(); runCurrent(); prepare(f); runCurrent(); f.answer()
        f.channel.snapshot = f.channel.snapshot.copy(sourceFirstFrame = true)
        advanceTimeBy(500); runCurrent(); f.frame()
        val binding = f.binding(); val old = f.channel
        f.channel = Channel(f.now).also { it.snapshot = old.snapshot.copy(remainingMs = 300_000, streaming = true) }
        old.epochLive = false
        advanceTimeBy(1000); runCurrent()
        assertEquals(binding, f.binding()); assertFalse(f.store.media.value!!.signalingInterrupted); assertTrue(old.closed)
        assertEquals(0, f.channel.attaches); assertEquals(0, f.channel.turns); assertEquals(0, f.channel.answers)
        advanceTimeBy(120_000); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED), f.store.state.value)
        assertNull(f.store.media.value)
    }

    @Test fun rotatedPeerOrChangedConnectionCannotRecoverOldVideo() = runTest {
        for (keyChanged in listOf(true, false)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }
            f.start(); runCurrent(); prepare(f); runCurrent(); f.answer()
            f.channel.snapshot = f.channel.snapshot.copy(sourceFirstFrame = true)
            advanceTimeBy(500); runCurrent(); f.frame()
            val old = f.channel
            f.channel = Channel(f.now).also {
                it.snapshot = old.snapshot.copy(streaming = true)
                if (keyChanged) it.peer = "rotated-key" else it.snapshot = it.snapshot.copy(attachment = ATTACHMENT.copy(connection = "new-pc"))
            }
            old.epochLive = false; advanceTimeBy(1000); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Failed(if (keyChanged) RemoteDesktopSetupFailure.DEVICE_IDENTITY_CHANGED else RemoteDesktopSetupFailure.TARGET_UNAVAILABLE), f.store.state.value)
            assertTrue(f.channel.closed); assertNull(f.store.media.value); assertEquals(0, f.channel.attaches)
        }
    }

    @Test fun accountChangeNeverUsesTheVideoGraceOrOpensAnotherChannel() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.start(); runCurrent(); prepare(f); runCurrent(); f.answer()
        f.channel.snapshot = f.channel.snapshot.copy(sourceFirstFrame = true)
        advanceTimeBy(500); runCurrent(); f.frame()
        f.account = false; advanceTimeBy(250); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.ACCOUNT_CHANGED), f.store.state.value)
        assertNull(f.store.media.value); assertEquals(1, f.opens)
    }

    @Test fun missingRequiredBudgetAndNearExpiryCredentialsNeverStartARenderer() = runTest {
        for (remaining in listOf<Long?>(null, 60_000)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }
            f.channel.snapshot = f.channel.snapshot.copy(remainingMs = remaining)
            f.start(); runCurrent(); prepare(f); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Failed(if (remaining == null) RemoteDesktopSetupFailure.INVALID_RESPONSE else RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED), f.store.state.value)
            assertNull(f.store.media.value)
        }
    }

    @Test fun absentPresentationHasABoundedSetupAndInvalidSizesFailImmediately() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.start(); runCurrent(); prepare(f); runCurrent(); f.answer()
        f.channel.snapshot = f.channel.snapshot.copy(sourceFirstFrame = true)
        advanceTimeBy(60_000); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.CONNECTION_TIMEOUT), f.store.state.value)
        assertNull(f.store.media.value)
        val g = Fixture(backgroundScope) { testScheduler.currentTime }
        g.start(); runCurrent(); prepare(g); runCurrent()
        g.store.dispatchMedia(RemoteDesktopMediaIntent.FramePresented(g.binding(), 0, 828))
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.INVALID_RESPONSE), g.store.state.value)
        assertNull(g.store.media.value)
    }

    @Test fun closingDuringRecoveryRetiresTheLateChannelWithoutRevivingTheRenderer() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.start(); runCurrent(); prepare(f); runCurrent(); f.answer()
        f.channel.snapshot = f.channel.snapshot.copy(sourceFirstFrame = true)
        advanceTimeBy(500); runCurrent(); f.frame()
        val old = f.channel; val release = CompletableDeferred<Unit>()
        f.channel = Channel(f.now).also { it.snapshot = old.snapshot.copy(streaming = true) }
        f.beforeOpen = { release.await() }; old.epochLive = false
        advanceTimeBy(1000); runCurrent()
        f.store.close(); assertNull(f.store.media.value)
        release.complete(Unit); runCurrent()
        assertTrue(f.channel.closed); assertEquals(0, f.channel.attaches); assertEquals(0, f.channel.turns)
        assertEquals(RemoteDesktopSetupUiState.Closed, f.store.state.value)
    }

    @Test fun aNewEpochLostBeforeInstallationCannotClearTheOriginalSignalingGrace() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.start(); runCurrent(); prepare(f); runCurrent(); f.answer()
        f.channel.snapshot = f.channel.snapshot.copy(sourceFirstFrame = true)
        advanceTimeBy(500); runCurrent(); f.frame()
        val old = f.channel
        f.channel = Channel(f.now).also { fresh ->
            fresh.snapshot = old.snapshot.copy(streaming = true)
            fresh.beforePoll = { fresh.epochLive = false }
        }
        old.epochLive = false; advanceTimeBy(1000); runCurrent()
        assertTrue(f.store.media.value!!.signalingInterrupted)
        assertFalse(old.closed); assertTrue(f.channel.closed)
        assertIs<RemoteDesktopSetupUiState.Viewing>(f.store.state.value)
        f.store.close(); runCurrent()
    }

    @Test fun aFrameAtExpirationCannotBeatTheScheduledDeadlineCheck() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.start(); runCurrent(); prepare(f); runCurrent(); f.answer()
        f.channel.snapshot = f.channel.snapshot.copy(sourceFirstFrame = true, remainingMs = 1000)
        advanceTimeBy(500); runCurrent()
        advanceTimeBy(1000)
        f.frame()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED), f.store.state.value)
        assertNull(f.store.media.value)
        runCurrent()
    }

    private fun TestScope.prepare(f: Fixture) {
        f.select()
        runCurrent()
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Prepare)
    }

    private class Fixture(scope: CoroutineScope, val now: () -> Long) {
        var channel = Channel(now); var account = true; var opens = 0; var ids = 0; var forceRelay = false
        var beforeOpen: suspend () -> Unit = {}
        val store = RemoteDesktopSetupStore(scope, { opens++; beforeOpen(); channel }, { account },
            { "id-${++ids}" }, now, { 1_000_000 + now() })
        fun start() { store.dispatch(RemoteDesktopSetupIntent.Load) }
        fun select() { store.dispatch(RemoteDesktopSetupIntent.SelectDisplay(DISPLAY.id, forceRelay)) }
        fun binding(): RemoteDesktopMediaBindingUi = store.media.value!!.let { RemoteDesktopMediaBindingUi(it.rendererId, it.attachmentId, it.connectionId) }
        fun answer() { store.dispatchMedia(RemoteDesktopMediaIntent.Answer(binding(), "private-answer")) }
        fun frame() { store.dispatchMedia(RemoteDesktopMediaIntent.FramePresented(binding(), 1280, 828)) }
    }

    private class Channel(val now: () -> Long) : RemoteDesktopSetupChannel {
        var closed = false; var epochLive = true; var peer = "fixed-peer"
        var attaches = 0; var turns = 0; var answers = 0; var detaches = 0; val events = mutableListOf<String>()
        var answerUnknown = false; var acceptAnswer = true
        var beforePoll: suspend () -> Unit = {}; var beforeTurn: suspend () -> Unit = {}; var beforeAnswer: suspend () -> Unit = {}
        var snapshot = RemoteDesktopHostMedia(ATTACHMENT, "private-offer", false, false, false, 300_000, false)
        override fun current(): Boolean = !closed && epochLive
        override fun close() { closed = true; events += "close" }
        override fun sameIdentityAs(other: RemoteDesktopSetupChannel): Boolean = other is Channel && other.peer == peer
        override suspend fun discover(): RemoteDesktopDirectory = RemoteDesktopDirectory("boot:1", listOf(DISPLAY), setOf("credential_rebuild_v1"))
        override suspend fun attach(id: String, revision: String, display: String, forceRelay: Boolean): RemoteDesktopAttachment {
            attaches++; snapshot = snapshot.copy(attachment = ATTACHMENT.copy(attachment = id), forceRelay = forceRelay)
            return snapshot.attachment!!
        }
        override suspend fun state(id: String): RemoteDesktopAttachment? = snapshot.attachment
        override suspend fun media(id: String): RemoteDesktopHostMedia {
            if (!current()) throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.ACCOUNT_CHANGED)
            beforePoll(); return snapshot
        }
        override suspend fun turn(id: String): RemoteDesktopReceiverCredentials {
            turns++; beforeTurn()
            return RemoteDesktopReceiverCredentials((1_000_000 + now()) / 1000 + 300,
                listOf(RemoteDesktopIceServerUi(listOf("turn:relay.invalid:3478?transport=udp"), "private-user", "private-secret")))
        }
        override suspend fun answer(id: String, connection: String, sdp: String) {
            answers++; beforeAnswer(); events += "answer-finished"
            snapshot = snapshot.copy(answerAccepted = acceptAnswer)
            if (answerUnknown) throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
        }
        override suspend fun detach(id: String) { detaches++; events += "detach" }
    }

    companion object {
        private val DISPLAY = RemoteDesktopDisplayUi("display", 1512, 982)
        private val ATTACHMENT = RemoteDesktopAttachment("id-1", "pc-1", DISPLAY.id)
    }
}
