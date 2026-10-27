package com.openbitfun.mobile.core.transport

import io.ktor.http.Url
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
public data class RemoteDesktopIceServer public constructor(
    public val urls: List<String>, public val username: String, public val credential: String,
) {
    override fun toString(): String = "RemoteDesktopIceServer(<redacted>)"
}

@Serializable
public data class RemoteDesktopTurnCredentials public constructor(
    @SerialName("target_device_id") public val targetDeviceId: String,
    @SerialName("attach_id") public val attachmentId: String,
    @SerialName("expires_at") public val expiresAt: Long,
    @SerialName("ice_servers") public val iceServers: List<RemoteDesktopIceServer>,
) {
    override fun toString(): String = "RemoteDesktopTurnCredentials(<redacted>)"
}

/** Pure validation; the account channel supplies the time after its final identity check. */
internal fun validateRemoteDesktopTurn(value: RemoteDesktopTurnCredentials, target: String, attachment: String, now: Long) {
    if (value.targetDeviceId != target || value.attachmentId != attachment || value.expiresAt <= now || value.expiresAt > now + 660
        || value.iceServers.isEmpty() || value.iceServers.size > 4 || value.iceServers.any { server ->
            server.username.isEmpty() || server.username.length > 256 || server.credential.isEmpty() || server.credential.length > 256
                || server.urls.isEmpty() || server.urls.size > 4 || server.urls.any { !validRemoteDesktopTurnUrl(it) }
        }) throw RemoteDesktopTransportException(RemoteDesktopTransportFailure.INVALID_RESPONSE)
}

internal fun validRemoteDesktopTurnUrl(value: String): Boolean {
    if (value.length > 1024 || value.any { it.isWhitespace() || it.code < 32 || it.code == 127 }) return false
    val scheme = value.substringBefore(':'); if (scheme !in setOf("turn", "turns")) return false
    val address = value.substringAfter(':'); val authority = address.substringBefore('?')
    val transport = address.substringAfter('?', "")
    if (authority.isEmpty() || authority.any { it in "/\\@#?%" }
        || transport !in setOf("", "transport=udp", "transport=tcp") || (scheme == "turns" && transport == "transport=udp")) return false
    // Url.port normalizes explicit zero to the scheme default; inspect the raw port.
    val port = if (authority.startsWith('[')) {
        val suffix = authority.substringAfter(']', "invalid")
        when {
            suffix.isEmpty() -> null
            suffix.startsWith(':') -> suffix.drop(1)
            else -> return false
        }
    } else if (':' in authority) authority.substringAfter(':') else null
    if (port != null && (port.isEmpty() || port.any { it !in '0'..'9' } || port.toIntOrNull() !in 1..65535)) return false
    return runCatching { val url = Url("https://$authority"); url.host.isNotEmpty() && url.port in 1..65535 }.getOrDefault(false)
}
