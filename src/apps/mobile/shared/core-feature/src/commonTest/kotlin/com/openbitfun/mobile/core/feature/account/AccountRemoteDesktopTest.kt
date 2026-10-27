package com.openbitfun.mobile.core.feature.account

import com.openbitfun.mobile.core.feature.remotedesktop.*
import com.openbitfun.mobile.core.persistence.SecureStore
import com.openbitfun.mobile.core.transport.RemoteCommandTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.*
import kotlin.test.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class AccountRemoteDesktopTest {
    @Test fun backgroundCannotCreateANewOwnerAndExplicitForegroundReconnectGetsAFreshStore() = runTest {
        val f = Fixture(backgroundScope); f.login(); runCurrent()
        val first = assertNotNull(f.account.createRemoteDesktopSetupStore(backgroundScope, "desktop-b"))
        first.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        f.account.setForeground(false)
        assertNull(f.account.createRemoteDesktopSetupStore(backgroundScope, "desktop-b"))
        f.account.setForeground(true)
        assertEquals(RemoteDesktopSetupUiState.Closed, first.state.value)
        val next = assertNotNull(f.account.createRemoteDesktopSetupStore(backgroundScope, "desktop-b"))
        next.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        assertNotSame(first, next)
        assertIs<RemoteDesktopSetupUiState.ChooseDisplay>(next.state.value)
        f.account.stop(); runCurrent()
    }

    @Test fun aReplacementWaitsForTheOriginalAttachAndDetachBeforeOpeningItsChannel() = runTest {
        for (invalidateWaitingOwner in listOf(false, true)) {
            val f = Fixture(backgroundScope); f.login(); runCurrent()
            val first = assertNotNull(f.account.createRemoteDesktopSetupStore(backgroundScope, "desktop-b"))
            first.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
            val channel = f.backend.channels.single()
            val attached = CompletableDeferred<Unit>(); val detached = CompletableDeferred<Unit>()
            channel.attachGate = attached; channel.detachGate = detached
            first.dispatch(RemoteDesktopSetupIntent.SelectDisplay("screen", false)); runCurrent()
            val next = assertNotNull(f.account.createRemoteDesktopSetupStore(backgroundScope, "desktop-a"))
            next.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Probing, next.state.value)
            assertEquals(listOf("desktop-b"), f.backend.targets)
            attached.complete(Unit); runCurrent()
            assertEquals(1, channel.detaches)
            assertEquals(listOf("desktop-b"), f.backend.targets)
            if (invalidateWaitingOwner) f.account.dispatch(AccountIntent.Logout)
            detached.complete(Unit); runCurrent()
            assertTrue(channel.closed)
            if (invalidateWaitingOwner) {
                assertEquals(listOf("desktop-b"), f.backend.targets)
                assertEquals(RemoteDesktopSetupUiState.Closed, next.state.value)
            } else {
                assertEquals(listOf("desktop-b", "desktop-a"), f.backend.targets)
                assertIs<RemoteDesktopSetupUiState.ChooseDisplay>(next.state.value)
            }
            f.account.stop(); runCurrent()
        }
    }

    @Test fun setupRequiresAuthenticatedDesktopMembershipAndProbesLegacyRowsSeparatelyFromAgentCompatibility() = runTest {
        val f = Fixture(backgroundScope)
        assertNull(f.account.createRemoteDesktopSetupStore(backgroundScope, "desktop-b"))
        f.login(); runCurrent()
        for (id in listOf("foreign", "self", "cli", "phone", "offline")) {
            assertNull(f.account.createRemoteDesktopSetupStore(backgroundScope, id), id)
        }
        // The dedicated RD version/capability handshake decides compatibility.
        for (id in listOf("desktop-b", "legacy")) {
            val store = assertNotNull(f.account.createRemoteDesktopSetupStore(backgroundScope, id))
            store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
            assertIs<RemoteDesktopSetupUiState.ChooseDisplay>(store.state.value)
            store.close(); runCurrent()
        }
        assertEquals(listOf("desktop-b", "legacy"), f.backend.targets)
        assertEquals(0, f.backend.agentTransports)
        f.account.stop()
    }

    @Test fun remoteDesktopTargetDoesNotChangeChatSelectionAndLogoutRetiresItsOwnerImmediately() = runTest {
        val f = Fixture(backgroundScope); f.login(); runCurrent()
        f.account.dispatch(AccountIntent.SelectDevice("desktop-a")); runCurrent()
        val store = assertNotNull(f.account.createRemoteDesktopSetupStore(backgroundScope, "desktop-b"))
        store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        assertEquals("desktop-a", assertIs<AccountUiState.Ready>(f.account.state.value).selectedDeviceId)
        assertEquals(listOf("desktop-b"), f.backend.targets)
        f.account.dispatch(AccountIntent.Logout)
        assertEquals(RemoteDesktopSetupUiState.Closed, store.state.value)
        runCurrent(); assertTrue(f.backend.channels.single().closed)
        store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.ACCOUNT_CHANGED), store.state.value)
        assertEquals(1, f.backend.targets.size)
    }

    @Test fun backgroundStopRelayChangeAndReplacementDoNotPermitAnOldStoreToReopen() = runTest {
        for (action in listOf("background", "stop", "relay", "replacement")) {
            val f = Fixture(backgroundScope); f.login(); runCurrent()
            val store = assertNotNull(f.account.createRemoteDesktopSetupStore(backgroundScope, "desktop-b"))
            store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
            when (action) {
                "background" -> { f.account.setForeground(false); f.account.setForeground(true) }
                "stop" -> f.account.stop()
                "relay" -> f.account.dispatch(AccountIntent.SelectRelay("http://127.0.0.1:19703"))
                "replacement" -> assertNotNull(f.account.createRemoteDesktopSetupStore(backgroundScope, "desktop-a"))
            }
            assertEquals(RemoteDesktopSetupUiState.Closed, store.state.value, action)
            runCurrent(); assertTrue(f.backend.channels.single().closed)
            store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
            assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.ACCOUNT_CHANGED), store.state.value, action)
            assertEquals(1, f.backend.targets.size)
            f.account.stop(); runCurrent()
        }
    }

    @Test fun disposingTheAccountOwnerRetiresRemoteDesktopEvenWithASeparateUiScope() = runTest {
        val parent = SupervisorJob(backgroundScope.coroutineContext[Job])
        val f = Fixture(CoroutineScope(backgroundScope.coroutineContext + parent)); f.login(); runCurrent()
        val store = assertNotNull(f.account.createRemoteDesktopSetupStore(backgroundScope, "desktop-b"))
        store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        parent.cancel(); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Closed, store.state.value)
        assertTrue(f.backend.channels.single().closed)
        store.dispatch(RemoteDesktopSetupIntent.Load); runCurrent()
        assertEquals(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.ACCOUNT_CHANGED), store.state.value)
        assertEquals(1, f.backend.targets.size)
    }

    private class Fixture(scope: CoroutineScope) {
        val backend = Backend()
        val account = AccountStore.create(scope, backend, object : SecureStore {
            val values = mutableMapOf<String, ByteArray>()
            override fun read(key: String): ByteArray? = values[key]?.copyOf()
            override fun write(key: String, value: ByteArray) { values[key] = value.copyOf() }
            override fun delete(key: String) { values.remove(key) }
        }, "self", "Test controller")
        fun login() { account.dispatch(AccountIntent.Login) }
    }

    private class Backend : AccountBackend {
        val targets = mutableListOf<String>(); val channels = mutableListOf<Channel>(); var agentTransports = 0
        override suspend fun login(relayUrl: String, deviceId: String, deviceName: String, deviceSecret: ByteArray,
            onAuthorization: (String) -> Unit): AccountSessionData =
            AccountSessionData(relayUrl, "test", "private-token", "account", ByteArray(32), null, null)
        override suspend fun listDevices(session: AccountSessionData, selfDeviceId: String): List<AccountDeviceUi> = listOf(
            AccountDeviceUi("self", "Self", true, null, null, "desktop"),
            AccountDeviceUi("desktop-a", "Desktop", true, null, true, "desktop"),
            AccountDeviceUi("desktop-b", "Another Desktop", true, null, false, "desktop"),
            AccountDeviceUi("legacy", "Legacy host", true, null),
            AccountDeviceUi("cli", "CLI host", true, null, true, "cli"),
            AccountDeviceUi("phone", "Phone", true, null, true, "mobile"),
            AccountDeviceUi("offline", "Offline", false, null, true, "desktop"),
        )
        override fun transport(session: AccountSessionData, targetDeviceId: String): RemoteCommandTransport {
            agentTransports++; error("Remote desktop must not create an Agent transport")
        }
        override suspend fun remoteDesktop(session: AccountSessionData, targetDeviceId: String): RemoteDesktopSetupChannel {
            targets += targetDeviceId
            return Channel().also { channels += it }
        }
    }
    private class Channel : RemoteDesktopSetupChannel {
        var closed = false
        var attachGate: CompletableDeferred<Unit>? = null
        var detachGate: CompletableDeferred<Unit>? = null
        var detaches = 0
        override fun current(): Boolean = !closed
        override fun close() { closed = true }
        override suspend fun discover(): RemoteDesktopDirectory = RemoteDesktopDirectory("boot:1", listOf(RemoteDesktopDisplayUi("screen", 100, 100)))
        override suspend fun attach(id: String, revision: String, display: String, forceRelay: Boolean): RemoteDesktopAttachment {
            attachGate?.await()
            return RemoteDesktopAttachment(id, "connection", display)
        }
        override suspend fun state(id: String): RemoteDesktopAttachment? = error("Unexpected state query")
        override suspend fun media(id: String): RemoteDesktopHostMedia = error("No renderer was prepared")
        override suspend fun turn(id: String): RemoteDesktopReceiverCredentials = error("No renderer was prepared")
        override suspend fun answer(id: String, connection: String, sdp: String) { error("No renderer was prepared") }
        override fun sameIdentityAs(other: RemoteDesktopSetupChannel): Boolean = other === this
        override suspend fun detach(id: String) { detaches++; detachGate?.await() }
    }
}
