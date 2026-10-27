package com.openbitfun.mobile.app

import android.graphics.Color
import android.util.Log
import android.app.Dialog
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.ui.test.longClick
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.platform.deviceIdentity
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopScreen
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopImeView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopWebView
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.CoreLog
import com.openbitfun.mobile.core.feature.account.AccountIntent
import com.openbitfun.mobile.core.feature.account.AccountStore
import com.openbitfun.mobile.core.feature.account.AccountUiState
import com.openbitfun.mobile.core.feature.account.create
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupStore
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupUiState
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupFailure
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlMode
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlIntent
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URI

/** Production account factory/crypto/socket/store/page. Auth and desktop are synthetic. */
class RemoteDesktopAccountMediaTest {
    @get:Rule val compose = createComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val args = InstrumentationRegistry.getArguments()
    private val port = args.getString("remoteDesktopFixturePort")?.toIntOrNull()
    private val key = args.getString("remoteDesktopFixtureKey")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var account: AccountStore? = null
    private val desktop = mutableStateOf<RemoteDesktopSetupStore?>(null)
    private val mounted = mutableStateOf(false)

    @Before fun requireIsolatedFixture() {
        assumeTrue("Use scripts/test-remote-desktop-android-account.mjs on its dedicated emulator",
            port != null && port in 1024..65535 && key?.matches(Regex("[a-f0-9]{64}")) == true)
        instrumentation.runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single() as ComponentActivity
            activity.enableEdgeToEdge()
            activity.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
    }

    private fun operation(name: String, body: JSONObject = JSONObject()): JSONObject {
        val connection = URI("http://127.0.0.1:$port/operation").toURL().openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 5000; connection.readTimeout = 5000
            connection.instanceFollowRedirects = false; connection.requestMethod = "POST"; connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer $key"); connection.setRequestProperty("Content-Type", "application/json")
            val data = body.put("operation", name).toString().toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(data.size); connection.outputStream.use { it.write(data) }
            check(connection.responseCode == 200) { "Fixture control unavailable" }
            return connection.inputStream.use {
                val bytes = it.readNBytes(16 * 1024 + 1); check(bytes.size <= 16 * 1024); JSONObject(bytes.toString(Charsets.UTF_8))
            }
        } finally { connection.disconnect() }
    }

    private fun open(allowView: Boolean, renewalSupported: Boolean = false, controlSupported: Boolean = false, controlGrant: Boolean = true,
        textSupported: Boolean = false, actualKeyboard: Boolean = false, gestures: Boolean = false) {
        operation("reset", JSONObject().put("allow_view", allowView).put("renewal_supported", renewalSupported)
            .put("control_supported", controlSupported).put("control_grant", controlGrant).put("text_supported", textSupported)
            .put("actual_keyboard", actualKeyboard).put("gestures", gestures))
        instrumentation.runOnMainSync {
            val identity = context.deviceIdentity()
            account = AccountStore.create(scope, context, identity.installId, identity.displayName, CoreLog.None, emptySet()).also {
                it.dispatch(AccountIntent.SelectRelay("http://127.0.0.1:$port")); it.dispatch(AccountIntent.Login)
            }
        }
        compose.waitUntil(15_000) { account?.state?.value is AccountUiState.Ready }
        instrumentation.runOnMainSync {
            account!!.dispatch(AccountIntent.SelectDevice("chat-target"))
            desktop.value = account!!.createRemoteDesktopSetupStore(scope, "media-target")
            assertNotNull(desktop.value); mounted.value = true
        }
        compose.setContent {
            if (mounted.value) OpenBitFunTheme(dark = false) {
                RemoteDesktopScreen(desktop.value, "Fixture desktop", onReconnect = {
                    desktop.value = account!!.createRemoteDesktopSetupStore(scope, "media-target")
                }, onBack = { mounted.value = false }, modifier = Modifier.fillMaxSize())
            }
        }
    }

    @Test fun nativePagePresentsTheEncryptedAccountTargetAndClosesItsAttachment() {
        open(true)
        chooseDisplayAndWait()
        val state = desktop.value!!.state.value as RemoteDesktopSetupUiState.Viewing
        assertEquals(320, state.width); assertEquals(180, state.height)
        val status = operation("status")
        assertEquals(0, status.getInt("errors")); assertTrue(status.getBoolean("attachment"))
        assertEquals("relay", status.getString("local")); assertEquals("relay", status.getString("remote"))
        assertTrue(status.getJSONObject("source").getJSONObject("bound").getBoolean("matches"))
        assertFalse(status.getJSONObject("source").getBoolean("unexpected_input"))
        assertEquals("chat-target", (account!!.state.value as AccountUiState.Ready).selectedDeviceId)
        // Viewing publishes before Compose removes its connecting overlay.
        // Require the native window to paint the actual video as well.
        waitForNativePixels()
        val oldBinding = desktop.value!!.media.value!!
        compose.onNodeWithTag("remote-desktop-pause").performClick()
        compose.waitUntil(10_000) { desktop.value!!.state.value is RemoteDesktopSetupUiState.Paused }
        assertNull(desktop.value!!.media.value)
        val paused = operation("status")
        assertTrue(paused.getBoolean("attachment")); assertEquals(0, paused.getJSONObject("counts").optInt("detach"))
        assertEquals("closed", paused.getJSONObject("source").getString("channel"))
        compose.onNodeWithTag("remote-desktop-resume").performClick()
        waitForViewing()
        val resumed = desktop.value!!.media.value!!
        assertEquals(oldBinding.attachmentId, resumed.attachmentId)
        assertNotEquals(oldBinding.connectionId, resumed.connectionId); assertNotEquals(oldBinding.rendererId, resumed.rendererId)
        assertEquals(1, operation("status").getJSONObject("counts").getInt("attach"))
        compose.onNodeWithText(context.getString(R.string.remote_desktop_disconnect)).performClick()
        compose.waitUntil(10_000) { !operation("status").getBoolean("attachment") }
        compose.onNodeWithText(context.getString(R.string.remote_desktop_disconnected)).assertIsDisplayed()
        assertEquals(1, operation("status").getJSONObject("counts").getInt("detach"))
        val previous = desktop.value
        compose.onNodeWithText(context.getString(R.string.remote_desktop_retry)).performClick()
        compose.runOnIdle { assertNotSame(previous, desktop.value) }
        chooseDisplayAndWait()
        assertEquals("chat-target", (account!!.state.value as AccountUiState.Ready).selectedDeviceId)
        compose.onNodeWithTag("remote-desktop-close").performClick()
        compose.waitUntil(10_000) { !operation("status").getBoolean("attachment") }
        assertEquals(2, operation("status").getJSONObject("counts").getInt("detach"))
    }

    @Test fun shortenedSyntheticHostBudgetRebuildsTheNativePcWithoutReattaching() {
        open(true, renewalSupported = true); chooseDisplayAndWait(); waitForNativePixels()
        val before = desktop.value!!.media.value!!
        operation("shorten_host_budget")
        compose.waitUntil(35_000) {
            val state = desktop.value!!.state.value
            assertFalse("Renewal failed: ${(state as? RemoteDesktopSetupUiState.Failed)?.reason}", state is RemoteDesktopSetupUiState.Failed)
            state is RemoteDesktopSetupUiState.Viewing && desktop.value!!.media.value?.connectionId != before.connectionId
        }
        val after = desktop.value!!.media.value!!
        assertEquals(before.attachmentId, after.attachmentId); assertNotEquals(before.rendererId, after.rendererId)
        waitForNativePixels()
        val status = operation("status"); val counts = status.getJSONObject("counts")
        for ((operation, count) in mapOf("attach" to 1, "suspend" to 1, "resume" to 1, "turn" to 2, "signal" to 2)) {
            assertEquals(operation, count, counts.getInt(operation))
        }
        assertEquals("relay", status.getString("local")); assertEquals("relay", status.getString("remote"))
        assertTrue(status.getJSONObject("source").getJSONObject("bound").getBoolean("matches"))
        assertFalse(status.getJSONObject("source").getBoolean("unexpected_input"))
        assertEquals("chat-target", (account!!.state.value as AccountUiState.Ready).selectedDeviceId)
        compose.onNodeWithTag("remote-desktop-close").performClick()
        compose.waitUntil(10_000) { !operation("status").getBoolean("attachment") }
        assertEquals(1, operation("status").getJSONObject("counts").getInt("detach"))
    }

    private fun waitForNativePixels() {
        compose.waitForIdle()
        compose.waitUntil(5_000) {
            val image = instrumentation.uiAutomation.takeScreenshot()
            val pixel = image.getPixel(image.width / 2, image.height / 2); image.recycle()
            Color.red(pixel) > 150 && Color.blue(pixel) < 80 || Color.blue(pixel) > 150 && Color.red(pixel) < 80
        }
    }

    @Test fun pausedDisplaySelectionCancelsThenPresentsOnlyTheNewGeneratedSource() {
        open(true); chooseDisplayAndWait(); waitForNativePixels()
        val before = desktop.value!!.media.value!!
        compose.onNodeWithTag("remote-desktop-pause").performClick()
        compose.waitUntil(10_000) { desktop.value!!.state.value is RemoteDesktopSetupUiState.Paused }
        compose.onNodeWithTag("remote-desktop-change-display").performClick()
        compose.waitUntil(5_000) { desktop.value!!.state.value is RemoteDesktopSetupUiState.ChoosePausedDisplay }
        compose.onNodeWithText(context.getString(R.string.remote_desktop_current_display)).assertIsDisplayed()
        compose.onNodeWithTag("remote-desktop-cancel-display").assertIsDisplayed().performClick()
        compose.runOnIdle { assertTrue(desktop.value!!.state.value is RemoteDesktopSetupUiState.Paused) }
        val cancelled = operation("status").getJSONObject("counts")
        assertEquals(0, cancelled.optInt("select_display")); assertEquals(0, cancelled.optInt("resume"))
        compose.onNodeWithTag("remote-desktop-change-display").performClick()
        compose.waitUntil(5_000) { desktop.value!!.state.value is RemoteDesktopSetupUiState.ChoosePausedDisplay }
        compose.onNodeWithTag("remote-desktop-paused-display:fixture-other-display").performScrollTo().performClick()
        waitForViewing(); waitForNativePixels()
        val after = desktop.value!!.media.value!!
        assertEquals(before.attachmentId, after.attachmentId)
        assertNotEquals(before.connectionId, after.connectionId); assertNotEquals(before.rendererId, after.rendererId)
        val viewing = desktop.value!!.state.value as RemoteDesktopSetupUiState.Viewing
        assertEquals("fixture-other-display", viewing.display.id); assertEquals(480, viewing.width); assertEquals(270, viewing.height)
        compose.waitUntil(5_000) {
            val image = instrumentation.uiAutomation.takeScreenshot()
            val pixel = image.getPixel(image.width / 2, image.height / 2); image.recycle()
            Color.green(pixel) > 150 && (Color.red(pixel) > 150 && Color.blue(pixel) < 80
                || Color.blue(pixel) > 150 && Color.red(pixel) < 80) // Only the new yellow/cyan source.
        }
        val status = operation("status"); val counts = status.getJSONObject("counts")
        assertEquals(1, counts.getInt("attach")); assertEquals(1, counts.getInt("select_display")); assertEquals(1, counts.getInt("resume"))
        assertEquals(3, counts.getInt("list_displays")); assertEquals("relay", status.getString("local")); assertEquals("relay", status.getString("remote"))
        assertFalse(status.getJSONObject("source").getBoolean("unexpected_input"))
        assertEquals("chat-target", (account!!.state.value as AccountUiState.Ready).selectedDeviceId)
        compose.onNodeWithTag("remote-desktop-close").performClick()
        compose.waitUntil(10_000) { !operation("status").getBoolean("attachment") }
        assertEquals(1, operation("status").getJSONObject("counts").getInt("detach"))
    }

    private fun chooseDisplayAndWait() {
        compose.waitUntil(15_000) {
            val state = desktop.value?.state?.value
            assertFalse("Discovery failed: ${(state as? RemoteDesktopSetupUiState.Failed)?.reason}", state is RemoteDesktopSetupUiState.Failed)
            state is RemoteDesktopSetupUiState.ChooseDisplay
        }
        val relay = compose.onNodeWithTag("remote-desktop-force-relay").performScrollTo()
        if (relay.fetchSemanticsNode().config[SemanticsProperties.ToggleableState] != ToggleableState.On) relay.performClick()
        compose.onNodeWithTag("remote-desktop-display:fixture-display").performScrollTo().performClick()
        waitForViewing()
    }

    private fun waitForViewing() {
        compose.waitUntil(35_000) {
            val state = desktop.value?.state?.value
            assertFalse("Media failed: ${(state as? RemoteDesktopSetupUiState.Failed)?.reason}", state is RemoteDesktopSetupUiState.Failed)
            state is RemoteDesktopSetupUiState.Viewing
        }
    }

    @Test fun deniedViewGrantNeverEnumeratesOrAllocatesMedia() {
        open(false)
        compose.waitUntil(15_000) { desktop.value?.state?.value is RemoteDesktopSetupUiState.Failed }
        assertEquals(RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED,
            (desktop.value!!.state.value as RemoteDesktopSetupUiState.Failed).reason)
        compose.onNodeWithText(context.getString(R.string.remote_desktop_device_approval)).assertIsDisplayed()
        val status = operation("status"); assertEquals(0, status.getInt("errors"))
        val counts = status.getJSONObject("counts")
        for (operation in listOf("list_displays", "attach", "turn", "signal")) assertEquals(0, counts.optInt(operation))
        assertFalse(status.getBoolean("attachment")); assertNull(desktop.value!!.media.value)
    }

    @Test fun nativeTapUsesTheCurrentLeaseAndFocusLossRejectsAQueuedTapWithoutAutomaticRecovery() {
        open(true, controlSupported = true); chooseDisplayAndWait(); waitForNativePixels()
        compose.waitUntil(10_000) { desktop.value!!.control.value.supported }
        compose.onNodeWithTag("remote-desktop-start-control").performClick()
        compose.waitUntil(8_000) { desktop.value!!.control.value.mode == RemoteDesktopControlMode.CONTROLLING }
        compose.onNodeWithTag("remote-desktop-media").performTouchInput { click(center) }
        compose.waitUntil(5_000) { operation("status").getJSONObject("source").getJSONArray("inputs").length() == 2 }
        val input = operation("status").getJSONObject("source").getJSONArray("inputs")
        assertTrue(input.getJSONObject(0).getBoolean("down")); assertFalse(input.getJSONObject(1).getBoolean("down"))
        for (index in 0..1) {
            assertEquals(0.5, input.getJSONObject(index).getDouble("x"), 0.02)
            assertEquals(0.5, input.getJSONObject(index).getDouble("y"), 0.02)
        }
        compose.onNodeWithTag("remote-desktop-media").performTouchInput { click(Offset(2f, 2f)) }
        compose.onNodeWithTag("remote-desktop-stop-control").performClick()
        compose.waitUntil(5_000) { !desktop.value!!.control.value.releasePending && desktop.value!!.control.value.generation == null }
        compose.onNodeWithTag("remote-desktop-media").performTouchInput { click(center) }
        assertEquals(2, operation("status").getJSONObject("source").getJSONArray("inputs").length())

        compose.onNodeWithTag("remote-desktop-start-control").performClick()
        compose.waitUntil(8_000) { desktop.value!!.control.value.mode == RemoteDesktopControlMode.CONTROLLING }
        var dialog: Dialog? = null
        try {
            instrumentation.runOnMainSync {
                val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                    .single { receiver(it.window.decorView) != null }
                val view = receiver(activity.window.decorView)!!
                val authority = desktop.value!!.control.value; val id = authority.binding!!
                // Hold the renderer until its native permission gate observes
                // focus loss (or this bounded test budget). The queued tap must
                // check that gate at execution time, not retain old permission.
                val args = listOf(id.rendererId, id.attachmentId, id.connectionId, authority.intentEpoch.toString(), authority.generation!!, "tap")
                    .joinToString(",") { JSONObject.quote(it) }
                view.evaluateJavascript("(()=>{const end=performance.now()+1200;while(performance.now()<end&&window.OpenBitFunDesktopHost.permitsControl($args)){};})()", null)
                desktop.value!!.dispatchControl(RemoteDesktopControlIntent.Tap(id, authority.intentEpoch, authority.generation!!, 0.25, 0.25))
                dialog = Dialog(activity).apply { setContentView(TextView(activity).apply { text = "Focus fixture" }); show() }
            }
            compose.waitUntil(8_000) {
                val state = desktop.value!!.state.value
                assertFalse("Focus loss failed: ${(state as? RemoteDesktopSetupUiState.Failed)?.reason}", state is RemoteDesktopSetupUiState.Failed)
                desktop.value!!.control.value.mode == RemoteDesktopControlMode.VIEWING && !desktop.value!!.control.value.releasePending
            }
            val status = operation("status"); val source = status.getJSONObject("source")
            assertTrue(source.isNull("lease")); assertEquals(2, source.getJSONArray("inputs").length())
            assertEquals(2, source.getJSONObject("control_counts").getInt("acquire_control"))
            assertEquals(2, source.getJSONObject("control_counts").getInt("release_control"))
            assertFalse(source.getBoolean("unexpected_input")); assertEquals("relay", status.getString("local")); assertEquals("relay", status.getString("remote"))
        } finally { instrumentation.runOnMainSync { dialog?.dismiss() } }
        compose.onNodeWithTag("remote-desktop-start-control").assertIsDisplayed()
        assertEquals(RemoteDesktopControlMode.VIEWING, desktop.value!!.control.value.mode)
        assertEquals(2, operation("status").getJSONObject("source").getJSONObject("control_counts").getInt("acquire_control"))
        val oldConnection = desktop.value!!.media.value!!.connectionId
        compose.onNodeWithTag("remote-desktop-pause").performClick()
        compose.waitUntil(10_000) { desktop.value!!.state.value is RemoteDesktopSetupUiState.Paused }
        assertFalse(desktop.value!!.control.value.supported)
        compose.onNodeWithTag("remote-desktop-resume").performClick(); waitForViewing()
        compose.waitUntil(10_000) { desktop.value!!.control.value.supported }
        assertNotEquals(oldConnection, desktop.value!!.media.value!!.connectionId)
        assertEquals(RemoteDesktopControlMode.VIEWING, desktop.value!!.control.value.mode)
        val fresh = operation("status").getJSONObject("source")
        assertTrue(fresh.isNull("lease")); assertEquals(0, fresh.getJSONObject("control_counts").optInt("acquire_control"))
        assertEquals(0, fresh.getJSONArray("inputs").length())
    }

    @Test fun controlGrantDenialKeepsViewingAndNeverSendsAPointerClick() {
        open(true, controlSupported = true, controlGrant = false); chooseDisplayAndWait(); waitForNativePixels()
        compose.waitUntil(10_000) { desktop.value!!.control.value.supported }
        compose.onNodeWithTag("remote-desktop-start-control").performClick()
        compose.waitUntil(8_000) { desktop.value!!.control.value.failure != null }
        compose.onNodeWithText(context.getString(R.string.remote_desktop_control_approval)).assertIsDisplayed()
        compose.onNodeWithTag("remote-desktop-media").performTouchInput { click(center) }
        assertTrue(desktop.value!!.state.value is RemoteDesktopSetupUiState.Viewing)
        val source = operation("status").getJSONObject("source")
        assertEquals(1, source.getJSONObject("control_counts").getInt("acquire_control"))
        assertTrue(source.isNull("lease")); assertEquals(0, source.getJSONArray("inputs").length())
        assertFalse(source.getBoolean("unexpected_input"))
    }

    @Test fun nativeGesturesReachTheCurrentLeaseAndPinchStaysLocal() {
        open(true, controlSupported = true, gestures = true); chooseDisplayAndWait(); waitForNativePixels()
        compose.waitUntil(10_000) { desktop.value!!.control.value.supported }
        compose.onNodeWithTag("remote-desktop-start-control").performClick()
        compose.waitUntil(8_000) { desktop.value!!.control.value.mode == RemoteDesktopControlMode.CONTROLLING }
        val media = compose.onNodeWithTag("remote-desktop-media")
        fun source() = operation("status").getJSONObject("source")
        fun inputs() = source().getJSONArray("inputs")
        media.performTouchInput { longClick(center, durationMillis = 650) }
        compose.waitUntil(5_000) { inputs().length() == 2 }
        for (index in 0..1) {
            assertEquals("right", inputs().getJSONObject(index).getString("button"))
            assertEquals(index == 0, inputs().getJSONObject(index).getBoolean("down"))
        }
        media.performTouchInput {
            down(center); advanceEventTime(30); up(); advanceEventTime(80); down(center)
            advanceEventTime(30); moveTo(center + Offset(90f, 0f)); advanceEventTime(30); up()
        }
        compose.waitUntil(5_000) {
            val current = source(); assertFalse(current.getBoolean("unexpected_input"))
            val rows = current.getJSONArray("inputs")
            rows.length() >= 7 && !rows.getJSONObject(rows.length() - 1).optBoolean("down", true)
        }
        val drag = inputs()
        val left = (2 until drag.length()).map { drag.getJSONObject(it) }.filter { it.optString("button") == "left" }
        assertEquals(listOf(true, false, true, false), left.map { it.getBoolean("down") })
        assertTrue((2 until drag.length()).any { drag.getJSONObject(it).optString("kind") == "pointer_move" })
        assertEquals(0, source().getJSONArray("held_buttons").length())
        media.performTouchInput {
            down(0, center + Offset(-60f, 0f)); down(1, center + Offset(60f, 0f))
            advanceEventTime(30)
            updatePointerTo(0, center + Offset(-60f, 70f)); updatePointerTo(1, center + Offset(60f, 70f)); move()
            up(0); up(1)
        }
        compose.waitUntil(5_000) { inputs().getJSONObject(inputs().length() - 1).optString("kind") == "wheel" }
        val wheel = inputs().getJSONObject(inputs().length() - 1)
        assertEquals(0.0, wheel.getDouble("dx"), 0.1); assertTrue(wheel.getDouble("dy") < 0)
        val beforePinch = inputs().length()
        media.performTouchInput {
            down(0, center + Offset(-60f, 0f)); down(1, center + Offset(60f, 0f))
            advanceEventTime(30)
            updatePointerTo(0, center + Offset(-120f, 0f)); updatePointerTo(1, center + Offset(120f, 0f)); move()
            up(0); up(1)
        }
        instrumentation.runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single()
            assertEquals(2f, receiver(activity.window.decorView)!!.scaleX, 0.01f)
        }
        assertEquals(beforePinch, inputs().length())
        media.performTouchInput { click(Offset(width * 0.75f, center.y)) }
        compose.waitUntil(5_000) { inputs().length() == beforePinch + 2 }
        val viewport = media.fetchSemanticsNode().boundsInRoot
        val sourceSize = desktop.value!!.state.value as RemoteDesktopSetupUiState.Viewing
        val fitWidth = minOf(viewport.width / sourceSize.width, viewport.height / sourceSize.height) * sourceSize.width
        val expectedX = 0.5 + viewport.width * 0.25 / 2 / fitWidth
        assertEquals(expectedX, inputs().getJSONObject(beforePinch).getDouble("x"), 0.02)
        // Cancel while a left button is down: cleanup releases the original
        // lease, not a guessed up at an invalid coordinate or a successor lease.
        media.performTouchInput {
            click(center); advanceEventTime(80); down(center); advanceEventTime(30)
            moveTo(center + Offset(80f, 0f)); advanceEventTime(30); cancel()
        }
        compose.waitUntil(8_000) { desktop.value!!.control.value.mode == RemoteDesktopControlMode.VIEWING && !desktop.value!!.control.value.releasePending }
        val stopped = source()
        assertFalse(stopped.getBoolean("unexpected_input")); assertTrue(stopped.isNull("lease"))
        assertEquals(0, stopped.getJSONArray("held_buttons").length())
        assertEquals(1, stopped.getJSONObject("control_counts").getInt("acquire_control"))
        assertEquals(1, stopped.getJSONObject("control_counts").getInt("release_control"))
        val status = operation("status"); assertEquals("relay", status.getString("local")); assertEquals("relay", status.getString("remote"))
    }

    @Test fun nativeKeyboardCommitsAndPairedKeysReachOnlyTheCurrentLease() {
        open(true, controlSupported = true, textSupported = true); chooseDisplayAndWait(); waitForNativePixels()
        compose.waitUntil(10_000) { desktop.value!!.control.value.textSupported }
        compose.onNodeWithTag("remote-desktop-start-control").performClick()
        compose.waitUntil(8_000) { desktop.value!!.control.value.mode == RemoteDesktopControlMode.CONTROLLING }
        compose.onNodeWithTag("remote-desktop-keyboard-toggle").performClick()
        var ime: RemoteDesktopImeView? = null
        compose.waitUntil(10_000) {
            instrumentation.runOnMainSync {
                val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single()
                ime = keyboard(activity.findViewById(android.R.id.content))
            }
            ime?.let { ViewCompat.getRootWindowInsets(it)?.isVisible(WindowInsetsCompat.Type.ime()) == true } == true
        }
        lateinit var connection: android.view.inputmethod.InputConnection
        instrumentation.runOnMainSync {
            connection = ime!!.onCreateInputConnection(EditorInfo())!!
            assertTrue(connection.setComposingText("nihao", 1)); assertTrue(connection.finishComposingText())
        }
        assertEquals(0, operation("status").getJSONObject("source").getJSONArray("inputs").length())
        instrumentation.runOnMainSync {
            assertTrue(connection.setComposingText("nihao", 1)); assertTrue(connection.commitText("\u4f60\u597d", 1))
            assertTrue(connection.commitText("123", 1)); assertTrue(connection.deleteSurroundingText(1, 0))
            assertTrue(connection.commitText("\n", 1))
        }
        compose.waitUntil(8_000) { operation("status").getJSONObject("source").getJSONArray("inputs").length() == 6 }
        val source = operation("status").getJSONObject("source"); assertFalse(source.getBoolean("unexpected_input"))
        val inputs = source.getJSONArray("inputs")
        for (index in 0..1) { assertEquals("text_commit", inputs.getJSONObject(index).getString("kind")); assertTrue(inputs.getJSONObject(index).getBoolean("matches_expected")) }
        for (index in 2..5) {
            val input = inputs.getJSONObject(index)
            assertEquals("key", input.getString("kind")); assertEquals(if (index < 4) 0x2a else 0x28, input.getInt("usage"))
            assertEquals(index % 2 == 0, input.getBoolean("down"))
        }
        compose.onNodeWithTag("remote-desktop-stop-control").performClick()
        compose.waitUntil(8_000) { !desktop.value!!.control.value.releasePending }
        instrumentation.runOnMainSync { assertFalse(connection.commitText("late", 1)); assertFalse(connection.deleteSurroundingText(1, 0)) }
        assertEquals(6, operation("status").getJSONObject("source").getJSONArray("inputs").length())
    }

    @Test fun actualGboardTouchesReachTheCurrentLease() {
        RemoteDesktopGboardProbe { compose.waitUntil(5_000, it) }.use { gboard ->
            open(true, controlSupported = true, textSupported = true, actualKeyboard = true)
            chooseDisplayAndWait(); waitForNativePixels()
            compose.waitUntil(10_000) { desktop.value!!.control.value.textSupported }
            compose.onNodeWithTag("remote-desktop-start-control").performClick()
            compose.waitUntil(8_000) { desktop.value!!.control.value.mode == RemoteDesktopControlMode.CONTROLLING }
            compose.onNodeWithTag("remote-desktop-keyboard-toggle").performClick()
            var phase = 0
            try {
                for ((labels, count) in listOf(setOf("h") to 1, setOf("i") to 2, setOf("shift") to 2,
                    setOf("h") to 3, setOf("delete", "backspace") to 5, setOf("enter", "return", "new line") to 7)) {
                    gboard.tapKey(labels)
                    compose.waitUntil(8_000) {
                        assertEquals(RemoteDesktopControlMode.CONTROLLING, desktop.value!!.control.value.mode)
                        val source = operation("status").getJSONObject("source")
                        assertFalse("Generated source rejected an input", source.getBoolean("unexpected_input"))
                        source.getJSONArray("inputs").length() == count
                    }
                    phase++
                }
            } catch (failure: Throwable) {
                var served = false; var focused = false; var visible = false
                instrumentation.runOnMainSync {
                    val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single()
                    val view = keyboard(activity.findViewById(android.R.id.content))
                    if (view != null) {
                        served = view.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java).isActive(view)
                        focused = view.hasFocus() && view.hasWindowFocus()
                        visible = ViewCompat.getRootWindowInsets(view)?.isVisible(WindowInsetsCompat.Type.ime()) == true
                    }
                }
                Log.e("OpenBitFunRdAccount", "Actual keyboard failed: phase=$phase mode=${desktop.value!!.control.value.mode} imeServed=$served focused=$focused visible=$visible")
                throw failure
            }
            val source = operation("status").getJSONObject("source"); val inputs = source.getJSONArray("inputs")
            assertFalse(source.getBoolean("unexpected_input"))
            for (index in 0..2) { assertEquals("text_commit", inputs.getJSONObject(index).getString("kind")); assertTrue(inputs.getJSONObject(index).getBoolean("matches_expected")) }
            for (index in 3..6) {
                val input = inputs.getJSONObject(index)
                assertEquals("key", input.getString("kind")); assertEquals(if (index < 5) 0x2a else 0x28, input.getInt("usage"))
                assertEquals(index % 2 == 1, input.getBoolean("down"))
                assertEquals(desktop.value!!.control.value.generation, input.getString("generation"))
            }
            assertEquals(RemoteDesktopControlMode.CONTROLLING, desktop.value!!.control.value.mode)
            val viewport = compose.onNodeWithTag("remote-desktop-media").fetchSemanticsNode().boundsInRoot
            assertTrue("Keyboard must leave visible media", viewport.height > 64)
            var red = false; var blue = false
            compose.waitUntil(5_000) {
                val image = instrumentation.uiAutomation.takeScreenshot()
                try {
                    assertTrue(viewport.center.x >= 0 && viewport.center.x < image.width && viewport.center.y >= 0 && viewport.center.y < image.height)
                    val pixel = image.getPixel(viewport.center.x.toInt(), viewport.center.y.toInt())
                    red = red || Color.red(pixel) > 150 && Color.blue(pixel) < 80
                    blue = blue || Color.blue(pixel) > 150 && Color.red(pixel) < 80
                    red && blue
                } finally { image.recycle() }
            }
            compose.onNodeWithTag("remote-desktop-stop-control").performClick()
            compose.waitUntil(8_000) { !desktop.value!!.control.value.releasePending }
            val stopped = operation("status").getJSONObject("source")
            assertTrue(stopped.isNull("lease")); assertEquals(7, stopped.getJSONArray("inputs").length())
            assertEquals(1, stopped.getJSONObject("control_counts").getInt("acquire_control"))
        }
    }

    private fun keyboard(view: View): RemoteDesktopImeView? {
        if (view is RemoteDesktopImeView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) keyboard(view.getChildAt(index))?.let { return it }
        return null
    }

    private fun receiver(view: View): RemoteDesktopWebView? {
        if (view is RemoteDesktopWebView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) receiver(view.getChildAt(index))?.let { return it }
        return null
    }

    @After fun close() {
        val finalState = desktop.value?.state?.value
        Log.i("OpenBitFunRdAccount", "Fixture final state=${finalState?.javaClass?.simpleName}, failure=${(finalState as? RemoteDesktopSetupUiState.Failed)?.reason}")
        instrumentation.runOnMainSync { desktop.value?.close(); mounted.value = false }
        if (account != null) {
            compose.waitUntil(12_000) { !operation("status").getBoolean("attachment") }
            instrumentation.runOnMainSync { account!!.dispatch(AccountIntent.Logout) }
            compose.waitUntil(10_000) { account!!.state.value == AccountUiState.SignedOut }
            instrumentation.runOnMainSync { account!!.stop() }
        }
        scope.cancel()
    }
}
