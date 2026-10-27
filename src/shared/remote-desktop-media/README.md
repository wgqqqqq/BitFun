# Bundled remote desktop media receiver

The shared page owns one receive-only PeerConnection, one reliable ordered
`rd` channel and native video presentation. App surfaces own account routing,
fixed device keys, target selection, permission UX and lifecycle.

WebView branding/version alone does not guarantee this receiver is available.
WebKitGTK 2.54 disables WebRTC during its backend transition; a native GTK 3 /
4.1 API probe still reported no `RTCPeerConnection` after enabling the setting.
The renderer must keep returning `media_backend_unavailable` when its required
APIs are absent. See the Linux probe and scope in
[the architecture document](../../../docs/architecture/remote-desktop-control.md#linux-webkitgtk-限制与下一步).

Pass only a scoped gathered offer and short-lived ICE credentials. Account
tokens, device secrets, grant storage, OS input and Agent commands never enter
this renderer. `bridge_ready`, transport, channel binding and actual frame
presentation are distinct events. Native source confirmation is required before
counting a presented frame; decoded counts are diagnostics, not input authority.
Source confirmation and presentation may arrive in either order: only dimensions
from the current PC are retained. The sender must never encode placeholder
frames before its authorized native source starts. Static first-frame behavior
still requires native end-to-end validation before input is enabled.

The gathered answer must contain an ICE candidate; there is no later trickle
path. Gathering complete with no candidates closes the PC with
`media_unreachable` instead of signaling an unusable answer.

Bundle these files into each actual app resource tree. Renderer rebuild/exit
must close the old PC and invalidate its app-side attachment callbacks. The
renderer never grants input by itself. Control additionally needs negotiated
support, a host-issued lease and fresh media/visibility/focus health; a renderer
probe alone is not acceptance of native input or freeze detection. Both local
control health and receiver reports require the video track to be explicitly
enabled, live and unmuted. A disabled live track can render black; it must not justify input.

Presentation progress uses monotonically advancing compositor `presentedFrames`
when available. Live WebKit media can keep `mediaTime` constant despite actual
presentation. Older renderers and the native canvas shim retain advancing
`mediaTime` as the fallback when no compositor counter has been observed. A
stuck counter never borrows decoder/media-time progress, and an invalid, missing
or regressed counter after observation invalidates presentation for that PC.

A bind send exception, channel error, unexpected channel close, failed/closed
PC, ended track, or periodic stats failure reports `media_unreachable` and
immediately retires the current PC, track, and video. Playback rejection uses
`media_playback_failed` with the same cleanup. It never reports a successful bind
after a send exception. Intentional stop and callbacks from retired media cannot
fail or close a successor, including when the app starts one inside an error
callback. A transient disconnected PC still uses the existing reconnection path.
The receiver reconciles a channel that is already open when `datachannel`
arrives, as well as a later `open` event. Both paths schedule one bind after
native event dispatch returns, sharing one pending/sent guard. Stop cancels the
pending task; its identity check also fences a retired connection. A thrown send
fails the PC without retry. Local send completion is not host acceptance: source
readiness and presentation remain separate gates.

Failed events may include a local diagnostic stage (channel, peer, track,
playback, stats, setup or a closed ICE error category). ICE errors are retained
only as selected numeric codes when gathering produces no candidates; endpoint,
error text and credentials are excluded. This does not retry gathering or change
the failure's `media_unreachable` semantics. A JavaScript send returning normally
still does not prove delivery if the engine later reports an asynchronous error.

Android WebView 149 showed an open channel and connected SCTP/PC while its first
send failed asynchronously with `INVALID_STATE`. Moving that first send outside
event dispatch passed two native four-case runs; this is a bounded mitigation,
not a claim of an isolated Chromium root cause or long-duration acceptance.
[Chromium's send implementation](https://chromium.googlesource.com/chromium/src/third_party/+/refs/heads/main/blink/renderer/modules/peerconnection/rtc_data_channel.cc)
reports asynchronous native send errors after the JavaScript call returns.

The Desktop Web UI bundles the same receiver in an opaque-origin sandboxed
iframe. Its app adapter binds messages to the current frame and a per-document
token; no Tauri bridge or account credentials enter the frame. Generated-video
presentation in a desktop webview is a renderer probe, not acceptance of two
authenticated computers or the native screen-capture path.

Desktop editors and toolbars live outside the opaque frame. `parent_focus`
therefore asks the app for focus using the current host health challenge and
the full local binding. Missing/late/old replies report no focus; a positive
answer expires on the renderer's monotonic clock. This is a local bridge
contract, not a new network authorization or heartbeat. Existing native-focus
and document-focus clients retain their default behavior.

`bridge_ready` advertises the optional local capability `control_epoch_v1`.
An adapter opting in supplies a canonical nonnegative signed-64-bit string
`control_epoch` in start/control envelopes. Control reports copy it when the
event is created, before native delivery. Input must match the current epoch;
acquire/release may advance it, and old epochs cannot act on a successor lease.
The field stays outside the wire command body. Legacy adapters omitting it keep
their existing report shape; an unstamped release remains available for local
cleanup. This stamp fences app callbacks and does not replace the host's lease
or the native adapter's execution-time focus checks.

Control health samples use the same monotonic clock as delegated focus. Wall
clock changes cannot extend their six-second freshness budget; a negative or
non-finite sample age or missing monotonic clock is unknown. For clock and lifecycle regressions, run from
the repository root:

```bash
node --test src/apps/mobile/harmonyos/tools/tests/remote-desktop-media.test.cjs src/apps/mobile/harmonyos/tools/tests/remote-desktop-control.test.cjs src/apps/mobile/harmonyos/tools/tests/remote-desktop-browser.test.cjs
```

The browser cases use loopback canvas video and an ordered DataChannel. They
exercise the shared receiver, not native desktop injection or phone acceptance.

Local release retires input immediately and retains that exact generation while
waiting for confirmation. A matching host `control_revoked` settles this wait:
the native host emits it after drainage, even if health invalidation discarded
the queued release request. Unrelated or malformed revocations cannot clear a
pending release or an acquisition with an unknown outcome. Missing confirmation
still closes the connection at the original deadline; reacquisition is explicit.
