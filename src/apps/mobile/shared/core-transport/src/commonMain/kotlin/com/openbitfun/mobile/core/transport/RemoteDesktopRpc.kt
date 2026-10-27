package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.protocol.EncryptedPayload
import kotlin.io.encoding.Base64

/** One authenticated account socket epoch and target, never an Agent session. */
internal interface RemoteDesktopRpcBinding {
    fun current(): Boolean
    suspend fun call(params: EncryptedPayload, timeoutMs: Long, attachment: String?): EncryptedPayload
    /** Retires only this binding; account chat keeps its shared socket. */
    fun close()
}

public enum class RemoteDesktopTransportFailure {
    RELAY_UPGRADE_REQUIRED, INVALID_REQUEST, INVALID_SIGNAL_ENVELOPE,
    ACCOUNT_CHANGED, RELAY_CONNECT_TIMEOUT, DELIVERY_UNKNOWN,
    AUTHORIZATION_REQUIRED, TARGET_UNAVAILABLE, RELAY_UNAVAILABLE,
    UNSUPPORTED_PROTOCOL, RATE_LIMITED,
    HTTPS_REQUIRED, INVALID_RESPONSE, DEVICE_IDENTITY_CHANGED, INVALID_PEER_KEY,
    ENCRYPTION_FAILED, DECRYPTION_FAILED, TURN_UNAVAILABLE,
}

/** No remote error text, ciphertext, device identity or credentials in messages. */
public class RemoteDesktopTransportException internal constructor(public val failure: RemoteDesktopTransportFailure) :
    IllegalStateException("Remote desktop transport failed: $failure")

internal object RemoteDesktopRpcWire {
    private val identifier = Regex("[A-Za-z0-9_.-]{1,128}")

    fun requireTarget(target: String) {
        if (!identifier.matches(target)) throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_REQUEST)
    }

    fun requireCall(params: EncryptedPayload, timeoutMs: Long, attachment: String?) {
        if (timeoutMs !in 1..30_000 || (attachment != null && !identifier.matches(attachment))) {
            throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_REQUEST)
        }
        requireEnvelope(params)
    }

    fun requireEnvelope(params: EncryptedPayload) {
        if (!canonicalBase64(params.encryptedData, 128 * 1024, 16, 96 * 1024)
            || !canonicalBase64(params.nonce, 16, 12, 12)) {
            throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_SIGNAL_ENVELOPE)
        }
    }

    private fun canonicalBase64(value: String, maxLength: Int, minBytes: Int, maxBytes: Int): Boolean {
        if (value.isEmpty() || value.length > maxLength) return false
        return try {
            val bytes = Base64.Default.decode(value)
            bytes.size in minBytes..maxBytes && Base64.Default.encode(bytes) == value
        } catch (_: IllegalArgumentException) { false }
    }

    fun rejection(code: String?): RemoteDesktopTransportException = RemoteDesktopTransportException(when (code) {
        "invalid_request" -> RemoteDesktopTransportFailure.INVALID_REQUEST
        "unsupported_protocol" -> RemoteDesktopTransportFailure.UNSUPPORTED_PROTOCOL
        "authorization_required" -> RemoteDesktopTransportFailure.AUTHORIZATION_REQUIRED
        "target_unavailable" -> RemoteDesktopTransportFailure.TARGET_UNAVAILABLE
        "rate_limited" -> RemoteDesktopTransportFailure.RATE_LIMITED
        "delivery_unknown" -> RemoteDesktopTransportFailure.DELIVERY_UNKNOWN
        else -> RemoteDesktopTransportFailure.RELAY_UNAVAILABLE
    })
}
