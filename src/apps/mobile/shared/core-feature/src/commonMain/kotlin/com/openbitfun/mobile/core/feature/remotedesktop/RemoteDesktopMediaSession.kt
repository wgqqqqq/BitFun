package com.openbitfun.mobile.core.feature.remotedesktop

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeout

/** One inbound-video PC. The store owns account/attachment lifetime; this owner
 * owns SDP, credentials, presentation evidence and bounded signaling recovery. */
internal class RemoteDesktopMediaSession(
    private val attachment: RemoteDesktopAttachment,
    private val rendererId: String,
    private val forceRelay: Boolean,
    private val capabilities: Set<String>,
    private val channel: () -> RemoteDesktopSetupChannel,
    private val openChannel: suspend () -> RemoteDesktopSetupChannel,
    private val replaceChannel: (RemoteDesktopSetupChannel) -> Unit,
    private val isCurrent: () -> Boolean,
    private val now: () -> Long,
    private val wallNow: () -> Long,
    private val publish: (RemoteDesktopMediaUiState?) -> Unit,
    private val presented: (Int, Int) -> Unit,
    private val failed: (RemoteDesktopSetupFailure) -> Unit,
    private val rebuild: () -> Unit,
) {
    private val budget = RemoteDesktopCredentialBudget()
    private var stopped = false
    private var projection: RemoteDesktopMediaUiState? = null
    private var answer: String? = null
    private var answerSubmitted = false
    private var answerConfirmed = false
    private var frame: Pair<Int, Int>? = null
    private var relayConfirmed = !forceRelay
    private var signalingLostAt: Long? = null
    var viewing = false
        private set

    private fun current(): Boolean = !stopped && isCurrent()

    fun stop() {
        stopped = true
        answer = null
        projection = null
        publish(null)
    }

    /** Fence events/polling now, but keep the PC until the host confirms suspend. */
    fun retireCallbacks() {
        stopped = true
        answer = null
        projection = null
    }

    fun checkDeadline() {
        if (current() && budget.remaining(now(), wallNow()) <= 0) failed(RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED)
        if (current() && viewing && !channel().current()) beginSignalingLoss()
        if (current() && signalingLostAt?.let { now() - it >= 30_000 } == true) failed(RemoteDesktopSetupFailure.NETWORK)
    }

    fun dispatch(intent: RemoteDesktopMediaIntent) {
        if (!current()) return
        checkDeadline()
        if (!current()) return
        val binding = when (intent) {
            RemoteDesktopMediaIntent.Prepare, RemoteDesktopMediaIntent.Unavailable, is RemoteDesktopMediaIntent.ControlReady -> return
            is RemoteDesktopMediaIntent.Answer -> intent.binding
            is RemoteDesktopMediaIntent.FramePresented -> intent.binding
            is RemoteDesktopMediaIntent.Health -> intent.binding
            is RemoteDesktopMediaIntent.Failed -> intent.binding
        }
        if (projection == null || binding.rendererId != rendererId || binding.attachmentId != attachment.attachment
            || binding.connectionId != attachment.connection) return
        when (intent) {
            is RemoteDesktopMediaIntent.Answer -> {
                if (intent.sdp.isEmpty() || intent.sdp.encodeToByteArray().size > 90 * 1024
                    || answer?.let { it != intent.sdp } == true) failed(RemoteDesktopSetupFailure.INVALID_RESPONSE)
                else answer = intent.sdp
            }
            is RemoteDesktopMediaIntent.FramePresented -> {
                if (intent.width !in 1..32768 || intent.height !in 1..32768) failed(RemoteDesktopSetupFailure.INVALID_RESPONSE)
                else { frame = intent.width to intent.height; publishViewing() }
            }
            is RemoteDesktopMediaIntent.Health -> {
                val candidates = listOf(intent.localCandidate, intent.remoteCandidate)
                if (forceRelay && candidates.any { it in setOf("host", "srflx", "prflx") }) {
                    failed(RemoteDesktopSetupFailure.RELAY_NOT_SELECTED)
                } else {
                    // Stats can precede selected-pair metadata. Unknown is not
                    // proof of relay, and setup remains bounded by the store.
                    relayConfirmed = !forceRelay || candidates.all { it == "relay" }
                    publishViewing()
                }
            }
            is RemoteDesktopMediaIntent.Failed -> failed(RemoteDesktopSetupFailure.MEDIA_UNREACHABLE)
            RemoteDesktopMediaIntent.Prepare, RemoteDesktopMediaIntent.Unavailable, is RemoteDesktopMediaIntent.ControlReady -> Unit
        }
    }

    private fun update(value: RemoteDesktopMediaUiState) {
        if (!current()) return
        projection = value
        publish(value)
    }

    private fun publishViewing() {
        val size = frame ?: return
        val media = projection ?: return
        if (current() && media.sourceReady && answerSubmitted && answerConfirmed && relayConfirmed) {
            viewing = true
            presented(size.first, size.second)
        }
    }

    suspend fun run() {
        while (current()) {
            val requestedAt = now()
            val snapshot = try { channel().media(attachment.attachment) }
            catch (error: Exception) {
                if (error is CancellationException) throw error
                if (!current()) return
                if (!viewing || !recoverable(error)) throw error
                recover()
                continue
            }
            if (!current()) return
            validate(snapshot, requestedAt)
            if (projection == null && snapshot.offer != null) {
                if (snapshot.forceRelay != forceRelay) reject(RemoteDesktopSetupFailure.INVALID_RESPONSE)
                val turnAt = now()
                val credentials = channel().turn(attachment.attachment)
                if (!current()) return
                budget.turn(credentials.expiresAt, turnAt, now(), wallNow())
                checkBudget()
                if ("credential_rebuild_v1" in capabilities && budget.remaining(now(), wallNow()) <= 60_000) {
                    reject(RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED)
                }
                update(RemoteDesktopMediaUiState(rendererId, attachment.attachment, attachment.connection,
                    snapshot.offer, credentials.servers, forceRelay, false, false, "ordered_control_v1" in capabilities))
            }
            val pendingAnswer = answer
            if (projection != null && pendingAnswer != null && !answerSubmitted) {
                answerSubmitted = true
                try { channel().answer(attachment.attachment, attachment.connection, pendingAnswer) }
                catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (remoteDesktopSetupFailure(error) != RemoteDesktopSetupFailure.DELIVERY_UNKNOWN) throw error
                    if (!current()) return
                    val queryAt = now()
                    val confirmed = channel().media(attachment.attachment)
                    if (!current()) return
                    validate(confirmed, queryAt)
                    if (!confirmed.answerAccepted) throw error
                }
                if (!current()) return
                answerConfirmed = true
            }
            if (snapshot.answerAccepted) answerConfirmed = true
            projection?.let { if (snapshot.sourceFirstFrame && !it.sourceReady) update(it.copy(sourceReady = true)) }
            checkBudget()
            publishViewing()
            // Renew only a presented PC over verified live signaling. The store
            // retires this session before reusing the source lifecycle.
            if (current() && viewing && signalingLostAt == null && channel().current()
                && "source_lifecycle_v1" in capabilities && "credential_rebuild_v1" in capabilities
                && budget.remaining(now(), wallNow()) <= 60_000) {
                rebuild()
            }
            delay(500)
        }
    }

    private fun validate(snapshot: RemoteDesktopHostMedia, requestedAt: Long) {
        if (snapshot.attachment != attachment) reject(RemoteDesktopSetupFailure.TARGET_UNAVAILABLE)
        if (snapshot.offer != null && "credential_rebuild_v1" in capabilities) {
            budget.host(snapshot.remainingMs ?: reject(RemoteDesktopSetupFailure.INVALID_RESPONSE), requestedAt, now())
        }
        projection?.let { if (snapshot.offer != it.offerSdp || snapshot.forceRelay != forceRelay) reject(RemoteDesktopSetupFailure.INVALID_RESPONSE) }
        checkBudget()
    }

    private fun checkBudget() {
        if (budget.remaining(now(), wallNow()) <= 0) reject(RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED)
    }

    private fun recoverable(error: Exception): Boolean = remoteDesktopSetupFailure(error) in setOf(
        RemoteDesktopSetupFailure.NETWORK, RemoteDesktopSetupFailure.DELIVERY_UNKNOWN, RemoteDesktopSetupFailure.ACCOUNT_CHANGED)

    private suspend fun recover() {
        val old = channel()
        beginSignalingLoss()
        val lostAt = signalingLostAt!!
        while (current() && now() - lostAt < 30_000) {
            checkBudget()
            var candidate: RemoteDesktopSetupChannel? = null
            var installed = false
            try {
                withTimeout((30_000 - (now() - lostAt)).coerceAtLeast(1)) {
                    val fresh = openChannel()
                    candidate = fresh
                    if (!current()) return@withTimeout
                    if (fresh === old) reject(RemoteDesktopSetupFailure.INVALID_RESPONSE)
                    if (!old.sameIdentityAs(fresh)) reject(RemoteDesktopSetupFailure.DEVICE_IDENTITY_CHANGED)
                    val requestedAt = now()
                    val snapshot = fresh.media(attachment.attachment)
                    if (!current()) return@withTimeout
                    validate(snapshot, requestedAt)
                    if (!snapshot.streaming || !snapshot.answerAccepted || !snapshot.sourceFirstFrame) reject(RemoteDesktopSetupFailure.TARGET_UNAVAILABLE)
                    if (!fresh.current()) reject(RemoteDesktopSetupFailure.NETWORK)
                    replaceChannel(fresh)
                    installed = true
                    old.close()
                    signalingLostAt = null
                    projection?.let { update(it.copy(signalingInterrupted = false)) }
                }
                if (installed || !current()) return
            } catch (_: TimeoutCancellationException) {
                currentCoroutineContext().ensureActive()
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (error: Exception) {
                if (!current()) return
                if (!recoverable(error)) throw error
            } finally { if (!installed) candidate?.close() }
            if (current()) delay(250)
        }
        if (current()) reject(RemoteDesktopSetupFailure.NETWORK)
    }

    private fun beginSignalingLoss() {
        if (signalingLostAt != null) return
        signalingLostAt = now()
        projection?.let { update(it.copy(signalingInterrupted = true)) }
    }

    private fun reject(reason: RemoteDesktopSetupFailure): Nothing = throw RemoteDesktopSetupException(reason)
}
