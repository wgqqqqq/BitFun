# Native remote desktop media probe

Isolated macOS risk fixture, not a shipping Desktop capability. Its nested Cargo
workspace locks media dependencies without adding them to the product build.
Do not add account state, Agent sessions, OS input, or a production Tauri command.
The existing Computer Use window capture path must keep its scoped contract.

DisplayCapture.swift owns ScreenCaptureKit, explicit display selection, consent,
and main-thread native UI. Rust owns the independent PeerConnection and raw-frame
source. The narrow C ABI borrows one valid CVPixelBuffer during push; webrtc-sys
0.3.49 consumes a retain, so Rust adds a +1 before wrapping it. Drain capture
callbacks before releasing the opaque media handle. Do not remove these lifetime
rules based on an apparently successful short run.

Focused checks from this directory:

```sh
cargo test --locked --lib
node build.mjs
```

See [README.md](README.md) for native consent, same-device ArkWeb, forced TURN,
capture/encode/presentation evidence, and cleanup. A native permission denial or
successful build is not proof of media. Do not run the full Desktop build for this
standalone fixture. Format only its own Rust source; keep unrelated local OHOS
artifacts untouched. Run core boundaries after its Cargo/layout changes.
