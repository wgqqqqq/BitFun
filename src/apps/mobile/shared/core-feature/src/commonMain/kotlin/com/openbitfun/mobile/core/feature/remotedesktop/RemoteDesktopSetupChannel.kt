package com.openbitfun.mobile.core.feature.remotedesktop

import com.openbitfun.mobile.core.transport.RemoteDesktopAccountChannel
import com.openbitfun.mobile.core.transport.RemoteDesktopTransportException
import com.openbitfun.mobile.core.transport.RemoteDesktopTransportFailure
import kotlinx.serialization.json.*

internal class RemoteDesktopSetupException(val reason: RemoteDesktopSetupFailure) : IllegalStateException("Remote desktop setup failed: $reason")
internal data class RemoteDesktopDirectory(val revision: String, val displays: List<RemoteDesktopDisplayUi>, val capabilities: Set<String> = emptySet())
internal data class RemoteDesktopAttachment(val attachment: String, val connection: String, val display: String)
internal data class RemoteDesktopSourceState(val revision: String, val attachment: RemoteDesktopAttachment?, val suspended: Boolean, val cleanupPending: Boolean,
    val streaming: Boolean = false)
internal data class RemoteDesktopHostMedia(val attachment: RemoteDesktopAttachment?, val offer: String?,
    val answerAccepted: Boolean, val sourceFirstFrame: Boolean, val forceRelay: Boolean, val remainingMs: Long?, val streaming: Boolean) {
    override fun toString(): String = "RemoteDesktopHostMedia(<redacted>)"
}
internal data class RemoteDesktopReceiverCredentials(val expiresAt: Long, val servers: List<RemoteDesktopIceServerUi>) {
    override fun toString(): String = "RemoteDesktopReceiverCredentials(<redacted>)"
}

/** Feature-local seam: the store does not know account tokens, crypto, JSON or Socket.IO. */
internal interface RemoteDesktopSetupChannel {
    fun current(): Boolean
    suspend fun discover(): RemoteDesktopDirectory
    suspend fun refreshDisplays(): RemoteDesktopDirectory = throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.UNSUPPORTED)
    suspend fun attach(id: String, revision: String, display: String, forceRelay: Boolean): RemoteDesktopAttachment
    suspend fun state(id: String): RemoteDesktopAttachment?
    suspend fun media(id: String): RemoteDesktopHostMedia
    suspend fun turn(id: String): RemoteDesktopReceiverCredentials
    suspend fun answer(id: String, connection: String, sdp: String)
    suspend fun sourceState(id: String): RemoteDesktopSourceState = throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.UNSUPPORTED)
    suspend fun suspendSource(id: String, revision: String): RemoteDesktopSourceState = throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.UNSUPPORTED)
    suspend fun resumeSource(id: String, revision: String): RemoteDesktopSourceState = throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.UNSUPPORTED)
    suspend fun selectSource(id: String, revision: String, display: String): RemoteDesktopSourceState = throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.UNSUPPORTED)
    fun sameIdentityAs(other: RemoteDesktopSetupChannel): Boolean
    suspend fun detach(id: String)
    fun close()
}

internal class AccountRemoteDesktopSetupChannel(private val channel: RemoteDesktopAccountChannel) : RemoteDesktopSetupChannel {
    override fun current(): Boolean = channel.current()
    override fun close() { channel.close() }
    override fun sameIdentityAs(other: RemoteDesktopSetupChannel): Boolean =
        other is AccountRemoteDesktopSetupChannel && channel.sameIdentityAs(other.channel)

    override suspend fun discover(): RemoteDesktopDirectory {
        val probe = call("capabilities", null, null)
        RemoteDesktopSetupProtocol.requireView(probe)
        return RemoteDesktopSetupProtocol.directory(call("list_displays", null, null)).copy(
            capabilities = (probe["capabilities"] as JsonArray).map { it.jsonPrimitive.content }.toSet())
    }

    // Directory discovery has no outer attachment, even while one is retained.
    override suspend fun refreshDisplays(): RemoteDesktopDirectory = RemoteDesktopSetupProtocol.directory(call("list_displays", null, null))

    override suspend fun attach(id: String, revision: String, display: String, forceRelay: Boolean): RemoteDesktopAttachment =
        RemoteDesktopSetupProtocol.attachment(call("attach", id, buildJsonObject {
            put("attach_id", id); put("expected_state_revision", revision); put("display_id", display); put("force_relay", forceRelay)
        })) ?: throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.INVALID_RESPONSE)

    override suspend fun state(id: String): RemoteDesktopAttachment? =
        RemoteDesktopSetupProtocol.attachment(call("get_state", id, null))

    override suspend fun media(id: String): RemoteDesktopHostMedia = RemoteDesktopSetupProtocol.media(call("get_state", id, null))

    override suspend fun turn(id: String): RemoteDesktopReceiverCredentials = channel.turn(id).let { value ->
        RemoteDesktopReceiverCredentials(value.expiresAt, value.iceServers.map { RemoteDesktopIceServerUi(it.urls, it.username, it.credential) })
    }

    override suspend fun answer(id: String, connection: String, sdp: String) {
        val reply = call("signal", id, buildJsonObject {
            put("attach_id", id); put("connection_id", connection); put("answer_sdp", sdp)
        })
        if ((reply["answer_accepted"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull != true) {
            throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.INVALID_RESPONSE)
        }
    }

    override suspend fun detach(id: String) { call("detach", id, buildJsonObject { put("attach_id", id) }) }

    override suspend fun sourceState(id: String): RemoteDesktopSourceState = RemoteDesktopSetupProtocol.source(call("get_state", id, null))
    override suspend fun suspendSource(id: String, revision: String): RemoteDesktopSourceState = sourceMutation("suspend", id, revision)
    override suspend fun resumeSource(id: String, revision: String): RemoteDesktopSourceState = sourceMutation("resume", id, revision)
    override suspend fun selectSource(id: String, revision: String, display: String): RemoteDesktopSourceState =
        RemoteDesktopSetupProtocol.source(call("select_display", id, buildJsonObject {
            put("attach_id", id); put("expected_state_revision", revision); put("display_id", display)
        }))
    private suspend fun sourceMutation(op: String, id: String, revision: String): RemoteDesktopSourceState =
        RemoteDesktopSetupProtocol.source(call(op, id, buildJsonObject {
            put("attach_id", id); put("expected_state_revision", revision)
        }))

    private suspend fun call(op: String, attachment: String?, body: JsonObject?): JsonObject {
        val reply = channel.call(buildJsonObject {
            put("version", 1); put("op", op)
            if (body != null) put("body", body)
        }, attachment)
        RemoteDesktopSetupProtocol.requireSuccess(reply)
        return reply
    }
}

/** Typed boundary for the existing v1 host wire; unknown additive fields are ignored. */
internal object RemoteDesktopSetupProtocol {
    private fun invalid(): Nothing = throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.INVALID_RESPONSE)
    private fun JsonObject.text(key: String): String = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: invalid()
    private fun revision(value: String): Boolean = value.length in 1..128 && value.all { it.isLetterOrDigit() && it.code < 128 || it in "-_.:" }
    private fun displayId(value: String): Boolean = value.length in 1..256 && value.none { it.code < 32 || it.code == 127 }

    fun requireSuccess(reply: JsonObject) {
        val error = reply["error"]?.takeUnless { it == JsonNull } ?: return
        val code = (error as? JsonObject)?.text("code") ?: invalid()
        throw RemoteDesktopSetupException(hostFailure(code))
    }

    private fun hostFailure(code: String): RemoteDesktopSetupFailure = when (code) {
        "device_approval_required", "authorization_expired", "authorization_required" -> RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED
        "permission_required" -> RemoteDesktopSetupFailure.PERMISSION_REQUIRED
        "stale_revision" -> RemoteDesktopSetupFailure.STALE_REVISION
        "busy", "attachment_busy", "target_conflict", "capacity_exceeded" -> RemoteDesktopSetupFailure.BUSY
        "cleanup_pending" -> RemoteDesktopSetupFailure.CLEANUP_PENDING
        "media_backend_unavailable" -> RemoteDesktopSetupFailure.BACKEND_UNAVAILABLE
        "unsupported", "unsupported_protocol", "platform_unsupported" -> RemoteDesktopSetupFailure.UNSUPPORTED
        "target_unavailable", "sharing_ended" -> RemoteDesktopSetupFailure.TARGET_UNAVAILABLE
        "media_unreachable", "media_playback_failed" -> RemoteDesktopSetupFailure.MEDIA_UNREACHABLE
        "turn_credentials_expired" -> RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED
        else -> RemoteDesktopSetupFailure.HOST_REJECTED
    }

    fun requireView(probe: JsonObject) {
        when (probe.text("availability")) {
            "ready" -> Unit
            "permission_required" -> throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.PERMISSION_REQUIRED)
            "media_backend_unavailable" -> throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.BACKEND_UNAVAILABLE)
            else -> throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.UNSUPPORTED)
        }
        val versions = probe["protocol_versions"] as? JsonArray ?: invalid()
        val capabilities = (probe["capabilities"] as? JsonArray)?.map {
            (it as? JsonPrimitive)?.takeIf { item -> item.isString }?.content ?: invalid()
        }?.toSet() ?: invalid()
        if (versions.none { (it as? JsonPrimitive)?.let { value -> !value.isString && value.intOrNull == 1 } == true }
            || !capabilities.containsAll(setOf("read_only_video_v1", "gathered_sdp_v1"))) {
            throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.UNSUPPORTED)
        }
        if (probe.text("authorization") != "view") throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED)
    }

    fun directory(reply: JsonObject): RemoteDesktopDirectory {
        val revision = reply.text("state_revision").takeIf(::revision) ?: invalid()
        val items = reply["displays"] as? JsonArray ?: invalid()
        val displays = items.map { item ->
            val value = item as? JsonObject ?: invalid()
            val id = value.text("display_id").takeIf(::displayId) ?: invalid()
            fun dimension(key: String): Int = (value[key] as? JsonPrimitive)?.takeIf { !it.isString }
                ?.intOrNull?.takeIf { it in 1..32768 } ?: invalid()
            RemoteDesktopDisplayUi(id, dimension("width"), dimension("height"))
        }
        if (displays.map { it.id }.distinct().size != displays.size) invalid()
        if (displays.isEmpty()) throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.NO_DISPLAYS)
        return RemoteDesktopDirectory(revision, displays)
    }

    fun attachment(reply: JsonObject): RemoteDesktopAttachment? {
        val source = source(reply)
        if (source.cleanupPending) throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.CLEANUP_PENDING)
        if (source.suspended) invalid()
        return source.attachment
    }

    fun source(reply: JsonObject): RemoteDesktopSourceState {
        val mediaError = reply["media_error"]?.takeUnless { it == JsonNull }
        if (mediaError != null) {
            if (mediaError !is JsonPrimitive || !mediaError.isString) invalid()
            if (mediaError.content.isNotEmpty()) throw RemoteDesktopSetupException(hostFailure(mediaError.content))
        }
        val state = reply["state"] as? JsonObject ?: invalid()
        val stateRevision = state.text("state_revision").takeIf(::revision) ?: invalid()
        val cleaning = (state["cleanup_pending"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: invalid()
        val value = state["attachment"].let { if (it == null || it == JsonNull) return RemoteDesktopSourceState(stateRevision, null, false, cleaning) else it as? JsonObject ?: invalid() }
        val phase = value.text("phase")
        if (phase !in setOf("binding", "streaming", "suspended")) invalid()
        val attachment = RemoteDesktopAttachment(value.text("attach_id").takeIf(::revision) ?: invalid(),
            value.text("connection_id").takeIf(::revision) ?: invalid(), value.text("display_id").takeIf(::displayId) ?: invalid())
        return RemoteDesktopSourceState(stateRevision, attachment, phase == "suspended", cleaning, phase == "streaming")
    }

    fun media(reply: JsonObject): RemoteDesktopHostMedia {
        val attachment = attachment(reply)
        val value = reply["media"]?.takeUnless { it == JsonNull }?.let { it as? JsonObject ?: invalid() }
            ?: return RemoteDesktopHostMedia(attachment, null, false, false, false, null, false)
        fun flag(key: String): Boolean = (value[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: invalid()
        val offer = value["offer_sdp"]?.takeUnless { it == JsonNull }?.let {
            (it as? JsonPrimitive)?.takeIf { item -> item.isString }?.content
                ?.takeIf { text -> text.isNotEmpty() && text.encodeToByteArray().size <= 90 * 1024 } ?: invalid()
        }
        val remaining = value["credentials_remaining_ms"]?.takeUnless { it == JsonNull }?.let {
            (it as? JsonPrimitive)?.takeIf { item -> !item.isString }?.longOrNull?.takeIf { ms -> ms in 0..660_000 } ?: invalid()
        }
        val streaming = attachment != null && reply["state"]!!.jsonObject["attachment"]!!.jsonObject.text("phase") == "streaming"
        return RemoteDesktopHostMedia(attachment, offer, flag("answer_accepted"), flag("source_first_frame"), flag("force_relay"), remaining, streaming)
    }
}

internal fun remoteDesktopSetupFailure(error: Exception): RemoteDesktopSetupFailure = when (error) {
    is RemoteDesktopSetupException -> error.reason
    is RemoteDesktopTransportException -> when (error.failure) {
        RemoteDesktopTransportFailure.RELAY_UPGRADE_REQUIRED -> RemoteDesktopSetupFailure.RELAY_UPGRADE_REQUIRED
        RemoteDesktopTransportFailure.HTTPS_REQUIRED -> RemoteDesktopSetupFailure.HTTPS_REQUIRED
        RemoteDesktopTransportFailure.ACCOUNT_CHANGED -> RemoteDesktopSetupFailure.ACCOUNT_CHANGED
        RemoteDesktopTransportFailure.DEVICE_IDENTITY_CHANGED, RemoteDesktopTransportFailure.INVALID_PEER_KEY -> RemoteDesktopSetupFailure.DEVICE_IDENTITY_CHANGED
        RemoteDesktopTransportFailure.AUTHORIZATION_REQUIRED -> RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED
        RemoteDesktopTransportFailure.TARGET_UNAVAILABLE -> RemoteDesktopSetupFailure.TARGET_UNAVAILABLE
        RemoteDesktopTransportFailure.UNSUPPORTED_PROTOCOL -> RemoteDesktopSetupFailure.UNSUPPORTED
        RemoteDesktopTransportFailure.DELIVERY_UNKNOWN -> RemoteDesktopSetupFailure.DELIVERY_UNKNOWN
        RemoteDesktopTransportFailure.RATE_LIMITED -> RemoteDesktopSetupFailure.RATE_LIMITED
        RemoteDesktopTransportFailure.TURN_UNAVAILABLE -> RemoteDesktopSetupFailure.BACKEND_UNAVAILABLE
        RemoteDesktopTransportFailure.RELAY_CONNECT_TIMEOUT, RemoteDesktopTransportFailure.RELAY_UNAVAILABLE -> RemoteDesktopSetupFailure.NETWORK
        else -> RemoteDesktopSetupFailure.INVALID_RESPONSE
    }
    else -> RemoteDesktopSetupFailure.INVALID_RESPONSE
}
