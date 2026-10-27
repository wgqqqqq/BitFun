package com.openbitfun.mobile.core.feature.remotedesktop

/** Pure per-PC deadline. Later snapshots and clock rollback can never extend it. */
internal class RemoteDesktopCredentialBudget {
    private var monotonicDeadline: Long? = null
    private var wallDeadline: Long? = null
    private var expired = false

    fun host(remainingMs: Long, requestedAt: Long, now: Long) {
        if (remainingMs !in 0..660_000 || requestedAt > now) invalid()
        constrain(requestedAt + remainingMs, null)
    }

    fun turn(expiresAt: Long, requestedAt: Long, now: Long, wallNow: Long) {
        if (expiresAt !in 1..(Long.MAX_VALUE / 1000) || requestedAt > now) invalid()
        val remaining = expiresAt * 1000 - wallNow
        if (remaining > 660_000) invalid()
        constrain(requestedAt + remaining.coerceAtLeast(0), expiresAt * 1000)
    }

    private fun constrain(monotonic: Long, wall: Long?) {
        monotonicDeadline = monotonicDeadline?.coerceAtMost(monotonic) ?: monotonic
        if (wall != null) wallDeadline = wallDeadline?.coerceAtMost(wall) ?: wall
    }

    fun remaining(now: Long, wallNow: Long): Long {
        if (expired) return 0
        val mono = monotonicDeadline?.minus(now) ?: Long.MAX_VALUE
        val wall = wallDeadline?.minus(wallNow) ?: Long.MAX_VALUE
        val value = minOf(mono, wall)
        if (value <= 0) expired = true
        return value.coerceAtLeast(0)
    }

    private fun invalid(): Nothing = throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.INVALID_RESPONSE)
}
