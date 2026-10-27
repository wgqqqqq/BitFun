# macOS native display media probe

Stage 1 risk fixture: ScreenCaptureKit display stream → borrowed NV12
CVPixelBuffer → LiveKit libwebrtc raw NativeVideoSource → independent
PeerConnection → the stage 0 HarmonyOS App's bundled ArkWeb. No LiveKit
Room/SFU/Cloud, account state, Agent session, or OS input is involved.
This does not add a shipping remote desktop entry point.

## Build and run

Requires macOS 14+, Apple command-line SDK, Rust and Node. Initial build target
is aarch64-apple-darwin; Intel, Windows, Linux and OHOS are not verified by it.
From this directory:

```sh
cargo test --locked --lib
node build.mjs
```

Cargo.lock fixes libwebrtc 0.3.52, webrtc-sys 0.3.49, and webrtc-sys-build 0.3.19.
The latter downloads LiveKit's `webrtc-89d790b` prebuilt artifact for the host
architecture. artifact-pin.json records the initially tested arm64 static library
hash; the build checks it before packaging. This detects a changed artifact, not
independent publisher attestation. Intel requires its own reviewed artifact pin.
The two macOS targets link `-ObjC`; Swift explicitly targets macOS 14. Source references are the
[LiveKit bindings](https://github.com/livekit/rust-sdks) and
[Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit).
No full libwebrtc source build or product Cargo dependency change is required.
The output is an ad-hoc signed local fixture, not a distributable product bundle.
Preserve the crate lock and record the prebuilt library hash before selecting
an engine for product packaging. Apache-2.0 bindings and upstream WebRTC notices
need the usual distribution review; this probe does not declare that review done.

Prepare private role-specific short-lived TURN credentials, isolated trial TURN,
loopback signaling, hdc reverse, and real HarmonyOS DEBUG receiver as described in
[the shared probe guide](../../../../../deploy/remote-desktop/probe/README.md).
Do not commit secrets. Both roles select one TURN URL per run; the signaling
server reads its config at startup, so restart it when changing UDP/TCP.

List actual displays and pass the intended ID explicitly:

```sh
PROBE_BIN='target/native/OpenBitFun Native Display Probe.app/Contents/MacOS/native-display-probe'
"$PROBE_BIN" --list-displays
"$PROBE_BIN" --config "$PRIVATE_PROBE_CONFIG" --display-id "$DISPLAY_ID" --codec H264 --relay
```

Click **Start native display capture** locally. The fixture requests Screen
Recording through macOS; denial stops before any capture or media-engine creation.
If needed, add the generated App in System Settings → Privacy & Security → Screen
& System Audio Recording, then restart it. Do not reset TCC or reuse another
App's identity/permission. The fixture covers the selected display with its own
native rendered clock, frame count, moving bar and color patches during capture;
this isolates test content. It still captures compositor display pixels through
SCStream, rather than generating raw test frames for the encoder. Do not switch
the selected display to private content during the run.

Alternatively add `--picker` on macOS 15.2+. It presents Apple's system picker
with only single-display selection allowed; its returned includedDisplays must
contain exactly the explicit display ID. This grants only the selected runtime
capture and does not require the persistent TCC grant. A different selection,
cancel or picker failure starts no capture. Selecting that screen is still a
local consent step. This path does not establish unattended capture; report it
separately from the persistent-permission source. The 60-second limit begins
when a media handle starts, not while waiting for the user in the picker.

Omit `--relay` for normal ICE; `--codec VP8` selects software-codec comparison.
`RD_PROBE_ENCODER=videotoolbox` requests the SDK's VideoToolbox backend for H.264;
`RD_PROBE_ENCODER=software` requests software explicitly. These are preferences,
not proof: the SDK can fall back. Always record actual encoderImplementation.
The fixture uses GatherOnce because it publishes a fully gathered offer without
trickle ICE; the SDK's GatherContinually default does not reach Complete.
Forced relay must also be present in the receiver policy and in its actually
selected candidate pair; ICE connected or a declared capability is insufficient.
TURN TCP means client↔TURN TCP, with UDP relay sockets. TLS and P2P need their
own evidence. A receiver rebuilt by rotation/restart must consume a fresh run;
old answer queries carry runId and cannot bind to a newer offer.

`--engine-smoke` is an optional negative check that creates the native media
factory without OS capture and verifies the no-native-frame timeout closes it.
It must leave the signaling offer empty and cannot count as a screen/media test.

## Scope, lifetime and measurements

- Explicit display only; no window-capture fallback or modification to Computer
  Use. Output width 1280, aspect-preserving even height, up to 15 fps, NV12,
  ScreenCaptureKit queueDepth 3, no audio/microphone.
- One video send-only track and one reliable ordered `rd` DataChannel. Sender
  bitrate capped at 350 kbps for the 3 Mbps trial server; runs stop at 60 seconds.
- Publish only after a complete native sample. NativeVideoSource's startup black
  keepalive is not counted as source success. Discard non-complete SCStream frames.
- Swift lends a valid CVPixelBuffer synchronously. webrtc-sys 0.3.49's ObjC bridge
  consumes a retain; Rust gives it a separate +1, while SCStream keeps its own.
  The encoder retains its wrapped frame; no pixel/base64 copies cross the phone
  bridge. Re-audit this ownership if upgrading the SDK.
- Stop clears the capture-queue handle, drains callbacks, stops SCStream, closes
  DataChannel/PC, drops the source and shuts down the isolated Tokio runtime.
  Native stream errors also clean up. Capture/ICE/answer startup timeouts fail
  explicitly. This fixture's cleanup is not the product input watchdog.
- Save sanitized native frame counts, framesEncoded, encode time, encoder name,
  bytes and DataChannel echo RTT beside real ArkWeb decoded/presented counters
  and selected candidate types. Never save full SDP, TURN credentials or screen
  payloads in logs. Dedicated test-content screenshots remain local ignored
  evidence. Echo RTT is not capture-to-display or interaction latency.

After runs, verify native process exit, capture/PC/source release and TURN budget;
allocation cleanup can lag PC close. Return the phone to ordinary EntryAbility,
remove only the dedicated hdc reverse, close signaling and stop idle trial TURN
with its UID firewall rule, using the parent deployment runbook. Keep the old
Relay and account data intact. Real permission revocation, prolonged stability,
native engine/codec/architecture matrix and packaging are separate evidence.
