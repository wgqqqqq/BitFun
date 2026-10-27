package com.openbitfun.mobile.core.feature.remotedesktop

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow

/** UI-scope owner for one explicit device's media and optional controller input.
 * Platform lifecycle calls Close before disposing its scope. No Agent selection,
 * native renderer or input authorization is owned here. Attachment retry is explicit;
 * the media session may revalidate signaling for an already presented PC. */
public class RemoteDesktopSetupStore internal constructor(
    private val scope: CoroutineScope,
    private val openChannel: suspend () -> RemoteDesktopSetupChannel,
    private val accountCurrent: () -> Boolean,
    private val identifier: () -> String,
    private val nowMillis: () -> Long,
    private val wallMillis: () -> Long,
) {
    private class Run {
        var channel: RemoteDesktopSetupChannel? = null
        var directory: RemoteDesktopDirectory? = null
        var attachment: String? = null
        var binding: RemoteDesktopAttachment? = null
        var display: RemoteDesktopDisplayUi? = null
        var media: RemoteDesktopMediaSession? = null
        var control: RemoteDesktopControlSession? = null
        var controlReady = false
        var forceRelay = false
        var job: Job? = null
        var sourceJob: Job? = null
        var sourceDeadline: Long? = null
        var pauseRequested = true
        var choiceEpoch = 0L
        var choices: RemoteDesktopDirectory? = null
        var watch: Job? = null
        var startedAt: Long? = null
        var cleaning = false
        val cleaned = CompletableDeferred<Unit>()
    }
    private var active: Run? = null
    private var last: Run? = null
    private val mutableState = MutableStateFlow<RemoteDesktopSetupUiState>(RemoteDesktopSetupUiState.Idle)
    public val state: StateFlow<RemoteDesktopSetupUiState> = mutableState.asStateFlow()
    private val mutableMedia = MutableStateFlow<RemoteDesktopMediaUiState?>(null)
    public val media: StateFlow<RemoteDesktopMediaUiState?> = mutableMedia.asStateFlow()
    private val mutableControl = MutableStateFlow(inactiveControl())
    public val control: StateFlow<RemoteDesktopControlUiState> = mutableControl.asStateFlow()
    private val rendererControl = Channel<RemoteDesktopControlRendererIntent>(8)
    /** One native renderer consumes these bounded, identity-stamped effects. */
    public val rendererControlIntents: Flow<RemoteDesktopControlRendererIntent> = rendererControl.receiveAsFlow()

    init { scope.coroutineContext[Job]?.invokeOnCompletion { close() } }

    public fun dispatch(intent: RemoteDesktopSetupIntent) {
        when (intent) {
            RemoteDesktopSetupIntent.Load -> load()
            is RemoteDesktopSetupIntent.SelectDisplay -> attach(intent)
            RemoteDesktopSetupIntent.Pause -> changeSource(false)
            RemoteDesktopSetupIntent.Resume -> changeSource(true)
            RemoteDesktopSetupIntent.ChangeDisplay -> choosePausedDisplay()
            RemoteDesktopSetupIntent.CancelDisplayChange -> cancelDisplayChange()
            is RemoteDesktopSetupIntent.SelectPausedDisplay -> selectPausedDisplay(intent.displayId)
            RemoteDesktopSetupIntent.Close -> close()
        }
    }

    public fun dispatchMedia(intent: RemoteDesktopMediaIntent) {
        val run = active ?: return
        if (intent == RemoteDesktopMediaIntent.Unavailable) fail(run, RemoteDesktopSetupFailure.BACKEND_UNAVAILABLE)
        else if (intent == RemoteDesktopMediaIntent.Prepare) prepareMedia(run)
        else if (intent is RemoteDesktopMediaIntent.ControlReady) {
            val media = mutableMedia.value ?: return
            if (!current(run) || mutableState.value !is RemoteDesktopSetupUiState.AwaitingFrame
                && mutableState.value !is RemoteDesktopSetupUiState.Viewing) return
            if (!run.controlReady && media.controlSupported && intent.binding == media.binding()) {
                run.controlReady = true
                installControl(run, media)
            }
        }
        else run.media?.dispatch(intent)
    }

    public fun dispatchControl(intent: RemoteDesktopControlIntent) {
        val run = active ?: return
        val owner = run.control ?: return
        run.media?.checkDeadline()
        if (active !== run) return
        scope.launch(start = CoroutineStart.UNDISPATCHED) { owner.dispatch(intent) }
    }

    public fun reportControl(intent: RemoteDesktopControlReportIntent) { active?.control?.report(intent) }

    private fun identityCurrent(run: Run): Boolean = active === run && scope.isActive && accountCurrent()

    private fun current(run: Run): Boolean = active === run && scope.isActive && accountCurrent() && run.channel?.current() != false

    private fun load() {
        if (!scope.isActive) { close(); return }
        if (active != null) return
        val previous = last
        val run = Run()
        active = run
        last = run
        mutableState.value = RemoteDesktopSetupUiState.Probing
        run.job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                // An explicit retry cannot overtake the previous attach/detach.
                previous?.cleaned?.await()
                if (!current(run)) { fail(run, RemoteDesktopSetupFailure.ACCOUNT_CHANGED); return@launch }
                run.channel = openChannel()
                if (!current(run)) { fail(run, RemoteDesktopSetupFailure.ACCOUNT_CHANGED); return@launch }
                watch(run)
                val directory = run.channel!!.discover()
                if (!current(run)) { fail(run, RemoteDesktopSetupFailure.ACCOUNT_CHANGED); return@launch }
                run.directory = directory
                mutableState.value = RemoteDesktopSetupUiState.ChooseDisplay(directory.displays)
            } catch (cancelled: CancellationException) {
                if (active === run) close()
                throw cancelled
            } catch (error: Exception) {
                fail(run, remoteDesktopSetupFailure(error))
            } finally {
                requestCleanup(run)
            }
        }
        startWork(run, run.job!!)
    }

    private fun attach(intent: RemoteDesktopSetupIntent.SelectDisplay) {
        val run = active ?: return
        if (mutableState.value !is RemoteDesktopSetupUiState.ChooseDisplay) return
        val directory = run.directory ?: return
        val display = directory.displays.singleOrNull { it.id == intent.displayId } ?: return
        if (!current(run)) { fail(run, RemoteDesktopSetupFailure.ACCOUNT_CHANGED); return }
        val id = identifier()
        run.attachment = id
        run.display = display
        run.forceRelay = intent.forceRelay
        run.startedAt = nowMillis()
        mutableState.value = RemoteDesktopSetupUiState.Attaching(display)
        run.job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                if (!current(run)) return@launch
                val channel = run.channel!!
                val attachment = try {
                    channel.attach(id, directory.revision, display.id, intent.forceRelay)
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (remoteDesktopSetupFailure(error) != RemoteDesktopSetupFailure.DELIVERY_UNKNOWN) throw error
                    if (!current(run)) return@launch
                    // Exactly one authoritative read; no mutation replay/new ID/CAS.
                    channel.state(id) ?: throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
                }
                if (!current(run)) { fail(run, RemoteDesktopSetupFailure.ACCOUNT_CHANGED); return@launch }
                if (attachment.attachment != id || attachment.display != display.id) {
                    throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.INVALID_RESPONSE)
                }
                run.binding = attachment
                mutableState.value = RemoteDesktopSetupUiState.Attached(display, id, attachment.connection)
            } catch (cancelled: CancellationException) {
                if (active === run) close()
                throw cancelled
            } catch (error: Exception) {
                fail(run, remoteDesktopSetupFailure(error))
            } finally {
                requestCleanup(run)
            }
        }
        startWork(run, run.job!!)
    }

    private fun prepareMedia(run: Run) {
        val attached = mutableState.value as? RemoteDesktopSetupUiState.Attached ?: return
        if (run.media != null || !current(run)) return
        val session = RemoteDesktopMediaSession(
            RemoteDesktopAttachment(attached.attachmentId, attached.connectionId, attached.display.id), identifier(), run.forceRelay,
            run.directory!!.capabilities, { run.channel!! }, openChannel,
            { fresh -> run.channel = fresh }, { identityCurrent(run) }, nowMillis, wallMillis,
            { value ->
                mutableMedia.value = value
                if (value == null) retireControl(run)
                else {
                    if (run.control == null) installControl(run, value)
                    if (value.signalingInterrupted) run.control?.release()
                }
            },
            { width, height ->
                if (identityCurrent(run)) {
                    val previous = mutableState.value as? RemoteDesktopSetupUiState.Viewing
                    if (previous != null && (previous.width != width || previous.height != height)) run.control?.release()
                    if (identityCurrent(run)) mutableState.value = RemoteDesktopSetupUiState.Viewing(attached.display, width, height,
                        "source_lifecycle_v1" in run.directory!!.capabilities)
                }
            },
            { reason -> fail(run, reason) },
            { if (identityCurrent(run)) changeSource(false, automatic = true) },
        )
        run.media = session
        mutableState.value = RemoteDesktopSetupUiState.AwaitingFrame(attached.display)
        run.job = scope.launch(start = CoroutineStart.LAZY) {
            try { session.run() }
            catch (cancelled: CancellationException) { if (active === run) close(); throw cancelled }
            catch (error: Exception) { fail(run, remoteDesktopSetupFailure(error)) }
            finally { requestCleanup(run) }
        }
        startWork(run, run.job!!)
    }

    private fun changeSource(resume: Boolean, automatic: Boolean = false) {
        val run = active ?: return
        // A manual pause wins even when an automatic resume is already in
        // flight. Confirm that mutation, then suspend its new PC before exposing it.
        if (!resume && !automatic && (mutableState.value is RemoteDesktopSetupUiState.Suspending
                || mutableState.value is RemoteDesktopSetupUiState.Resuming || mutableState.value is RemoteDesktopSetupUiState.SelectingDisplay)) {
            run.pauseRequested = true
            return
        }
        if (resume && mutableState.value !is RemoteDesktopSetupUiState.Paused
            || !resume && mutableState.value !is RemoteDesktopSetupUiState.Viewing) return
        if ("source_lifecycle_v1" !in run.directory!!.capabilities) { fail(run, RemoteDesktopSetupFailure.UNSUPPORTED); return }
        if (mutableMedia.value?.signalingInterrupted == true) return
        if (!current(run)) { fail(run, RemoteDesktopSetupFailure.ACCOUNT_CHANGED); return }
        if (run.binding == null) return
        val display = run.display ?: return
        val oldMedia = run.media
        retireControl(run)
        oldMedia?.retireCallbacks()
        run.pauseRequested = !resume && !automatic
        if (!resume) {
            run.sourceDeadline = nowMillis() + 60_000
            run.startedAt = null
        } else run.startedAt = nowMillis()
        mutableState.value = if (resume) RemoteDesktopSetupUiState.Resuming(display) else RemoteDesktopSetupUiState.Suspending(display)
        val priorMediaWork = run.job
        val priorSourceWork = run.sourceJob
        run.sourceJob = scope.launch(start = CoroutineStart.LAZY) {
            try {
                priorMediaWork?.join()
                priorSourceWork?.join()
                var resuming = resume
                while (current(run)) {
                    val previous = run.binding!!
                    val channel = run.channel!!
                    val before = channel.sourceState(previous.attachment)
                    if (!current(run)) return@launch
                    if (before.attachment != previous || resuming && (!before.suspended || before.cleanupPending)) {
                        throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.TARGET_UNAVAILABLE)
                    }
                    val result = try {
                        if (resuming) channel.resumeSource(previous.attachment, before.revision)
                        else channel.suspendSource(previous.attachment, before.revision)
                    } catch (error: Exception) {
                        if (error is CancellationException) throw error
                        if (remoteDesktopSetupFailure(error) != RemoteDesktopSetupFailure.DELIVERY_UNKNOWN) throw error
                        if (!current(run)) return@launch
                        // One read can confirm an uncertain mutation; never replay it.
                        channel.sourceState(previous.attachment)
                    }
                    if (!current(run)) return@launch
                    if (resuming) {
                        val next = result.attachment
                        if (next == null || next.attachment != previous.attachment || next.display != previous.display
                            || next.connection == previous.connection || result.suspended || result.cleanupPending) {
                            throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
                        }
                        run.binding = next
                        if (run.pauseRequested) {
                            mutableState.value = RemoteDesktopSetupUiState.Suspending(display)
                            resuming = false
                            continue
                        }
                        run.sourceDeadline = null
                        mutableState.value = RemoteDesktopSetupUiState.Attached(display, next.attachment, next.connection)
                        return@launch
                    } else {
                        var paused = result
                        fun requirePaused() {
                            if (paused.attachment != previous || !paused.suspended) {
                                throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
                            }
                        }
                        requirePaused()
                        // The host has acknowledged suspension. Closing the old PC
                        // now cannot be mistaken for an unexpected transport loss.
                        oldMedia?.stop()
                        run.media = null
                        mutableMedia.value = null
                        while (paused.cleanupPending) {
                            delay(250)
                            if (!current(run)) return@launch
                            paused = channel.sourceState(previous.attachment)
                            if (!current(run)) return@launch
                            requirePaused()
                        }
                        run.startedAt = null
                        if (!run.pauseRequested) {
                            run.startedAt = nowMillis()
                            mutableState.value = RemoteDesktopSetupUiState.Resuming(display)
                            resuming = true
                            continue
                        }
                        mutableState.value = RemoteDesktopSetupUiState.Paused(display)
                        return@launch
                    }
                }
            } catch (cancelled: CancellationException) {
                if (active === run) close()
                throw cancelled
            } catch (error: Exception) { fail(run, remoteDesktopSetupFailure(error)) }
            finally { requestCleanup(run) }
        }
        startWork(run, run.sourceJob!!)
    }

    private fun cancelDisplayChange() {
        val run = active ?: return
        if (mutableState.value !is RemoteDesktopSetupUiState.LoadingDisplayChoices
            && mutableState.value !is RemoteDesktopSetupUiState.ChoosePausedDisplay) return
        run.choiceEpoch++
        run.choices = null
        mutableState.value = RemoteDesktopSetupUiState.Paused(run.display!!)
    }

    private fun choosePausedDisplay() {
        val run = active ?: return
        if (mutableState.value !is RemoteDesktopSetupUiState.Paused) return
        if (!current(run)) { fail(run, RemoteDesktopSetupFailure.ACCOUNT_CHANGED); return }
        val epoch = ++run.choiceEpoch
        run.choices = null
        mutableState.value = RemoteDesktopSetupUiState.LoadingDisplayChoices(run.display!!)
        val priorWork = run.sourceJob
        run.sourceJob = scope.launch(start = CoroutineStart.LAZY) {
            fun choosing(): Boolean = current(run) && epoch == run.choiceEpoch
            try {
                priorWork?.join()
                if (!choosing()) return@launch
                val catalog = run.channel!!.refreshDisplays()
                if (!choosing()) return@launch
                run.choices = catalog
                mutableState.value = RemoteDesktopSetupUiState.ChoosePausedDisplay(run.display!!, catalog.displays)
            } catch (cancelled: CancellationException) {
                if (active === run) close()
                throw cancelled
            } catch (error: Exception) {
                if (choosing()) fail(run, remoteDesktopSetupFailure(error))
            } finally { requestCleanup(run) }
        }
        startWork(run, run.sourceJob!!)
    }

    private fun selectPausedDisplay(id: String) {
        val run = active ?: return
        if (mutableState.value !is RemoteDesktopSetupUiState.ChoosePausedDisplay) return
        val selected = run.choices?.displays?.singleOrNull { it.id == id } ?: return
        if (!current(run)) { fail(run, RemoteDesktopSetupFailure.ACCOUNT_CHANGED); return }
        val previous = run.binding ?: return
        run.choiceEpoch++
        run.choices = null
        run.pauseRequested = false
        mutableState.value = RemoteDesktopSetupUiState.SelectingDisplay(selected)
        val priorWork = run.sourceJob
        run.sourceJob = scope.launch(start = CoroutineStart.LAZY) {
            try {
                priorWork?.join()
                if (!current(run)) return@launch
                val channel = run.channel!!
                val before = channel.sourceState(previous.attachment)
                if (!current(run)) return@launch
                if (before.attachment != previous || !before.suspended || before.cleanupPending) {
                    throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.TARGET_UNAVAILABLE)
                }
                val result = try { channel.selectSource(previous.attachment, before.revision, selected.id) }
                catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (remoteDesktopSetupFailure(error) != RemoteDesktopSetupFailure.DELIVERY_UNKNOWN) throw error
                    if (!current(run)) return@launch
                    channel.sourceState(previous.attachment)
                }
                if (!current(run)) return@launch
                val next = result.attachment
                if (next != previous.copy(display = selected.id) || !result.suspended || result.cleanupPending) {
                    throw RemoteDesktopSetupException(RemoteDesktopSetupFailure.DELIVERY_UNKNOWN)
                }
                run.binding = next
                run.display = selected
                mutableState.value = RemoteDesktopSetupUiState.Paused(selected)
                if (!run.pauseRequested) changeSource(true)
            } catch (cancelled: CancellationException) {
                if (active === run) close()
                throw cancelled
            } catch (error: Exception) { fail(run, remoteDesktopSetupFailure(error)) }
            finally { requestCleanup(run) }
        }
        startWork(run, run.sourceJob!!)
    }

    private fun startWork(run: Run, job: Job) {
        job.invokeOnCompletion { requestCleanup(run) }
        job.start()
    }

    private fun requestCleanup(run: Run) {
        if (active !== run && run.job?.isCompleted != false && run.sourceJob?.isCompleted != false) {
            scope.launch(start = CoroutineStart.UNDISPATCHED) { cleanup(run) }
        }
    }

    private fun watch(run: Run) {
        run.watch = scope.launch {
            try {
                while (active === run) {
                    delay(250)
                    if (!identityCurrent(run) || (run.media == null && !current(run))) fail(run, RemoteDesktopSetupFailure.ACCOUNT_CHANGED)
                    else if (run.sourceDeadline?.let { nowMillis() >= it } == true) fail(run, RemoteDesktopSetupFailure.CONNECTION_TIMEOUT)
                    else if (run.media?.viewing != true && run.startedAt?.let { nowMillis() - it >= 60_000 } == true) {
                        fail(run, RemoteDesktopSetupFailure.CONNECTION_TIMEOUT)
                    }
                    else run.media?.checkDeadline()
                }
            } finally {
                if (!isActive && active === run) close()
            }
        }
    }

    public fun close() {
        mutableState.value = RemoteDesktopSetupUiState.Closed
        retire()
    }

    /** Account-level replacement must not overtake this owner's pending attach/detach. */
    internal suspend fun awaitCleanup() { last?.cleaned?.await() }

    private fun fail(run: Run, reason: RemoteDesktopSetupFailure) {
        if (active !== run) return
        mutableState.value = RemoteDesktopSetupUiState.Failed(if (accountCurrent()) reason else RemoteDesktopSetupFailure.ACCOUNT_CHANGED)
        retire()
    }

    private fun retire() {
        val run = active ?: return
        active = null
        retireControl(run)
        run.media?.stop()
        run.watch?.cancel()
        // Do not cancel an in-flight attach: cleanup must follow its completion.
        requestCleanup(run)
    }

    private fun inactiveControl(): RemoteDesktopControlUiState = RemoteDesktopControlUiState(null, false,
        RemoteDesktopControlMode.VIEWING, null, 0, false, null)

    private fun RemoteDesktopMediaUiState.binding(): RemoteDesktopMediaBindingUi =
        RemoteDesktopMediaBindingUi(rendererId, attachmentId, connectionId)

    private fun installControl(run: Run, media: RemoteDesktopMediaUiState) {
        run.control?.close()
        val binding = media.binding()
        lateinit var owner: RemoteDesktopControlSession
        owner = RemoteDesktopControlSession(binding, run.display!!.id, media.controlSupported && run.controlReady,
            { identityCurrent(run) && mutableMedia.value?.binding() == binding },
            { current(run) && mutableState.value is RemoteDesktopSetupUiState.Viewing
                && mutableMedia.value?.signalingInterrupted == false && run.controlReady },
            { run.channel!!.sourceState(binding.attachmentId) },
            { command -> run.control === owner && rendererControl.trySend(command).isSuccess },
            { state -> if (run.control === owner) mutableControl.value = state },
            { reason -> if (run.control === owner) fail(run, reason) },
            textSupported = "text_commit_v1" in run.directory!!.capabilities)
        run.control = owner
        mutableControl.value = owner.state
    }

    private fun retireControl(run: Run) {
        run.control?.close()
        run.control = null
        run.controlReady = false
        mutableControl.value = inactiveControl()
        while (rendererControl.tryReceive().isSuccess) { /* Retired native effects cannot be replayed. */ }
    }

    private suspend fun cleanup(run: Run) {
        if (run.cleaning) return
        run.cleaning = true
        withContext(NonCancellable) {
            try {
                val channel = run.channel
                val id = run.attachment
                if (channel != null && id != null && channel.current()) {
                    withTimeout(10_000) { channel.detach(id) }
                }
            } catch (_: Exception) {
                // Best effort over the original binding; the host's bounded cleanup is independent.
            } finally {
                val channel = run.channel
                run.channel = null
                run.media = null
                try { channel?.close() } finally { run.cleaned.complete(Unit) }
            }
        }
    }
}
