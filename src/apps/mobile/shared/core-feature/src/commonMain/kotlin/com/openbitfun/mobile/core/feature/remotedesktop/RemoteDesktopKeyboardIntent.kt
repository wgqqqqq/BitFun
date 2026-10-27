package com.openbitfun.mobile.core.feature.remotedesktop

/** Validate one confirmed commit and retain the authority captured by its editor.
 * Preedit, remote text history and platform InputConnections stay outside core. */
public fun remoteDesktopTextCommitIntent(authority: RemoteDesktopControlUiState, text: String): RemoteDesktopControlIntent.TextCommit? {
    val binding = authority.binding ?: return null
    val generation = authority.generation ?: return null
    if (!authority.supported || !authority.textSupported || authority.mode != RemoteDesktopControlMode.CONTROLLING
        || text.isEmpty() || text.length > 4096 || '\u0000' in text
        || !runCatching { text.encodeToByteArray(throwOnInvalidSequence = true).size <= 4096 }.getOrDefault(false)) return null
    return RemoteDesktopControlIntent.TextCommit(binding, authority.intentEpoch, generation, text)
}
