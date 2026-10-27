package com.openbitfun.mobile.app.ui.remote

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewConfiguration
import com.openbitfun.mobile.core.feature.remotedesktop.*
import org.json.JSONObject

/** App-private native leaf. No account access or OS input; the peer remains the
 * authority. Its snapshot port is read-only and may run on the JS bridge thread. */
internal interface RemoteDesktopControlHost {
    fun state(): RemoteDesktopControlUiState
    fun dispatch(intent: RemoteDesktopControlIntent)
    fun report(intent: RemoteDesktopControlReportIntent)
}

internal class RemoteDesktopControlBridge(
    private val host: RemoteDesktopControlHost,
    private val evaluate: (String, (String?) -> Unit) -> Unit,
    private val onReady: (RemoteDesktopMediaBindingUi) -> Unit,
    private val failed: () -> Unit,
    configuration: ViewConfiguration,
    density: Float,
    transformed: (RemoteDesktopGesturePolicy.Transform) -> Unit,
) {
    @Volatile private var media: RemoteDesktopMediaUiState? = null
    @Volatile private var focused = false
    @Volatile private var sdkSupported = false
    private var frame = 0 to 0
    private var focusObserved = false
    private val handler = Handler(Looper.getMainLooper())
    private val pending = mutableSetOf<Runnable>()
    @Volatile private var disposed = false
    private var lastState: RemoteDesktopControlUiState? = null
    private var viewport = 0 to 0
    private var queuedMove: RemoteDesktopControlRendererIntent.PointerMove? = null
    private val flushMove = Runnable { queuedMove?.let { queuedMove = null; execute(it) } }
    private val gestures = RemoteDesktopGesturePolicy(configuration.scaledTouchSlop.toDouble(),
        configuration.scaledDoubleTapSlop.toDouble(), ViewConfiguration.getLongPressTimeout().toLong(),
        ViewConfiguration.getDoubleTapTimeout().toLong(), density.toDouble(), host::dispatch, transformed)
    private val longPress = Runnable { if (!disposed) gestures.longPress(SystemClock.uptimeMillis()) }

    private fun RemoteDesktopMediaUiState.binding() = RemoteDesktopMediaBindingUi(rendererId, attachmentId, connectionId)
    fun sdkSupported(value: Boolean) { sdkSupported = value }
    fun sdkSupported(): Boolean = sdkSupported

    fun render(value: RemoteDesktopMediaUiState?) {
        if (media?.binding() != value?.binding()) {
            frame = 0 to 0; focusObserved = false; resetGesture(); lastState = null
            gestures.configure(viewport.first, viewport.second, 0, 0, resetZoom = true)
            pending.forEach(handler::removeCallbacks); pending.clear()
        }
        media = value
        if (value == null || value.signalingInterrupted) resetGesture()
    }

    fun geometry(width: Int, height: Int) {
        if (frame == (width to height)) return
        resetGesture()
        frame = width to height
        gestures.configure(viewport.first, viewport.second, width, height, resetZoom = true)
    }

    fun ready() {
        val value = media ?: return
        if (!value.controlSupported || !sdkSupported || !focusObserved || disposed || frame.first == 0) return
        val state = host.state()
        if (state.binding != value.binding() || !state.supported) onReady(value.binding())
    }

    fun hasFocus(): Boolean = focused
    fun focusReplyDelivered(binding: RemoteDesktopMediaBindingUi) {
        if (media?.binding() == binding) { focusObserved = true; ready() }
    }

    fun focusChanged(value: Boolean) {
        if (disposed) return
        focused = value
        if (!value) {
            resetGesture()
            val state = host.state()
            state.binding?.takeIf { it == media?.binding() }?.let { host.dispatch(RemoteDesktopControlIntent.Release(it, state.intentEpoch)) }
        }
    }

    fun resetGesture() {
        handler.removeCallbacks(longPress)
        handler.removeCallbacks(flushMove); queuedMove = null
        gestures.cancel()
    }

    fun viewport(width: Int, height: Int) {
        if (viewport != (width to height)) resetGesture()
        viewport = width to height
        gestures.configure(width, height, frame.first, frame.second)
    }

    fun sync(state: RemoteDesktopControlUiState) {
        val previous = lastState
        lastState = state
        if (previous != null && (state.binding != previous.binding || state.intentEpoch != previous.intentEpoch
            || state.generation != previous.generation || state.mode != previous.mode)) resetGesture()
        val value = media ?: return
        if (state.binding != value.binding() && previous?.binding == value.binding()
            && (previous.mode != RemoteDesktopControlMode.VIEWING || previous.releasePending)) {
            resetGesture()
            // Local cleanup only. It cannot grant or restore authority.
            val command = JSONObject().put("kind", "control").put("renderer_id", value.rendererId)
                .put("attach_id", value.attachmentId).put("connection_id", value.connectionId)
                .put("body", JSONObject().put("kind", "release_control"))
            evaluate("window.OpenBitFunDesktopReceiver.accept($command);void 0") { }
        }
    }

    fun touch(event: MotionEvent, width: Int, height: Int): Boolean {
        if (disposed) return true
        viewport(width, height)
        val value = media
        val state = host.state()
        val authority = state.takeIf { focused && value?.sourceReady == true && !value.signalingInterrupted
            && state.binding == value.binding() && state.mode == RemoteDesktopControlMode.CONTROLLING }
        // Android transforms MotionEvent coordinates into the scaled child's
        // space. Restore stable viewport coordinates before classifying gestures.
        val transform = gestures.transform
        val points = (0 until event.pointerCount).map { i -> RemoteDesktopGesturePolicy.Point(event.getPointerId(i),
            (event.getX(i) - width / 2.0) * transform.scale + width / 2.0 + transform.x,
            (event.getY(i) - height / 2.0) * transform.scale + height / 2.0 + transform.y) }
        handler.removeCallbacks(longPress)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> gestures.down(points, event.eventTime, authority)
            MotionEvent.ACTION_MOVE -> gestures.move(points)
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> gestures.up(points, event.eventTime, event.pointerCount - 1)
            MotionEvent.ACTION_CANCEL -> resetGesture()
        }
        gestures.deadline?.let { handler.postAtTime(longPress, it) }
        return true
    }

    /** Queried at JS execution time, not merely when native queued the script. */
    fun permits(renderer: String, attachment: String, connection: String, epoch: String, generation: String, action: String): Boolean {
        val value = media ?: return false
        if (disposed || !sdkSupported || !value.controlSupported || value.rendererId != renderer || value.attachmentId != attachment
            || value.connectionId != connection) return false
        val state = host.state()
        if (state.binding != value.binding() || state.intentEpoch.toString() != epoch || !state.supported) return false
        return when (action) {
            "acquire" -> focused && value.sourceReady && !value.signalingInterrupted && state.mode == RemoteDesktopControlMode.ACQUIRING
            "release" -> state.mode == RemoteDesktopControlMode.VIEWING && state.releasePending
            "tap", "key", "text", "pointer", "wheel" -> focused && value.sourceReady && !value.signalingInterrupted && state.mode == RemoteDesktopControlMode.CONTROLLING
                && state.generation == generation && (action != "text" || state.textSupported)
            else -> false
        }
    }

    fun command(command: RemoteDesktopControlRendererIntent) {
        if (disposed) return
        if (command is RemoteDesktopControlRendererIntent.PointerMove) {
            if (queuedMove == null) handler.postDelayed(flushMove, 16)
            queuedMove = command
            return
        }
        // Coalesce only adjacent moves. Button/key edges and wheel preserve order.
        handler.removeCallbacks(flushMove); flushMove.run()
        execute(command)
    }

    private fun execute(command: RemoteDesktopControlRendererIntent) {
        if (disposed) return
        val action = when (command) {
            is RemoteDesktopControlRendererIntent.Acquire -> "acquire"
            is RemoteDesktopControlRendererIntent.Release -> "release"
            is RemoteDesktopControlRendererIntent.Tap -> "tap"
            is RemoteDesktopControlRendererIntent.PointerMove, is RemoteDesktopControlRendererIntent.PointerButton -> "pointer"
            is RemoteDesktopControlRendererIntent.Wheel -> "wheel"
            is RemoteDesktopControlRendererIntent.KeyTap -> "key"
            is RemoteDesktopControlRendererIntent.TextCommit -> "text"
        }
        val generation = when (command) {
            is RemoteDesktopControlRendererIntent.Tap -> command.generation
            is RemoteDesktopControlRendererIntent.PointerMove -> command.generation
            is RemoteDesktopControlRendererIntent.PointerButton -> command.generation
            is RemoteDesktopControlRendererIntent.Wheel -> command.generation
            is RemoteDesktopControlRendererIntent.KeyTap -> command.generation
            is RemoteDesktopControlRendererIntent.TextCommit -> command.generation
            else -> ""
        }
        val id = command.binding
        val epoch = command.intentEpoch.toString()
        if (!permits(id.rendererId, id.attachmentId, id.connectionId, epoch, generation, action)) {
            skipped(command); return
        }
        val bodies = when (command) {
            is RemoteDesktopControlRendererIntent.Acquire -> listOf(JSONObject().put("kind", "acquire_control").put("expected_state_revision", command.revision))
            is RemoteDesktopControlRendererIntent.Release -> listOf(JSONObject().put("kind", "release_control"))
            is RemoteDesktopControlRendererIntent.Tap -> listOf(true, false).map { down ->
                JSONObject().put("kind", "pointer_button").put("control_generation", command.generation).put("body",
                    JSONObject().put("x", command.x).put("y", command.y).put("button", command.button.name.lowercase()).put("down", down))
            }
            is RemoteDesktopControlRendererIntent.PointerMove -> listOf(JSONObject().put("kind", "pointer_move")
                .put("control_generation", command.generation).put("body", JSONObject().put("x", command.x).put("y", command.y)))
            is RemoteDesktopControlRendererIntent.PointerButton -> listOf(JSONObject().put("kind", "pointer_button")
                .put("control_generation", command.generation).put("body", JSONObject().put("x", command.x).put("y", command.y)
                    .put("button", command.button.name.lowercase()).put("down", command.down)))
            is RemoteDesktopControlRendererIntent.Wheel -> listOf(JSONObject().put("kind", "wheel")
                .put("control_generation", command.generation).put("body", JSONObject().put("x", command.x).put("y", command.y)
                    .put("dx", command.dx).put("dy", command.dy)))
            is RemoteDesktopControlRendererIntent.TextCommit -> listOf(JSONObject().put("kind", "text_commit")
                .put("control_generation", command.generation).put("body", JSONObject().put("text", command.text)))
            is RemoteDesktopControlRendererIntent.KeyTap -> {
                val usage = when (command.key) {
                    RemoteDesktopKeyboardKey.BACKSPACE -> 0x2a
                    RemoteDesktopKeyboardKey.DELETE -> 0x4c
                    RemoteDesktopKeyboardKey.ENTER -> 0x28
                    RemoteDesktopKeyboardKey.TAB -> 0x2b
                    RemoteDesktopKeyboardKey.ESCAPE -> 0x29
                    RemoteDesktopKeyboardKey.LEFT -> 0x50
                    RemoteDesktopKeyboardKey.RIGHT -> 0x4f
                    RemoteDesktopKeyboardKey.UP -> 0x52
                    RemoteDesktopKeyboardKey.DOWN -> 0x51
                }
                listOf(true, false).map { down -> JSONObject().put("kind", "key").put("control_generation", command.generation)
                    .put("body", JSONObject().put("usage", usage).put("down", down)) }
            }
        }
        val payloads = bodies.map { body -> JSONObject().put("kind", "control").put("renderer_id", id.rendererId)
            .put("attach_id", id.attachmentId).put("connection_id", id.connectionId).put("control_epoch", epoch).put("body", body) }
        val args = listOf(id.rendererId, id.attachmentId, id.connectionId, epoch, generation, action).joinToString(",") { JSONObject.quote(it) }
        val body = payloads.joinToString("") { "if(!h.permitsControl($args))return false;r.accept($it);" }
        val script = "(()=>{const h=window.OpenBitFunDesktopHost,r=window.OpenBitFunDesktopReceiver;$body return true;})()"
        if (pending.size >= 8) { failed(); return }
        val timeout = object : Runnable { override fun run() { if (pending.remove(this)) failed() } }
        pending += timeout; handler.postDelayed(timeout, 2_000)
        try {
            evaluate(script) { result ->
                if (pending.remove(timeout)) handler.removeCallbacks(timeout)
                if (!disposed && result != "true") skipped(command)
            }
        } catch (_: Exception) { pending.remove(timeout); handler.removeCallbacks(timeout); failed() }
    }

    private fun skipped(command: RemoteDesktopControlRendererIntent) {
        val state = host.state()
        if (state.binding != command.binding || state.intentEpoch != command.intentEpoch) return
        when (command) {
            is RemoteDesktopControlRendererIntent.Acquire -> host.report(RemoteDesktopControlReportIntent(command.binding,
                command.intentEpoch, null, null, RemoteDesktopControlFailure.INPUT_SUSPENDED))
            is RemoteDesktopControlRendererIntent.Tap, is RemoteDesktopControlRendererIntent.KeyTap,
            is RemoteDesktopControlRendererIntent.PointerMove, is RemoteDesktopControlRendererIntent.PointerButton,
            is RemoteDesktopControlRendererIntent.Wheel, is RemoteDesktopControlRendererIntent.TextCommit -> host.dispatch(RemoteDesktopControlIntent.Release(command.binding, command.intentEpoch))
            is RemoteDesktopControlRendererIntent.Release -> failed()
        }
    }

    fun report(event: JSONObject, binding: RemoteDesktopMediaBindingUi) {
        try {
            val epochText = event.get("control_epoch") as? String ?: error("Invalid epoch")
            val epoch = epochText.toLongOrNull()?.takeIf { it >= 0 && it.toString() == epochText } ?: error("Invalid epoch")
            fun optional(name: String): String? {
                if (!event.has(name) || event.isNull(name)) return null
                return event.get(name) as? String ?: error("Invalid field")
            }
            val pending = when (optional("pending")) {
                null -> null
                "acquire_control" -> RemoteDesktopControlPending.ACQUIRE
                "release_control" -> RemoteDesktopControlPending.RELEASE
                "renew_control" -> RemoteDesktopControlPending.RENEW
                else -> error("Invalid pending action")
            }
            val failure = when (event.get("code") as? String) {
                "ok" -> null
                "control_busy", "busy", "attachment_busy" -> RemoteDesktopControlFailure.BUSY
                "device_approval_required", "authorization_required", "authorization_expired", "authorization_unknown" -> RemoteDesktopControlFailure.DEVICE_APPROVAL_REQUIRED
                "permission_required" -> RemoteDesktopControlFailure.PERMISSION_REQUIRED
                "stale_revision" -> RemoteDesktopControlFailure.STALE_REVISION
                "control_revoked" -> RemoteDesktopControlFailure.REVOKED
                "input_suspended", "lease_expired", "stale_control" -> RemoteDesktopControlFailure.INPUT_SUSPENDED
                "control_delivery_unknown", "input_backpressure" -> RemoteDesktopControlFailure.DELIVERY_UNKNOWN
                else -> RemoteDesktopControlFailure.INVALID_RESPONSE
            }
            host.report(RemoteDesktopControlReportIntent(binding, epoch, optional("control_generation"), pending, failure))
        } catch (_: Exception) { failed() }
    }

    fun close() {
        disposed = true; media = null; focused = false; resetGesture()
        pending.forEach(handler::removeCallbacks); pending.clear()
    }
}
