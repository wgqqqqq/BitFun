package com.openbitfun.mobile.core.feature.remotedesktop

/** Map native view coordinates into the contained video, without clamping bars
 * into a clickable desktop point. Keep the gesture's original authority. */
public fun remoteDesktopTapIntent(
    control: RemoteDesktopControlUiState,
    viewportWidth: Double,
    viewportHeight: Double,
    videoWidth: Int,
    videoHeight: Int,
    x: Double,
    y: Double,
): RemoteDesktopControlIntent.Tap? = projectDesktopPoint(control, viewportWidth, viewportHeight, videoWidth, videoHeight, x, y, false)

/** Active dragging may finish at a video edge; a bar never starts a click. */
public fun remoteDesktopPointerMoveIntent(control: RemoteDesktopControlUiState, viewportWidth: Double, viewportHeight: Double,
    videoWidth: Int, videoHeight: Int, x: Double, y: Double): RemoteDesktopControlIntent.PointerMove? =
    projectDesktopPoint(control, viewportWidth, viewportHeight, videoWidth, videoHeight, x, y, true)?.let {
        RemoteDesktopControlIntent.PointerMove(it.binding, it.intentEpoch, it.generation, it.x, it.y)
    }

private fun projectDesktopPoint(control: RemoteDesktopControlUiState, viewportWidth: Double, viewportHeight: Double,
    videoWidth: Int, videoHeight: Int, x: Double, y: Double, clamp: Boolean): RemoteDesktopControlIntent.Tap? {
    val binding = control.binding ?: return null
    val generation = control.generation ?: return null
    if (!control.supported || control.mode != RemoteDesktopControlMode.CONTROLLING
        || !viewportWidth.isFinite() || !viewportHeight.isFinite() || viewportWidth <= 0 || viewportHeight <= 0
        || videoWidth !in 1..32768 || videoHeight !in 1..32768 || !x.isFinite() || !y.isFinite()) return null
    val scale = minOf(viewportWidth / videoWidth, viewportHeight / videoHeight)
    val width = videoWidth * scale
    val height = videoHeight * scale
    val normalizedX = (x - (viewportWidth - width) / 2) / width
    val normalizedY = (y - (viewportHeight - height) / 2) / height
    if (!clamp && (normalizedX !in 0.0..1.0 || normalizedY !in 0.0..1.0)) return null
    return RemoteDesktopControlIntent.Tap(binding, control.intentEpoch, generation, normalizedX.coerceIn(0.0, 1.0), normalizedY.coerceIn(0.0, 1.0))
}
