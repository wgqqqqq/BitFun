package com.openbitfun.mobile.core.feature.remotedesktop

/** Ephemeral renderer input. Never persists or receives account credentials. */
public data class RemoteDesktopMediaUiState(
    public val rendererId: String,
    public val attachmentId: String,
    public val connectionId: String,
    public val offerSdp: String,
    public val iceServers: List<RemoteDesktopIceServerUi>,
    public val forceRelay: Boolean,
    public val sourceReady: Boolean,
    public val signalingInterrupted: Boolean,
    /** Host advertisement, not a grant; native readiness is negotiated separately. */
    public val controlSupported: Boolean,
) {
    public constructor(rendererId: String, attachmentId: String, connectionId: String, offerSdp: String,
        iceServers: List<RemoteDesktopIceServerUi>, forceRelay: Boolean, sourceReady: Boolean, signalingInterrupted: Boolean)
        : this(rendererId, attachmentId, connectionId, offerSdp, iceServers, forceRelay, sourceReady, signalingInterrupted, false)
    override fun toString(): String = "RemoteDesktopMediaUiState(<redacted>)"
}

public data class RemoteDesktopIceServerUi(public val urls: List<String>, public val username: String, public val credential: String) {
    override fun toString(): String = "RemoteDesktopIceServerUi(<redacted>)"
}

public data class RemoteDesktopMediaBindingUi(public val rendererId: String, public val attachmentId: String, public val connectionId: String)

public sealed interface RemoteDesktopMediaIntent {
    /** Bundled page or required WebView API unavailable before a PC exists. */
    public data object Unavailable : RemoteDesktopMediaIntent
    /** The native adapter has loaded its bundled media page and narrow bridge. */
    public data object Prepare : RemoteDesktopMediaIntent
    /** The platform adapter supports epoch-stamped reports and input retirement for this exact PC. */
    public data class ControlReady(public val binding: RemoteDesktopMediaBindingUi) : RemoteDesktopMediaIntent
    public data class Answer(public val binding: RemoteDesktopMediaBindingUi, public val sdp: String) : RemoteDesktopMediaIntent {
        override fun toString(): String = "RemoteDesktopMediaIntent.Answer(<redacted>)"
    }
    public data class FramePresented(public val binding: RemoteDesktopMediaBindingUi, public val width: Int, public val height: Int) : RemoteDesktopMediaIntent
    public data class Health(public val binding: RemoteDesktopMediaBindingUi, public val localCandidate: String, public val remoteCandidate: String) : RemoteDesktopMediaIntent
    public data class Failed(public val binding: RemoteDesktopMediaBindingUi) : RemoteDesktopMediaIntent
}
