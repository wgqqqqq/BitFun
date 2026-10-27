package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.crypto.CloudAccountCipher
import com.openbitfun.mobile.core.crypto.DeviceIdentity
import com.openbitfun.mobile.core.protocol.EncryptedPayload
import com.openbitfun.mobile.core.protocol.RelayJson
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.io.encoding.Base64
import kotlin.test.*
import kotlin.time.Clock

class RemoteDesktopAccountChannelTest {
    @Test
    fun aFreshEpochMustMatchTheOriginalAccountObjectTargetAndPinnedPeer() = channelTest { f ->
        val old = f.open()
        f.bindings.single().close()
        assertFalse(old.current())
        val fresh = f.open()
        assertTrue(fresh.current()); assertTrue(old.sameIdentityAs(fresh))
        f.peerPublic = DeviceIdentity.publicKey(ByteArray(32) { 17 })
        val rotated = f.open()
        assertFalse(old.sameIdentityAs(rotated))
        f.client.deviceDirectoryChanges(BASE, CloudAccountSession("new-token", "another-account", ByteArray(32)))
        assertFalse(old.sameIdentityAs(fresh))
        assertEquals(0, f.signals)
        old.close(); fresh.close()
    }

    @Test
    fun discoversAndPinsAFreshPeerAndEncryptsEachCallWithANewNonce() = channelTest { f ->
        val channel = f.open()
        val request = buildJsonObject { put("version", 1); put("op", "capabilities"); put("private_fixture", "do not log") }
        val first = channel.call(request, null); val second = channel.call(request, null)
        assertEquals("future", first["unknown_field"]?.jsonPrimitive?.content)
        assertEquals(first, second)
        assertEquals(listOf(request, request), f.plainRequests)
        assertNotEquals(f.nonces[0], f.nonces[1])
        assertEquals(3, f.keyReads, "One initial pin plus a fresh identity check for each reply")
        assertEquals(0, f.genericCalls)
        channel.close(); assertFalse(channel.current()); assertFalse(f.sockets.single().closed)
        assertTrue(f.client.listDevices(BASE, f.session, "phone").isEmpty(), "Closing the dedicated HTTP view must preserve the account client")
    }

    @Test
    fun oldRelayWithoutCapabilitiesNeverReadsAKeyOrInvokesAHost() = channelTest { f ->
        f.info = buildJsonObject { put("legacy", true) }.toString()
        assertEquals(RemoteDesktopTransportFailure.RELAY_UPGRADE_REQUIRED, f.openFailure())
        assertEquals(0, f.keyReads); assertEquals(0, f.prepared); assertEquals(0, f.signals)
    }

    @Test
    fun turnAndCredentialBindingCapabilitiesAreBothRequired() = channelTest { f ->
        f.info = """{"capabilities":["remote_desktop_route_v1"]}"""
        assertEquals(RemoteDesktopTransportFailure.TURN_UNAVAILABLE, f.openFailure())
        assertEquals(0, f.prepared)
    }

    @Test
    fun insecureEndpointsAreRefusedBeforeCreatingAnAccountSocket() = channelTest { f ->
        val error = assertFailsWith<RemoteDesktopTransportException> {
            f.client.remoteDesktopChannel("http://192.168.1.2", f.session, TARGET)
        }
        assertEquals(RemoteDesktopTransportFailure.HTTPS_REQUIRED, error.failure)
        assertTrue(f.sockets.isEmpty()); assertTrue(f.paths.isEmpty())
    }

    @Test
    fun oversizedMetadataAndRedirectsCannotMoveTokensOrOpenSignalBindings() = channelTest { f ->
        f.info = "x".repeat(16 * 1024 + 1)
        assertEquals(RemoteDesktopTransportFailure.INVALID_RESPONSE, f.openFailure())
        f.redirect = true
        assertEquals(RemoteDesktopTransportFailure.RELAY_UNAVAILABLE, f.openFailure())
        assertEquals(listOf("/api/info", "/api/info"), f.paths)
        assertEquals(0, f.prepared)
    }

    @Test
    fun wrongDeviceIdentityAndInvalidPublicKeysRetirePreparedBindings() = channelTest { f ->
        f.keyDevice = "another-device"
        assertEquals(RemoteDesktopTransportFailure.DEVICE_IDENTITY_CHANGED, f.openFailure())
        assertTrue(f.bindings.single().retired)
        f.keyDevice = TARGET; f.peerPublic = ByteArray(31)
        assertEquals(RemoteDesktopTransportFailure.INVALID_PEER_KEY, f.openFailure())
        assertTrue(f.bindings.last().retired); assertEquals(0, f.signals)
    }

    @Test
    fun changingThePeerKeyRejectsAnOtherwiseAuthenticOldReplyWithoutRekeying() = channelTest { f ->
        val channel = f.open(); f.peerPublic = DeviceIdentity.publicKey(ByteArray(32) { 17 })
        assertEquals(RemoteDesktopTransportFailure.DEVICE_IDENTITY_CHANGED,
            assertFailsWith<RemoteDesktopTransportException> { channel.call(REQUEST, null) }.failure)
        assertFalse(channel.current())
        assertEquals(RemoteDesktopTransportFailure.ACCOUNT_CHANGED,
            assertFailsWith<RemoteDesktopTransportException> { channel.call(REQUEST, null) }.failure)
        assertEquals(1, f.signals)
    }

    @Test
    fun malformedOrWrongPeerIdentityAfterOpeningRetiresTheChannel() = channelTest { f ->
        val original = f.peerPublic.copyOf()
        for (failure in listOf(RemoteDesktopTransportFailure.DEVICE_IDENTITY_CHANGED, RemoteDesktopTransportFailure.INVALID_PEER_KEY)) {
            f.peerPublic = original; f.keyDevice = TARGET
            val channel = f.open()
            if (failure == RemoteDesktopTransportFailure.DEVICE_IDENTITY_CHANGED) f.keyDevice = "another-device"
            else f.peerPublic = ByteArray(31)
            assertEquals(failure, assertFailsWith<RemoteDesktopTransportException> { channel.call(REQUEST, null) }.failure)
            assertFalse(channel.current()); assertTrue(f.bindings.last().retired)
        }
        assertEquals(2, f.signals)
    }

    @Test
    fun accountChangeDuringPeerDiscoveryRetiresThePreparedBinding() = channelTest { f ->
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.beforeKey = { entered.complete(Unit); release.await() }
        coroutineScope {
            val open = async { runCatching { f.open() } }
            entered.await()
            f.client.deviceDirectoryChanges(BASE, CloudAccountSession("new-token", "another-account", ByteArray(32)))
            release.complete(Unit)
            assertEquals(RemoteDesktopTransportFailure.ACCOUNT_CHANGED,
                assertIs<RemoteDesktopTransportException>(open.await().exceptionOrNull()).failure)
        }
        assertTrue(f.bindings.single().retired); assertEquals(0, f.signals)
    }

    @Test
    fun changingAccountsRejectsALateSignalReplyAndNeverReopensTheOldAccount() = channelTest { f ->
        val channel = f.open(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.beforeReply = { entered.complete(Unit); release.await() }
        coroutineScope {
            val call = async { runCatching { channel.call(REQUEST, null) } }
            entered.await()
            f.client.deviceDirectoryChanges(BASE, CloudAccountSession("new-token", "another-account", ByteArray(32)))
            release.complete(Unit)
            assertEquals(RemoteDesktopTransportFailure.ACCOUNT_CHANGED,
                assertIs<RemoteDesktopTransportException>(call.await().exceptionOrNull()).failure)
        }
        assertFalse(channel.current()); assertTrue(f.sockets.first().closed); assertEquals(1, f.signals)
    }

    @Test
    fun closingDuringASignalRetiresItsReplyAndKeepsTheAccountSocket() = channelTest { f ->
        val channel = f.open(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.beforeReply = { entered.complete(Unit); release.await() }
        coroutineScope {
            val call = async { runCatching { channel.call(REQUEST, null) } }
            entered.await(); channel.close(); release.complete(Unit)
            assertEquals(RemoteDesktopTransportFailure.ACCOUNT_CHANGED,
                assertIs<RemoteDesktopTransportException>(call.await().exceptionOrNull()).failure)
        }
        assertFalse(f.sockets.single().closed)
    }

    @Test
    fun turnCredentialsAreBoundedScopedAndRedacted() = channelTest { f ->
        val channel = f.open(); val credentials = channel.turn("attach-1")
        assertEquals(TARGET, credentials.targetDeviceId); assertEquals("attach-1", credentials.attachmentId)
        assertTrue(credentials.expiresAt > Clock.System.now().epochSeconds)
        assertFalse(credentials.toString().contains("private-credential"))
        assertFalse(credentials.iceServers.single().toString().contains("private-credential"))
        for (bad in listOf(
            f.turnValue.copy(targetDeviceId = "different"), f.turnValue.copy(attachmentId = "old-attach"),
            f.turnValue.copy(expiresAt = 1), f.turnValue.copy(expiresAt = Clock.System.now().epochSeconds + 1000),
            f.turnValue.copy(iceServers = emptyList()),
            f.turnValue.copy(iceServers = listOf(RemoteDesktopIceServer(listOf("https://invalid"), "user", "secret"))),
        )) {
            f.turnValue = bad
            assertEquals(RemoteDesktopTransportFailure.INVALID_RESPONSE,
                assertFailsWith<RemoteDesktopTransportException> { channel.turn("attach-1") }.failure)
        }
    }

    @Test
    fun lateTurnCredentialsCannotSurviveAnAccountChange() = channelTest { f ->
        val channel = f.open(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.beforeTurn = { entered.complete(Unit); release.await() }
        coroutineScope {
            val turn = async { runCatching { channel.turn("attach-1") } }
            entered.await()
            f.client.deviceDirectoryChanges(BASE, CloudAccountSession("new-token", "another-account", ByteArray(32)))
            release.complete(Unit)
            assertEquals(RemoteDesktopTransportFailure.ACCOUNT_CHANGED,
                assertIs<RemoteDesktopTransportException>(turn.await().exceptionOrNull()).failure)
        }
        assertFalse(channel.current()); assertEquals(1, f.keyReads)
    }

    @Test
    fun callerCancellationIsPreservedDuringTurnFetch() = channelTest { f ->
        val channel = f.open(); val entered = CompletableDeferred<Unit>()
        f.beforeTurn = { entered.complete(Unit); awaitCancellation() }
        coroutineScope {
            val turn = async { channel.turn("attach-1") }
            entered.await(); turn.cancel()
            assertFailsWith<CancellationException> { turn.await() }
        }
        assertTrue(channel.current()); assertFalse(f.sockets.single().closed)
    }

    @Test
    fun encryptedHostErrorsStayProtocolObjectsAndInvalidRepliesFailClosed() = channelTest { f ->
        val channel = f.open()
        f.replyText = """{"ok":false,"error":{"code":"authorization_required","future":true}}"""
        assertEquals(RelayJson.parseToJsonElement(f.replyText), channel.call(REQUEST, null))
        for (text in listOf("[]", "invalid json")) {
            f.replyText = text
            assertEquals(RemoteDesktopTransportFailure.INVALID_RESPONSE,
                assertFailsWith<RemoteDesktopTransportException> { channel.call(REQUEST, null) }.failure)
        }
        assertEquals(0, f.genericCalls)
    }

    @Test
    fun callRejectsAgentCommandsUnsupportedVersionsAndUnboundedPlaintext() = channelTest { f ->
        val channel = f.open()
        for (bad in listOf(buildJsonObject { put("cmd", "list_sessions") },
            buildJsonObject { put("version", 1); put("op", "invoke") },
            buildJsonObject { put("version", 1); put("op", "signal"); put("body", "x".repeat(96 * 1024)) })) {
            assertFailsWith<RemoteDesktopTransportException> { channel.call(bad, null) }
        }
        assertEquals(0, f.signals); assertEquals(0, f.genericCalls)
    }

    @Test
    fun turnUrlValidationAcceptsOnlyScopedWebRtcServerUrls() {
        for (value in listOf("turn:relay.invalid:3478?transport=udp", "turns:relay.invalid:5349?transport=tcp", "turn:[2001:db8::1]:3478", "turn:relay.invalid", "turn:[2001:db8::1]")) {
            assertTrue(validRemoteDesktopTurnUrl(value), value)
        }
        for (value in listOf("https://relay.invalid", "turn:user@relay.invalid", "turn:relay.invalid/path",
            "turns:relay.invalid?transport=udp", "turn:relay.invalid:0", "turn:[2001:db8::1]:0", "turn:relay.invalid:",
            "turn:[2001:db8::1]:", "turn:relay.invalid:65536", "turn:relay.invalid:-1", "turn:relay.invalid:+3478",
            "turn:relay.invalid\\path", "turn:relay.invalid%2fpath", "turn:relay.invalid?transport=udp&other=1", "turn:relay.invalid\n")) {
            assertFalse(validRemoteDesktopTurnUrl(value), value)
        }
    }

    private fun channelTest(block: suspend (Fixture) -> Unit) = runTest {
        withContext(Dispatchers.Default) {
            val f = Fixture.create()
            try { block(f) } finally { f.channel?.close(); f.client.closeAccount(); f.http.close() }
        }
    }

    private class SocketOwner : AccountRpcConnection {
        var closed = false
        override fun close() { closed = true }
        override suspend fun call(target: String, params: JsonElement, timeoutMs: Long): JsonElement = error("No Agent RPC expected")
    }
    private class Binding(private val owner: SocketOwner, private val signal: suspend (EncryptedPayload) -> EncryptedPayload) : RemoteDesktopRpcBinding {
        var retired = false
        override fun current() = !retired && !owner.closed
        override fun close() { retired = true }
        override suspend fun call(params: EncryptedPayload, timeoutMs: Long, attachment: String?): EncryptedPayload = signal(params)
    }
    private class Fixture(private val messageKey: ByteArray, var peerPublic: ByteArray) {
        val session = CloudAccountSession("private-device-token", "test-account", ByteArray(32) { it.toByte() })
        var info = """{"capabilities":["remote_desktop_route_v1","remote_desktop_turn_v1","remote_desktop_credential_binding_v1"],"future":true}"""
        var redirect = false; var keyDevice = TARGET; var keyReads = 0; var prepared = 0; var signals = 0; var genericCalls = 0
        val paths = mutableListOf<String>(); val sockets = mutableListOf<SocketOwner>(); val bindings = mutableListOf<Binding>()
        val plainRequests = mutableListOf<JsonObject>(); val nonces = mutableListOf<String>()
        var beforeReply: suspend () -> Unit = {}
        var beforeKey: suspend () -> Unit = {}
        var beforeTurn: suspend () -> Unit = {}
        var replyText = """{"unknown_field":"future"}"""
        var channel: RemoteDesktopAccountChannel? = null
        var turnValue = RemoteDesktopTurnCredentials(TARGET, "attach-1", Clock.System.now().epochSeconds + 300,
            listOf(RemoteDesktopIceServer(listOf("turn:relay.invalid:3478?transport=udp"), "private-user", "private-credential")))
        val http = relayHttpClient(MockEngine { request ->
            assertEquals("127.0.0.1", request.url.host)
            val path = request.url.encodedPath; paths += path
            assertEquals(if (path == "/api/info") null else "Bearer private-device-token", request.headers[HttpHeaders.Authorization])
            if (redirect) respond("", HttpStatusCode.Found, headersOf(HttpHeaders.Location, "https://must-not-follow.invalid/"))
            else {
                val body = when {
                    path == "/api/info" -> info
                    path.endsWith("/key") -> { keyReads++; beforeKey(); """{"device_id":"$keyDevice","public_key":"${Base64.Default.encode(peerPublic)}"}""" }
                    path == "/api/remote-desktop/turn" -> {
                        assertEquals(TARGET, request.url.parameters["target_device_id"]); assertEquals("attach-1", request.url.parameters["attach_id"])
                        beforeTurn()
                        RelayJson.encodeToString(RemoteDesktopTurnCredentials.serializer(), turnValue)
                    }
                    path == "/api/devices" -> "[]"
                    else -> error("Unexpected HTTP request")
                }
                respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()))
            }
        })
        val client = CloudAccountClient(http, processingDispatcher = Dispatchers.Default, realtimeFactory = { _, _, _ ->
            val owner = object : AccountRpcConnection {
                val state = SocketOwner()
                override fun close() = state.close()
                override suspend fun call(target: String, params: JsonElement, timeoutMs: Long): JsonElement { genericCalls++; error("No generic fallback") }
                override suspend fun prepareRemoteDesktop(target: String, relayCapabilities: Set<String>): RemoteDesktopRpcBinding {
                    prepared++; assertEquals(TARGET, target)
                    return Binding(state) { params ->
                        signals++; nonces += params.nonce
                        val plain = CloudAccountCipher.decrypt(Base64.Default.decode(params.encryptedData), messageKey, Base64.Default.decode(params.nonce))
                        plainRequests += RelayJson.parseToJsonElement(plain.decodeToString()).jsonObject
                        beforeReply()
                        val nonce = DeviceIdentity.randomBytes(12)
                        val cipher = CloudAccountCipher.encrypt(replyText.encodeToByteArray(), messageKey, nonce)
                        EncryptedPayload(Base64.Default.encode(cipher), Base64.Default.encode(nonce))
                    }.also { bindings += it }
                }
            }
            sockets += owner.state; owner
        })
        suspend fun open(): RemoteDesktopAccountChannel = client.remoteDesktopChannel(BASE, session, TARGET).also { channel = it }
        suspend fun openFailure(): RemoteDesktopTransportFailure = assertFailsWith<RemoteDesktopTransportException> { open() }.failure
        companion object {
            suspend fun create(): Fixture {
                val secret = ByteArray(32) { 11 }
                val key = DeviceIdentity.messageKey(secret, DeviceIdentity.publicKey(ByteArray(32) { it.toByte() }))
                return Fixture(key, DeviceIdentity.publicKey(secret))
            }
        }
    }

    companion object {
        private const val BASE = "http://127.0.0.1:19703"
        private const val TARGET = "desktop-1"
        private val REQUEST = buildJsonObject { put("version", 1); put("op", "get_state") }
    }
}
