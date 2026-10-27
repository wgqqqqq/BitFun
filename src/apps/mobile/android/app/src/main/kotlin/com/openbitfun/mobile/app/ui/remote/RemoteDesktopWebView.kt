package com.openbitfun.mobile.app.ui.remote

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.view.View
import android.view.ViewConfiguration
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopMediaBindingUi
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopMediaIntent
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopMediaUiState
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlRendererIntent
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlUiState
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.atomic.AtomicLong

/** One fixed bundled media document. Never accepts account IO or generic JS commands. */
@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
internal class RemoteDesktopWebView(
    context: Context,
    private val onReady: () -> Unit,
    private val onIntent: (RemoteDesktopMediaIntent) -> Unit,
    private val controlHost: RemoteDesktopControlHost? = null,
) : WebView(context) {
    @Volatile private var disposed = false
    // Own the allowed load before issuing loadUrl. JS bridge messages and
    // onPageStarted arrive on different threads and may be queued out of order.
    private val documentEpoch = AtomicLong(1)
    private var documentStarted = false
    private var ready = false
    private var desired: RemoteDesktopMediaUiState? = null
    private var started: RemoteDesktopMediaUiState? = null
    private var sourceSent = false
    private var nativeDestroyed = false
    private val handler = Handler(Looper.getMainLooper())
    private val destroyFallback = Runnable { destroyNative() }
    private val readyTimeout = Runnable { if (!ready && !disposed) fail(FailureStage.READY_TIMEOUT) }
    @Volatile private var input: RemoteDesktopControlBridge? = null

    private enum class FailureStage { READY_TIMEOUT, NAVIGATION, ASSET, RESOURCE, RENDERER, CONFIGURATION, GEOMETRY, MEDIA, INPUT }
    private enum class MediaFailure { UNREACHABLE, PLAYBACK, CONFIGURATION, BACKEND, OTHER }
    private enum class MediaFailureStage { CHANNEL, PEER, TRACK, PLAYBACK, STATS, SETUP,
        ICE_401, ICE_403, ICE_437, ICE_438, ICE_441, ICE_486, ICE_508, ICE_701, ICE_NO_CANDIDATES, OTHER }

    init {
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.domStorageEnabled = false
        settings.mediaPlaybackRequiresUserGesture = false
        settings.setSupportMultipleWindows(false)
        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        isFocusable = false
        input = controlHost?.let { host -> RemoteDesktopControlBridge(host,
            { script, callback -> if (!disposed) evaluateJavascript(script, callback) },
            { binding -> onIntent(RemoteDesktopMediaIntent.ControlReady(binding)) }, { fail(FailureStage.INPUT) },
            ViewConfiguration.get(context), resources.displayMetrics.density, { transform ->
                scaleX = transform.scale.toFloat(); scaleY = transform.scale.toFloat()
                translationX = transform.x.toFloat(); translationY = transform.y.toFloat()
            }) }
        setOnTouchListener { _, event -> input?.touch(event, width, height) ?: true }
        addJavascriptInterface(Bridge(), BRIDGE)
        webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = true
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.toString() != PAGE || !request.isForMainFrame || documentStarted

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (url != PAGE || documentStarted) { fail(FailureStage.NAVIGATION); return }
                documentStarted = true
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val file = FILES[request.url.toString()]
                if (disposed || file == null || request.method != "GET") return blocked()
                return try {
                    WebResourceResponse(if (file.endsWith(".html")) "text/html" else "text/javascript", "UTF-8",
                        200, "OK", mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"),
                        context.assets.open("remote-desktop/$file"))
                } catch (_: Exception) { post { fail(FailureStage.ASSET) }; blocked() }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame || request.url.toString() in FILES) fail(FailureStage.RESOURCE)
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                ready = false
                fail(FailureStage.RENDERER)
                return true
            }
        }
        handler.postDelayed(readyTimeout, 10_000)
        loadUrl(PAGE)
    }

    fun render(value: RemoteDesktopMediaUiState?) {
        if (disposed) return
        desired = value
        input?.render(value)
        if (value == null) {
            started = null
            sourceSent = false
            visibility = INVISIBLE
            if (ready) evaluateJavascript("window.OpenBitFunDesktopReceiver.stop();void 0", null)
            return
        }
        visibility = VISIBLE
        if (!ready) return
        val old = started
        if (old?.rendererId == value.rendererId) {
            if (old.copy(sourceReady = value.sourceReady, signalingInterrupted = value.signalingInterrupted) != value
                || sourceSent && !value.sourceReady) { fail(FailureStage.CONFIGURATION); return }
        } else {
            started = value
            sourceSent = false
            val servers = JSONArray()
            value.iceServers.forEach { servers.put(JSONObject().put("urls", JSONArray(it.urls)).put("username", it.username).put("credential", it.credential)) }
            val controllable = value.controlSupported && input?.sdkSupported() == true
            val start = JSONObject().put("kind", "start").put("renderer_id", value.rendererId).put("attach_id", value.attachmentId)
                .put("connection_id", value.connectionId).put("offer_sdp", value.offerSdp).put("ice_servers", servers)
                .put("force_relay", value.forceRelay).put("control_supported", controllable).put("parent_focus", controllable)
            if (controllable) start.put("control_epoch", "0")
            send(start)
        }
        if (value.sourceReady && !sourceSent) {
            sourceSent = true
            send(JSONObject().put("kind", "source_ready").put("renderer_id", value.rendererId).put("connection_id", value.connectionId))
        }
    }

    fun updateBackground(color: Int) {
        if (!disposed) setBackgroundColor(color)
    }

    fun renderControl(state: RemoteDesktopControlUiState) { if (!disposed) input?.sync(state) }
    fun control(intent: RemoteDesktopControlRendererIntent) { if (!disposed) input?.command(intent) }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        input?.focusChanged(hasWindowFocus && windowVisibility == View.VISIBLE)
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        input?.focusChanged(visibility == View.VISIBLE && hasWindowFocus())
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        input?.viewport(w, h)
    }

    /** Reconcile readiness when the store is waiting to prepare a connection. */
    fun prepareConnection() {
        if (!disposed && ready) onReady()
    }

    private fun send(value: JSONObject, delivered: () -> Unit = {}) {
        if (!disposed) evaluateJavascript("window.OpenBitFunDesktopReceiver.accept($value);void 0") { if (!disposed) delivered() }
    }

    private fun binding(): RemoteDesktopMediaBindingUi? = started?.let { RemoteDesktopMediaBindingUi(it.rendererId, it.attachmentId, it.connectionId) }

    private inner class Bridge {
        @JavascriptInterface fun permitsControl(renderer: String?, attachment: String?, connection: String?,
            epoch: String?, generation: String?, action: String?): Boolean = !disposed
            && renderer != null && attachment != null && connection != null && epoch != null && generation != null && action != null
            && renderer.length in 1..128 && attachment.length in 1..128 && connection.length in 1..128
            && epoch.length in 1..19 && generation.length <= 20
            && input?.permits(renderer, attachment, connection, epoch, generation, action) == true

        @JavascriptInterface fun postMessage(raw: String) {
            if (disposed || raw.length > 96 * 1024 || raw.toByteArray(Charsets.UTF_8).size > 96 * 1024) return
            val epoch = documentEpoch.get()
            post {
                if (disposed || epoch != documentEpoch.get() || url != PAGE) return@post
                val event = runCatching { JSONObject(raw) }.getOrNull() ?: return@post
                if (event.optString("kind") == "bridge_ready") {
                    if (ready) return@post
                    ready = true
                    val capabilities = event.optJSONArray("capabilities")
                    input?.sdkSupported(capabilities != null && (0 until capabilities.length()).any { capabilities.opt(it) == "control_epoch_v1" })
                    handler.removeCallbacks(readyTimeout)
                    prepareConnection()
                    if (!disposed) render(desired)
                    return@post
                }
                val id = binding() ?: return@post
                if (event.optString("renderer_id") != id.rendererId || event.optString("attach_id") != id.attachmentId
                    || event.optString("connection_id") != id.connectionId) return@post
                when (event.optString("kind")) {
                    "answer" -> (event.opt("answer_sdp") as? String)?.let { onIntent(RemoteDesktopMediaIntent.Answer(id, it)) }
                    "first_frame_presented", "frame_resized" -> {
                        val width = event.opt("width") as? Int
                        val height = event.opt("height") as? Int
                        if (width == null || height == null || width !in 1..32768 || height !in 1..32768) fail(FailureStage.GEOMETRY)
                        else {
                            input?.focusChanged(hasWindowFocus() && windowVisibility == View.VISIBLE)
                            input?.geometry(width, height)
                            onIntent(RemoteDesktopMediaIntent.FramePresented(id, width, height))
                            input?.ready()
                        }
                    }
                    "health" -> {
                        onIntent(RemoteDesktopMediaIntent.Health(id, event.optString("candidate_type"), event.optString("remote_candidate_type")))
                        input?.ready()
                    }
                    "focus_probe" -> {
                        val echo = event.opt("echo") as? String
                        if (echo != null && echo.length in 1..20 && echo.all { it in '0'..'9' }) {
                            send(JSONObject().put("kind", "focus_reply").put("renderer_id", id.rendererId)
                                .put("attach_id", id.attachmentId).put("connection_id", id.connectionId).put("echo", echo)
                                .put("focused", input?.hasFocus() == true)) {
                                if (binding() == id) input?.focusReplyDelivered(id)
                            }
                        }
                    }
                    "control_state" -> if (input != null) input?.report(event, id) else fail(FailureStage.INPUT)
                    "failed", "bridge_failed" -> fail(FailureStage.MEDIA, when (event.optString("code")) {
                        "media_unreachable" -> MediaFailure.UNREACHABLE
                        "media_playback_failed" -> MediaFailure.PLAYBACK
                        "invalid_media_config", "invalid_answer" -> MediaFailure.CONFIGURATION
                        "media_backend_unavailable", "control_not_available" -> MediaFailure.BACKEND
                        else -> MediaFailure.OTHER
                    }, when (event.optString("stage")) {
                        "channel" -> MediaFailureStage.CHANNEL
                        "peer" -> MediaFailureStage.PEER
                        "track" -> MediaFailureStage.TRACK
                        "playback" -> MediaFailureStage.PLAYBACK
                        "stats" -> MediaFailureStage.STATS
                        "setup" -> MediaFailureStage.SETUP
                        "ice_401" -> MediaFailureStage.ICE_401
                        "ice_403" -> MediaFailureStage.ICE_403
                        "ice_437" -> MediaFailureStage.ICE_437
                        "ice_438" -> MediaFailureStage.ICE_438
                        "ice_441" -> MediaFailureStage.ICE_441
                        "ice_486" -> MediaFailureStage.ICE_486
                        "ice_508" -> MediaFailureStage.ICE_508
                        "ice_701" -> MediaFailureStage.ICE_701
                        "ice_no_candidates" -> MediaFailureStage.ICE_NO_CANDIDATES
                        else -> MediaFailureStage.OTHER
                    })
                }
            }
        }
    }

    private fun fail(stage: FailureStage, reason: MediaFailure? = null, source: MediaFailureStage? = null) {
        if (disposed) return
        // Fixed stages and booleans only: no URLs, SDP, credentials or raw events.
        Log.w("OpenBitFunRdMedia", "Renderer failed: stage=$stage reason=$reason source=$source ready=$ready documentStarted=$documentStarted pc=${started != null}")
        val id = binding()
        dispose(false)
        onIntent(if (id == null) RemoteDesktopMediaIntent.Unavailable else RemoteDesktopMediaIntent.Failed(id))
    }

    fun dispose(reportLoss: Boolean = true) {
        if (disposed) return
        val id = binding()
        disposed = true
        input?.close()
        documentEpoch.incrementAndGet()
        desired = null
        started = null
        visibility = INVISIBLE
        handler.removeCallbacks(readyTimeout)
        removeJavascriptInterface(BRIDGE)
        stopLoading()
        // Let the bundled receiver close its channel/PC before destroying the
        // document. Privacy/callback retirement above is synchronous; this wait
        // is bounded and never depends on a network acknowledgement.
        if (ready) {
            handler.postDelayed(destroyFallback, 2_000)
            runCatching { evaluateJavascript("window.OpenBitFunDesktopReceiver?.stop();true") { destroyNative() } }
                .onFailure { destroyNative() }
        } else destroyNative()
        if (reportLoss && id != null) onIntent(RemoteDesktopMediaIntent.Failed(id))
    }

    private fun destroyNative() {
        if (nativeDestroyed) return
        nativeDestroyed = true
        handler.removeCallbacks(destroyFallback)
        (parent as? ViewGroup)?.removeView(this)
        destroy()
    }

    private companion object {
        const val BRIDGE = "OpenBitFunDesktopHost"
        const val ORIGIN = "https://remote-desktop.invalid"
        const val PAGE = "$ORIGIN/index.html"
        val FILES = mapOf(PAGE to "index.html", "$ORIGIN/control.js" to "control.js", "$ORIGIN/receiver.js" to "receiver.js")
        fun blocked(): WebResourceResponse = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(byteArrayOf()))
    }
}
