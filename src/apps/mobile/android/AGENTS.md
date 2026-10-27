# Android App Guide

This directory owns the native Android application and is an independent
Gradle build root over `../shared`.

## Java Runtime

Use the JetBrains Runtime bundled with Android Studio. The system `java`
launcher may exist without a configured macOS Java runtime, so do not rely on
it for Gradle commands in this directory.

```bash
export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
"$JAVA_HOME/bin/java" -version
```

Android Studio uses the standard macOS SDK location `~/Library/Android/sdk`.
Export that location once so commands do not bake a machine-specific absolute
home directory into repository documentation:

```bash
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
"$ANDROID_SDK_ROOT/platform-tools/adb" devices
```

For a one-off command, keep the runtime selection local to that process:

```bash
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew :app:assembleDebug
```

## Focused Verification

Run commands from `src/apps/mobile/android` unless a command says otherwise.

```bash
# Compile the Android app.
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew :app:assembleDebug

# Run Android host tests.
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew :app:testDebugUnitTest

# Run instrumentation tests on an attached emulator or device.
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew :app:connectedDebugAndroidTest

# Verify notification onboarding persistence and existing grants.
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.openbitfun.mobile.app.NotificationOnboardingTest

# Verify negotiated execution modes and legacy fallback on an emulator.
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.openbitfun.mobile.app.HarnessProfileMenuTest

# Verify running-input, plan gating, offline tools, and attachment retention.
./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.openbitfun.mobile.app.MobileParityTest

# Verify terminal WebView focus and native keyboard routing inside the dialog.
./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.openbitfun.mobile.app.RuntimeTerminalViewTest

# Verify desktop selection, explicit control, lifecycle, and compact/wide presentation.
./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.openbitfun.mobile.app.RemoteDesktopScreenTest

# From the repository root: probe Android WebView with a separate Chrome sender.
node scripts/test-remote-desktop-android-media.mjs --serial "$ANDROID_SERIAL"

# From the repository root: integrate the production account factory/store and
# native page with synthetic authentication/desktop and short-lived real TURN.
node scripts/test-remote-desktop-android-account.mjs --serial "$ANDROID_SERIAL" --ice-config "$PRIVATE_ICE_CONFIG"

# Focus only the new native IME -> ordered DC case; this is one case, not the full suite.
node scripts/test-remote-desktop-android-account.mjs --serial "$ANDROID_SERIAL" --ice-config "$PRIVATE_ICE_CONFIG" --keyboard-only

# Real Gboard touches -> native controller -> generated sender over forced TURN.
node scripts/test-remote-desktop-android-account.mjs --serial "$ANDROID_SERIAL" --ice-config "$PRIVATE_ICE_CONFIG" --actual-ime-only

# Direct touch classification and native execution/focus boundary.
./gradlew :app:testDebugUnitTest --tests '*RemoteDesktopGesturePolicyTest'
./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.openbitfun.mobile.app.RemoteDesktopControlBridgeTest

# From the repository root: native gestures -> ordered DC, generated video and real TURN.
node scripts/test-remote-desktop-android-account.mjs --serial "$ANDROID_SERIAL" --ice-config "$PRIVATE_ICE_CONFIG" --gestures-only

# Native IME composition/cancellation, stale callbacks and actual keyboard insets.
./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.openbitfun.mobile.app.RemoteDesktopKeyboardTest

# Run shared JVM tests after core-feature changes.
cd ../shared
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew jvmTest
```

Use the narrowest command covering the changed behavior. Keep credentials,
keystores, signing values, device identifiers, and local SDK paths out of the
repository.

The remote-desktop media runner requires the dedicated
`BitFun_RemoteDesktop_Probe` AVD. The production APK packages only the three shared
receiver files under `assets/remote-desktop/`; the generated asset task uses the
AGP Variant API and preserves the terminal's root assets. `RemoteDesktopWebView`
loads one intercepted secure-origin document, refuses external resources,
file/content access, storage and media permissions, and exposes only typed
`core-feature` media/control events. It starts viewing without a lease. The Compose adapter
binds one store for its lifetime and collects media with Main.immediate so null
retires visible pixels before asynchronous cleanup. The page owner closes the
store on exit/background; layout changes within the same composition retain the
view. `RemoteDesktopScreen` owns the native page, explicit screen selection and
back/stop behavior. Its lifecycle opens once when started, closes on stop or
disposal, and requires explicit reconnect after returning. AccountStore must
supply its fixed-device store; presentation never changes the chat target.
Negotiated pause fences callbacks but retains the WebView until the host
confirms suspended; keep the view mounted during `Suspending`. Resume appears
only after drain completes, retains the attachment and requires a new
connection/renderer/frame. Each new PC gets a fresh native document even if
Compose coalesces transition states; ordinary layout changes retain the view.
The readiness callback also reconciles an already-ready document with the store.
Disconnect and background still close immediately.
The pause action remains available while suspending/resuming, so a manual pause
can cancel automatic credential recovery without cancelling an in-flight host
mutation or showing its new PC.
`RemoteDesktopScreenTest` uses synthetic UiState/Intent and a native lifecycle
registry, not a real account or renderer. Its compact/wide cases use constrained
native viewports and enlarged text, not physical rotation/fold acceptance.

The runner exercises this production adapter with a separate generated-video
sender. Its four required, non-skipped cases check actual native pixels,
ordered DataChannel health, stop/restart source binding, permission denial and
navigation failure/retired callbacks and same-origin reload refusal. Append `--ice-config` with a private JSON
file containing short-lived `ice_servers` and `force_relay` to test TURN;
optional `profiles` keyed by `first`, `old`, `new`, and `navigation` keep each
source and failure case separate. The restart case closes its independent
sender after asserting receiver teardown, before creating the next source.
Credentials stay out of the repository. Signaling is an authenticated
ADB reverse using the existing debug-only loopback HTTP allowance. Direct
instrumentation without fixture arguments explicitly skips these integration
cases. This is not account routing, public HTTPS, native desktop capture,
physical-phone or OS input acceptance. The account device picker exposes an
independent view-only desktop entry using the shared policy; the host probe and
local grant remain authoritative. `AccountViewModel` owns that destination
without changing chat selection. Explicit reconnect asks AccountStore for a new
store; it waits for the previous attach/detach before opening a channel and
refuses background or retired account owners. Also run `RuntimeTerminalViewTest` after asset
packaging changes to cover the retained terminal assets.

The account/media runner uses the same dedicated AVD and generated sender. Its
nine required non-skipped cases exercise the real public account factory,
X25519/AES-GCM, OkHttp/Socket.IO, fixed target setup, native page/video,
same-attachment pause/resume, automatic credential rebuild, explicit fresh-store
reconnect and detach. Paused display selection refreshes a two-source directory,
checks the current marker and cancel, then requires the other source's different
dimensions and yellow/cyan pixels over a new connection/renderer, preserving
the attachment and relay policy. Discovery must have no outer attachment;
selection and resume use their own fresh CAS. This is generated multi-source
evidence, not two physical monitors. The renewal case shortens only the synthetic host-reported
budget after first presentation; real short-lived TURN credentials are retained.
It requires new connection/renderer, authenticated channel binding, native video
pixels and relay/relay again, without another attach. It does not measure actual
TURN expiration or long-duration renewal. The
synthetic host reports source readiness only after the current channel bind and
encoded frames. A denied synthetic view grant must not
enumerate displays, attach or request TURN. Authentication and host replies are
test-only loopback fixtures; there is no production login bypass, real account
service, macOS capture, phone or OS input acceptance. The test signs out its own
ephemeral emulator account. It never clones an existing device identity or grant.

The two control cases use synthetic grants and an in-memory input sink. A native
tap sends one normalized left-button down/up pair; black bars and viewing mode
send none. A native dialog steals window focus while JS input is queued: the
execution-time native predicate must reject it and release the lease. Returning
focus or rebuilding the PC must remain viewing until another explicit acquire.
Denied control keeps video visible without pointer input. These cases exercise
the production Compose/WebView/core-feature bridge, not a physical Android
phone, native desktop injection or real local device approval.

`RemoteDesktopControlBridge` owns only the native focus, gesture and JS-execution
boundary. The portable store owns intent admission; bundled JS owns wire leases,
ACK deadlines and renewal. Readiness requires the host capability, the receiver's
`control_epoch_v1`, valid frame geometry and a delivered delegated-focus reply.
Reports carry the epoch stamped when JS creates the event; this app-local field
never enters DataChannel input. Native commands have a bounded eight-entry
execution ledger and a two-second completion deadline; pressure/unknown delivery
closes the PC rather than dropping/retrying input. Focus loss retires local
authority before queued scripts run, and release is still permitted for cleanup.
Confirmed IME text uses negotiated `text_commit_v1`; absent support disables the
keyboard and explains the limitation while special keys remain available.
`RemoteDesktopKeyboardView` owns a native input connection with local preedit
only. Confirmed commits go directly to the captured remote lease, never a draft
or local send button. Finish/hide/close discard unconfirmed composition; late
callbacks, hidden IME and lost focus cannot send. The portable text-intent helper
owns the 4096-byte UTF-8/NUL/surrogate rules. Paired editing/navigation key taps
reuse the existing native execution predicate and JS controller. There is no
remote text mirror, clipboard read, raw held modifier or inferred range edit;
unsupported multi-character deletion requests return false.

`RemoteDesktopGesturePolicy` owns native direct-touch classification and local
zoom geometry without Android APIs or timers. Long press is a right click;
double-tap and hold/move starts a left-button drag. Two parallel fingers lock to
remote wheel, pinch locks to local zoom (1–3x); neither can change kind after
classification. Letterbox bars cannot start remote input. A transformed native
WebView receives inverse-mapped touch coordinates; controls stay outside its
clipped parent. Cancel, viewport/source change, extra fingers and focus loss
release a held drag's original lease. Returning focus never restores control.
Only adjacent pointer moves coalesce for one frame in the native bridge; button,
key and wheel edges retain order and the execution-time lease/focus predicate.
A retired/disposed view cannot release a successor's control state.

`--gestures-only` requires one executed, non-skipped account/media case: actual
native touch events, right-button pairs, drag/move/up, wheel, local pinch and
inverse-mapped click, followed by drag cancellation and an empty memory held
ledger. Compact and wide launch configurations use contain geometry separately;
a wide video's sidebars are not part of its source width. The fixture uses
synthetic grants and a generated source over forced TURN; this does not prove
native desktop button cleanup, physical Android, live rotation/folding or OS
double-click interpretation. Mouse mode, drag lock and an explicit canvas-pan
tool remain pending on Android.

The local proxy knows neither the remote cursor position nor its sentence/case
context. Initialize only the empty local selection, return no inferred cursor
caps mode, and reset local selection after commit/cancel. Explicit uppercase
commits remain unchanged. The native keyboard filter covers this after setting
the local selection to zero; the stock BaseInputConnection otherwise reports a
word/sentence capitalization mode from that empty local buffer.

The keyboard integration case submits fixed confirmed Unicode/ASCII text through
the actual Android InputConnection and checks text matches plus paired
Backspace/Enter at the generated sender. The source retains only fixed test
match flags and key summaries in diagnostics, never text transcripts. This is
programmatic input-connection evidence, not manual Chinese candidate selection
or physical-phone/macOS input acceptance. `--keyboard-only` requires exactly one
executed, non-skipped case and labels the narrower evidence explicitly.
Native keyboard layout checks use the production edge-to-edge/adjustResize
window contract. Check compact light and wide dark with actual IME insets,
visible media, fixed stop/hide controls, scrollable special keys and system Back.
Display overrides between test launches do not prove live rotation/folding.

`--actual-ime-only` executes one strict case using actual Gboard touches without
replacing its framework-created InputConnection. The test-only Gboard driver
requires the dedicated AVD, reads keys only from the Gboard IME window, waits for
onscreen geometry to settle, injects one touch pair and restores accessibility
flags on exit. It checks lowercase letters, explicit Shift uppercase and paired
Backspace/Enter at the generated sender. Two alternating native video colors
must remain visible above the open IME. This Gboard prerequisite belongs to the
probe; production is not tied to one keyboard vendor. Record the installed
keyboard/OS version and keep programmatic versus real-touch results distinct.
The focused result never advertises the whole nine-case suite as executed.
Account fixture diagnostics retain bounded input counts, lease/request counts
and refusal classifications; no committed text is written to these traces.

Keep real TURN quota refusal as a failed integration case, with its closed ICE
diagnostic code. Concurrent manual trials can consume the same server budget;
do not raise quotas, stop another trial, replay bind or reclassify the case as a
skip to get a passing run. Native PC closure and TURN allocation reclamation are
different observations. The raw restart case creates a new WebView document,
matching production, and checks that retired callbacks cannot revive it.

The allowed document's epoch is established before loadUrl, never advanced by
onPageStarted: JS bridge calls and navigation callbacks run on different threads.
A reload still retires the document; document messages and media events retain
their disposal and renderer/attachment/connection fences. Renderer failures log
only fixed stages and booleans. The raw runner also saves XML and sanitized
native diagnostics on failure, including channel/PC/SCTP state and buffered bytes
around bind. Renderer failures use closed local stage/reason categories; they
must not log credentials, SDP, arbitrary console strings or event payloads.

Paused display selection keeps cancel in the fixed header, reachable in compact
and wide layouts without scrolling the catalog. Text actions use onSurface for
legibility in both themes. To export synthetic native layout captures, rerun
only the relevant screen test with
`-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true`, pull its
`getExternalFilesDir` PNGs from the dedicated emulator, then restore normal
instrumentation cleanup. Do not use this workflow on a manual-test phone.

Run instrumented Gradle tests on a dedicated test emulator, not an authenticated
manual-acceptance device. The test runner can uninstall the target application
after the suite and remove its local account state. Use `adb install -r` for
manual acceptance updates to preserve that state.
