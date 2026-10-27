package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.protocol.EncryptedPayload
import com.openbitfun.mobile.core.protocol.RelayJson
import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64
import kotlin.test.*

/** Real loopback WebSocket/Engine.IO/Socket.IO with Android's Ktor engine.
 * Ciphertext fixtures contain no screen, account, media, keys or OS input. */
class RemoteDesktopRealtimeTest {
    private val envelope = EncryptedPayload(Base64.getEncoder().encodeToString(ByteArray(16)),
        Base64.getEncoder().encodeToString(ByteArray(12)))
    private val capabilities = setOf("remote_desktop_route_v1")

    @Test
    fun dedicatedLaneIsVersionedInlineAndClosingItPreservesChat(): Unit = runBlocking {
        exercise { realtime, accept ->
            val host = async(Dispatchers.IO) {
                accept().use { peer ->
                    peer.authenticate()
                    val (id, event) = peer.request()
                    assertEquals("rd-call", event[0].jsonPrimitive.content)
                    val request = event[1].jsonObject
                    assertEquals(setOf("version", "targetDeviceId", "params", "timeoutMs", "attachId"), request.keys)
                    assertEquals(1, request.getValue("version").jsonPrimitive.int)
                    assertEquals("desktop-1", request.getValue("targetDeviceId").jsonPrimitive.content)
                    assertEquals("attachment-1", request.getValue("attachId").jsonPrimitive.content)
                    assertEquals(envelope, RelayJson.decodeFromJsonElement(EncryptedPayload.serializer(), request.getValue("params")))
                    peer.ack(id, buildJsonObject { put("ok", true); put("result", request.getValue("params")) })
                    val (chatId, chat) = peer.request()
                    assertEquals("rpc-call", chat[0].jsonPrimitive.content)
                    peer.ack(chatId, buildJsonObject { put("ok", true); put("result", buildJsonObject { put("chat", true) }) })
                    awaitCancellation()
                }
            }
            try {
                val binding = realtime.prepareRemoteDesktop("desktop-1", capabilities)
                assertTrue(binding.current())
                assertEquals(envelope, binding.call(envelope, 3000, "attachment-1"))
                binding.close(); assertFalse(binding.current())
                assertEquals(RemoteDesktopTransportFailure.ACCOUNT_CHANGED,
                    assertFailsWith<RemoteDesktopTransportException> { binding.call(envelope, 3000, null) }.failure)
                assertTrue(realtime.call("desktop-1", buildJsonObject {}, 3000).jsonObject.getValue("chat").jsonPrimitive.boolean)
                assertEquals(1L, realtime.connections.value)
            } finally { host.cancelAndJoin() }
        }
    }

    @Test
    fun absentCapabilityOrMalformedEnvelopeCannotSendDedicatedCalls(): Unit = runBlocking {
        exercise { realtime, accept ->
            val host = async(Dispatchers.IO) {
                accept().use { peer ->
                    peer.authenticate()
                    val (id, event) = peer.request()
                    assertEquals("rpc-call", event[0].jsonPrimitive.content, "Only the final chat check may be submitted")
                    peer.ack(id, buildJsonObject { put("ok", true); put("result", buildJsonObject {}) })
                    awaitCancellation()
                }
            }
            try {
                assertEquals(RemoteDesktopTransportFailure.RELAY_UPGRADE_REQUIRED,
                    assertFailsWith<RemoteDesktopTransportException> { realtime.prepareRemoteDesktop("desktop-1", emptySet()) }.failure)
                val binding = realtime.prepareRemoteDesktop("desktop-1", capabilities)
                assertFailsWith<RemoteDesktopTransportException> { binding.call(envelope.copy(nonce = "bad"), 1000, null) }
                assertFailsWith<RemoteDesktopTransportException> { binding.call(envelope, 30_001, null) }
                realtime.call("desktop-1", buildJsonObject {}, 3000)
            } finally { host.cancelAndJoin() }
        }
    }

    @Test
    fun submittedCallLosesAckAndOldBindingNeverFollowsReconnect(): Unit = runBlocking {
        exercise { realtime, accept ->
            val host = async(Dispatchers.IO) {
                accept().use { peer ->
                    peer.authenticate()
                    assertEquals("rd-call", peer.request().second[0].jsonPrimitive.content)
                    // Dispatched, but no acknowledgement: execution is unknown.
                }
                accept().use { peer ->
                    peer.authenticate()
                    val (id, event) = peer.request()
                    assertEquals("rd-call", event[0].jsonPrimitive.content)
                    assertFalse(event[1].jsonObject.containsKey("attachId"))
                    peer.ack(id, buildJsonObject { put("ok", true); put("result", event[1].jsonObject.getValue("params")) })
                    awaitCancellation()
                }
            }
            try {
                val old = realtime.prepareRemoteDesktop("desktop-1", capabilities)
                assertEquals(RemoteDesktopTransportFailure.DELIVERY_UNKNOWN,
                    assertFailsWith<RemoteDesktopTransportException> { old.call(envelope, 3000, "attachment-1") }.failure)
                withTimeout(10_000) { realtime.connections.first { it >= 2 } }
                assertFalse(old.current())
                assertEquals(RemoteDesktopTransportFailure.ACCOUNT_CHANGED,
                    assertFailsWith<RemoteDesktopTransportException> { old.call(envelope, 3000, "attachment-1") }.failure)
                val fresh = realtime.prepareRemoteDesktop("desktop-1", capabilities)
                assertEquals(envelope, fresh.call(envelope, 3000, null))
                realtime.close(); assertFalse(fresh.current())
            } finally { host.cancelAndJoin() }
        }
    }

    @Test
    fun ciphertextReplyCannotBecomeABulkFetchAndErrorsAreRedacted(): Unit = runBlocking {
        exercise { realtime, accept ->
            val host = async(Dispatchers.IO) {
                accept().use { peer ->
                    peer.authenticate()
                    val (id, _) = peer.request()
                    peer.ack(id, buildJsonObject { put("ok", true); put("result", buildJsonObject { put("\$relayPayload", "private-url") }) })
                    val (nextId, _) = peer.request()
                    peer.ack(nextId, buildJsonObject { put("ok", false); put("error", "private-url-and-token") })
                    awaitCancellation()
                }
            }
            try {
                val binding = realtime.prepareRemoteDesktop("desktop-1", capabilities)
                assertEquals(RemoteDesktopTransportFailure.INVALID_SIGNAL_ENVELOPE,
                    assertFailsWith<RemoteDesktopTransportException> { binding.call(envelope, 3000, null) }.failure)
                val error = assertFailsWith<RemoteDesktopTransportException> { binding.call(envelope, 3000, null) }
                assertEquals(RemoteDesktopTransportFailure.RELAY_UNAVAILABLE, error.failure)
                assertFalse(error.toString().contains("private-url-and-token"))
            } finally { host.cancelAndJoin() }
        }
    }

    @Test
    fun closingDuringACallRejectsItsLateReplyWithoutClosingAccount(): Unit = runBlocking {
        exercise { realtime, accept ->
            val dispatched = CompletableDeferred<Unit>()
            val allowAck = CompletableDeferred<Unit>()
            val host = async(Dispatchers.IO) {
                accept().use { peer ->
                    peer.authenticate()
                    val (id, event) = peer.request(); dispatched.complete(Unit); allowAck.await()
                    peer.ack(id, buildJsonObject { put("ok", true); put("result", event[1].jsonObject.getValue("params")) })
                    val (chatId, chat) = peer.request(); assertEquals("rpc-call", chat[0].jsonPrimitive.content)
                    peer.ack(chatId, buildJsonObject { put("ok", true); put("result", buildJsonObject {}) })
                    awaitCancellation()
                }
            }
            try {
                val binding = realtime.prepareRemoteDesktop("desktop-1", capabilities)
                val call = async { runCatching { binding.call(envelope, 3000, null) } }
                dispatched.await(); binding.close(); allowAck.complete(Unit)
                assertEquals(RemoteDesktopTransportFailure.DELIVERY_UNKNOWN,
                    assertIs<RemoteDesktopTransportException>(call.await().exceptionOrNull()).failure)
                realtime.call("desktop-1", buildJsonObject {}, 3000)
                assertEquals(1L, realtime.connections.value)
            } finally { host.cancelAndJoin() }
        }
    }

    @Test
    fun timedOutCallDoesNotReplayAndItsLateAckCannotAnswerTheNextCall(): Unit = runBlocking {
        exercise { realtime, accept ->
            val dispatched = CompletableDeferred<Unit>()
            val allowAck = CompletableDeferred<Unit>()
            val host = async(Dispatchers.IO) {
                accept().use { peer ->
                    peer.authenticate()
                    val (id, event) = peer.request(); dispatched.complete(Unit); allowAck.await()
                    peer.ack(id, buildJsonObject { put("ok", true); put("result", event[1].jsonObject.getValue("params")) })
                    val (chatId, chat) = peer.request()
                    assertNotEquals(id, chatId); assertEquals("rpc-call", chat[0].jsonPrimitive.content)
                    peer.ack(chatId, buildJsonObject { put("ok", true); put("result", buildJsonObject { put("fresh", true) }) })
                    awaitCancellation()
                }
            }
            try {
                val binding = realtime.prepareRemoteDesktop("desktop-1", capabilities)
                val call = async { runCatching { binding.call(envelope, 1000, null) } }
                dispatched.await()
                assertEquals(RemoteDesktopTransportFailure.DELIVERY_UNKNOWN,
                    assertIs<RemoteDesktopTransportException>(call.await().exceptionOrNull()).failure)
                allowAck.complete(Unit)
                assertTrue(realtime.call("desktop-1", buildJsonObject {}, 3000).jsonObject.getValue("fresh").jsonPrimitive.boolean)
                assertTrue(binding.current())
            } finally { host.cancelAndJoin() }
        }
    }

    @Test
    fun concurrentChatAndRemoteDesktopAcksCannotCrossEvenWhenReordered(): Unit = runBlocking {
        exercise { realtime, accept ->
            val host = async(Dispatchers.IO) {
                accept().use { peer ->
                    peer.authenticate()
                    val requests = listOf(peer.request(), peer.request())
                    assertNotEquals(requests[0].first, requests[1].first)
                    assertEquals(setOf("rd-call", "rpc-call"), requests.map { it.second[0].jsonPrimitive.content }.toSet())
                    requests.reversed().forEach { (id, event) ->
                        val result = if (event[0].jsonPrimitive.content == "rd-call") event[1].jsonObject.getValue("params")
                            else buildJsonObject { put("chat", 42) }
                        peer.ack(id, buildJsonObject { put("ok", true); put("result", result) })
                    }
                    awaitCancellation()
                }
            }
            try {
                val binding = realtime.prepareRemoteDesktop("desktop-1", capabilities)
                val remote = async { binding.call(envelope, 3000, null) }
                val chat = async { realtime.call("desktop-1", buildJsonObject {}, 3000) }
                assertEquals(envelope, remote.await())
                assertEquals(42, chat.await().jsonObject.getValue("chat").jsonPrimitive.int)
                assertTrue(binding.current()); assertEquals(1L, realtime.connections.value)
            } finally { host.cancelAndJoin() }
        }
    }

    private suspend fun exercise(check: suspend CoroutineScope.(AccountRealtime, () -> Peer) -> Unit): Unit = coroutineScope {
        ServerSocket(0).use { server ->
            server.soTimeout = 10_000
            val http = relayHttpClient(OkHttp.create())
            val realtime = AccountRealtime(http, "http://127.0.0.1:${server.localPort}", "test-token")
            try { withTimeout(15_000) { check(realtime) { Peer(server.accept()) } } }
            finally { realtime.close(); http.close() }
        }
    }

    private class Peer(private val socket: Socket) : AutoCloseable {
        private val input = socket.getInputStream()
        private val output = socket.getOutputStream()
        init {
            socket.soTimeout = 10_000
            val header = StringBuilder()
            while (!header.endsWith("\r\n\r\n")) { val byte = input.read(); check(byte >= 0); header.append(byte.toChar()) }
            val key = header.lines().first { it.startsWith("Sec-WebSocket-Key:", true) }.substringAfter(':').trim()
            val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
            output.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n").toByteArray())
        }
        fun authenticate() {
            send("0{\"sid\":\"test\",\"upgrades\":[],\"pingInterval\":25000,\"pingTimeout\":20000}")
            check(receive().startsWith("40")); send("40{\"sid\":\"test\"}"); send("42[\"auth-ok\",{}]")
        }
        fun request(): Pair<String, JsonArray> {
            val wire = receive(); check(wire.startsWith("42")); val index = wire.indexOf('[')
            return wire.substring(2, index) to RelayJson.parseToJsonElement(wire.substring(index)).jsonArray
        }
        fun ack(id: String, result: JsonObject) { send("43$id[$result]") }
        private fun send(text: String) {
            val bytes = text.toByteArray(); check(bytes.size < 65536)
            output.write(0x81)
            if (bytes.size < 126) output.write(bytes.size)
            else { output.write(126); output.write(bytes.size ushr 8); output.write(bytes.size and 255) }
            output.write(bytes); output.flush()
        }
        private fun receive(): String {
            check(input.read() == 0x81); val lengthByte = input.read(); check(lengthByte and 0x80 != 0)
            var length = lengthByte and 0x7f
            if (length == 126) length = (input.read() shl 8) or input.read()
            check(length < 65536)
            val mask = input.readNBytes(4); val bytes = input.readNBytes(length)
            check(mask.size == 4 && bytes.size == length)
            return ByteArray(length) { (bytes[it].toInt() xor mask[it % 4].toInt()).toByte() }.toString(Charsets.UTF_8)
        }
        override fun close() { socket.close() }
    }
}
