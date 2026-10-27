# HarmonyOS App Instructions

These rules apply to all changes under `src/apps/mobile/harmonyos`.

## Controller product boundary

Phone, tablet, and foldable entrypoints are remote controllers. They must not
instantiate a local Agent Runtime, model provider, local chat command owner, or
model configuration store. GitHub identity and the authenticated device directory
are the authority for selection and reconnect; QR data supplies only a device id.
Keep old persisted records readable and retained without activating legacy room
credentials or local execution. Compact and wide hosts enforce the same boundary.

Remote desktop uses an independent self-hosted device-pairing service, not the
GitHub account directory. Its endpoint and HUKS credential namespace stay
separate from account login; account replacement/logout must not retire that
connection. The phone still runs no local Agent Runtime. Desktop trust remains
local to the controlled computer and cannot be granted by phone enrollment.

For independent enrollment, retained credentials and late disconnect results,
run `node --test tools/tests/remote-desktop-service.test.cjs tools/tests/remote-desktop-i18n.test.cjs`.
These execute production endpoint/ViewModel code with platform storage and HTTP
fixtures; they do not prove native HUKS, ArkWeb, compact/wide layout or real input.

## MVVM Refactor Boundaries

This app has one `entry` module, so MVVM is the file-organization boundary for
the module. Keep the official responsibilities explicit:

- Model/services own data access, persistence, transport, and business logic;
  they do not import views or page components.
- Views own presentation and user input; they consume projected state and emit
  intents/events rather than calling services directly.
- ViewModels bridge services and views by owning feature state, projecting data,
  and handling intents. ViewModels must not import components.
- Shared conversation presentation DTOs (`ChatSurface`, `ChatComposerCapabilities`,
  `ConversationUiModels`) live in `pages/state/`. State must not import
  `pages/components`.

The following constraints are enforced incrementally by
`pnpm run harmony:architecture` (the runtime behavior checks remain in
`entry/src/test/ArchitectureUnit.test.ets`):

1. `services/**` must not import `../pages/`.
2. `pages/state/**` must not import `pages/components/`.
3. `pages/components/**` must not import `pages/viewmodel/`; imports of
   `pages/state/` and `pages/policy/` are allowed for observable state and pure
   policies.
4. The page dependency graph must remain acyclic; ViewModels must not depend on
   components.
5. Actions and Hooks use typed interfaces with object literals. Do not add
   position-dependent callback constructors.
6. New components use `@ComponentV2`; do not add V1 `@Component`, `@State`,
   `@Prop`, `@Link`, or `@Watch` declarations. `@BuilderParam` remains supported.
7. General Chat and Remote Chat shared observable fields belong to
   `pages/state/ConversationCoreState.ets`. Page-specific state objects compose
   that core and must not redeclare the shared `@Trace` fields.
8. Keep files focused by ownership, not by a hard line count. When a file
   starts mixing unrelated concerns, extract the new owner. Do not cram or
   flatten structure just to stay under a number.
9. Components must not import permission, scanner, input-method, or other
   side-effectful platform kits directly. Put platform lifecycle and error
   handling behind a service or a focused platform leaf component, then expose
   typed state and events to the presentation tree.
10. Long, unbounded timelines use `Repeat.virtualScroll()` with stable identity
    keys. V2 message rows must remain reusable, and mutable render content must
    not be embedded in the identity key.
11. CPU-bound native work must not execute synchronously on the ArkTS caller
    thread. Expose it through Node-API async work (or an equivalent TaskPool /
    Worker owner), return a Promise, and bound the ArkTS wait with an explicit
    timeout.
12. `ConversationView` consumes grouped presentation state/options and emits a
    typed `ConversationIntent`. Do not reintroduce one public parameter or event
    per projected field/action.

User-facing copy lives in `entry/src/main/ets/i18n`. Keep `zh-CN` and `en-US`
catalogs in key lockstep, use canonical locale ids, and route language changes
through `LocaleController`. Do not import Web UI or mobile-web locale catalogs.

The current local HarmonyOS verification loop is:

```bash
node --test tools/tests/*.test.cjs  # host stream paging/hints/restart gaps, catalog, terminal, identity checks
node --test miniapps/*.test.cjs  # bundled sources, browser bridge, and local storage compatibility
source scripts/ohos-env.sh
"$HVIGORW" --mode module -p product=default -p module=entry@default assembleHap --no-daemon
"$HVIGORW" --mode module -p module=entry@default -p ohos.test.type=LocalTest test --no-daemon
```

For window inset subscription lifecycle and late completion regressions, run
`node --test tools/tests/window-insets-lifecycle.test.cjs tools/tests/immersive-bottom.test.cjs`.
The lifecycle tests run the production service with deferred platform window
reads; device rotation and folding still require native verification.
The same test covers media-surface system icon ownership, theme changes while
the surface is open, and restoration on exit. Remote desktop uses the existing
dark media tokens in both app themes; keep its viewport, keyboard toolbar and
system bars readable together.

For ordered remote-desktop control and authenticated transport preparation, run
`node --test tools/tests/remote-desktop-control.test.cjs tools/tests/remote-desktop-realtime.test.cjs tools/tests/remote-desktop-controller.test.cjs`
for ordered control generations/renewal, redacted namespace refusal, exact Relay
origin-port options and opaque native display IDs. Native API 26 was exercised
against a private same-account trial Relay: encrypted capability probing reaches
the desktop and missing local grants are refused. This does not verify media or
input authority. Older API support for non-default Relay ports remains unproven;
do not weaken the server origin policy or append conflicting Origin headers.
The controller tests also delay a real shared JS controller's renewal state
across native release, reject retired input, and keep unknown late grants fatal.
They additionally cover multiple later acquire/release intents: the local
`control_epoch_v1` creation stamp must match the service's existing intent
counter before a report changes authority. Old stamps are ignored, malformed or
future stamps close media; an older local renderer remains view-only. The stamp
stays outside Relay/DataChannel input, and move coalescing cannot cross it.
Run `node --test tools/tests/remote-desktop-bridge-lifecycle.test.cjs` for the
native media leaf's readiness and disposal. It executes the actual bundled ready
report, including additive capabilities; do not compare the entire JSON string
to recognize readiness. This mock-platform test does not replace ArkWeb evidence.
Terminal connection diagnostics distinguish probe, attach/snapshot, TURN and
signal failures by a local operation name while keeping wire payloads and
credentials out of logs. Late failures from retired generations stay silent;
these diagnostics must not replay requests or relax failure handling. The
encrypted account channel distinguishes `target_unavailable` returned by Relay
from the authenticated host reply using fixed origin labels only; retired
channels and arbitrary error details stay silent.
Renderer failures retain only fixed local stage labels (peer, channel, track,
stats and known ICE failures); unknown stages log `unknown`. Retired renderer
events stay silent, and the extra diagnostics do not change fatal cleanup.
Repeated release must preserve the original ACK deadline and block acquisition;
the `remote-desktop-browser` filter checks that behavior over a real ordered DC
with delayed/missing ACKs. These fixtures have no native input provider.
The same filters cover release racing host revocation: a matching post-drain
notification settles the retired lease without its ACK; stale/malformed notices
must preserve pending barriers, and a successor still requires explicit acquire.
The Chromium case crosses the original four-second deadline with no release ACK
while retaining video; it does not prove native resource drainage.
The controller filter also covers bounded signaling-read recovery after first
presentation: retire input, keep the same renderer for at most 30 seconds from
the first transient failure, and resume viewing only after the same streaming
source is authenticated. Do not soften explicit authorization, identity or
media errors, replay mutations, or preserve media after background. Add
`node --test tools/tests/remote-desktop-i18n.test.cjs` for remote-desktop copy:
`RemoteI18n.t` reads packaged native string resources, so ETS catalogs alone
cannot make new labels available at runtime.
Controller tests also delay attach replies across exit/background, lost ACKs,
replacement views and account invalidation. Local media/input stop immediately;
cleanup waits for that request and uses only its old channel/attachment, then
erases the channel key without closing the shared account socket.
The same controller filter covers explicit reconnect after failure/background:
refresh the directory, probe a new channel, and wait for a new display choice;
never replay attach or restore control. Account/Relay changes, duplicate clicks,
exit/background during directory lookup and superseding device selection must
reject late results. For a source-lifecycle host, fresh setup reads unscoped
occupancy before the display catalog: wait at most 60 seconds of monotonic
uptime for the prior owned source and native drain, never adopt/detach it or
replay attach. Other-controller occupancy fails explicitly. Retired setup,
invalid snapshots, rollback/missing clock during a wait and timeout cannot
reach a later catalog or start media. The native `--layout-only` check also exercises the terminal
page's reconnect and back actions with one retained renderer bridge.

The same controller and renderer-queue filters cover `source_lifecycle_v1`
pause/resume: retire native input and old callbacks immediately, wait for the
host's suspended state before closing the old PC, then wait for native drainage.
Resume uses the same attachment and ICE policy with a new PC/renderer and a new
first-frame gate; control stays viewing. Unknown ACKs get one snapshot read,
never mutation replay. Cover stale CAS, old poll failures, native bridge exit,
identity changes, retained expiry and detach waiting for a pending mutation.
Display choice additionally refreshes the authorized catalog while suspended,
rejects duplicate IDs, and selects by opaque ID with a fresh snapshot CAS. Discovery (`list_displays`)
uses no outer attachment, matching the Rust request contract; only selection
and resume carry the bound attachment. Keep this refusal in the mock channel.
Cancel/identity changes fence late catalog results; selection errors never
resume another target. A confirmed selection reuses the same attachment and
ICE policy, then resumes a fresh PC as view-only. The controller filter covers
lost selection ACKs, stale/denied/missing targets, exit during mutation and
retained expiry while the picker is visible.
The same filter covers `quality_presets_v1`: require source lifecycle and a
drained manual pause, fetch a fresh CAS, confirm the requested preset and remain
paused. Unknown ACKs get one snapshot read; refusal never replays or resumes.
Exit waits for the old mutation before detaching on its own channel; retired
results cannot update a successor. A host advertising presets must return a
known quality in its snapshot; legacy hosts retain their existing viewing path.
Use `python3 tools/check-remote-desktop-ui.py --hdc "$HDC" --device <target> --quality-only`
for all three preset labels/current states, explicit view-only resume and live
resize in compact/wide and both themes. This debug-only native preview has no
account, capture, encoder, TURN or OS input; actual encoded quality/throughput
requires the account/media path. Keep the installed trial identity and restore
ordinary viewing after any package or preview check.
Use `python3 tools/check-remote-desktop-ui.py --hdc "$HDC" --source-only` for
compact/wide, light/dark display selection, current labels, cancel, explicit
resume and live resize with one native bridge. Its two display entries are
fixture metadata; it neither captures a second screen nor proves physical
multi-monitor switching or native OS input. Record those separately.
The `--layout-only` check also exercises production More → Pause and Resume in
both pane widths/themes, preserving the native bridge and requiring a new
control request. It does not connect to a host or prove native capture drainage.


For native remote-desktop input preparation, add
`node --test tools/tests/remote-desktop-touch.test.cjs tools/tests/remote-desktop-touch-clock.test.cjs tools/tests/remote-desktop-renderer-queue.test.cjs tools/tests/remote-desktop-navigation.test.cjs`
to the focused controller/receiver tests above. Gestures capture the lease
generation at creation; a bridge outbox must preserve down/up order and reject
pressure instead of silently dropping input. The virtual keyboard keeps IME
preedit local and forwards confirmed text directly to remote focus; it has no
local draft/send step. Pending adjacent moves may replace only a valid move
with the same renderer, attachment, connection and control generation. Button,
key, text, wheel, lifecycle and control commands remain ordered barriers; both
item and byte budgets still apply to replacement. The queue tests cover a
stalled bridge, legacy opaque commands, boundary isolation and byte credit.
Local zoom, zoomed canvas panning and touch cancellation must not release the
control lease. Drain any held pointer button under its original binding, then
allow the next gesture to continue. The focused touch/default-control tests
cover this separately from authority or source-geometry changes.
The fixed receiver's native-focus option requires
the app owner to close on WindowStage INACTIVE/HIDDEN as well as background; it
must not become a generic browser focus bypass. The no-account native UI checker
covers compact/wide, themes, pointer/key pairs, resize release and virtual typing;
it does not prove remote OS injection or authorize opening the normal host gate.
Gesture durations use ArkUI BaseEvent's boot-relative nanosecond timestamp,
converted by `RemoteDesktopGestureClock`, rather than handler dispatch time.
Use native LongPressGesture recognition, not a JS timer that can fire while a
short-tap Up is queued. The clock tests execute the actual viewport handlers
with delayed dispatch, wall-clock jumps, invalid/backward event time and retired
gesture callbacks. Invalid time cancels input and releases control with the
existing paused state; a cleanup ACK must not imply input recovered. Do not
change the phone's real clock or fall back to calendar/handler time. The separate
live uptime method remains for media credential budgets.
For local remote-desktop screenshots, run
`node --test tools/tests/remote-desktop-screenshot.test.cjs tools/tests/remote-desktop-media.test.cjs`.
Capture the current video frame at its received dimensions, outside the control
wire and its size budget. Fence renderer changes, retire temporary files and
use the native save control for photo export; no broad photo-library permission
or account upload is required. Real photo export still requires native evidence.
For composition, paired remote keys, retired callbacks and serialized platform
IME attachment, also run `node --test tools/tests/remote-desktop-keyboard.test.cjs tools/tests/remote-desktop-keyboard-lifecycle.test.cjs`.
These use mocked platform adapters, not native IME or remote OS injection.
The component filter executes production lifecycle methods with delayed timers:
open fixes the initiating renderer/control generation, and input, hidden and
failure callbacks require that binding and the current keyboard instance.
Reopening retires the previous instance immediately; a canceled queued timer
cannot replace a newer request, including before ArkUI unmount completes.
The panel's keyboard request is checked synchronously by those callbacks.
Hiding or hiding/reopening in one UI flush must retire the old request even
while its component still exists; a valid control generation alone is not enough.
Native UI checks must scroll the More menu before asserting an offscreen action;
the platform accessibility tree omits children outside the scroll viewport.
Each callback removal is independent: one platform `off` failure must not skip
the remaining callbacks or detach, and detach stays serialized before the next
keyboard attachment. Any callback the platform retains must stay inactive.
For a native repeat after keyboard layout changes, use
`python3 tools/check-remote-desktop-ui.py --hdc "$HDC" --keyboard-only`.
It checks both pane widths/themes and portrait, actual IME typing without a send
button, native Backspace/Return pairs and retention of the receiver/control
context while the keyboard resizes it. The no-account sink records counts, not
text. Use `--layout-only` for connection/control transitions without repeating
the IME matrix.
Use `--rotation-only` to rotate the same live native page from portrait to
landscape and back in both themes while its IME is open. It checks control
release and keyboard closure, retained process/bridge/selection, no extra input,
and a paired click at normalized (0.25, 0.75) after reacquiring. It uses the
production More menu, including scrolling above a landscape IME. The ordinary
App follows the system preference until the user explicitly rotates this view.
For adapter retirement and window-preference restoration, run
`node --test tools/tests/remote-desktop-orientation.test.cjs`.
It covers late window lookup, rotation pending at close, replacement ownership,
platform failure and restoring the original preference exactly once.
The checker captures the initial orientation and restores it before reopening
the ordinary App, including on failure; it must not leave a phone in the last
forced landscape preview. Local copies of initial/final ordinary-page dumps are
removed after reading geometry; successful cleanup verifies no preview remains.
This no-account check does not prove remote OS injection, actual video during
rotation, or physical fold transitions.
For real native direct-touch coordinates, double-tap drag and long-press pairs, use
`python3 tools/check-remote-desktop-ui.py --hdc "$HDC" --gesture-only`.
It covers both pane widths and themes using a no-account sink, checks centered
normalized coordinates and balanced left buttons with actual movement, and
restores the ordinary App. Start ordinary EntryAbility before this checker if
installation left no App window, so it can record and restore initial orientation. It proves no native desktop injection or host drain.

For the shared-renderer DEBUG media fixture, run
`node --test tools/tests/remote-desktop-probe-lifecycle.test.cjs tools/tests/remote-desktop-media.test.cjs`
and compile the HAP. The fixture reuses `RemoteDesktopMediaView`, never a second
receiver implementation. Its launch flag `remoteDesktopSharedReceiver=true`
only applies inside the existing DEBUG remote-desktop probe route. Answer SDP
goes to the private probe transport, never the diagnostic text. Match installed
version/signing/storage isolation when updating a trial HAP; never uninstall or
reset user data. From the repository root, the actual native sender/phone run is
`node scripts/test-remote-desktop-harmony-media.mjs --display macos:<uuid>`;
see the Desktop guide for optional private TURN configuration and evidence scope.
The media tests also cover monotonic control-health freshness across wall-clock
changes and rejection of missing clocks or negative sample ages; these are input gating checks,
not proof of native clock adjustment or OS input delivery.

For language-refresh and literal-parameter regressions, run
`node --test tools/tests/host-text-retranslator.test.cjs`. This exercises the
production retranslator and RemoteI18n with real element catalogs; platform
resource access is mocked and does not replace native resource/device checks.

For workspace/session catalog rendering, install the debug HAP and run
`python3 tools/check-catalog-refresh.py --hdc "$HDC"` (add `--dark` for dark
mode). Run in compact and wide postures. The isolated fixture replaces objects
while preserving IDs and checks titles and click payloads in the sidebar,
recent sessions, time/project lists, and workspace picker. The script restores
the normal App even on assertion failure; it does not modify remote data.

For composer submission timing and draft ownership, run
`node --test tools/tests/composer-submit.test.cjs`. The native preview scenario
`composer-submit` uses the real composer and command controller with a pending
fake RPC: send must clear the input before pressing **Acknowledge**, and a
**Next draft** entered while pending must survive acknowledgment. Exercise both
compact and wide layouts and return to normal `EntryAbility` afterward.

For rollback reply ownership and session switching, run
`node --test tools/tests/rollback-session-isolation.test.cjs`.
In the `copy-rollback` native preview, stage a rollback, use **Resize**, and verify
the preview remains for the same session. Use **Switch session** and verify the
staging bar and full-text panel close while `SESSION-B-DRAFT` remains untouched.
Exercise compact and wide widths in light and dark modes, then restore normal
`EntryAbility`. Deferred-response unit tests cover switching while rollback,
send acknowledgment, and voice shutdown are pending; the preview uses a mock
host and is not evidence of live relay or physical fold behavior.
After installing the debug HAP on a wide device/emulator, run
`python3 tools/check-rollback-session-isolation.py --hdc "$HDC" --device <target>`
for compact/wide, light/dark and live resize checks with layout/screenshot evidence.

For history loading and explicit jump-to-bottom navigation, install the debug
HAP and run `python3 tools/check-history-scroll.py --hdc "$HDC"`. The
`history-scroll` preview holds a mock history response while the production
ChatTimeline handles the jump. It covers success/failure at wide and compact
content widths with a live resize and restores the normal App afterward.
This is native controller UI coverage, not remote transport or physical fold
coverage; exercise those separately when their behavior changes.

For durable transcript projection, run
`node --test tools/tests/session-record.test.cjs tools/tests/host-stream.test.cjs tools/tests/streaming-markdown.test.cjs`.
The `durable-timeline` native preview uses the
production reducer, timeline store and rows. **Next replay** exercises late tool
insertion, 30 identical publications, text correction, deletion and completion;
block counts must be 2, 3, 3, 3, 2, 2, with one visible answer. Verify compact,
wide and live fold transitions, then return to normal `EntryAbility`.

For host shutdown/restart handling, run
`node --test tools/tests/connection-health.test.cjs tools/tests/session-record.test.cjs tools/tests/host-stream.test.cjs`.
In `durable-timeline`, **Host offline** must retain content and disable Stop;
**Host returned** publishes an interrupted turn, preserving its output and
removing the running action. Test both postures and restore normal App afterward.

## Visual reference fidelity

- Before drawing a system glyph, text approximation, or new bitmap, search the existing HarmonyOS media resources and the approved desktop reference images. Reuse the established asset when one exists.
- Conversation header controls must use the approved `remote_ref_back` and `remote_ref_more` assets. Do not replace them with a system chevron or text such as `...` / bullet characters. Compact top-left open-sidebar uses `CompactMenuButton` (`gpt_home_menu_glyph`). Wide restore/collapse uses `SidebarToggleButton` (the sidebar-pane glyph).
- Render monochrome reference assets in template mode and tint them with semantic theme colors such as `INK`. Never rely on the bitmap's original black or white pixels; the same control must remain legible in light and dark themes.
- Keep paired header controls on the same fixed touch-target size and optical alignment. A responsive layout may reposition a control, but must not silently change its icon geometry or visual weight.
- Keep `SymbolGlyph` geometry separate from its touch target. When a glyph is clickable or sits in a decorated control, wrap it in `Stack({ alignContent: Alignment.Center })` (or use a centered `Button`) that carries the touch-target size, and size the glyph with `.fontSize()` only. Do not stretch the glyph itself to the full 32vp/40vp/44vp target.
- Prefer `.fontSize()` over `.width()`/`.height()` on a `SymbolGlyph`. Measured on device: a glyph's natural advance box is `fontSize * 1.013` square for most symbols, but `chevron_left` and `chevron_right` are only `fontSize * 0.507` wide. Ink is drawn **left-anchored** inside any box forced wider than the natural box (vertically it stays centered, so only the horizontal axis is affected), and a box forced *smaller* than the natural box makes the glyph overflow rather than scale. So `.width(N)` on a chevron shifts it left of its container's center by `(N - fontSize * 0.507) / 2`.
- A collapse indicator that swaps between `chevron_right` and `chevron_down` still needs a fixed slot so the adjacent label does not jump between states. Put the fixed size on a wrapping `Stack({ alignContent: Alignment.Center })` and select the symbol with a ternary on one unsized `SymbolGlyph`; see `SubagentTaskCard.ets`. Never put the slot size on the glyph itself.
- The one place a forced width is correct is a leading icon slot in a list row: because ink is left-anchored, a shared `.width()` is what keeps icon and text left edges aligned down a column of rows whose `fontSize` values differ. Leave those alone.

## Responsive interaction semantics

- Every HarmonyOS change that can affect presentation or interaction — including
  state, actions, ViewModels, and components — must treat compact phones, wide
  screens, and foldables in both folded and unfolded postures as first-class
  targets. Do not implement or review a feature against only the currently
  visible layout.
- Before editing, search for every responsive host and presentation branch that
  exposes the affected action or state (for example compact overlays, wide
  master/detail hosts, sidebars, routed destinations, sheets, and popovers).
  Keep their behavior and capability gating aligned; a fix is incomplete while
  an equivalent wide or compact entry point still uses legacy behavior.
- Do not infer device class from a single width captured at startup. Layout must
  remain correct when a foldable changes posture or window size while the app is
  running, preserving state, selection, and interaction meaning across the
  transition.
- For UI changes, verify at minimum one compact layout and one wide layout. When
  a foldable or resizable emulator/device is available, also exercise a live
  folded/unfolded or resize transition. Record any unverified posture explicitly
  in the handoff instead of treating a phone-only check as sufficient evidence.
- Wide and compact layouts must keep the same interaction meaning. Responsive presentation may change spacing and available width, but it must not turn a lightweight anchored action menu into a bottom sheet by default.
- Conversation-header overflow actions open from the top-right trigger as an anchored popover on both compact and wide layouts. Use a bottom sheet only when the content is a genuinely large or multi-step mobile workflow and the design explicitly calls for it.
- Anchor popovers to their actual trigger with `bindPopup` or the equivalent platform API. Do not emulate the anchor with unrelated page-level absolute positioning.
- Preserve auto-dismiss, outside-tap handling, accessibility labels, and a short enter/exit transition for anchored menus.

## Theme and device verification

For cold-start home animation geometry, launch the isolated design preview with
`hdc shell aa start -a EntryAbility -b <bundle-id> --ps openbitfunDesignPreview cold-start-home`
(or `cold-start-home-dark`). Use **Replay** to run the production 2400 ms
transition over the production recent-home component and **Resize** during
playback to remeasure its anchor. This fixture does not load account or remote
state. Check compact and wide windows separately, then force-stop and start the
normal EntryAbility without preview arguments. A fixture check does not replace
authenticated cold-process, signed-out, and background/foreground verification.

- Use existing semantic colors from `Theme.ets`; do not hard-code a light-only foreground or surface color.
- For changes to navigation controls, menus, or responsive presentation, verify compact and wide behavior, light and dark theme legibility, and capture a real-device screenshot before completion when a device is connected.
- Run the smallest matching HarmonyOS build/check plus `pnpm run theme:color-audit:all` for theme or color-related changes.

For the bundled native file editor renderer (read-only mode, horizontal lines,
line-number scroll alignment, and edit bridge), run from the repository root:

```bash
node --test src/mobile-web/tests/harmony-file-editor-browser.test.mjs
node --test src/apps/mobile/harmonyos/tools/tests/workspace-editor.test.cjs
```

The Chrome renderer test does not replace Harmony device-level keyboard and
sheet-layout checks.

For the isolated read-only remote-desktop receiver probe, run
`node --check deploy/remote-desktop/probe/receiver.js` and
`node --check deploy/remote-desktop/probe/sender.js` from the repository root,
then `pnpm run harmony:architecture` and the focused debug HAP build above.
Use [the probe guide](../../../../deploy/remote-desktop/probe/README.md) for
real-device launch, direct/relay evidence, lifecycle and compact/wide checks.
The packaged receiver is generated; its source lives with the probe guide.

For the native account service's dedicated remote desktop signaling and legacy
RPC compatibility, run `node --test tools/tests/remote-desktop-realtime.test.cjs`.
This mock transport check does not replace real account/media or device tests.

For the formal read-only remote desktop controller and shared media receiver,
run from this directory:

```bash
node --test tools/tests/remote-desktop-controller.test.cjs tools/tests/remote-desktop-media.test.cjs tools/tests/remote-desktop-realtime.test.cjs tools/tests/remote-desktop-browser.test.cjs
```

Credential renewal requires both `source_lifecycle_v1` and `credential_rebuild_v1`.
The controller fixes the shorter host/local TURN budget using native uptime and
wall time, charges request time, and only shortens it. At the 60-second margin,
reuse suspend/drain/resume with one attachment and a fresh PC/renderer; await a
new first frame and restore viewing only. Explicit pause, account change,
background and close must not auto-resume. Missing/expired/too-short credentials
fail clearly without a rebuild loop. The Harmony ViewModel requests a fresh
lease after presentation and transport readiness when the user still intends
to control; explicit stop, refusal, revocation or signaling interruption cancels
that intent. Run `node --test tools/tests/remote-desktop-default-control.test.cjs`
for this surface policy. The controller filter covers these races;
it does not prove a long-lived native TURN session or held-input drainage.

Transport reports can change within one PeerConnection (including TURN UDP/TCP
selection). Use connection/renderer or probe-local PC instance identity plus
first-frame events for rebuild evidence; a path-log count is not a PC count.
Preserve incremental observations when bounded device logs evict older records.
HDC can exit with status zero while printing `[Fail]` for a disconnected device.
Reject that output, confirm the exact target and expected command result, and
verify received files exist before accepting install, launch or UI evidence.

Presented-frame geometry is validated before entering observation. The bundled
receiver's local `frame_resized` event updates the native viewport and retires
input without creating another first-frame event or connection. Retired renderer
events and resize events before observation cannot reopen the view. The browser
filter includes an actual canvas-stream resolution change; it is not evidence of
native encoder adaptation or a physical desktop display change.

The browser check exercises actual local WebRTC with a canvas source, not native
capture or account authorization. The media filter also checks completed gathering
with no ICE candidates: no answer is emitted and the failed PC is closed; the
fixture does not emulate a TURN server or prove a specific server quota cause. The same filters cover a disabled
video track that remains live/unmuted: local input health and receiving reports
both become negative. The browser case toggles an actual receive track; native
held-key drainage remains a separate device-level check. Build/install the debug HAP and run
`python3 tools/check-remote-desktop-ui.py --hdc "$HDC"` for actual rawfile bridge,
light/dark compact/wide and live resize checks. The debug-only fixture loads no
account or remote pixels, and restores normal EntryAbility after completion.
It does not replace physical fold, live account, TURN, capture/permission,
background media cleanup or revocation checks. Preserve the installed bundle
identity and user data; a device upgrade must not uninstall the app to bypass a
version downgrade rejection.

The browser receiver fixture also freezes its presentation-observation callback
while actual RTP decoding continues, and separately stops canvas updates. It
records actual health replies in a printed temporary directory; these are
Chromium/canvas observations, not a physical compositor, native desktop, ArkWeb
or forced-TURN freeze verdict. Never use this scope to enable phone control.

The media filter also checks the single scheduled bind after native event
dispatch, including an already-open channel, duplicate open events, send failure
and stop before the pending task runs. Stop must cancel it; old identities must
never send into a successor. This is not mutation or input retry. Android native
reproduction and browser checks are separate evidence from ArkWeb acceptance.
