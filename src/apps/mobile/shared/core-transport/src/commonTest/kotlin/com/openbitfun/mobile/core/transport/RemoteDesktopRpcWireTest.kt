package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.protocol.EncryptedPayload
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlin.io.encoding.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class RemoteDesktopRpcWireTest {
    private val envelope = EncryptedPayload(Base64.Default.encode(ByteArray(16)), Base64.Default.encode(ByteArray(12)))

    @Test
    fun versionOneIdentifiersAndTimeoutsAreBounded() {
        RemoteDesktopRpcWire.requireTarget("desktop_1.local-test")
        for (target in listOf("", "host:invoke", "a".repeat(129), "../host", "\u4e3b\u673a")) {
            assertEquals(RemoteDesktopTransportFailure.INVALID_REQUEST,
                assertFailsWith<RemoteDesktopTransportException> { RemoteDesktopRpcWire.requireTarget(target) }.failure)
        }
        for (timeout in listOf(0L, 30_001L, Long.MAX_VALUE)) {
            assertFailsWith<RemoteDesktopTransportException> { RemoteDesktopRpcWire.requireCall(envelope, timeout, null) }
        }
        RemoteDesktopRpcWire.requireCall(envelope, 30_000, null)
        for (attachment in listOf("", "a/b", "x".repeat(129))) {
            assertFailsWith<RemoteDesktopTransportException> { RemoteDesktopRpcWire.requireCall(envelope, 1000, attachment) }
        }
    }

    @Test
    fun ciphertextMustBeBoundedCanonicalBase64AndNonceTwelveBytes() {
        RemoteDesktopRpcWire.requireEnvelope(envelope)
        for (invalid in listOf(
            envelope.copy(encryptedData = ""), envelope.copy(encryptedData = "secret body"),
            envelope.copy(encryptedData = Base64.Default.encode(ByteArray(15))),
            envelope.copy(encryptedData = "A".repeat(128 * 1024 + 4)),
            envelope.copy(encryptedData = envelope.encryptedData.trimEnd('=')),
            envelope.copy(nonce = Base64.Default.encode(ByteArray(11))),
            envelope.copy(nonce = Base64.Default.encode(ByteArray(13))),
        )) {
            assertEquals(RemoteDesktopTransportFailure.INVALID_SIGNAL_ENVELOPE,
                assertFailsWith<RemoteDesktopTransportException> { RemoteDesktopRpcWire.requireEnvelope(invalid) }.failure)
        }
    }

    @Test
    fun relayRefusalsKeepOnlyClosedFailureLabels() {
        assertEquals(RemoteDesktopTransportFailure.DELIVERY_UNKNOWN, RemoteDesktopRpcWire.rejection("delivery_unknown").failure)
        assertEquals(RemoteDesktopTransportFailure.TARGET_UNAVAILABLE, RemoteDesktopRpcWire.rejection("target_unavailable").failure)
        val secret = "untrusted SDP and credentials"
        val error = RemoteDesktopRpcWire.rejection(secret)
        assertEquals(RemoteDesktopTransportFailure.RELAY_UNAVAILABLE, error.failure)
        assertFalse(error.toString().contains(secret))
    }

    @Test
    fun olderConnectionImplementationsRemainUnsupportedWithoutGenericFallback() = runTest {
        val legacy = object : AccountRpcConnection {
            override suspend fun call(target: String, params: JsonElement, timeoutMs: Long): JsonElement =
                error("Remote desktop must not use legacy invoke")
            override fun close() {}
        }
        assertEquals(RemoteDesktopTransportFailure.RELAY_UPGRADE_REQUIRED,
            assertFailsWith<RemoteDesktopTransportException> {
                legacy.prepareRemoteDesktop("desktop-1", setOf("remote_desktop_route_v1"))
            }.failure)
    }
}
