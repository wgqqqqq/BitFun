package com.openbitfun.mobile.app

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.viewinterop.AndroidView
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopImeView
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopScreenContent
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import androidx.test.platform.app.InstrumentationRegistry
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowCompat
import java.io.File
import com.openbitfun.mobile.core.feature.remotedesktop.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.Before
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicInteger

/** Actual native IME connection with an intent sink. No account, screen or OS input. */
class RemoteDesktopKeyboardTest {
    @get:Rule val compose = createComposeRule()
    private val view = AtomicReference<RemoteDesktopImeView>()
    private val mounted = mutableStateOf(true)
    private val intents = mutableListOf<RemoteDesktopControlIntent>()
    private val authority = RemoteDesktopControlUiState(RemoteDesktopMediaBindingUi("renderer", "attachment", "connection"),
        true, RemoteDesktopControlMode.CONTROLLING, "7", 3, false, null, true)

    @Before fun useTheProductionWindowContract() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).single() as ComponentActivity
            activity.enableEdgeToEdge()
            activity.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            val light = InstrumentationRegistry.getArguments().getString("remoteDesktopKeyboardTheme") != "dark"
            WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
                isAppearanceLightStatusBars = light; isAppearanceLightNavigationBars = light
            }
        }
    }

    private fun open() {
        compose.setContent {
            if (mounted.value) AndroidView(modifier = Modifier.fillMaxSize(), factory = { context ->
                RemoteDesktopImeView(context, authority, intents::add).also { view.set(it) }
            }, onRelease = { it.dispose() })
        }
        compose.waitUntil(10_000) { view.get()?.let { it.hasWindowFocus()
            && ViewCompat.getRootWindowInsets(it)?.isVisible(WindowInsetsCompat.Type.ime()) == true } == true }
        compose.waitForIdle()
    }

    @Test fun composingStaysLocalAndOnlyConfirmedTextAndPairedKeyIntentsLeaveTheIme() {
        open()
        compose.runOnIdle {
            val info = EditorInfo(); val connection = view.get().onCreateInputConnection(info)!!
            assertTrue(connection.setComposingText("nihao", 1)); assertTrue(connection.setComposingText("你好", 1))
            assertTrue(intents.isEmpty())
            assertTrue(connection.commitText("你好", 1)); assertTrue(connection.commitText("123", 1))
            assertTrue(connection.deleteSurroundingText(1, 0))
            assertTrue(connection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)))
            assertTrue(connection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER)))
            assertTrue(connection.commitText("\n", 1)); assertTrue(connection.performEditorAction(EditorInfo.IME_ACTION_DONE))
            assertEquals(listOf("你好", "123"), intents.filterIsInstance<RemoteDesktopControlIntent.TextCommit>().map { it.text })
            assertEquals(listOf(RemoteDesktopKeyboardKey.BACKSPACE, RemoteDesktopKeyboardKey.ENTER,
                RemoteDesktopKeyboardKey.ENTER, RemoteDesktopKeyboardKey.ENTER),
                intents.filterIsInstance<RemoteDesktopControlIntent.KeyTap>().map { it.key })
            for (intent in intents) when (intent) {
                is RemoteDesktopControlIntent.TextCommit -> { assertEquals(3L, intent.intentEpoch); assertEquals("7", intent.generation) }
                is RemoteDesktopControlIntent.KeyTap -> { assertEquals(3L, intent.intentEpoch); assertEquals("7", intent.generation) }
                else -> fail("Unexpected IME intent")
            }
            assertTrue(info.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING != 0)
            connection.closeConnection()
        }
    }

    @Test fun finishAndDisposalDiscardUnconfirmedCompositionAndRejectLateCallbacks() {
        open()
        compose.runOnIdle {
            val connection = view.get().onCreateInputConnection(EditorInfo())!!
            assertTrue(connection.setComposingText("未确认", 1)); assertTrue(connection.finishComposingText())
            assertTrue(intents.isEmpty())
            assertTrue(connection.setComposingText("取消", 1))
            view.get().dispose()
            assertFalse(connection.commitText("迟到", 1)); assertFalse(connection.deleteSurroundingText(1, 0))
            assertFalse(connection.performEditorAction(EditorInfo.IME_ACTION_DONE)); assertTrue(intents.isEmpty())
        }
        compose.runOnIdle { mounted.value = false }
    }

    @Test fun invalidCommitsAndUnsupportedDeleteRangesNeverBecomeRemoteInput() {
        open()
        compose.runOnIdle {
            val connection = view.get().onCreateInputConnection(EditorInfo())!!
            for (text in listOf("\ud800", "\udc00", "x\u0000y", "好".repeat(1366))) assertFalse(connection.commitText(text, 1))
            assertFalse(connection.deleteSurroundingText(10, 0)); assertFalse(connection.deleteSurroundingText(0, 10))
            assertTrue(intents.isEmpty())
            connection.closeConnection(); assertFalse(connection.commitText("after close", 1))
        }
    }

    @Test fun imeCannotInferRemoteCursorCapsOrCommittedHistoryFromTheLocalBuffer() {
        open()
        compose.runOnIdle {
            val info = EditorInfo(); val connection = view.get().onCreateInputConnection(info)!!
            assertTrue(connection.setSelection(0, 0))
            val requested = android.text.TextUtils.CAP_MODE_CHARACTERS or android.text.TextUtils.CAP_MODE_WORDS or android.text.TextUtils.CAP_MODE_SENTENCES
            assertEquals("Local emptiness is not evidence of the remote cursor context", 0, connection.getCursorCapsMode(requested))
            assertEquals(0, info.initialSelStart); assertEquals(0, info.initialSelEnd); assertEquals(0, info.initialCapsMode)
            assertTrue(connection.commitText("H", 1))
            assertEquals("H", (intents.single() as RemoteDesktopControlIntent.TextCommit).text)
            assertEquals("", connection.getTextBeforeCursor(20, 0).toString())
            assertEquals(0, connection.getCursorCapsMode(requested))
            connection.closeConnection()
        }
    }

    @Test fun actualImeKeepsVideoAndFixedControlsVisibleAndSpecialKeysRemainReachable() {
        val inset = AtomicInteger()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val dark = InstrumentationRegistry.getArguments().getString("remoteDesktopKeyboardTheme") == "dark"
        compose.setContent {
            val bottom = WindowInsets.ime.getBottom(LocalDensity.current)
            SideEffect { inset.set(bottom) }
            OpenBitFunTheme(dark = dark) {
                RemoteDesktopScreenContent(RemoteDesktopSetupUiState.Viewing(RemoteDesktopDisplayUi("display", 320, 180), 320, 180, true),
                    false, {}, {}, Modifier.fillMaxSize(), "Fixture Mac", authority, intents::add) {
                    Box(Modifier.fillMaxSize().testTag("keyboard-fixture-video"))
                }
            }
        }
        compose.onNodeWithTag("remote-desktop-keyboard-toggle").performClick()
        compose.waitUntil(10_000) { inset.get() > 0 }
        compose.onNodeWithTag("remote-desktop-close").assertDoesNotExist()
        compose.onNodeWithTag("remote-desktop-stop-control").assertIsDisplayed()
        compose.onNodeWithTag("remote-desktop-keyboard-toggle").assertIsDisplayed()
        val media = compose.onNodeWithTag("keyboard-fixture-video").fetchSemanticsNode().boundsInRoot
        assertTrue("IME must leave visible remote pixels", media.height > 64)
        val bottom = compose.onNodeWithTag("remote-desktop-page").fetchSemanticsNode().boundsInRoot.bottom
        val controls = compose.onNodeWithTag("remote-desktop-stop-control").fetchSemanticsNode().boundsInRoot
        assertTrue("Controls must remain close to the IME instead of reserving its height twice", bottom - inset.get() - controls.bottom < 128)
        compose.onNodeWithTag("remote-desktop-key-ENTER").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(RemoteDesktopKeyboardKey.ENTER, (intents.single() as RemoteDesktopControlIntent.KeyTap).key) }
        compose.waitForIdle()
        val image = instrumentation.uiAutomation.takeScreenshot()
        try {
            File(instrumentation.targetContext.getExternalFilesDir(null), "remote-desktop-ime-${image.width}x${image.height}-${if (dark) "dark" else "light"}.png")
                .outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        } finally { image.recycle() }
        compose.onNodeWithTag("remote-desktop-keyboard-toggle").performClick()
        compose.waitUntil(10_000) { inset.get() == 0 }
        compose.onNodeWithTag("remote-desktop-close").assertIsDisplayed()
        compose.onNodeWithTag("remote-desktop-keyboard-toggle").performClick()
        compose.waitUntil(10_000) { inset.get() > 0 }
        instrumentation.uiAutomation.executeShellCommand("input keyevent 4").use {
            java.io.FileInputStream(it.fileDescriptor).use { stream -> stream.readBytes() }
        }
        compose.waitUntil(10_000) { inset.get() == 0 }
        compose.onNodeWithText(instrumentation.targetContext.getString(R.string.remote_desktop_show_keyboard)).assertIsDisplayed()
        compose.runOnIdle { assertEquals(1, intents.size) }
    }
}
