package com.openbitfun.mobile.app.ui.remote

import android.widget.FrameLayout
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopMediaIntent
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupStore
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopSetupUiState
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlUiState
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlIntent
import com.openbitfun.mobile.core.feature.remotedesktop.RemoteDesktopControlReportIntent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

private data class MountedRemoteDesktop(val view: RemoteDesktopWebView, val scope: CoroutineScope)
private class RendererIdentity { var connection: Pair<String, String>? = null }

/** The page owns store.Close on exit/background. Layout updates preserve this WebView. */
@Composable
internal fun RemoteDesktopMediaView(store: RemoteDesktopSetupStore, modifier: Modifier) {
    val state by store.state.collectAsState()
    val parent = rememberCoroutineScope()
    val renderer = remember(store) { RendererIdentity() }
    val background = MaterialTheme.colorScheme.background.toArgb()
    if (state is RemoteDesktopSetupUiState.Attached || state is RemoteDesktopSetupUiState.AwaitingFrame
        || state is RemoteDesktopSetupUiState.Viewing || state is RemoteDesktopSetupUiState.Suspending) {
        (state as? RemoteDesktopSetupUiState.Attached)?.let { renderer.connection = it.attachmentId to it.connectionId }
        // Layout changes retain the native view; a new PC gets a fresh document
        // even if Compose coalesces the intervening paused/resuming states.
        key(store, renderer.connection) {
            AndroidView(modifier = modifier, factory = { context ->
                FrameLayout(context).also { host ->
                    val view = try {
                        RemoteDesktopWebView(context, { store.dispatchMedia(RemoteDesktopMediaIntent.Prepare) }, store::dispatchMedia,
                            object : RemoteDesktopControlHost {
                                override fun state(): RemoteDesktopControlUiState = store.control.value
                                override fun dispatch(intent: RemoteDesktopControlIntent) { store.dispatchControl(intent) }
                                override fun report(intent: RemoteDesktopControlReportIntent) { store.reportControl(intent) }
                            })
                    } catch (_: Exception) {
                        store.dispatchMedia(RemoteDesktopMediaIntent.Unavailable)
                        null
                    } ?: return@also
                    host.addView(view)
                    val scope = CoroutineScope(SupervisorJob(parent.coroutineContext[Job]) + Dispatchers.Main.immediate)
                    host.tag = MountedRemoteDesktop(view, scope)
                    scope.launch { store.media.collect { view.render(it) } }
                    scope.launch { store.control.collect { view.renderControl(it) } }
                    scope.launch { store.rendererControlIntents.collect { view.control(it) } }
                }
            }, update = { host ->
                host.setBackgroundColor(background)
                (host.tag as? MountedRemoteDesktop)?.view?.let { view ->
                    view.updateBackground(background)
                    if (state is RemoteDesktopSetupUiState.Attached) view.prepareConnection()
                }
            }, onRelease = { host ->
                (host.tag as? MountedRemoteDesktop)?.let { mounted -> mounted.scope.cancel(); mounted.view.dispose() }
            })
        }
    }
}
