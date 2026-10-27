package com.openbitfun.mobile.core.feature.remotedesktop

public data class RemoteDesktopDisplayUi(public val id: String, public val width: Int, public val height: Int)

/** Read-only connection facts. Attached is logical; Viewing requires confirmed source and presentation. */
public sealed interface RemoteDesktopSetupUiState {
    public data object Idle : RemoteDesktopSetupUiState
    public data object Probing : RemoteDesktopSetupUiState
    public data class ChooseDisplay(public val displays: List<RemoteDesktopDisplayUi>) : RemoteDesktopSetupUiState
    public data class Attaching(public val display: RemoteDesktopDisplayUi) : RemoteDesktopSetupUiState
    public data class Attached(
        public val display: RemoteDesktopDisplayUi,
        public val attachmentId: String,
        public val connectionId: String,
    ) : RemoteDesktopSetupUiState
    public data class AwaitingFrame(public val display: RemoteDesktopDisplayUi) : RemoteDesktopSetupUiState
    public data class Viewing(public val display: RemoteDesktopDisplayUi, public val width: Int, public val height: Int,
        public val sourceLifecycleSupported: Boolean) : RemoteDesktopSetupUiState {
        public constructor(display: RemoteDesktopDisplayUi, width: Int, height: Int) : this(display, width, height, false)
    }
    public data class Suspending(public val display: RemoteDesktopDisplayUi) : RemoteDesktopSetupUiState
    public data class Paused(public val display: RemoteDesktopDisplayUi) : RemoteDesktopSetupUiState
    public data class LoadingDisplayChoices(public val display: RemoteDesktopDisplayUi) : RemoteDesktopSetupUiState
    public data class ChoosePausedDisplay(public val display: RemoteDesktopDisplayUi, public val displays: List<RemoteDesktopDisplayUi>) : RemoteDesktopSetupUiState
    public data class SelectingDisplay(public val display: RemoteDesktopDisplayUi) : RemoteDesktopSetupUiState
    public data class Resuming(public val display: RemoteDesktopDisplayUi) : RemoteDesktopSetupUiState
    public data class Failed(public val reason: RemoteDesktopSetupFailure) : RemoteDesktopSetupUiState
    public data object Closed : RemoteDesktopSetupUiState
}

public enum class RemoteDesktopSetupFailure {
    UNSUPPORTED, RELAY_UPGRADE_REQUIRED, HTTPS_REQUIRED, DEVICE_APPROVAL_REQUIRED,
    PERMISSION_REQUIRED, BACKEND_UNAVAILABLE, NO_DISPLAYS, TARGET_UNAVAILABLE,
    ACCOUNT_CHANGED, DEVICE_IDENTITY_CHANGED, INVALID_RESPONSE, DELIVERY_UNKNOWN,
    STALE_REVISION, BUSY, CLEANUP_PENDING, NETWORK, CONNECTION_TIMEOUT, RATE_LIMITED, HOST_REJECTED,
    CREDENTIALS_EXPIRED, MEDIA_UNREACHABLE, RELAY_NOT_SELECTED,
}

public sealed interface RemoteDesktopSetupIntent {
    public data object Load : RemoteDesktopSetupIntent
    public data class SelectDisplay(public val displayId: String, public val forceRelay: Boolean) : RemoteDesktopSetupIntent
    public data object Pause : RemoteDesktopSetupIntent
    public data object Resume : RemoteDesktopSetupIntent
    public data object ChangeDisplay : RemoteDesktopSetupIntent
    public data object CancelDisplayChange : RemoteDesktopSetupIntent
    public data class SelectPausedDisplay(public val displayId: String) : RemoteDesktopSetupIntent
    public data object Close : RemoteDesktopSetupIntent
}
