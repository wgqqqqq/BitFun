package com.openbitfun.mobile.core.feature.remotedesktop

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class RemoteDesktopSetupStoreTest {
    @Test fun unavailableBundledPageFailsPreparationWithoutCreatingAnAttachment() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        f.store.dispatchMedia(RemoteDesktopMediaIntent.Unavailable); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.BACKEND_UNAVAILABLE), f.store.state.value)
        assertTrue(f.channel.closed); assertEquals(0, f.channel.attaches); assertNull(f.store.media.value)
    }

    @Test fun discoveryWaitsForExplicitDisplayChoiceAndDoesNotClaimVisibleVideo() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.ChooseDisplay(listOf(DISPLAY)), f.store.state.value)
        assertEquals(listOf("open", "discover"), f.events)
        f.store.dispatch(RemoteDesktopSetupIntent.SelectDisplay("foreign", false)); runCurrent()
        assertEquals(0, f.channel.attaches)
        f.store.dispatch(RemoteDesktopSetupIntent.SelectDisplay(DISPLAY.id, true)); runCurrent()
        val attached = assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value)
        assertEquals("attach-1", attached.attachmentId); assertEquals("connection-1", attached.connectionId)
        assertEquals(listOf(true), f.channel.forceRelay)
        f.store.dispatch(RemoteDesktopSetupIntent.Load)
        f.store.dispatch(RemoteDesktopSetupIntent.SelectDisplay(DISPLAY.id, false)); runCurrent()
        assertEquals(1, f.channel.attaches)
        f.store.close(); runCurrent()
        assertEquals(listOf("detach:attach-1", "close"), f.events.takeLast(2))
    }

    @Test fun onlyDeliveryUnknownQueriesOnceAndNeverReplaysAttach() = runTest {
        for (reason in listOf(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN, RemoteDesktopSetupFailure.STALE_REVISION,
            RemoteDesktopSetupFailure.BUSY, RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }
            f.channel.attachFailure = reason
            f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
            f.select(); runCurrent()
            assertEquals(1, f.channel.attaches)
            assertEquals(if (reason == RemoteDesktopSetupFailure.DELIVERY_UNKNOWN) 1 else 0, f.channel.stateReads)
            if (reason == RemoteDesktopSetupFailure.DELIVERY_UNKNOWN) assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value)
            else assertEquals(RemoteDesktopSetupUiState.Failed(reason), f.store.state.value)
            f.store.close(); runCurrent()
        }
    }

    @Test fun lostAckWithNoOwnedAttachmentFailsWithoutChoosingAnotherIdOrRevision() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.channel.attachFailure = RemoteDesktopSetupFailure.DELIVERY_UNKNOWN; f.channel.snapshot = null
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent(); f.select(); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN), f.store.state.value)
        assertEquals(1, f.channel.attaches); assertEquals(1, f.channel.stateReads)
        assertTrue(f.channel.closed)
    }

    @Test fun closingWaitsForTheOriginalAttachThenDetachesBeforeClosingItsChannel() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        val release = CompletableDeferred<Unit>()
        f.channel.beforeAttach = { release.await() }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent(); f.select(); runCurrent()
        f.store.close(); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Closed, f.store.state.value)
        assertFalse(f.channel.closed); assertEquals(0, f.channel.detaches)
        release.complete(Unit); runCurrent()
        assertEquals(listOf("attached", "detach:attach-1", "close"), f.events.takeLast(3))
        assertEquals(RemoteDesktopSetupUiState.Closed, f.store.state.value)
    }

    @Test fun inlineScopeCannotDetachBeforeTheAttachRequestCompletes() = runTest {
        val f = Fixture(CoroutineScope(backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler))) { testScheduler.currentTime }
        val release = CompletableDeferred<Unit>()
        f.channel.beforeAttach = { f.store.close(); release.await() }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); f.select()
        assertEquals(0, f.channel.detaches); assertFalse(f.channel.closed)
        release.complete(Unit); runCurrent()
        assertEquals(listOf("attached", "detach:attach-1", "close"), f.events.takeLast(3))
    }

    @Test fun closingDuringDiscoveryDiscardsTheLateDirectoryAndKeepsTheChannelUntilItReturns() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; val release = CompletableDeferred<Unit>()
        f.channel.beforeDiscovery = { release.await() }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent(); f.store.close(); runCurrent()
        assertFalse(f.channel.closed)
        release.complete(Unit); runCurrent()
        assertTrue(f.channel.closed); assertEquals(0, f.channel.attaches)
        assertEquals(RemoteDesktopSetupUiState.Closed, f.store.state.value)
    }

    @Test fun lateOpenedChannelIsRetiredWithoutDiscovery() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; val release = CompletableDeferred<Unit>()
        f.beforeOpen = { release.await() }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent(); f.store.close()
        release.complete(Unit); runCurrent()
        assertEquals(listOf("open", "close"), f.events)
    }

    @Test fun accountOrSocketRetirementClosesPreparationWithoutAutoReconnect() = runTest {
        for (accountChange in listOf(true, false)) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }
            f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent(); f.select(); runCurrent()
            if (accountChange) f.accountCurrent = false else f.channel.live = false
            advanceTimeBy(250); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.ACCOUNT_CHANGED), f.store.state.value)
            assertTrue(f.channel.closed); assertEquals(1, f.opens)
            assertEquals(0, f.channel.detaches, "Never clean an old attachment through a replacement binding")
        }
    }

    @Test fun explicitRetryWaitsForOldDetachAndUsesFreshDiscoveryAndAttachment() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }; val release = CompletableDeferred<Unit>()
        f.channel.beforeDetach = { release.await() }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent(); f.select(); runCurrent()
        f.store.close(); runCurrent()
        val old = f.channel; f.channel = FakeChannel(f.events) { f.accountCurrent }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        assertEquals(1, f.opens)
        release.complete(Unit); runCurrent()
        assertTrue(old.closed); assertEquals(2, f.opens)
        f.select(); runCurrent()
        assertEquals("attach-2", assertIs<RemoteDesktopSetupUiState.Attached>(f.store.state.value).attachmentId)
        f.store.close(); runCurrent()
    }

    @Test fun wrongAttachmentOrDisplayNeverBecomesAttached() = runTest {
        for (snapshot in listOf(RemoteDesktopAttachment("foreign", "connection-1", DISPLAY.id),
            RemoteDesktopAttachment("attach-1", "connection-1", "another-display"))) {
            val f = Fixture(backgroundScope) { testScheduler.currentTime }; f.channel.snapshot = snapshot
            f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent(); f.select(); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.INVALID_RESPONSE), f.store.state.value)
            assertTrue(f.channel.closed)
        }
    }

    @Test fun abandonedSetupExpiresAndDetachFailureStillRetiresTheChannel() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.channel.beforeDetach = { error("private remote error must not escape") }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent(); f.select(); runCurrent()
        advanceTimeBy(60_000); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.CONNECTION_TIMEOUT), f.store.state.value)
        assertTrue(f.channel.closed)
    }

    @Test fun disposingTheUiScopeClosesAnIdlePreparedChannel() = runTest {
        val parent = SupervisorJob(backgroundScope.coroutineContext[Job])
        val f = Fixture(CoroutineScope(backgroundScope.coroutineContext + parent)) { testScheduler.currentTime }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        parent.cancel(); runCurrent()
        assertTrue(f.channel.closed); assertEquals(RemoteDesktopSetupUiState.Closed, f.store.state.value)
    }

    @Test fun cancellingScopeDoesNotMistakeACancellingAttachForACompletedOne() = runTest {
        val parent = SupervisorJob(backgroundScope.coroutineContext[Job])
        val f = Fixture(CoroutineScope(backgroundScope.coroutineContext + parent)) { testScheduler.currentTime }
        val release = CompletableDeferred<Unit>()
        f.channel.beforeAttach = { withContext(NonCancellable) { release.await() } }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent(); f.select(); runCurrent()
        parent.cancel(); runCurrent()
        assertEquals(0, f.channel.detaches); assertFalse(f.channel.closed)
        release.complete(Unit); runCurrent()
        assertEquals(listOf("attached", "detach:attach-1", "close"), f.events.takeLast(3))
        assertEquals(RemoteDesktopSetupUiState.Closed, f.store.state.value)
    }

    @Test fun detachTimeoutRetiresTheOriginalChannelBeforeExplicitRetryCanOpenAnother() = runTest {
        val f = Fixture(backgroundScope) { testScheduler.currentTime }
        f.channel.beforeDetach = { awaitCancellation() }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent(); f.select(); runCurrent()
        f.store.close(); runCurrent()
        val old = f.channel; f.channel = FakeChannel(f.events) { f.accountCurrent }
        f.store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        assertEquals(1, f.opens); assertFalse(old.closed)
        advanceTimeBy(10_000); runCurrent()
        assertTrue(old.closed); assertEquals(2, f.opens)
        assertIs<RemoteDesktopSetupUiState.ChooseDisplay>(f.store.state.value)
        f.store.close(); runCurrent()
    }

    private class Fixture(scope: CoroutineScope, now: () -> Long) {
        var accountCurrent = true; var opens = 0; var ids = 0
        val events = mutableListOf<String>(); var channel = FakeChannel(events) { accountCurrent }
        var beforeOpen: suspend () -> Unit = {}
        val store = RemoteDesktopSetupStore(scope, { opens++; events += "open"; beforeOpen(); channel },
            { accountCurrent }, { "attach-${++ids}" }, now, { 1_000_000 + now() })
        fun select() { store.dispatch(RemoteDesktopSetupIntent.SelectDisplay(DISPLAY.id, true)) }
    }

    private class FakeChannel(val events: MutableList<String>, val authority: () -> Boolean) : RemoteDesktopSetupChannel {
        var live = true; var closed = false; var attaches = 0; var detaches = 0; var stateReads = 0
        var attachFailure: RemoteDesktopSetupFailure? = null
        var snapshot: RemoteDesktopAttachment? = RemoteDesktopAttachment("attach-1", "connection-1", DISPLAY.id)
        var beforeDiscovery: suspend () -> Unit = {}; var beforeAttach: suspend () -> Unit = {}; var beforeDetach: suspend () -> Unit = {}
        val forceRelay = mutableListOf<Boolean>()
        override fun current(): Boolean = live && !closed && authority()
        override fun close() { events += "close"; closed = true }
        override suspend fun discover(): RemoteDesktopDirectory {
            events += "discover"; beforeDiscovery(); return RemoteDesktopDirectory("boot:2", listOf(DISPLAY))
        }
        override suspend fun attach(id: String, revision: String, display: String, forceRelay: Boolean): RemoteDesktopAttachment {
            assertEquals("boot:2", revision); attaches++; this.forceRelay += forceRelay; events += "attach:$id"
            beforeAttach(); events += "attached"
            attachFailure?.let { throw RemoteDesktopSetupException(it) }
            return snapshot!!.let { if (it.attachment == "attach-1") it.copy(attachment = id) else it }
        }
        override suspend fun state(id: String): RemoteDesktopAttachment? { stateReads++; return snapshot }
        override suspend fun media(id: String): RemoteDesktopHostMedia = error("No renderer was prepared")
        override suspend fun turn(id: String): RemoteDesktopReceiverCredentials = error("No renderer was prepared")
        override suspend fun answer(id: String, connection: String, sdp: String) { error("No renderer was prepared") }
        override fun sameIdentityAs(other: RemoteDesktopSetupChannel): Boolean = other === this
        override suspend fun detach(id: String) { detaches++; events += "detach:$id"; beforeDetach() }
    }

    companion object { private val DISPLAY = RemoteDesktopDisplayUi("display:opaque", 1512, 982) }
}
