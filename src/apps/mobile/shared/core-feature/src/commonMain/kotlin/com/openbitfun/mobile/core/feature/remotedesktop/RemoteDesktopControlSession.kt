package com.openbitfun.mobile.core.feature.remotedesktop

import kotlinx.coroutines.CancellationException

/** Native-side intent fence for one PC. The shared JS controller remains the
 * owner of wire requests, ACK deadlines, renewals and ordered-channel IO. */
internal class RemoteDesktopControlSession(
    private val binding: RemoteDesktopMediaBindingUi,
    private val displayId: String,
    supported: Boolean,
    private val current: () -> Boolean,
    private val ready: () -> Boolean,
    private val readState: suspend () -> RemoteDesktopSourceState,
    private val submit: (RemoteDesktopControlRendererIntent) -> Boolean,
    private val publish: (RemoteDesktopControlUiState) -> Unit,
    private val failed: (RemoteDesktopSetupFailure) -> Unit,
    textSupported: Boolean = false,
) {
    var state = RemoteDesktopControlUiState(binding, supported, RemoteDesktopControlMode.VIEWING, null, 0, false, null, supported && textSupported)
        private set
    private var closed = false
    private var acquireIssued = false
    private var retiredGeneration: String? = null
    private var releaseSeen = false

    private fun live(): Boolean = !closed && current()
    private fun update(value: RemoteDesktopControlUiState) { state = value; publish(value) }
    private fun matches(value: RemoteDesktopMediaBindingUi, epoch: Long): Boolean = live() && value == binding && epoch == state.intentEpoch

    suspend fun dispatch(intent: RemoteDesktopControlIntent) {
        when (intent) {
            is RemoteDesktopControlIntent.Acquire -> if (matches(intent.binding, intent.intentEpoch)) acquire()
            is RemoteDesktopControlIntent.Release -> if (matches(intent.binding, intent.intentEpoch)) release()
            is RemoteDesktopControlIntent.Tap -> {
                if (!matches(intent.binding, intent.intentEpoch) || state.mode != RemoteDesktopControlMode.CONTROLLING
                    || state.generation != intent.generation || !intent.x.isFinite() || !intent.y.isFinite()
                    || intent.x !in 0.0..1.0 || intent.y !in 0.0..1.0) return
                if (!ready()) { release(); return }
                send(RemoteDesktopControlRendererIntent.Tap(binding, state.intentEpoch, intent.generation, intent.x, intent.y, intent.button))
            }
            is RemoteDesktopControlIntent.PointerMove -> {
                if (!inputAllowed(intent.binding, intent.intentEpoch, intent.generation) || !point(intent.x, intent.y)) return
                if (!ready()) { release(); return }
                send(RemoteDesktopControlRendererIntent.PointerMove(binding, state.intentEpoch, intent.generation, intent.x, intent.y))
            }
            is RemoteDesktopControlIntent.PointerButton -> {
                if (!inputAllowed(intent.binding, intent.intentEpoch, intent.generation) || !point(intent.x, intent.y)) return
                if (!ready()) { release(); return }
                send(RemoteDesktopControlRendererIntent.PointerButton(binding, state.intentEpoch, intent.generation, intent.x, intent.y, intent.button, intent.down))
            }
            is RemoteDesktopControlIntent.Wheel -> {
                if (!inputAllowed(intent.binding, intent.intentEpoch, intent.generation) || !point(intent.x, intent.y)
                    || !intent.dx.isFinite() || !intent.dy.isFinite() || intent.dx !in -65536.0..65536.0 || intent.dy !in -65536.0..65536.0
                    || intent.dx == 0.0 && intent.dy == 0.0) return
                if (!ready()) { release(); return }
                send(RemoteDesktopControlRendererIntent.Wheel(binding, state.intentEpoch, intent.generation, intent.x, intent.y, intent.dx, intent.dy))
            }
            is RemoteDesktopControlIntent.TextCommit -> {
                if (!inputAllowed(intent.binding, intent.intentEpoch, intent.generation) || remoteDesktopTextCommitIntent(state, intent.text) == null) return
                if (!ready()) { release(); return }
                send(RemoteDesktopControlRendererIntent.TextCommit(binding, state.intentEpoch, intent.generation, intent.text))
            }
            is RemoteDesktopControlIntent.KeyTap -> {
                if (!inputAllowed(intent.binding, intent.intentEpoch, intent.generation)) return
                if (!ready()) { release(); return }
                send(RemoteDesktopControlRendererIntent.KeyTap(binding, state.intentEpoch, intent.generation, intent.key))
            }
        }
    }

    private fun inputAllowed(value: RemoteDesktopMediaBindingUi, epoch: Long, generation: String): Boolean =
        matches(value, epoch) && state.mode == RemoteDesktopControlMode.CONTROLLING && state.generation == generation
    private fun point(x: Double, y: Double): Boolean = x.isFinite() && y.isFinite() && x in 0.0..1.0 && y in 0.0..1.0

    private suspend fun acquire() {
        if (!state.supported || state.mode != RemoteDesktopControlMode.VIEWING || state.releasePending || !ready()) return
        val epoch = state.intentEpoch + 1
        acquireIssued = false
        update(state.copy(mode = RemoteDesktopControlMode.ACQUIRING, intentEpoch = epoch, failure = null))
        try {
            val snapshot = readState()
            if (!live() || state.intentEpoch != epoch || state.mode != RemoteDesktopControlMode.ACQUIRING) return
            if (snapshot.attachment != RemoteDesktopAttachment(binding.attachmentId, binding.connectionId, displayId)
                || !snapshot.streaming || snapshot.suspended || snapshot.cleanupPending || !ready()) {
                update(state.copy(mode = RemoteDesktopControlMode.VIEWING, failure = RemoteDesktopControlFailure.INPUT_SUSPENDED))
                return
            }
            acquireIssued = true
            send(RemoteDesktopControlRendererIntent.Acquire(binding, epoch, snapshot.revision))
        } catch (cancelled: CancellationException) {
            if (live() && state.intentEpoch == epoch && !acquireIssued) {
                update(state.copy(mode = RemoteDesktopControlMode.VIEWING, intentEpoch = epoch + 1))
            }
            throw cancelled
        } catch (error: Exception) {
            if (live() && state.intentEpoch == epoch && !acquireIssued) {
                val reason = remoteDesktopSetupFailure(error)
                if (reason in setOf(RemoteDesktopSetupFailure.ACCOUNT_CHANGED, RemoteDesktopSetupFailure.DEVICE_IDENTITY_CHANGED,
                        RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED, RemoteDesktopSetupFailure.PERMISSION_REQUIRED,
                        RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED, RemoteDesktopSetupFailure.TARGET_UNAVAILABLE,
                        RemoteDesktopSetupFailure.INVALID_RESPONSE)) {
                    fatal(reason); return
                }
                update(state.copy(mode = RemoteDesktopControlMode.VIEWING, failure = RemoteDesktopControlFailure.INPUT_SUSPENDED))
            }
        }
    }

    /** Retire local input before sending cleanup. An unknown acquire must close
     * its PC rather than guessing a generation or replaying its mutation. */
    fun release() {
        if (!live() || state.releasePending) return
        if (state.mode == RemoteDesktopControlMode.VIEWING && state.generation == null) return
        if (state.mode == RemoteDesktopControlMode.ACQUIRING && acquireIssued) {
            fatal(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN); return
        }
        val generation = state.generation
        if (generation != null) retiredGeneration = generation
        val epoch = state.intentEpoch + 1
        acquireIssued = false
        releaseSeen = false
        update(state.copy(mode = RemoteDesktopControlMode.VIEWING, generation = null, intentEpoch = epoch,
            releasePending = generation != null))
        if (generation != null) send(RemoteDesktopControlRendererIntent.Release(binding, epoch))
    }

    fun report(report: RemoteDesktopControlReportIntent) {
        if (!live() || report.binding != binding || report.intentEpoch != state.intentEpoch) return
        val generation = report.generation
        if (generation != null && !validGeneration(generation)) { fatal(RemoteDesktopSetupFailure.INVALID_RESPONSE); return }
        if (generation != null && generation == retiredGeneration) return
        if (report.failure != null && report.pending != null) { fatal(RemoteDesktopSetupFailure.INVALID_RESPONSE); return }
        if (report.failure in setOf(RemoteDesktopControlFailure.DELIVERY_UNKNOWN, RemoteDesktopControlFailure.INVALID_RESPONSE)) {
            fatal(if (report.failure == RemoteDesktopControlFailure.INVALID_RESPONSE) RemoteDesktopSetupFailure.INVALID_RESPONSE
                else RemoteDesktopSetupFailure.DELIVERY_UNKNOWN); return
        }
        if (generation != null) {
            if (!state.supported || !ready() || report.failure != null
                || report.pending in setOf(RemoteDesktopControlPending.ACQUIRE, RemoteDesktopControlPending.RELEASE)
                || !(state.mode == RemoteDesktopControlMode.ACQUIRING && acquireIssued
                    || state.mode == RemoteDesktopControlMode.CONTROLLING && state.generation == generation)) {
                fatal(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN); return
            }
            acquireIssued = false
            update(state.copy(mode = RemoteDesktopControlMode.CONTROLLING, generation = generation, failure = null))
            return
        }
        when (report.pending) {
            RemoteDesktopControlPending.ACQUIRE -> {
                if (state.mode != RemoteDesktopControlMode.ACQUIRING || !acquireIssued) fatal(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
            }
            RemoteDesktopControlPending.RELEASE -> {
                if (state.mode == RemoteDesktopControlMode.ACQUIRING) { fatal(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN); return }
                val old = state.generation
                if (old != null) retiredGeneration = old
                releaseSeen = true
                update(state.copy(mode = RemoteDesktopControlMode.VIEWING, generation = null, releasePending = true,
                    intentEpoch = state.intentEpoch))
            }
            RemoteDesktopControlPending.RENEW -> {
                // JS retirement can still name its in-flight renewal before
                // replacing it with release_control. It is no longer a grant.
                if (state.releasePending) return
                val old = state.generation
                if (state.mode != RemoteDesktopControlMode.CONTROLLING || old == null) {
                    fatal(RemoteDesktopSetupFailure.INVALID_RESPONSE); return
                }
                retiredGeneration = old
                releaseSeen = false
                update(state.copy(mode = RemoteDesktopControlMode.VIEWING, generation = null, releasePending = true))
            }
            null -> {
                // JS first reports local retirement, then release-pending, then
                // its ACK. The first report cannot reopen acquisition.
                if (state.releasePending && !releaseSeen && report.failure != RemoteDesktopControlFailure.REVOKED) return
                if (state.mode == RemoteDesktopControlMode.ACQUIRING && acquireIssued && report.failure == null) {
                    fatal(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN); return
                }
                val old = state.generation
                if (old != null) retiredGeneration = old
                acquireIssued = false
                // An automatic JS health release emits local retirement before
                // its release request. A host revocation is already terminal.
                val awaitingRelease = old != null && report.failure == null
                releaseSeen = false
                update(state.copy(mode = RemoteDesktopControlMode.VIEWING, generation = null, releasePending = awaitingRelease,
                    failure = report.failure))
            }
        }
    }

    fun close() {
        if (closed) return
        closed = true
        update(state.copy(binding = null, supported = false, mode = RemoteDesktopControlMode.VIEWING, generation = null,
            intentEpoch = state.intentEpoch + 1, releasePending = false, textSupported = false))
    }

    private fun send(command: RemoteDesktopControlRendererIntent) {
        val accepted = try { submit(command) } catch (_: Exception) { false }
        if (!accepted) fatal(RemoteDesktopSetupFailure.MEDIA_UNREACHABLE)
    }

    private fun fatal(reason: RemoteDesktopSetupFailure) {
        close()
        failed(reason)
    }

    private fun validGeneration(value: String): Boolean = value.length in 1..20 && value[0] in '1'..'9'
        && value.all { it in '0'..'9' } && (value.length < 20 || value <= "18446744073709551615")
}
