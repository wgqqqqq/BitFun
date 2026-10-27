package com.openbitfun.mobile.core.feature.remotedesktop

public enum class RemoteDesktopControlMode { VIEWING, ACQUIRING, CONTROLLING }
public enum class RemoteDesktopControlPending { ACQUIRE, RELEASE, RENEW }
public enum class RemoteDesktopKeyboardKey { BACKSPACE, DELETE, ENTER, TAB, ESCAPE, LEFT, RIGHT, UP, DOWN }
public enum class RemoteDesktopPointerButton { LEFT, RIGHT, MIDDLE }
public enum class RemoteDesktopControlFailure {
    BUSY, DEVICE_APPROVAL_REQUIRED, PERMISSION_REQUIRED, STALE_REVISION,
    INPUT_SUSPENDED, REVOKED, DELIVERY_UNKNOWN, INVALID_RESPONSE,
}

/** Ephemeral local authority. It never grants host permission or persists a lease. */
public data class RemoteDesktopControlUiState(
    public val binding: RemoteDesktopMediaBindingUi?,
    public val supported: Boolean,
    public val mode: RemoteDesktopControlMode,
    public val generation: String?,
    public val intentEpoch: Long,
    public val releasePending: Boolean,
    public val failure: RemoteDesktopControlFailure?,
    public val textSupported: Boolean,
) {
    public constructor(binding: RemoteDesktopMediaBindingUi?, supported: Boolean, mode: RemoteDesktopControlMode,
        generation: String?, intentEpoch: Long, releasePending: Boolean, failure: RemoteDesktopControlFailure?)
        : this(binding, supported, mode, generation, intentEpoch, releasePending, failure, false)
}

public sealed interface RemoteDesktopControlIntent {
    public data class Acquire(public val binding: RemoteDesktopMediaBindingUi, public val intentEpoch: Long) : RemoteDesktopControlIntent
    public data class Release(public val binding: RemoteDesktopMediaBindingUi, public val intentEpoch: Long) : RemoteDesktopControlIntent
    /** Coordinates are normalized to the presented image, excluding letterboxing. */
    public data class Tap(public val binding: RemoteDesktopMediaBindingUi, public val intentEpoch: Long,
        public val generation: String, public val x: Double, public val y: Double, public val button: RemoteDesktopPointerButton) : RemoteDesktopControlIntent {
        public constructor(binding: RemoteDesktopMediaBindingUi, intentEpoch: Long, generation: String, x: Double, y: Double)
            : this(binding, intentEpoch, generation, x, y, RemoteDesktopPointerButton.LEFT)
        override fun toString(): String = "RemoteDesktopControlIntent.Tap(<redacted>)"
    }
    public data class PointerMove(public val binding: RemoteDesktopMediaBindingUi, public val intentEpoch: Long,
        public val generation: String, public val x: Double, public val y: Double) : RemoteDesktopControlIntent {
        override fun toString(): String = "RemoteDesktopControlIntent.PointerMove(<redacted>)"
    }
    public data class PointerButton(public val binding: RemoteDesktopMediaBindingUi, public val intentEpoch: Long,
        public val generation: String, public val x: Double, public val y: Double, public val button: RemoteDesktopPointerButton,
        public val down: Boolean) : RemoteDesktopControlIntent {
        override fun toString(): String = "RemoteDesktopControlIntent.PointerButton(<redacted>)"
    }
    public data class Wheel(public val binding: RemoteDesktopMediaBindingUi, public val intentEpoch: Long,
        public val generation: String, public val x: Double, public val y: Double, public val dx: Double, public val dy: Double) : RemoteDesktopControlIntent {
        override fun toString(): String = "RemoteDesktopControlIntent.Wheel(<redacted>)"
    }
    public data class TextCommit(public val binding: RemoteDesktopMediaBindingUi, public val intentEpoch: Long,
        public val generation: String, public val text: String) : RemoteDesktopControlIntent {
        override fun toString(): String = "RemoteDesktopControlIntent.TextCommit(<redacted>)"
    }
    public data class KeyTap(public val binding: RemoteDesktopMediaBindingUi, public val intentEpoch: Long,
        public val generation: String, public val key: RemoteDesktopKeyboardKey) : RemoteDesktopControlIntent {
        override fun toString(): String = "RemoteDesktopControlIntent.KeyTap(<redacted>)"
    }
}

/** One bounded native-renderer action, not a new wire protocol. */
public sealed interface RemoteDesktopControlRendererIntent {
    public val binding: RemoteDesktopMediaBindingUi
    public val intentEpoch: Long
    public data class Acquire(override val binding: RemoteDesktopMediaBindingUi, override val intentEpoch: Long,
        public val revision: String) : RemoteDesktopControlRendererIntent
    public data class Release(override val binding: RemoteDesktopMediaBindingUi, override val intentEpoch: Long) : RemoteDesktopControlRendererIntent
    public data class Tap(override val binding: RemoteDesktopMediaBindingUi, override val intentEpoch: Long,
        public val generation: String, public val x: Double, public val y: Double, public val button: RemoteDesktopPointerButton) : RemoteDesktopControlRendererIntent {
        public constructor(binding: RemoteDesktopMediaBindingUi, intentEpoch: Long, generation: String, x: Double, y: Double)
            : this(binding, intentEpoch, generation, x, y, RemoteDesktopPointerButton.LEFT)
        override fun toString(): String = "RemoteDesktopControlRendererIntent.Tap(<redacted>)"
    }
    public data class PointerMove(override val binding: RemoteDesktopMediaBindingUi, override val intentEpoch: Long,
        public val generation: String, public val x: Double, public val y: Double) : RemoteDesktopControlRendererIntent {
        override fun toString(): String = "RemoteDesktopControlRendererIntent.PointerMove(<redacted>)"
    }
    public data class PointerButton(override val binding: RemoteDesktopMediaBindingUi, override val intentEpoch: Long,
        public val generation: String, public val x: Double, public val y: Double, public val button: RemoteDesktopPointerButton,
        public val down: Boolean) : RemoteDesktopControlRendererIntent {
        override fun toString(): String = "RemoteDesktopControlRendererIntent.PointerButton(<redacted>)"
    }
    public data class Wheel(override val binding: RemoteDesktopMediaBindingUi, override val intentEpoch: Long,
        public val generation: String, public val x: Double, public val y: Double, public val dx: Double, public val dy: Double) : RemoteDesktopControlRendererIntent {
        override fun toString(): String = "RemoteDesktopControlRendererIntent.Wheel(<redacted>)"
    }
    public data class TextCommit(override val binding: RemoteDesktopMediaBindingUi, override val intentEpoch: Long,
        public val generation: String, public val text: String) : RemoteDesktopControlRendererIntent {
        override fun toString(): String = "RemoteDesktopControlRendererIntent.TextCommit(<redacted>)"
    }
    public data class KeyTap(override val binding: RemoteDesktopMediaBindingUi, override val intentEpoch: Long,
        public val generation: String, public val key: RemoteDesktopKeyboardKey) : RemoteDesktopControlRendererIntent {
        override fun toString(): String = "RemoteDesktopControlRendererIntent.KeyTap(<redacted>)"
    }
}

public data class RemoteDesktopControlReportIntent(
    public val binding: RemoteDesktopMediaBindingUi,
    /** Stamp at JS event creation; never relabel an arriving report with a newer intent. */
    public val intentEpoch: Long,
    public val generation: String?,
    public val pending: RemoteDesktopControlPending?,
    public val failure: RemoteDesktopControlFailure?,
)
