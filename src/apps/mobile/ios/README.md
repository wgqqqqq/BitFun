# OpenBitFun iOS

Native SwiftUI client for local and remote conversations, account device connection,
workspace and session management, approvals, attachments, and file previews.
It follows the HarmonyOS reference geometry: 76pt conversation header, 44pt
circle controls, 16pt content margins, the 48pt connection strip, and the
floating composer with 52pt collapsed height.

## Project layout

- `OpenBitFun/App/`: lifecycle, launch configuration, and composition root.
- `OpenBitFun/Features/Chat/`: conversation home, header, timeline bubbles, and composer.
- `OpenBitFun/Features/Remote/`: remote conversation home surfaces.
- `OpenBitFun/Features/Settings/`: app settings composition and reusable settings cards.
- `OpenBitFun/Features/Account/`: sign-in step, account device picker, and inline account sections embedded in settings.
- `OpenBitFun/Features/Shell/`: theme tokens, drawer, shell layout, and remote supporting surfaces.
- `OpenBitFun/Infrastructure/`: observable state, failure copy, and platform adapters.
- `OpenBitFun/Presentation/Models/`: SwiftUI-facing presentation DTOs.
- `OpenBitFun/Resources.xcassets/`: app icon and future native assets.

## Build and run

The repository does not change the machine-wide developer directory. Use the
Xcode copy in `~/Downloads` when it is the compatible version:

```bash
export DEVELOPER_DIR="$HOME/Downloads/Xcode.app/Contents/Developer"
"$DEVELOPER_DIR/usr/bin/xcodebuild" \
  -project OpenBitFun.xcodeproj -scheme OpenBitFun \
  -destination 'platform=iOS Simulator,id=1D7E5AA6-1AE9-4CAB-966B-A83B5F113B4A' \
  -derivedDataPath /tmp/OpenBitFun-iOS-Derived \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
```

`MobileAppModel` is kept in `Infrastructure` so the SwiftUI views do not know
about transport or persistence. Local chat, pairing, and remote session state
are supplied by the generated `OpenBitFunMobileCore` framework from
`src/apps/mobile/shared/core-feature`; SwiftUI only maps the typed state to its
presentation model. Desktops are connected through the signed-in account's
device list; there is no QR scanner or manual link entry. Connections paired by
older builds stay readable, reconnectable, and disconnectable.

Run the platform-independent Swift infrastructure checks through the registered
focused entry point. It compiles production helpers together with their local
test executables; test mains are not part of the app target:

```bash
export DEVELOPER_DIR="$HOME/Downloads/Xcode.app/Contents/Developer"
./Testing/run-pure-swift-tests.sh
```

After changing shared Kotlin code, regenerate the framework with the same compatible
toolchain before building the Xcode project. Xcode links the existing XCFramework;
its build does not rebuild Kotlin. Compiling a Kotlin target alone also does not
update the XCFramework consumed by this app:

```bash
export JAVA_HOME="/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
export DEVELOPER_DIR="$HOME/Downloads/Xcode.app/Contents/Developer"
cd ../shared
./gradlew :core-feature:assembleOpenBitFunMobileCoreDebugXCFramework
```

The shell includes both product surfaces already: Local opens the HarmonyOS
welcome prompts, Remote has the disconnected desktop state and connection
action, and the unified drawer mirrors the HarmonyOS recent-chat, device,
workspace, chat, and settings sections. A connected preview exposes the
remote empty home through the same conversation chrome.

For repeatable simulator captures, pass `--remote`, `--connected`, `--drawer`,
`--settings`, `--remote-settings`, `--remote-view-settings`, `--remote-view-density`, `--model-settings`, `--composer-model-picker`, `--device-picker` (legacy aliases `--pairing`, `--pairing-account`), `--remote-create`, `--remote-create-workspace-picker`, `--remote-chat-section`, `--project-create-menu`, `--file-preview`, `--plan-preview`, `--session-actions`, `--sidebar-actions`, `--local-actions`, and/or
`--account-login` or `--account-profile` after the bundle identifier in `simctl launch`. The local
actions flag can be combined with the session-actions flag; the account-login
flag opens a deterministic signed-out surface without storing credentials, and
the account-profile flag opens Settings with a signed-in preview account inline.
`--remote-settings` is an alias that opens the same single Settings page on the
Remote surface; the permission mode section lives there. These launch flags
select deterministic inspection states; normal launches use the live KMP
pairing/session stores.

Hosts advertising `harness_profiles_v1` expose Minimal, Standard, and Ultimate
execution modes; older hosts retain Code and Cowork. Use `--connected --drawer
--harness-preview --project-create-menu` to inspect the supported-host menu.
Task completion notifications use a bounded iOS background task; they do not
guarantee delivery after process termination. See the mobile README parity table.

To verify that skipping notification onboarding survives restart, run this on a
fresh simulator installation with undecided notification authorization:

```bash
xcodebuild -project OpenBitFun.xcodeproj -scheme OpenBitFun \
  -destination 'platform=iOS Simulator,name=Notification Onboarding QA' \
  -only-testing:OpenBitFunUITests/NotificationOnboardingUITests test
```

For the sidebar's New Chat menu and compact/wide scrolling checks, use the same
command with `-only-testing:OpenBitFunUITests/SidebarNavigationUITests` instead.
This suite uses deterministic remote preview data and does not create host sessions.

Use `-only-testing:OpenBitFunUITests/GitHubLoginPresentationUITests` on a signed-out
simulator to check the compact login sheet and automatic authorization-browser
handoff. This check needs the configured relay's login endpoint and opens Safari;
it does not submit GitHub credentials or approve account access.

For offline parity regression, use `-only-testing:OpenBitFunUITests/MobileParityUITests`.
It exercises language switching, numbered file previews, plan capability gating,
and all three bundled Mini Apps using isolated preview data. No host command is sent.
The Mini App resource build phase requires Node.js on PATH.

For next-input suggestions, run the simulator suite with
`-only-testing:OpenBitFunUITests/PromptSuggestionUITests` on a phone and an iPad.
The Debug-only `--prompt-suggestion-preview` launch flag uses an isolated host
hint with the production composer; acceptance must preserve its whitespace,
focus the editor and leave the text unsent. It does not contact a remote host.

The MiniApp build phase generates resources directly into the app bundle, so
incremental builds include CSS and script edits without relying on a folder
reference's timestamp. `miniapps.css` owns iOS font-family adaptations; the iframe
sandbox and network restrictions remain in the shared document wrapper.

The Mini App gallery follows the HarmonyOS full-page surface: a 56pt back/title
bar, an offline header, and square preview tiles in two columns (three from
600pt). The `miniapp-*.imageset` previews are PNG projections of HarmonyOS
`miniapp_*_preview.webp` assets; retain their original artwork and center-crop
them in the native view. App pages display their own name in the same header.

## Remote desktop

The account device picker has an independent Remote desktop action for online
desktops; it uses the shared device-kind policy and capability probe. It does
not change the chat target. The native page provides explicit display selection,
relay policy, pause/resume, paused display selection and reconnect through the
existing KMP store. Supported hosts expose explicit enable/stop control and
letterbox-aware left-button taps. Hosts with `text_commit_v1` also expose an
explicit native keyboard with paired editing/navigation keys. Advanced gestures
remain pending.

`Features/RemoteDesktop/RemoteDesktopModel.swift` owns presentation and lifecycle;
`RemoteDesktopReceiver.swift` owns one WKWebView document. The app packages exactly
`index.html`, `control.js` and `receiver.js` from `src/shared/remote-desktop-media`.
The receiver uses a nonpersistent data store and the bundled file directory only,
requires a secure context and RTCPeerConnection at runtime, rejects navigation,
reload, popups and media-capture permission, and exposes no account API. The optional `RemoteDesktopControlBridge` maps typed
KMP renderer intents onto the existing JS controller; it owns neither wire leases
nor host authorization. `RemoteDesktopWebView` supplies native window/foreground
focus and viewport facts. Each new connection mounts a new document. Background/inactive/exit closes the
local receiver synchronously, closes the store and requires explicit reconnect.

Regenerate the current XCFramework using the command above before compiling.
For an Apple Silicon simulator, restrict the architecture to the framework's
actual target rather than asking a generic destination to build x86_64 too:

```bash
xcodebuild -project OpenBitFun.xcodeproj -scheme OpenBitFun \
  -destination 'generic/platform=iOS Simulator' -sdk iphonesimulator ARCHS=arm64 \
  -derivedDataPath "$IOS_RD_DERIVED" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build-for-testing
```

Use a dedicated simulator named `OpenBitFun Remote Desktop Probe`. With fresh,
private short-lived ICE profiles, run from the repository root:

```bash
node scripts/test-remote-desktop-ios-media.mjs --simulator "$IOS_SIMULATOR_UDID" \
  --ice-config "$PRIVATE_ICE_CONFIG" --products "$IOS_RD_DERIVED/Build/Products"
```

The runner requires two executed, non-skipped native cases: both alternating
video colors, real ordered DC health, relay/relay, stop, media permission denial
and external navigation refusal. Navigation must close the native channel before
the generated sender is cleaned up. It uses a simulator-only Debug launch path,
ephemeral authenticated loopback fixture and generated source, with no account,
Mac capture, host grant or OS input. It removes its temporary test configuration;
private result bundles can still contain short-lived test metadata.

The account/media path also needs the simulator's application identity
entitlement for real Keychain IO. Use the locally signed build above;
`CODE_SIGNING_ALLOWED=NO` can run a media-only page but fails account setup with
`SECURE_STORAGE`. Do not replace the Keychain or reset records to work around it.

Run the separate public-account-factory integration from the repository root:

```bash
node scripts/test-remote-desktop-ios-account.mjs --simulator "$IOS_SIMULATOR_UDID" \
  --ice-config "$PRIVATE_ICE_CONFIG" --products "$IOS_RD_DERIVED/Build/Products"
```

Its eleven strict cases use actual Keychain, X25519/AES-GCM, Darwin HTTP/WebSocket,
the KMP account/setup stores and the product page. The same neutral
`account-desktop-fixture.mjs` serves Android and iOS; authentication and host
responses remain synthetic. Cases check forced TURN/current native pixels,
same-attachment pause/display selection with a new PC, fresh explicit reopen,
background close and view-only return, unchanged chat target, denied view before
allocation, detach and an account socket retained until sign-out. Control cases
also check explicit acquire/stop, native taps excluding black bars, serialized
button pairs under rapid submission, denied control retaining video, and actual
WK work queued before a native window takes focus. Native boundary checks reject
duplicate/out-of-order/old/expired requests and bounded-queue overflow. Paused
source replacement returns to viewing; background ends an active control lease.
Keyboard cases cover actual on-screen English keys through the media/controller
path, paired Backspace/Enter, keyboard removal on stop, and a hide/rotate/reopen
sequence retaining the attachment and PC. A separate UIKit test drives preedit
APIs, confirmed Unicode, local composition cancellation and old-editor callbacks;
it does not itself exercise a candidate picker. A third keyboard case chooses
Simplified Pinyin through the OS keyboard menu, types preedit, deletes locally,
selects the actual candidate, and checks one confirmed Unicode commit. Actual
system Delete/Return produce paired remote keys after confirmation; hiding new
preedit emits nothing. English tests also select their input method explicitly,
so a previous Chinese test cannot change their meaning. Keyboard cases require
English (US) and Simplified Pinyin installed in the dedicated simulator; missing
layouts fail explicitly rather than falling back to inserted test text.
The simulator's first-use
QuickPath introduction is completed before typing, with no replay of input.
`--smoke-only` executes one account/media case, `--control-only` selects four
control cases, `--keyboard-only` selects the three keyboard cases, and
`--only-test <method-name>` runs one allowlisted case. Each
result lists exactly the cases executed and cannot stand in for the full suite.

For independent test controllers, a private ICE file can include `test_sessions`:
one full `{expires_at, profiles: {first, old, new, navigation}}` object per case,
with distinct short-lived REST usernames across all profiles. The top-level
profiles remain compatible with the raw media runner. The fixture consumes one
session on reset instead of sharing a per-user TURN quota across test accounts;
it does not change server quotas or mint credentials locally. Profiles must
cover the selected batch plus the client's 60-second expiry margin. The full
suite uses the existing Relay's 5–10-minute credential contract; this is not a
server-policy change or an expiry-test override.

The shipped WK bootstrap's ordering, native refusal, reply failure and receiver
failure paths also have four pure JS checks (no WebKit, media or OS input):

```bash
node --test scripts/remote-desktop/ios-control-bootstrap.test.mjs
```

Each native command has a bounded two-second monotonic deadline and an opaque,
one-use ID. WK serializes whole commands and asks the native reply handler to
recheck each body against the actual KMP snapshot, binding, lease and native focus
before admission. This prevents delayed requests from borrowing new authority;
an already-admitted body remains in flight. Unknown bridge completion closes the
PC without replay. Focus loss releases control; return requires explicit acquire.
Initial null media means not prepared; an actual media-to-null transition retires
the document immediately. A closed/missing renderer fails the exact binding
rather than silently dropping a control effect.

`RemoteDesktopKeyboardView.swift` owns a native UITextView IME destination, not
a local draft or remote-text mirror. The visible controls stay in SwiftUI. Each
explicit opening captures its original binding/epoch/generation and a native
lifecycle token; closing invalidates that token synchronously before UIKit can
unmark text during resignation. Every callback also checks the actual KMP
snapshot, first responder, key window and application activity. Retired editors
cannot borrow new authority. Confirmed text uses the shared Unicode validator;
preedit stays local, and Backspace edits preedit locally before targeting the
remote caret. Clipboard and local text history are not exposed. Compact-height
keyboard chrome combines the toolbar and control dock into one row, leaving at
least half the remaining height for the desktop in the dedicated phone check.

These results are not real account-service, local host approval, Mac capture,
physical iPhone/iPad, native input or long-duration renewal acceptance.

Run `-only-testing:OpenBitFunUITests/RemoteDesktopLayoutUITests` with
`test-without-building` against the same products to check compact portrait and
wide landscape chrome, fixed cancel/current marker, display choice and explicit
reconnect, plus enable/stop dock and keyboard-toolbar reachability and a minimum
44-point touch target.
These are separate launch configurations with fixture state. They do
not prove live connection rotation, a physical phone/iPad, real account routing,
long-duration renewal or OS input. Use full-screen `XCUIScreen` captures for
landscape QA; app-only screenshot cropping may carry misleading orientation
metadata even when the native window geometry is correct.
