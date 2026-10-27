# AGENTS.md

Native mobile applications are product entrypoints under `src/apps/mobile`.

## Boundaries

- Keep Android, iOS, and HarmonyOS lifecycle and platform API usage inside the
  corresponding platform directory.
- Keep reusable product logic platform-agnostic and expose it through stable
  contracts or adapters.
- Do not import implementation details from `src/apps/desktop` or
  `src/web-ui`.
- Treat remote workspace support as part of feature design. Gate unsupported
  behavior with a clear user-facing state.
- Keep credentials, signing files, provisioning profiles, device identifiers,
  and local SDK paths out of the repository.
- Add platform-specific build and verification commands here when a native
  toolchain is selected.

## Directory Ownership

| Directory | Ownership |
|---|---|
| `android/` | Android app, resources, lifecycle, and adapters |
| `ios/` | iOS app, resources, lifecycle, and adapters |
| `harmonyos/` | HarmonyOS app, resources, lifecycle, and adapters |
| `shared/` | Kotlin Multiplatform core: protocol, crypto, transport, persistence, domain, feature stores |
| `miniapps/` | Build-time packaging and isolated document bridge for product-owned offline tools; native storage and WebView lifecycle stay in each app |
| `design-system/` | HarmonyOS-derived mobile tokens, component contracts, deterministic preview scenarios, and the desktop comparison surface |

## Native UI Contract

HarmonyOS is the visual reference implementation. Stable colors, typography,
geometry, breakpoints, motion durations, component anatomy, and comparison
scenarios are recorded under `design-system/`; Android and iOS consume generated
native constants but continue to render with Compose and SwiftUI respectively.
Do not introduce a shared cross-platform renderer or make generated files the
source of truth.

- Change the HarmonyOS implementation and the source contract together when a
  stable visual fact changes.
- Run `pnpm run mobile:ui:generate` after contract changes and commit the
  generated native files.
- Run `pnpm run mobile:ui:check` before pushing to reject generated drift.
- Use `pnpm run mobile:ui:preview` for the local three-column HarmonyOS / Android
  / iOS comparison surface. Native captures belong under the documented
  `design-system/preview/snapshots/` convention and are local evidence unless a
  fixture is intentionally reviewed into the repository.
- Keep safe areas, keyboard behavior, accessibility, navigation gestures, and
  platform presentation primitives in each native app.

## Shared Core

`shared/` holds the Kotlin Multiplatform modules that `android/` and `ios/`
build on. `core-feature` is the platform seam: everything the apps see is a
UiState or an Intent declared there, and no module above it is visible to them.

- `android/` and `ios/` may depend on `shared/`. `shared/` must not depend on
  any platform directory, and `harmonyos/` and `shared/` do not depend on each
  other.
- `android/` is its own build root and pulls `shared/` in with
  `includeBuild("../shared")`, so the arrow points one way only: the app knows
  the shared build, never the reverse. That makes app dependencies read as
  coordinates — `implementation("com.openbitfun.mobile:core-feature")` — rather than
  `project(":core-feature")`. Both spellings are subject to the seam rule below.
- `core-feature` is the only shared module the apps may reference. Everything
  crossing that seam is a UiState or an Intent, never a repository or a DTO.
- `core-domain` is pure logic. Transport and persistence are adapters behind
  ports it declares, wired by `core-feature`.
- Shared code returns typed states, never localized display strings; the apps
  own all user-facing text.
- Remote session content is read on demand from the online desktop
  (`core-transport/.../HostStream.kt`, `read_stream` device RPC plus encrypted
  `host-stream-changed` hints). The relay stores none of it and the apps keep
  no relay stream replica: a `STREAM_EVENT_GAP` means the desktop restarted the
  stream and derived state must be dropped, and a host without `host_stream_v1`
  is surfaced as `RemoteSessionFailureReason.HOST_STREAM_UNSUPPORTED`, never
  probed with unknown commands. Do not reintroduce `relay_stream_*` tables.
- Run `pnpm run mobile:architecture` before pushing. It enforces the rules
  above, mirroring `pnpm run harmony:architecture`.
- Build and test from `shared/`: `./gradlew jvmTest` for host logic,
  `./gradlew assembleAndroidMain testAndroidHostTest` for Android, and
  `./gradlew compileKotlinIosSimulatorArm64` for iOS. Run iOS pure Swift
  infrastructure checks from the repository root with
  `(cd src/apps/mobile/ios && ./Testing/run-pure-swift-tests.sh)`.
  The isolated native streaming fixture (no remote requests) is covered by
  `xcodebuild -project src/apps/mobile/ios/OpenBitFun.xcodeproj -scheme OpenBitFun -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 16 Plus' -parallel-testing-enabled NO -only-testing:OpenBitFunUITests/StreamingPresentationUITests test`.
  Run it on one phone and one iPad destination when changing timeline layout,
  streaming reveal, keyboard dismissal, or history anchoring. The Debug-only
  launch argument `--streaming-regression` opens the same deterministic fixture.
  `local.properties` holds
  the local SDK path and is not committed.
- For the iOS remote-desktop receiver and native layout, use the focused
  build / simulator commands in `ios/README.md` → Remote desktop.
  The WKWebView probe uses generated media. The account runner adds the public
  iOS account factory, Keychain and encrypted transport against synthetic auth /
  host replies; use a locally signed simulator build. Keep real account-service,
  physical-phone and OS input acceptance separate.
- For account target selection and legacy device-kind compatibility, run from
  `shared/`:
  `./gradlew :core-feature:jvmTest --tests '*AccountDevicePolicyTest' --tests '*AccountStoreTest' --tests '*AccountDeviceLinkTest'`
  and
  `./gradlew :core-transport:jvmTest --tests '*CloudAccountClientTest.listDevicesOffersHostsAndDropsPhones'`.
  Use `:core-feature:testAndroidHostTest` with the same feature test filters for
  Android compilation and host-side regression coverage.
  These cover session host selection and DTO mapping; they do not prove native
  remote-desktop capture, rendering, or input on Android/iOS.
- For the dedicated remote-desktop Socket.IO lane, run from `shared/`:
  `./gradlew :core-transport:jvmTest --tests '*RemoteDesktopAccountChannelTest' --tests '*RemoteDesktopRpcWireTest' --tests '*RemoteDesktopRealtimeTest' --tests '*OkHttpRealtimeTest' --tests '*CloudAccountClientTest'`.
  Also run `:core-transport:testAndroidHostTest --tests '*RemoteDesktopAccountChannelTest' --tests '*RemoteDesktopRpcWireTest' --tests '*CloudAccountClientTest'`
  for Android compilation and common validation. The JVM socket fixture uses
  the actual OkHttp engine with a loopback Engine.IO/Socket.IO peer; it verifies
  fixed target/epoch, capability refusal, no bulk/fallback/replay, late ACKs,
  concurrent chat isolation and binding-only close. `CloudAccountClient` creates
  the encrypted channel after capability discovery; it pins the target key and
  socket epoch without borrowing the Agent key cache. Channel lifecycle/crypto,
  bounded no-redirect HTTP metadata, and pure scoped TURN validation have separate
  owners. Common tests cover actual encryption with mocked HTTP/socket peers,
  account/key changes, cancellation, late results and redaction. These tests are
  transport evidence, not an Android/iOS product entry, media, native-device or
  public-network acceptance. Keep the platform apps behind `core-feature`.
- For KMP remote-desktop discovery, attachment and read-only media state, run from `shared/`:
  `./gradlew :core-feature:jvmTest --tests '*RemoteDesktop*Test' --tests '*AccountRemoteDesktopTest' --tests '*AccountDevicePolicyTest' --tests '*AccountStoreTest' --tests '*AccountDeviceLinkTest'`
  and `:core-feature:testAndroidHostTest` with the same filters.
  `AccountStore` creates one explicit-target setup owner without changing chat
  selection. Background or retired account scopes cannot create an owner.
  Replacement waits for the old owner's attach/detach cleanup before opening its
  channel; a foreground page reconnect requests a fresh owner instead of reviving
  its invalidated store. The feature-local channel maps v1 host JSON into typed setup facts;
  the store owns state, fixed binding, close ordering and bounded cleanup.
  `RemoteDesktopMediaSession` owns one read-only PC's signaling/presentation
  evidence and 30-second Relay grace; `RemoteDesktopCredentialBudget` owns pure
  monotonic/wall deadlines. Read-only recovery requires a fresh binding with the
  same account object, target, pinned key and verified live host connection.
  It never replays attachment or input. Tests use a fake feature channel and
  actual host-shaped JSON. `Attached` is logical; `Viewing` also requires source,
  answer, actual presentation and forced-TURN evidence when requested.
  `RemoteDesktopSourceLifecycleTest` covers negotiated manual suspend/resume:
  retire old callbacks before the mutation, keep the PC until host suspension
  confirmation, wait for native drain, require a new connection and first frame.
  Uncertain mutations get one state read and no replay; close waits for both
  media and source work. Paused/draining attachments expire after 60 seconds and
  never resume automatically after a manual pause. Negotiated automatic credential
  renewal requires both source and credential-rebuild capabilities, a presented
  PC and live signaling. At the 60-second margin it reuses suspend/drain/resume,
  retaining the attachment but requiring a fresh connection/renderer/frame.
  A manual pause wins during suspend, drain or an already-sent resume; confirm
  the latter, then suspend its new PC without presenting it. Account retirement,
  close, source timeout and revoked authorization cannot restart media. New
  credentials with at most 60 seconds remaining fail rather than loop.
  Paused display choice refreshes the authorized catalog without an outer
  attachment; cancel retires its local read generation and leaves the original
  retention deadline intact. Select and resume each read a fresh CAS over the
  fixed attachment channel. Unknown selection ACKs get one confirmation read,
  never replay or fallback to the old display. Selection preserves the paused
  connection until resume creates a new one; old frames cannot satisfy it.
  `RemoteDesktopControlSession` owns only native-side intent admission and
  retirement; the bundled JS controller still owns lease requests, ACK deadlines,
  renewal and DC ordering. SetupStore exposes typed renderer intents through a
  bounded single-consumer queue and fails on pressure instead of dropping input.
  Host `ordered_control_v1` is insufficient: the exact renderer must signal
  ControlReady after implementing epoch-stamped reports and queued-input fencing.
  Stamp report epochs when JS creates the event, never when native receives it.
  Source/account/PC retirement clears local authority and pending renderer work;
  a resumed PC starts without native control readiness. Pure common tests cover
  known/unknown acquire, release crossing renewal, stale events after multiple
  leases, geometry changes, malformed grants and pressure. They are not native
  pointer, keyboard, focus or OS-input acceptance. Android sends ControlReady
  only after the current receiver advertises `control_epoch_v1`, presents valid
  geometry and completes a delegated native focus reply. Its native adapter
  supports explicit acquire/release, letterbox-aware taps and committed text /
  paired special keys; a synchronous
  read-only native predicate fences queued JS execution after focus/lease loss.
  Run the Android account/media runner in its local guide for actual emulator
  tap, keyboard and focus retirement evidence. Text requires `text_commit_v1`;
  the portable helper validates confirmed Unicode without replacing malformed
  surrogates, and editor callbacks retain their original authority. Physical OS
  input remains separate work; synthetic grants do not prove host authorization.
  The native adapter must stop its PC synchronously when media becomes null,
  fence all callbacks with renderer/attachment/connection identity, and keep
  account credentials out of its bundled receive-only page. These tests prove
  state behavior, not actual WebView, account media or platform UI acceptance.
- The Android app builds from `android/`: `./gradlew :app:assembleDebug` and
  `:app:installDebug`; release verification is `./gradlew :app:assembleRelease`.
  Release builds use the standard local Android debug keystore when formal
  signing credentials are absent; all four `OPENBITFUN_ANDROID_KEYSTORE`,
  `OPENBITFUN_ANDROID_KEYSTORE_PASSWORD`, `OPENBITFUN_ANDROID_KEY_ALIAS`, and
  `OPENBITFUN_ANDROID_KEY_PASSWORD` environment variables override it. Signing
  files and values must never be committed. AGP 9 compiles Kotlin itself — applying
  `org.jetbrains.kotlin.android` is an error, not a no-op, and
  `kotlin { jvmToolchain(...) }` is no longer available in an app module.
- Crypto and transport also run on a device: `./gradlew
  :core-crypto:connectedAndroidDeviceTest :core-transport:connectedAndroidDeviceTest`
  from `shared/`, with an emulator or handset attached. Those suites compile the
  same `commonTest` sources onto ART; they are not in CI, so run them by hand
  when touching either module.

## Remote capability ownership

For next-input suggestion replay, stale-turn retirement, host restart and session
isolation, run from `shared/` with the Android guide's Java runtime:
`./gradlew :core-feature:jvmTest --tests '*promptSuggestion*' --tests '*SessionRecordReplicaTest*'`.
These are simulated host streams, not evidence of a live remote connection.

Native mobile surfaces are controllers. Desktop and CLI own execution, files, terminals and SSH credentials. Mobile workspace selection may use only connections already saved on the controlled runtime; it must not create an SSH connection or instantiate another runtime. Carry the selected connection identity through every operation, and report missing identity instead of falling back to local files.

## Offline Mini Apps

Android preBuild and the iOS resource phase run `miniapps/generate.cjs` (Node.js
must be on PATH). Generated native HTML is ignored; update product-owned built-in
sources or the packaging owner, never the generated resources. Harmony retains
its existing native host and invokes the same generator without native wrappers.
Run `node --test src/apps/mobile/miniapps/*.test.cjs src/apps/mobile/harmonyos/miniapps/*.test.cjs`
from the repository root after bundle/bridge changes. Storage keys remain scoped
to an allowlisted app; retain unreadable records and surface the error.
