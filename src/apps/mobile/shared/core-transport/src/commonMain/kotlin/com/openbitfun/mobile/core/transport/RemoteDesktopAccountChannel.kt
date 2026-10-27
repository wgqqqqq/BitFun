package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.crypto.CloudAccountCipher
import com.openbitfun.mobile.core.crypto.DeviceIdentity
import com.openbitfun.mobile.core.protocol.EncryptedPayload
import com.openbitfun.mobile.core.protocol.RelayJson
import io.ktor.client.HttpClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import kotlin.io.encoding.Base64
import kotlin.time.Clock

/** Fixed account, target public key and authenticated socket epoch. Host replies
 * remain protocol objects, including host errors; the feature owns their UX.
 * Closing retires only this channel, never the shared account socket. */
public class RemoteDesktopAccountChannel private constructor(
    private val metadata: RemoteDesktopMetadata,
    private val target: String,
    private val peerPublic: ByteArray,
    private val key: ByteArray,
    private val binding: RemoteDesktopRpcBinding,
    private val accountIdentity: Any,
    private val accountCurrent: () -> Boolean,
    private val dispatcher: CoroutineDispatcher,
) {
    private val closed = MutableStateFlow(false)
    public fun current(): Boolean = !closed.value && accountCurrent() && binding.current()
    /** A new socket epoch may recover read-only video only after the feature also
     * revalidates the live host attachment. This comparison never refreshes a key. */
    public fun sameIdentityAs(other: RemoteDesktopAccountChannel): Boolean =
        accountIdentity === other.accountIdentity && target == other.target
            && peerPublic.contentEquals(other.peerPublic) && accountCurrent() && other.accountCurrent()
    public fun close() {
        if (!closed.compareAndSet(false, true)) return
        binding.close()
        key.fill(0)
        metadata.close()
    }
    private fun requireCurrent() {
        if (!current()) throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.ACCOUNT_CHANGED)
    }

    private suspend fun verifyPeer() {
        requireCurrent()
        val peer = try {
            protect(RemoteDesktopTransportFailure.INVALID_PEER_KEY) { metadata.peer(target) }
        } catch (error: RemoteDesktopTransportException) {
            if (error.failure == RemoteDesktopTransportFailure.DEVICE_IDENTITY_CHANGED
                || error.failure == RemoteDesktopTransportFailure.INVALID_PEER_KEY) close()
            throw error
        }
        requireCurrent()
        if (!peer.contentEquals(peerPublic)) {
            close()
            throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.DEVICE_IDENTITY_CHANGED)
        }
    }

    /** No automatic retry, key refresh or generic Agent invoke fallback. */
    public suspend fun call(request: JsonObject, attachment: String?): JsonObject {
        requireCurrent()
        if ((request["version"] as? JsonPrimitive)?.intOrNull != 1) {
            throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.UNSUPPORTED_PROTOCOL)
        }
        if ((request["op"] as? JsonPrimitive)?.contentOrNull !in OPERATIONS) {
            throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_REQUEST)
        }
        val plain = request.toString().encodeToByteArray()
        if (plain.size > 96 * 1024 - 64) throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_REQUEST)
        val localKey = key.copyOf()
        try {
            val nonce = DeviceIdentity.randomBytes(12)
            val cipher = protect(RemoteDesktopTransportFailure.ENCRYPTION_FAILED) {
                withContext(dispatcher) { CloudAccountCipher.encrypt(plain, localKey, nonce) }
            }
            requireCurrent()
            val reply = binding.call(EncryptedPayload(Base64.Default.encode(cipher), Base64.Default.encode(nonce)), 10_000, attachment)
            requireCurrent()
            verifyPeer()
            val decoded = protect(RemoteDesktopTransportFailure.DECRYPTION_FAILED) {
                withContext(dispatcher) {
                    CloudAccountCipher.decrypt(Base64.Default.decode(reply.encryptedData), localKey, Base64.Default.decode(reply.nonce))
                }
            }
            requireCurrent()
            if (decoded.size > 96 * 1024) throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_RESPONSE)
            return protect(RemoteDesktopTransportFailure.INVALID_RESPONSE) {
                withContext(dispatcher) { RelayJson.parseToJsonElement(decoded.decodeToString(throwOnInvalidSequence = true)) as? JsonObject
                    ?: throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_RESPONSE) }
            }.also { requireCurrent() }
        } finally {
            localKey.fill(0)
            plain.fill(0)
        }
    }

    public suspend fun turn(attachment: String): RemoteDesktopTurnCredentials {
        requireCurrent()
        RemoteDesktopRpcWire.requireTarget(attachment)
        val value = protect(RemoteDesktopTransportFailure.INVALID_RESPONSE) { metadata.turn(target, attachment) }
        requireCurrent()
        verifyPeer()
        validateRemoteDesktopTurn(value, target, attachment, Clock.System.now().epochSeconds)
        return value.also { requireCurrent() }
    }

    private suspend fun <T> protect(fallback: RemoteDesktopTransportFailure, operation: suspend () -> T): T = try {
        operation()
    } catch (cancelled: CancellationException) { throw cancelled
    } catch (error: RemoteDesktopTransportException) { throw error
    } catch (_: Exception) {
        throw RemoteDesktopTransportException(if (current()) fallback else RemoteDesktopTransportFailure.ACCOUNT_CHANGED)
    }

    internal companion object {
        private val OPERATIONS = setOf("capabilities", "list_displays", "get_state", "attach", "detach", "signal", "suspend", "resume", "select_display")

        suspend fun open(client: HttpClient, base: String, session: CloudAccountSession, target: String,
            socket: AccountRpcConnection, accountIdentity: Any, accountCurrent: () -> Boolean, dispatcher: CoroutineDispatcher): RemoteDesktopAccountChannel {
            val metadata = RemoteDesktopMetadata(client, base, session.token)
            var binding: RemoteDesktopRpcBinding? = null
            var key: ByteArray? = null
            try {
                val capabilities = metadata.capabilities()
                if (!accountCurrent()) throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.ACCOUNT_CHANGED)
                if ("remote_desktop_route_v1" !in capabilities) throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.RELAY_UPGRADE_REQUIRED)
                if ("remote_desktop_turn_v1" !in capabilities || "remote_desktop_credential_binding_v1" !in capabilities) {
                    throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.TURN_UNAVAILABLE)
                }
                binding = socket.prepareRemoteDesktop(target, capabilities)
                val peer = metadata.peer(target)
                if (!accountCurrent() || !binding.current()) throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.ACCOUNT_CHANGED)
                key = withContext(dispatcher) { DeviceIdentity.messageKey(session.masterKey, peer) }
                if (!accountCurrent() || !binding.current()) throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.ACCOUNT_CHANGED)
                return RemoteDesktopAccountChannel(metadata, target, peer, key, binding, accountIdentity, accountCurrent, dispatcher)
            } catch (cancelled: CancellationException) {
                key?.fill(0); binding?.close(); metadata.close(); throw cancelled
            } catch (error: Exception) {
                val stale = !accountCurrent() || binding?.current() == false
                key?.fill(0); binding?.close(); metadata.close()
                throw when {
                    stale -> RemoteDesktopTransportException(RemoteDesktopTransportFailure.ACCOUNT_CHANGED)
                    error is RemoteDesktopTransportException -> error
                    else -> RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_PEER_KEY)
                }
            }
        }
    }
}

