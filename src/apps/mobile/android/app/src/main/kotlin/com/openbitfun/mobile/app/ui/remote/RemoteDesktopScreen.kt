package com.openbitfun.mobile.app.ui.remote

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupFailure
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupIntent
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupStore
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupUiState
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlUiState
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlIntent
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlMode

/** Native desktop page. AccountStore supplies the fixed-device owner; no Agent selection. */
@Composable
internal fun RemoteDesktopScreen(store: RemoteDesktopSetupStore?, deviceName: String, onReconnect: () -> Unit, onBack: () -> Unit, modifier: Modifier) {
    if (store == null) {
        BackHandler(onBack = onBack)
        RemoteDesktopScreenContent(RemoteDesktopSetupUiState.Failed(RemoteDesktopSetupFailure.TARGET_UNAVAILABLE), false,
            { if (it == RemoteDesktopSetupIntent.Load) onReconnect() }, onBack, modifier, deviceName, {})
        return
    }
    key(store) {
        val state by store.state.collectAsState()
        val media by store.media.collectAsState()
        val control by store.control.collectAsState()
        RemoteDesktopPageLifetime(store::dispatch)
        val close = { store.dispatch(RemoteDesktopSetupIntent.Close); onBack() }
        BackHandler(onBack = close)
        RemoteDesktopScreenContent(state, media?.signalingInterrupted == true,
            { if (it == RemoteDesktopSetupIntent.Load) onReconnect() else store.dispatch(it) }, close, modifier, deviceName,
            control, store::dispatchControl) {
            RemoteDesktopMediaView(store, Modifier.fillMaxSize().testTag("remote-desktop-media"))
        }
    }
}

/** Open once while started. Returning from background never silently reattaches. */
@Composable
internal fun RemoteDesktopPageLifetime(onIntent: (RemoteDesktopSetupIntent) -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val dispatch by rememberUpdatedState(onIntent)
    DisposableEffect(lifecycle) {
        var opened = false
        fun openOnce() {
            if (!opened) {
                opened = true
                dispatch(RemoteDesktopSetupIntent.Load)
            }
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> openOnce()
                Lifecycle.Event.ON_STOP -> { opened = true; dispatch(RemoteDesktopSetupIntent.Close) }
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) openOnce()
        onDispose {
            lifecycle.removeObserver(observer)
            dispatch(RemoteDesktopSetupIntent.Close)
        }
    }
}

@Composable
internal fun RemoteDesktopScreenContent(
    state: RemoteDesktopSetupUiState,
    signalingInterrupted: Boolean,
    onIntent: (RemoteDesktopSetupIntent) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier,
    deviceName: String,
    media: @Composable () -> Unit,
) { RemoteDesktopScreenContent(state, signalingInterrupted, onIntent, onClose, modifier, deviceName, null, {}, media) }

@Composable
internal fun RemoteDesktopScreenContent(
    state: RemoteDesktopSetupUiState,
    signalingInterrupted: Boolean,
    onIntent: (RemoteDesktopSetupIntent) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier,
    deviceName: String,
    control: RemoteDesktopControlUiState?,
    onControl: (RemoteDesktopControlIntent) -> Unit,
    media: @Composable () -> Unit,
) {
    val actionColors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
    val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    Surface(modifier.fillMaxSize().testTag("remote-desktop-page"), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
            if (!imeVisible) Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose, modifier = Modifier.testTag("remote-desktop-close")) {
                    Icon(painterResource(R.drawable.ic_symbol_chevron_left), stringResource(R.string.common_back))
                }
                Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                    Text(deviceName.ifBlank { stringResource(R.string.remote_desktop_title) }, style = MaterialTheme.typography.titleMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(stringResource(if (control?.mode == RemoteDesktopControlMode.CONTROLLING) R.string.remote_desktop_controlling
                        else R.string.remote_desktop_read_only), style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (state is RemoteDesktopSetupUiState.Viewing && state.sourceLifecycleSupported
                    || state is RemoteDesktopSetupUiState.Suspending || state is RemoteDesktopSetupUiState.Resuming
                    || state is RemoteDesktopSetupUiState.SelectingDisplay) {
                    TextButton(onClick = { onIntent(RemoteDesktopSetupIntent.Pause) }, colors = actionColors, enabled = !signalingInterrupted,
                        modifier = Modifier.testTag("remote-desktop-pause")) {
                        Text(stringResource(R.string.remote_desktop_pause))
                    }
                }
                if (state is RemoteDesktopSetupUiState.ChoosePausedDisplay || state is RemoteDesktopSetupUiState.LoadingDisplayChoices) {
                    TextButton(onClick = { onIntent(RemoteDesktopSetupIntent.CancelDisplayChange) }, colors = actionColors,
                        modifier = Modifier.testTag("remote-desktop-cancel-display")) {
                        Text(stringResource(R.string.common_cancel))
                    }
                }
                if (state is RemoteDesktopSetupUiState.Viewing || state is RemoteDesktopSetupUiState.AwaitingFrame
                    || state is RemoteDesktopSetupUiState.Attached || state is RemoteDesktopSetupUiState.Suspending
                    || state is RemoteDesktopSetupUiState.Resuming || state is RemoteDesktopSetupUiState.Paused
                    || state is RemoteDesktopSetupUiState.LoadingDisplayChoices || state is RemoteDesktopSetupUiState.ChoosePausedDisplay
                    || state is RemoteDesktopSetupUiState.SelectingDisplay) {
                    TextButton(onClick = { onIntent(RemoteDesktopSetupIntent.Close) }, colors = actionColors) {
                        Text(stringResource(R.string.remote_desktop_disconnect))
                    }
                }
            }
            if (signalingInterrupted) {
                Text(stringResource(R.string.remote_desktop_signaling_interrupted), style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp))
            }
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                media()
                if (state !is RemoteDesktopSetupUiState.Viewing) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
                            when (state) {
                                is RemoteDesktopSetupUiState.ChooseDisplay -> {
                                    var forceRelay by rememberSaveable { mutableStateOf(false) }
                                    Text(stringResource(R.string.remote_desktop_choose_display), style = MaterialTheme.typography.headlineSmall)
                                    Text(stringResource(R.string.remote_desktop_approval_hint), style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically) {
                                        Text(stringResource(R.string.remote_desktop_use_relay), style = MaterialTheme.typography.bodyMedium,
                                            modifier = Modifier.weight(1f))
                                        Switch(checked = forceRelay, onCheckedChange = { forceRelay = it },
                                            modifier = Modifier.testTag("remote-desktop-force-relay"))
                                    }
                                    state.displays.forEachIndexed { index, display ->
                                        Button(onClick = { onIntent(RemoteDesktopSetupIntent.SelectDisplay(display.id, forceRelay)) },
                                            modifier = Modifier.fillMaxWidth().testTag("remote-desktop-display:${display.id}")) {
                                            Text(stringResource(R.string.remote_desktop_display, index + 1, display.width, display.height))
                                        }
                                    }
                                }
                                is RemoteDesktopSetupUiState.Failed -> {
                                    Text(stringResource(failureMessage(state.reason)), style = MaterialTheme.typography.bodyMedium)
                                    Button(onClick = { onIntent(RemoteDesktopSetupIntent.Load) }) { Text(stringResource(R.string.remote_desktop_retry)) }
                                }
                                RemoteDesktopSetupUiState.Closed -> {
                                    Text(stringResource(R.string.remote_desktop_disconnected), style = MaterialTheme.typography.headlineSmall)
                                    Button(onClick = { onIntent(RemoteDesktopSetupIntent.Load) }) { Text(stringResource(R.string.remote_desktop_retry)) }
                                }
                                is RemoteDesktopSetupUiState.Paused -> {
                                    Text(stringResource(R.string.remote_desktop_paused), style = MaterialTheme.typography.headlineSmall)
                                    Button(onClick = { onIntent(RemoteDesktopSetupIntent.Resume) }, modifier = Modifier.testTag("remote-desktop-resume")) {
                                        Text(stringResource(R.string.remote_desktop_resume))
                                    }
                                    TextButton(onClick = { onIntent(RemoteDesktopSetupIntent.ChangeDisplay) }, colors = actionColors,
                                        modifier = Modifier.testTag("remote-desktop-change-display")) {
                                        Text(stringResource(R.string.remote_desktop_change_display))
                                    }
                                }
                                is RemoteDesktopSetupUiState.ChoosePausedDisplay -> {
                                    Text(stringResource(R.string.remote_desktop_choose_display), style = MaterialTheme.typography.headlineSmall)
                                    state.displays.forEachIndexed { index, display ->
                                        Button(onClick = { onIntent(RemoteDesktopSetupIntent.SelectPausedDisplay(display.id)) },
                                            modifier = Modifier.fillMaxWidth().testTag("remote-desktop-paused-display:${display.id}")) {
                                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                                Text(stringResource(R.string.remote_desktop_display, index + 1, display.width, display.height))
                                                if (display.id == state.display.id) Text(stringResource(R.string.remote_desktop_current_display),
                                                    style = MaterialTheme.typography.labelSmall)
                                            }
                                        }
                                    }
                                }
                                is RemoteDesktopSetupUiState.LoadingDisplayChoices -> {
                                    CircularProgressIndicator(Modifier.size(28.dp))
                                    Text(stringResource(R.string.remote_desktop_loading), style = MaterialTheme.typography.bodyMedium)
                                }
                                else -> {
                                    CircularProgressIndicator(Modifier.size(28.dp))
                                    Text(stringResource(when (state) {
                                        is RemoteDesktopSetupUiState.Probing, RemoteDesktopSetupUiState.Idle -> R.string.remote_desktop_loading
                                        is RemoteDesktopSetupUiState.Suspending -> R.string.remote_desktop_pausing
                                        else -> R.string.remote_desktop_awaiting_frame
                                    }), style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    }
                }
            }
            if (state is RemoteDesktopSetupUiState.Viewing && control?.supported == true) {
                RemoteDesktopControlDock(control, signalingInterrupted, onControl)
            }
        }
    }
}

private fun failureMessage(reason: RemoteDesktopSetupFailure): Int = when (reason) {
    RemoteDesktopSetupFailure.UNSUPPORTED -> R.string.remote_desktop_unsupported
    RemoteDesktopSetupFailure.RELAY_UPGRADE_REQUIRED -> R.string.remote_desktop_relay_upgrade
    RemoteDesktopSetupFailure.HTTPS_REQUIRED -> R.string.remote_desktop_https_required
    RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED -> R.string.remote_desktop_device_approval
    RemoteDesktopSetupFailure.PERMISSION_REQUIRED -> R.string.remote_desktop_permission
    RemoteDesktopSetupFailure.BACKEND_UNAVAILABLE -> R.string.remote_desktop_backend_unavailable
    RemoteDesktopSetupFailure.NO_DISPLAYS -> R.string.remote_desktop_no_displays
    RemoteDesktopSetupFailure.TARGET_UNAVAILABLE -> R.string.remote_desktop_target_unavailable
    RemoteDesktopSetupFailure.ACCOUNT_CHANGED -> R.string.remote_desktop_account_changed
    RemoteDesktopSetupFailure.DEVICE_IDENTITY_CHANGED -> R.string.remote_desktop_identity_changed
    RemoteDesktopSetupFailure.INVALID_RESPONSE -> R.string.remote_desktop_invalid_response
    RemoteDesktopSetupFailure.DELIVERY_UNKNOWN -> R.string.remote_desktop_delivery_unknown
    RemoteDesktopSetupFailure.STALE_REVISION -> R.string.remote_desktop_display_changed
    RemoteDesktopSetupFailure.BUSY -> R.string.remote_desktop_busy
    RemoteDesktopSetupFailure.CLEANUP_PENDING -> R.string.remote_desktop_cleanup_pending
    RemoteDesktopSetupFailure.NETWORK -> R.string.account_network
    RemoteDesktopSetupFailure.CONNECTION_TIMEOUT -> R.string.account_timeout
    RemoteDesktopSetupFailure.RATE_LIMITED -> R.string.remote_desktop_rate_limited
    RemoteDesktopSetupFailure.HOST_REJECTED -> R.string.remote_desktop_host_rejected
    RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED -> R.string.remote_desktop_credentials_expired
    RemoteDesktopSetupFailure.MEDIA_UNREACHABLE -> R.string.remote_desktop_media_unreachable
    RemoteDesktopSetupFailure.RELAY_NOT_SELECTED -> R.string.remote_desktop_relay_not_selected
}
