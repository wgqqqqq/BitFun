package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.protocol.RelayJson
import io.ktor.client.HttpClient
import io.ktor.client.plugins.timeout
import io.ktor.client.request.accept
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.Url
import io.ktor.http.contentLength
import io.ktor.utils.io.readAvailable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import kotlin.io.encoding.Base64

/** Bounded streaming metadata only; redirects never move an account token. */
internal class RemoteDesktopMetadata(client: HttpClient, private val base: String, private val token: String) {
    private val client = client.config { followRedirects = false }

    suspend fun capabilities(): Set<String> = (get("/api/info", false)["capabilities"] as? JsonArray)
        ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }?.toSet().orEmpty()

    suspend fun turn(target: String, attachment: String): RemoteDesktopTurnCredentials =
        RelayJson.decodeFromJsonElement(RemoteDesktopTurnCredentials.serializer(),
            get("/api/remote-desktop/turn?target_device_id=$target&attach_id=$attachment", true))

    fun close() { client.close() }
    suspend fun peer(target: String): ByteArray {
        val json = get("/api/devices/$target/key", true)
        if ((json["device_id"] as? JsonPrimitive)?.contentOrNull != target) {
            throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.DEVICE_IDENTITY_CHANGED)
        }
        val encoded = (json["public_key"] as? JsonPrimitive)?.contentOrNull
            ?: throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_PEER_KEY)
        return try { Base64.Default.decode(encoded).also {
            if (it.size != 32 || Base64.Default.encode(it) != encoded) throw IllegalArgumentException()
        } } catch (_: IllegalArgumentException) { throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_PEER_KEY) }
    }

    private suspend fun get(path: String, authenticated: Boolean): JsonObject = try {
        withTimeout(5000) {
            client.prepareGet(base + path) {
                accept(ContentType.Application.Json)
                if (authenticated) bearerAuth(token)
                timeout { requestTimeoutMillis = 5000 }
            }.execute { response ->
                val status = response.status.value
                if (status !in 200..299) throw RemoteDesktopTransportException(when (status) {
                    401, 403 -> RemoteDesktopTransportFailure.AUTHORIZATION_REQUIRED
                    429 -> RemoteDesktopTransportFailure.RATE_LIMITED
                    else -> RemoteDesktopTransportFailure.RELAY_UNAVAILABLE
                })
                val limit = 16 * 1024
                if (response.contentLength()?.let { it !in 0..limit.toLong() } == true) {
                    throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_RESPONSE)
                }
                val bytes = ByteArray(limit + 1); var count = 0; val body = response.bodyAsChannel()
                while (count < bytes.size) {
                    val read = body.readAvailable(bytes, count, bytes.size - count)
                    if (read < 0) break
                    count += read
                }
                if (count > limit) throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_RESPONSE)
                RelayJson.parseToJsonElement(bytes.decodeToString(0, count, throwOnInvalidSequence = true)) as? JsonObject
                    ?: throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_RESPONSE)
            }
        }
    } catch (_: TimeoutCancellationException) {
        currentCoroutineContext().ensureActive()
        throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.RELAY_CONNECT_TIMEOUT)
    } catch (cancelled: CancellationException) { throw cancelled
    } catch (error: RemoteDesktopTransportException) { throw error
    } catch (_: Exception) { throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_RESPONSE) }
}

internal fun remoteDesktopRelayUrl(value: String): String {
    val base = normalizeAccountRelayUrl(value) ?: throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_REQUEST)
    val url = Url(base)
    if (url.protocol.name != "https" && url.host.removeSurrounding("[", "]") !in setOf("127.0.0.1", "localhost", "::1")) {
        throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.HTTPS_REQUIRED)
    }
    return base
}

