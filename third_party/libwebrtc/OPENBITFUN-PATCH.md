# Native received-channel properties

Source: crates.io `libwebrtc` 0.3.52, LiveKit rust-sdks revision
`49b3ebe9ab1c574114b164868ad226cc26a9b1be`, package path `libwebrtc`.
The upstream source, normalized manifest, changelog, attribution and Apache-2.0
license are retained. Cargo's local installation marker and nested lockfile are
omitted. This copy uses the same pinned engine and local `webrtc-sys` package;
it does not rebuild or modify the WebRTC archive.

The only source additions are the native `DataChannelReliability` value and
`DataChannel::reliability()` in `src/data_channel.rs`, and its forwarding method
in `src/native/data_channel.rs`. They read ordered delivery and the optional
packet-lifetime / retransmission limits from the native received channel.
`Some(0)` remains distinct from `None`; neither a label nor the sender's claimed
configuration proves reliable ordered delivery. The method adds no observer,
callback, handle, timer, runtime owner, or protocol field. Existing API and
creation behavior are unchanged; the new API is native-only.

The Desktop consumer's focused native regression is:

```sh
cargo test --locked -p openbitfun-desktop --features remote-desktop-media --lib native_received_reliability_and_repeated_teardown
```

It reads properties from six kinds of real received channels, including zero
limits; repeats factory/connection use and cleanup; and exercises incomplete
initialization and invalid signaling. Linux additionally checks repeated
thread/FD counts against a warmed baseline. It uses no external ICE server,
account, screen capture or OS input, and does not establish product media or
authorization acceptance. Receiver rejection and real UI presentation require
separate adapter tests.

Remove this override when a released SDK exposes equivalent received-channel
facts. Update its dependency-source guard together with both wrapper patches,
then rerun native properties and diagnostic-privacy checks.
