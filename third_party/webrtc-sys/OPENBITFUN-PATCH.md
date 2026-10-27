# Native SDK diagnostic privacy and received-channel properties

Source: crates.io `webrtc-sys` 0.3.49 from LiveKit rust-sdks revision
`49b3ebe9ab1c574114b164868ad226cc26a9b1be`, package path `webrtc-sys`.
The upstream source, native headers, build files, attribution and licenses in
`NOTICE.md` are retained. Cargo's local installation marker, nested lockfile and
upstream developer-local `compile_flags.txt` are omitted. The latter contains
absolute editor paths and is not read by the Cargo build script. This patch does not rebuild or change the pinned WebRTC engine
archive; the existing `webrtc-sys-build` resolver and Desktop artifact hash
verification remain in effect.

The diagnostic change is the native LogSink subscription in `src/webrtc.cpp`:
use `LS_WARNING` instead of `LS_VERBOSE`. WebRTC's verbose logging enables its
`TextPcapPacketObserver`, which writes decrypted SCTP packets directly to process
output. Filtering Rust's `libwebrtc` target does not prevent that observer from
being constructed. DataChannel payloads can contain remote keyboard text and
must not become debug transcripts. SDK warning/error events still reach the
existing Rust callback; this patch does not alter its upstream severity mapping.
The `data_channel` C++ / cxx bridge also exposes an immutable reliability
snapshot: ordered delivery and optional packet-lifetime / retransmission
limits read from the actual native channel. Presence bits preserve a zero
limit. The safe forwarding API and focused native checks are documented in
[libwebrtc's patch note](../libwebrtc/OPENBITFUN-PATCH.md). There are no new
handles, observers or back-references. No protocol, codec, transport, factory
or native ownership behavior is changed.
The resolved dependency audit requires this local version while media is enabled,
so a newer registry package cannot silently bypass the patch during an update.

Run the transport privacy regression from the repository root:

```sh
node scripts/test-remote-desktop-log-privacy.mjs
```

It creates two real native PeerConnections, delivers fixed private text to an
in-memory input sink and a fixed result back, and checks both stdout and stderr
for packet dumps, literal canaries and their hexadecimal encoding. It never
captures the screen, requests a lease, instantiates an OS input provider, or
uses an account/TURN server. `OPENBITFUN_TEST_BINARY` may select an already-built
current Desktop library test binary. Run this check after SDK/pin updates;
normal Rust log filtering is not evidence of privacy. Native phone/media and
platform acceptance remain separate.

Remove the diagnostic change when the released SDK offers a non-verbose native sink by
default or a supported way to disable plaintext packet observation before any
PeerConnection is created. Update the resolved version/source guard at the same time and re-run the native
regression before removing it. Keep the override until the received-channel
properties are also available upstream and their native regression passes.
