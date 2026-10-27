package com.openbitfun.mobile.app.ui.remote

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.remotedesktop.*

@Composable
internal fun RemoteDesktopControlDock(state: RemoteDesktopControlUiState, interrupted: Boolean,
    onIntent: (RemoteDesktopControlIntent) -> Unit) {
    val binding = state.binding ?: return
    var keyboardShown by remember(state.binding, state.intentEpoch, state.generation) { mutableStateOf(false) }
    val controlling = state.mode == RemoteDesktopControlMode.CONTROLLING
    val actionColors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
    val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    var imeObserved by remember(state.binding, state.intentEpoch, state.generation, keyboardShown) { mutableStateOf(false) }
    LaunchedEffect(keyboardShown, imeVisible) {
        if (keyboardShown) {
            if (imeVisible) imeObserved = true else if (imeObserved) keyboardShown = false
        }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Button(onClick = {
                onIntent(if (controlling) RemoteDesktopControlIntent.Release(binding, state.intentEpoch)
                    else RemoteDesktopControlIntent.Acquire(binding, state.intentEpoch))
            }, enabled = !interrupted && !state.releasePending && state.mode != RemoteDesktopControlMode.ACQUIRING,
                modifier = Modifier.testTag(if (controlling) "remote-desktop-stop-control" else "remote-desktop-start-control")) {
                Text(stringResource(when {
                    controlling -> R.string.remote_desktop_stop_control
                    state.releasePending -> R.string.remote_desktop_releasing_control
                    state.mode == RemoteDesktopControlMode.ACQUIRING -> R.string.remote_desktop_acquiring_control
                    else -> R.string.remote_desktop_start_control
                }))
            }
            if (controlling && !interrupted) {
                TextButton(onClick = { keyboardShown = !keyboardShown }, enabled = state.textSupported, colors = actionColors,
                    modifier = Modifier.testTag("remote-desktop-keyboard-toggle")) {
                    Text(stringResource(if (keyboardShown) R.string.remote_desktop_hide_keyboard else R.string.remote_desktop_show_keyboard))
                }
                Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for ((label, key) in listOf("Esc" to RemoteDesktopKeyboardKey.ESCAPE, "Tab" to RemoteDesktopKeyboardKey.TAB,
                        "←" to RemoteDesktopKeyboardKey.LEFT, "→" to RemoteDesktopKeyboardKey.RIGHT,
                        "↑" to RemoteDesktopKeyboardKey.UP, "↓" to RemoteDesktopKeyboardKey.DOWN,
                        "⌫" to RemoteDesktopKeyboardKey.BACKSPACE, "↵" to RemoteDesktopKeyboardKey.ENTER)) {
                        TextButton(onClick = { state.generation?.let { onIntent(RemoteDesktopControlIntent.KeyTap(binding, state.intentEpoch, it, key)) } }, colors = actionColors,
                            modifier = Modifier.testTag("remote-desktop-key-$key")) { Text(label) }
                    }
                }
            }
        }
        if (controlling && !interrupted) {
            if (!imeVisible) Text(stringResource(if (state.textSupported) R.string.remote_desktop_tap_hint else R.string.remote_desktop_text_unavailable),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (keyboardShown && state.textSupported) RemoteDesktopKeyboardView(state, onIntent, Modifier.size(1.dp))
        }
        state.failure?.let { failure ->
            Text(stringResource(when (failure) {
                RemoteDesktopControlFailure.BUSY -> R.string.remote_desktop_control_busy
                RemoteDesktopControlFailure.DEVICE_APPROVAL_REQUIRED -> R.string.remote_desktop_control_approval
                RemoteDesktopControlFailure.PERMISSION_REQUIRED -> R.string.remote_desktop_control_permission
                else -> R.string.remote_desktop_control_suspended
            }), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
