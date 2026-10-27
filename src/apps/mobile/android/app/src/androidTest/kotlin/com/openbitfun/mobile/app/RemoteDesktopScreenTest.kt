package com.openbitfun.mobile.app

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopPageLifetime
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopScreenContent
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopScreen
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopDisplayUi
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupFailure
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupIntent
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupUiState
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlUiState
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopMediaBindingUi
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlMode
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlIntent
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Native presentation/lifecycle only. No account, screen capture, PC or OS input. */
class RemoteDesktopScreenTest {
    @get:Rule val compose = createComposeRule()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val display = RemoteDesktopDisplayUi("fixture-display", 1512, 982)

    @Test fun negotiatedSourceControlsWaitForHostDrainAndNeverReconnectByThemselves() {
        val state = mutableStateOf<RemoteDesktopSetupUiState>(RemoteDesktopSetupUiState.Viewing(display, 320, 180, true))
        val interrupted = mutableStateOf(true)
        val intents = mutableListOf<RemoteDesktopSetupIntent>()
        compose.setContent {
            OpenBitFunTheme(dark = false) {
                RemoteDesktopScreenContent(state.value, interrupted.value, {
                    intents += it
                    state.value = if (it == RemoteDesktopSetupIntent.Pause) RemoteDesktopSetupUiState.Suspending(display)
                        else RemoteDesktopSetupUiState.Resuming(display)
                }, {}, Modifier.fillMaxSize(), "Fixture Mac", {})
            }
        }
        compose.onNodeWithTag("remote-desktop-pause").assertIsNotEnabled()
        compose.runOnIdle { interrupted.value = false }
        compose.onNodeWithTag("remote-desktop-pause").performClick()
        compose.onNodeWithText(context.getString(R.string.remote_desktop_pausing)).assertIsDisplayed()
        compose.onNodeWithTag("remote-desktop-resume").assertDoesNotExist()
        compose.onNodeWithTag("remote-desktop-pause").performClick()
        compose.runOnIdle { state.value = RemoteDesktopSetupUiState.Paused(display) }
        compose.onNodeWithTag("remote-desktop-resume").performClick()
        compose.onNodeWithTag("remote-desktop-pause").performClick()
        compose.runOnIdle { assertEquals(listOf(RemoteDesktopSetupIntent.Pause, RemoteDesktopSetupIntent.Pause,
            RemoteDesktopSetupIntent.Resume, RemoteDesktopSetupIntent.Pause), intents) }
    }

    @Test fun unavailableAccountTargetShowsFailureAndReconnectIsExplicit() {
        var retries = 0
        var backs = 0
        compose.setContent {
            OpenBitFunTheme(dark = false) {
                RemoteDesktopScreen(null, "Fixture Mac", { retries++ }, { backs++ }, Modifier.fillMaxSize())
            }
        }
        compose.onNodeWithText("Fixture Mac").assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.remote_desktop_target_unavailable)).assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, retries) }
        compose.onNodeWithText(context.getString(R.string.remote_desktop_retry)).performClick()
        compose.onNodeWithTag("remote-desktop-close").performClick()
        compose.runOnIdle { assertEquals(1, retries); assertEquals(1, backs) }
    }

    @Test fun displaySelectionEmitsOnlyTheChosenReadOnlyTarget() {
        val events = mutableListOf<RemoteDesktopSetupIntent>()
        compose.setContent {
            OpenBitFunTheme(dark = false) {
                RemoteDesktopScreenContent(RemoteDesktopSetupUiState.ChooseDisplay(listOf(display)), false,
                    events::add, {}, Modifier.fillMaxSize(), "Fixture Mac", {})
            }
        }
        compose.onNodeWithText(context.getString(R.string.remote_desktop_read_only)).assertIsDisplayed()
        compose.onNodeWithTag("remote-desktop-display:${display.id}").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(RemoteDesktopSetupIntent.SelectDisplay(display.id, false)), events) }
    }

    @Test fun backgroundClosesAndForegroundDoesNotAutomaticallyReconnect() {
        val owner = Owner()
        val mounted = mutableStateOf(true)
        val events = mutableListOf<RemoteDesktopSetupIntent>()
        InstrumentationRegistry.getInstrumentation().runOnMainSync { owner.registry.currentState = Lifecycle.State.RESUMED }
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides owner) {
                if (mounted.value) RemoteDesktopPageLifetime(events::add)
            }
        }
        compose.runOnIdle {
            assertEquals(listOf(RemoteDesktopSetupIntent.Load), events)
            owner.registry.currentState = Lifecycle.State.CREATED
            assertEquals(RemoteDesktopSetupIntent.Close, events.last())
            owner.registry.currentState = Lifecycle.State.RESUMED
            assertEquals(1, events.count { it == RemoteDesktopSetupIntent.Load })
            mounted.value = false
        }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(2, events.count { it == RemoteDesktopSetupIntent.Close }) }
    }

    @Test fun pageDoesNotStartBeforeTheHostIsVisible() {
        val owner = Owner()
        val events = mutableListOf<RemoteDesktopSetupIntent>()
        InstrumentationRegistry.getInstrumentation().runOnMainSync { owner.registry.currentState = Lifecycle.State.CREATED }
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides owner) { RemoteDesktopPageLifetime(events::add) }
        }
        compose.runOnIdle {
            assertEquals(emptyList<RemoteDesktopSetupIntent>(), events)
            owner.registry.currentState = Lifecycle.State.STARTED
            assertEquals(listOf(RemoteDesktopSetupIntent.Load), events)
        }
    }

    @Test fun disconnectKeepsThePageClosedUntilAnExplicitReconnect() {
        val state = mutableStateOf<RemoteDesktopSetupUiState>(RemoteDesktopSetupUiState.Viewing(display, 1280, 828))
        val interrupted = mutableStateOf(true)
        val events = mutableListOf<RemoteDesktopSetupIntent>()
        compose.setContent {
            OpenBitFunTheme(dark = true) {
                RemoteDesktopScreenContent(state.value, interrupted.value, {
                    events += it
                    if (it == RemoteDesktopSetupIntent.Close) {
                        state.value = RemoteDesktopSetupUiState.Closed
                        interrupted.value = false
                    }
                }, {}, Modifier.fillMaxSize(), "Fixture Mac") {
                    if (state.value is RemoteDesktopSetupUiState.Viewing) Box(Modifier.fillMaxSize().testTag("fixture-media"))
                }
            }
        }
        compose.onNodeWithText(context.getString(R.string.remote_desktop_signaling_interrupted)).assertIsDisplayed()
        compose.onNodeWithTag("fixture-media").assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.remote_desktop_disconnect)).performClick()
        compose.onNodeWithText(context.getString(R.string.remote_desktop_disconnected)).assertIsDisplayed()
        compose.onNodeWithTag("fixture-media").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf(RemoteDesktopSetupIntent.Close), events) }
        compose.onNodeWithText(context.getString(R.string.remote_desktop_retry)).performClick()
        compose.runOnIdle { assertEquals(listOf(RemoteDesktopSetupIntent.Close, RemoteDesktopSetupIntent.Load), events) }
    }

    @Test fun compactLightAndWideDarkKeepFailureAndExitReachable() {
        val wide = mutableStateOf(false)
        val failure = mutableStateOf(RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED)
        var closed = 0
        compose.setContent {
            OpenBitFunTheme(dark = wide.value) {
                // Fits both native orientations inside this dedicated portrait AVD;
                // enlarged system text is represented by the native density provider.
                CompositionLocalProvider(LocalDensity provides Density(1f, 1.3f)) {
                    Box(Modifier.requiredSize(if (wide.value) 900.dp else 380.dp, if (wide.value) 340.dp else 720.dp)) {
                        RemoteDesktopScreenContent(RemoteDesktopSetupUiState.Failed(failure.value), false, {}, { closed++ },
                            Modifier.fillMaxSize(), "Fixture Mac", {})
                    }
                }
            }
        }
        compose.onNodeWithText(context.getString(R.string.remote_desktop_device_approval)).performScrollTo().assertIsDisplayed()
        capture("compact-light")
        compose.onNodeWithTag("remote-desktop-close").performClick()
        compose.runOnIdle { wide.value = true; failure.value = RemoteDesktopSetupFailure.PERMISSION_REQUIRED }
        compose.onNodeWithText(context.getString(R.string.remote_desktop_permission)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.remote_desktop_retry)).performScrollTo().assertIsDisplayed()
        capture("wide-dark")
        compose.onNodeWithTag("remote-desktop-close").performClick()
        compose.runOnIdle { assertEquals(2, closed) }
    }

    @Test fun pausedChoiceKeepsCancelCurrentMarkerAndOpaqueSelectionAcrossCompactAndWide() {
        val wide = mutableStateOf(false)
        val state = mutableStateOf<RemoteDesktopSetupUiState>(RemoteDesktopSetupUiState.Paused(display))
        val other = RemoteDesktopDisplayUi("opaque:other/source", 1920, 1080)
        val events = mutableListOf<RemoteDesktopSetupIntent>()
        compose.setContent {
            OpenBitFunTheme(dark = wide.value) {
                CompositionLocalProvider(LocalDensity provides Density(1f, 1.3f)) {
                    Box(Modifier.requiredSize(if (wide.value) 900.dp else 380.dp, if (wide.value) 340.dp else 720.dp)) {
                        RemoteDesktopScreenContent(state.value, false, {
                            events += it
                            state.value = when (it) {
                                RemoteDesktopSetupIntent.ChangeDisplay -> RemoteDesktopSetupUiState.LoadingDisplayChoices(display)
                                RemoteDesktopSetupIntent.CancelDisplayChange -> RemoteDesktopSetupUiState.Paused(display)
                                is RemoteDesktopSetupIntent.SelectPausedDisplay -> RemoteDesktopSetupUiState.SelectingDisplay(other)
                                else -> state.value
                            }
                        }, {}, Modifier.fillMaxSize(), "Fixture Mac", {})
                    }
                }
            }
        }
        for (isWide in listOf(false, true)) {
            compose.runOnIdle { wide.value = isWide; state.value = RemoteDesktopSetupUiState.Paused(display) }
            compose.onNodeWithTag("remote-desktop-change-display").performScrollTo().performClick()
            compose.onNodeWithTag("remote-desktop-cancel-display").assertIsDisplayed().performClick()
            compose.onNodeWithTag("remote-desktop-resume").performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("remote-desktop-change-display").performScrollTo().performClick()
            compose.runOnIdle { state.value = RemoteDesktopSetupUiState.ChoosePausedDisplay(display, listOf(display, other)) }
            compose.onNodeWithText(context.getString(R.string.remote_desktop_current_display)).performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("remote-desktop-cancel-display").assertIsDisplayed()
            compose.onNodeWithTag("remote-desktop-force-relay").assertDoesNotExist()
            capture(if (isWide) "display-choice-wide-dark" else "display-choice-compact-light")
            compose.onNodeWithTag("remote-desktop-paused-display:${other.id}").performScrollTo().performClick()
            compose.onNodeWithTag("remote-desktop-pause").performClick()
        }
        compose.runOnIdle {
            assertEquals(2, events.count { it == RemoteDesktopSetupIntent.SelectPausedDisplay(other.id) })
            assertEquals(2, events.count { it == RemoteDesktopSetupIntent.CancelDisplayChange })
            assertEquals(0, events.count { it == RemoteDesktopSetupIntent.Resume })
        }
    }

    @Test fun controlDockRequiresExplicitAcquireAndKeepsReleasePendingAcrossBothLayouts() {
        val wide = mutableStateOf(false)
        val binding = RemoteDesktopMediaBindingUi("renderer", "attachment", "connection")
        val control = mutableStateOf(RemoteDesktopControlUiState(binding, true, RemoteDesktopControlMode.VIEWING, null, 0, false, null))
        val events = mutableListOf<RemoteDesktopControlIntent>()
        compose.setContent {
            OpenBitFunTheme(dark = wide.value) {
                CompositionLocalProvider(LocalDensity provides Density(1f, 1.3f)) {
                    Box(Modifier.requiredSize(if (wide.value) 900.dp else 380.dp, if (wide.value) 340.dp else 720.dp)) {
                        RemoteDesktopScreenContent(RemoteDesktopSetupUiState.Viewing(display, 320, 180, true), false, {}, {},
                            Modifier.fillMaxSize(), "Fixture Mac", control.value, {
                                events += it
                                control.value = if (it is RemoteDesktopControlIntent.Acquire) control.value.copy(mode = RemoteDesktopControlMode.ACQUIRING, intentEpoch = it.intentEpoch + 1)
                                    else control.value.copy(mode = RemoteDesktopControlMode.VIEWING, generation = null, intentEpoch = control.value.intentEpoch + 1, releasePending = true)
                            }, {})
                    }
                }
            }
        }
        compose.runOnIdle { assertTrue(events.isEmpty()) }
        compose.onNodeWithTag("remote-desktop-start-control").performClick()
        compose.onNodeWithTag("remote-desktop-start-control").assertIsNotEnabled()
        compose.runOnIdle { control.value = control.value.copy(mode = RemoteDesktopControlMode.CONTROLLING, generation = "7") }
        capture("control-compact-light")
        compose.onNodeWithTag("remote-desktop-stop-control").performClick()
        compose.onNodeWithTag("remote-desktop-start-control").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(listOf(RemoteDesktopControlIntent.Acquire(binding, 0), RemoteDesktopControlIntent.Release(binding, 1)), events)
            control.value = control.value.copy(mode = RemoteDesktopControlMode.CONTROLLING, generation = "8", releasePending = false)
            wide.value = true
        }
        compose.onNodeWithTag("remote-desktop-stop-control").assertIsDisplayed()
        capture("control-wide-dark")
        compose.runOnIdle { assertEquals(2, events.size) }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val page = compose.onNodeWithTag("remote-desktop-page").captureToImage().asAndroidBitmap()
        File(context.getExternalFilesDir(null), "remote-desktop-$name-page.png").outputStream().use {
            page.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        val screenshot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        try {
            File(context.getExternalFilesDir(null), "remote-desktop-$name.png").outputStream().use {
                screenshot.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        } finally { screenshot.recycle() }
    }

    private class Owner : LifecycleOwner {
        val registry = LifecycleRegistry(this)
        override val lifecycle: Lifecycle get() = registry
    }
}
