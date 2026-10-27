package com.openbitfun.mobile.app

import android.graphics.Color
import android.os.Build
import android.util.Log
import android.webkit.WebView
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopWebView
import com.openbitfun.mobile.core.feature.remotedesktop.*
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Before
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Actual Android WebView, bundled receiver, generated video and ordered DC.
 * No account, native screen source, input lease, or remote OS input. */
class RemoteDesktopMediaProbeTest {
    @get:Rule val compose = createComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val view = AtomicReference<RemoteDesktopWebView>()
    private var configuration: RemoteDesktopMediaUiState? = null
    private val events = CopyOnWriteArrayList<JSONObject>()
    private val mounted = mutableStateOf(true)
    private val document = mutableStateOf(0)
    private val arguments = InstrumentationRegistry.getArguments()
    private val fixturePort = arguments.getString("remoteDesktopProbePort")?.toIntOrNull()
    private val fixtureKey = arguments.getString("remoteDesktopProbeKey")
    private var forceRelay = false

    @Before fun requireExternalSender() {
        assumeTrue("Use scripts/test-remote-desktop-android-media.mjs with a dedicated emulator",
            fixturePort != null && fixturePort in 1024..65535 && fixtureKey?.matches(Regex("[a-f0-9]{64}")) == true)
    }

    private fun remote(operation: String, body: JSONObject = JSONObject()): JSONObject {
        val connection = URI("http://127.0.0.1:$fixturePort/operation").toURL().openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15000; connection.readTimeout = 15000
            connection.instanceFollowRedirects = false; connection.requestMethod = "POST"; connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer $fixtureKey")
            connection.setRequestProperty("Content-Type", "application/json")
            val bytes = body.put("operation", operation).toString().toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.outputStream.use { it.write(bytes) }
            check(connection.responseCode == 200) { "External probe operation failed" }
            val response = connection.inputStream.use { stream ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(4096)
                while (true) {
                    val size = stream.read(buffer); if (size < 0) break
                    check(output.size() + size <= 128 * 1024) { "External probe response too large" }
                    output.write(buffer, 0, size)
                }
                output.toString("UTF-8")
            }
            return JSONObject(response).also { check(!it.optBoolean("unexpected_input")) { "Unexpected input in a read-only fixture" } }
        } finally { connection.disconnect() }
    }
    private fun event(intent: RemoteDesktopMediaIntent) {
        val value = JSONObject()
        val binding = when (intent) {
            is RemoteDesktopMediaIntent.Answer -> { value.put("kind", "answer").put("answer_sdp", intent.sdp); intent.binding }
            is RemoteDesktopMediaIntent.FramePresented -> { value.put("kind", "first_frame_presented").put("width", intent.width).put("height", intent.height); intent.binding }
            is RemoteDesktopMediaIntent.Health -> { value.put("kind", "health"); intent.binding }
            is RemoteDesktopMediaIntent.Failed -> { value.put("kind", "failed"); intent.binding }
            RemoteDesktopMediaIntent.Unavailable -> { value.put("kind", "failed"); null }
            RemoteDesktopMediaIntent.Prepare -> null
            is RemoteDesktopMediaIntent.ControlReady -> null
        }
        binding?.let { value.put("renderer_id", it.rendererId).put("attach_id", it.attachmentId).put("connection_id", it.connectionId) }
        if (events.size < 256) events += value
    }

    private fun open() {
        // Instantiate the production adapter, including its asset loader and bridge.
        compose.setContent {
            if (mounted.value) key(document.value) { AndroidView(modifier = Modifier.fillMaxSize(), factory = { context ->
                RemoteDesktopWebView(context, { events += JSONObject().put("kind", "bridge_ready") }, ::event).also { view.set(it) }
            }, onRelease = { released -> view.compareAndSet(released, null); released.dispose() }) }
        }
        waitFor { events.any { it.optString("kind") == "bridge_ready" } }
        assertEquals(1, events.count { it.optString("kind") == "bridge_ready" })
        assertTrue(status().getBoolean("secure"))
        // Observe only fixed event kinds in this generated-video fixture. The
        // production bridge still receives its original messages unchanged.
        execute("""window.__rdProbeEventKinds=[];window.__rdProbeSends=[];{
            const NativePeer=window.RTCPeerConnection;
            window.RTCPeerConnection=class extends NativePeer {
                constructor(...args){super(...args);window.__rdProbePeer=this;
                    this.addEventListener('datachannel',event=>{
                        const channel=event.channel;window.__rdProbeChannel=channel;
                        const send=channel.send.bind(channel);
                        channel.send=value=>{
                            if(window.__rdProbeSends.length<8)window.__rdProbeSends.push({
                                state:channel.readyState,id:channel.id,buffered:channel.bufferedAmount,
                                peer:this.connectionState,sctp:this.sctp?.state});
                            return send(value);
                        };
                    });}
            };
            const host=window.OpenBitFunDesktopHost;
            window.OpenBitFunDesktopHost={postMessage(raw){
                const kind=JSON.parse(raw).kind;
                if(['bound','transport_connected','answer','failed'].includes(kind))window.__rdProbeEventKinds.push(kind);
                if(kind==='bound')window.__rdProbeBindState={peer:window.__rdProbePeer?.connectionState,
                    sctp:window.__rdProbePeer?.sctp?.state,channel:window.__rdProbeChannel?.readyState};
                host.postMessage(raw);
            }};
        }void 0""".trimIndent())
        val assets = instrumentation.targetContext.assets
        for (file in listOf("index.html", "control.js", "receiver.js")) {
            assertTrue("Production receiver asset missing", assets.open("remote-desktop/$file").use { it.read() >= 0 })
        }
    }

    private fun render(value: RemoteDesktopMediaUiState?) {
        configuration = value
        instrumentation.runOnMainSync { view.get().render(value) }
    }

    private fun execute(script: String) = instrumentation.runOnMainSync { view.get().evaluateJavascript(script, null) }
    private fun status(): JSONObject {
        val done = CountDownLatch(1)
        val raw = AtomicReference("")
        instrumentation.runOnMainSync {
            view.get().evaluateJavascript("JSON.stringify({attached:!!document.querySelector('video').srcObject,width:document.querySelector('video').videoWidth,secure:window.isSecureContext,permissionDenied:window.__rdProbePermissionDenied===true,events:window.__rdProbeEventKinds||[],bindState:window.__rdProbeBindState||null,sends:window.__rdProbeSends||[],channelState:window.__rdProbeChannel?.readyState,buffered:window.__rdProbeChannel?.bufferedAmount})") {
                raw.set(JSONTokener(it).nextValue().toString()); done.countDown()
            }
        }
        assertTrue("WebView status callback timed out", done.await(5, TimeUnit.SECONDS))
        return JSONObject(raw.get())
    }
    private fun waitFor(condition: () -> Boolean) {
        try {
            compose.waitUntil(25_000) {
                assertFalse("Renderer reported a failure", events.any { it.optString("kind") in setOf("failed", "probe_failed", "probe_send_failed", "probe_unexpected_input") })
                condition()
            }
        } catch (failure: Throwable) {
            // Diagnostics only: never log answer SDP or arbitrary bridge bodies.
            val sends = events.filter { it.optString("kind") == "probe_send_failed" }
                .map { "${it.optString("side")}:${it.optString("state")}:${it.optString("code")}" }
            Log.e("OpenBitFunRdProbe", "Probe wait failed: kinds=${events.map { it.optString("kind") }}, sendFailures=$sends")
            val sender = runCatching { remote("status") }.getOrNull()
            val stats = runCatching { remote("stats") }.getOrNull()
            val video = runCatching { status() }.getOrNull()
            Log.e("OpenBitFunRdProbe", "Probe transport: channel=${sender?.optString("channel")}, bound=${sender?.optJSONObject("bound") != null}, " +
                "encoded=${stats?.optLong("frames_encoded")}, local=${stats?.optString("candidate_type")}, remote=${stats?.optString("remote_candidate_type")}, " +
                "peer=${sender?.optString("peer")}, sctp=${sender?.optString("sctp")}, messages=${sender?.optInt("messages_received")}, " +
                "videoWidth=${video?.optInt("width")}, attached=${video?.optBoolean("attached")}, receiverEvents=${video?.optJSONArray("events")}, " +
                "bindState=${video?.optJSONObject("bindState")}, sends=${video?.optJSONArray("sends")}, " +
                "localChannel=${video?.optString("channelState")}, buffered=${video?.optLong("buffered")}")
            throw failure
        }
    }
    private fun matching(kind: String, id: String) = events.filter { it.optString("kind") == kind && it.optString("renderer_id") == id }
    private fun start(id: String) {
        val command = remote("start", JSONObject().put("id", id))
        forceRelay = command.optBoolean("force_relay")
        val ice = command.getJSONArray("ice_servers")
        val servers = (0 until ice.length()).map { index ->
            val server = ice.getJSONObject(index); val urls = server.getJSONArray("urls")
            RemoteDesktopIceServerUi((0 until urls.length()).map { urls.getString(it) }, server.optString("username"), server.optString("credential"))
        }
        render(RemoteDesktopMediaUiState(id, "attach-$id", "pc-$id", command.getString("offer_sdp"), servers, forceRelay, false, false))
        waitFor { matching("answer", id).isNotEmpty() }
        remote("answer", JSONObject().put("sdp", matching("answer", id).single().getString("answer_sdp")))
        waitFor { !remote("status").isNull("bound") && status().optInt("width") > 0 }
        val bound = remote("status").getJSONObject("bound")
        assertEquals(1, bound.getInt("version")); assertTrue(bound.getBoolean("matches"))
        assertTrue(bound.getBoolean("ordered")); assertEquals("rd", bound.getString("label"))
    }
    private fun source(id: String) {
        val current = configuration
        if (current?.rendererId == id) render(current.copy(sourceReady = true))
        else {
            // Also retain the shared receiver's explicit stale-source check.
            val command = JSONObject().put("kind", "source_ready").put("renderer_id", id).put("connection_id", "pc-$id")
            execute("window.OpenBitFunDesktopReceiver.accept($command);void 0")
        }
    }
    private fun confirmAndProbe(id: String) {
        source(id)
        waitFor { matching("first_frame_presented", id).isNotEmpty() }
        val first = matching("first_frame_presented", id).single()
        assertEquals(320, first.getInt("width")); assertEquals(180, first.getInt("height"))
        waitFor {
            val health = remote("probe").optJSONObject("health")
            health?.optBoolean("first_frame") == true && health.optBoolean("visible") && health.optBoolean("receiving")
                && health.optString("decoded").toLongOrNull()?.let { it > 0 } == true
                && health.optString("presented").toLongOrNull()?.let { it > 0 } == true
        }
    }

    @Test fun bundledReceiverPresentsVideoAndAnswersTheOrderedChannel() {
        open(); start("first")
        remote("probe")
        waitFor { !remote("status").isNull("health") }
        assertFalse(remote("status").getJSONObject("health").getBoolean("first_frame"))
        assertTrue(matching("first_frame_presented", "first").isEmpty())
        confirmAndProbe("first")
        val stats = remote("stats")
        assertTrue(stats.getLong("frames_encoded") > 0)
        assertTrue(stats.getString("codec").lowercase() in setOf("video/vp8", "video/h264"))
        if (forceRelay) {
            assertEquals("relay", stats.getString("candidate_type"))
            assertEquals("relay", stats.getString("remote_candidate_type"))
        }
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        val pixel = bitmap.getPixel(bitmap.width / 2, bitmap.height / 2)
        bitmap.recycle()
        assertTrue("Generated video must be visible in the native window", Color.red(pixel) > 150 && Color.blue(pixel) < 80 || Color.blue(pixel) > 150 && Color.red(pixel) < 80)
        val health = remote("status").getJSONObject("health")
        Log.i("OpenBitFunRdProbe", "Generated media probe passed: sdk=${Build.VERSION.SDK_INT}, " +
            "webview=${WebView.getCurrentWebViewPackage()?.versionName}, codec=${stats.getString("codec")}, " +
            "encoded=${stats.getLong("frames_encoded")}, decoded=${health.getString("decoded")}, " +
            "presented=${health.getString("presented")}, local=${stats.optString("candidate_type")}, " +
            "remote=${stats.optString("remote_candidate_type")}, protocol=${stats.optString("protocol")}, " +
            "relayProtocol=${stats.optString("relay_protocol")}, native_pixels=true, input=false")
    }

    @Test fun stopAndRestartRequireAFrameFromTheNewSourceBinding() {
        open(); start("old"); confirmAndProbe("old")
        render(null)
        waitFor { !status().getBoolean("attached") && remote("status").optString("channel") != "open" }
        // The receiver close is the assertion above. Retire this fixture's
        // independent sender too, before gathering candidates for a new PC;
        // otherwise its unused TURN allocations overlap the next source.
        remote("stop")
        assertEquals("closed", remote("status").getString("channel"))
        // Match production: one native document per PC. In particular, new TURN
        // credentials must not be tested by reviving the retired document.
        val oldView = view.get()
        compose.runOnIdle { document.value++ }
        waitFor { events.count { it.optString("kind") == "bridge_ready" } == 2 }
        assertEquals(2, events.count { it.optString("kind") == "bridge_ready" })
        assertTrue(view.get() !== oldView)
        assertFalse(status().getBoolean("attached"))
        start("new")
        val before = events.size
        instrumentation.runOnMainSync { oldView.render(configuration) }
        assertEquals(before, events.size)
        source("old"); remote("probe")
        waitFor { !remote("status").isNull("health") }
        assertFalse(remote("status").getJSONObject("health").getBoolean("first_frame"))
        assertTrue(matching("first_frame_presented", "new").isEmpty())
        confirmAndProbe("new")
        Log.i("OpenBitFunRdProbe", "Receiver restart probe passed: old_channel_closed=true, new_source_required=true, input=false")
    }

    @Test fun navigationFailureClosesTheProductionViewAndOldCallbacksCannotReviveIt() {
        open(); start("navigation"); confirmAndProbe("navigation")
        execute("window.__rdProbePermissionDenied=false;navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop())},()=>{window.__rdProbePermissionDenied=true});void 0")
        waitFor { status().optBoolean("permissionDenied") }
        val old = configuration!!
        instrumentation.runOnMainSync { view.get().loadUrl("https://blocked-remote-desktop.invalid/") }
        compose.waitUntil(10_000) { events.any { it.optString("kind") == "failed" } && remote("status").optString("channel") != "open" }
        instrumentation.runOnMainSync { view.get().render(old) }
        assertTrue(events.count { it.optString("kind") == "answer" } == 1)
        assertTrue(remote("status").optString("channel") != "open")
        Log.i("OpenBitFunRdProbe", "Production adapter navigation probe passed: blocked=true, retired=true, stale_callbacks_ignored=true, permission_denied=true, input=false")
    }

    @Test fun sameOriginReloadClosesTheDocumentInsteadOfAcceptingAnotherBridge() {
        open()
        instrumentation.runOnMainSync { view.get().reload() }
        compose.waitUntil(10_000) { events.any { it.optString("kind") == "failed" } }
        instrumentation.runOnMainSync { view.get().prepareConnection() }
        assertEquals(1, events.count { it.optString("kind") == "bridge_ready" })
        assertTrue(events.none { it.optString("kind") == "answer" })
        Log.i("OpenBitFunRdProbe", "Same-origin reload probe passed: closed=true, bridge_retired=true, input=false")
    }

    @After fun close() {
        try { instrumentation.runOnMainSync { view.get()?.dispose() } }
        finally {
            compose.runOnIdle { mounted.value = false }; compose.waitForIdle()
            if (fixturePort != null && fixtureKey != null) remote("stop")
        }
    }
}
