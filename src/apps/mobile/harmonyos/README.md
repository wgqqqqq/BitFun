# OpenBitFun HarmonyOS

Native HarmonyOS controller for OpenBitFun desktop and CLI hosts on phones,
foldables, and tablets. Sign in with GitHub, select an account device, then send
tasks and view results from that host. The phone does not run an Agent Runtime or
store model-provider configuration. Model selection applies to the selected host.

Device QR codes identify a target; the authenticated account directory authorizes
access. Old room records and local conversation data remain on disk during an
upgrade, but do not automatically reconnect or start a local runtime.

GitHub usernames and avatars are presentation metadata loaded from GitHub's public
user-by-ID API without forwarding account credentials. The phone caches them for
24 hours in its encrypted account store, scoped to the authenticated GitHub ID.
Existing signed-in installs are enriched on startup. Offline or rate-limited
profile requests retain the session and cached display; device authorization
continues to use the immutable ID issued by Relay.

## Project Layout

- `AppScope/`: application metadata and shared resources.
- `entry/src/main/ets/`: ArkTS application code.
- `entry/src/main/resources/`: entry-module resources.
- `entry/src/test/`: local unit tests.
- `entry/src/ohosTest/`: device tests.
- `tools/fake-relay.mjs`: local relay simulator for UI and protocol testing.

## Development

Open this directory as a project in DevEco Studio. Install dependencies through
OHPM before building the `entry` module.

On macOS with DevEco Studio installed in its default location:

```bash
source scripts/ohos-env.sh
"$OHPM" install
"$HVIGORW" --mode module -p module=entry assembleHap --no-daemon
```

Signing configuration is intentionally not stored in the repository. Configure
a local signing identity in DevEco Studio when installing the app on a device.

The current project targets HarmonyOS `6.1.1(24)` and supports
`6.0.1(21)` or newer on phone and tablet devices.

## Remote desktop preview

Open **Remote control** beside **Mini apps** in the sidebar. Select an online
computer to open its desktop directly; the session device list has no separate
**View desktop** button. The dedicated picker probes the selected computer,
then lets you choose one of its authorized displays. Viewing and control follow the computer's advertised
capabilities and local authorization. It keeps the
chat host and workspace selection intact, and closes media when leaving the
page or entering the background.

The phone defaults to direct touch. Pinch zoom and zoomed two-finger panning
adjust the local canvas without releasing control. **Move canvas** also keeps
control; exit that mode to click the computer again. At fit size, a two-finger
slide still scrolls the remote computer. The desktop sits on a dark media canvas,
with a compact device badge, close button and more menu at the top. The bottom
shows control status and keeps the keyboard button reachable; mode, canvas movement, screen
rotation and disconnect live in the more menu, which scrolls in short windows.
**Rotate screen** changes only the phone viewport, closes the keyboard and
releases control. Leaving the view restores its original window orientation
preference. **Keyboard** opens the phone's native input method for both Chinese
and English. Select the computer's input field first; confirmed text goes
directly to that remote focus, without a local draft or send button. A compact
row above the input method provides Backspace, Return, Esc, Tab and arrow keys.
Unconfirmed composition is discarded when closing the keyboard or selecting a
different remote target. Ordinary builds still keep
host input disabled until the complete acceptance matrix passes.

On a computer that supports quality selection, **More → Pause sharing** shows
the current preset and **Data saver**, **Balanced**, and **Clear** choices.
Selecting a preset keeps sharing paused. Choose **Resume viewing** to start a
new video connection and request a fresh control lease automatically. Computers
without this capability keep the existing pause/resume page.

**Screenshot** beside the keyboard button captures the complete current display
frame, regardless of phone zoom or panning, and opens a compact bottom-sheet preview. **Save image**
exports it to Photos using the system save control. The image uses the received
video resolution and contains no phone toolbar. Capture is available while
viewing, does not require keyboard/mouse control, and sends no image through the
account Relay. Closing the preview removes its temporary file.

The computer must first authorize this phone and display in its local remote
desktop settings and have screen recording permission. This development path
requires the optional macOS `remote-desktop-media` build feature and a Relay
with dedicated remote desktop routing and TURN credential issuance. It is not
yet enabled in the default desktop build or verified against the complete
acceptance matrix. After backgrounding or an interruption, use **Reconnect** on
the closed page to refresh the device directory and probe the same computer,
then explicitly select its display. After a new frame and healthy transport, the
phone requests control through the existing authorization checks. Normal
connections need no start-control button. **More** provides **Stop control** and
**Resume control**; explicit stops, refusals, revocation and signaling interruptions
do not trigger automatic retries. Healthy media credential renewal requests a
fresh lease only while the user still intends to control. Account or Relay
changes require returning to the device picker.

## Built-in MiniApps

Choose **MiniApps** from the sidebar to open Gomoku, Regex Playground,
or Daily Divination. The gallery uses two columns of rounded showcase previews
on phones and three on wide screens; tapping a preview opens the app directly.
Showcase images reuse the existing desktop artwork under
`src/web-ui/src/assets/miniapps/showcases/`. Navigation typography follows the
shared mobile body role, with the same proportions on compact and wide hosts.

These bundled pages run locally in ArkWeb without signing
in, pairing, a desktop connection, or internet access. Storage and clipboard
writes use the phone. Data is isolated by app and retained across app upgrades;
it is not synchronized with desktop MiniApps. Closing a page discards its
unsaved page state. Changing desktop targets has no effect on these local tools.

Every IDE/CLI HAP build runs `miniapps/generate.cjs` through
`entry/hvigorfile.ts`. It packages the existing shared MiniApp sources and
canonical appearance tokens into generated raw resources; do not edit those
outputs. `miniapps/mobile.css` owns phone-only layout adaptation. The pages
follow the app language and system light/dark appearance. They resize in place
for compact, wide, and folded/unfolded layouts.

The sandboxed iframe has no network access or local-file access. The native
bridge permits only per-app storage keys and clipboard writes; it has no generic
invoke, Worker, shell, workspace, AI, or Agent API. Local records are replaced
atomically, and malformed records are retained and return an error. These local
tools do not read any remote workspace or peer content, and do not execute jobs
on CLI/Detached Dispatch hosts. Existing Remote Connect protocols are unchanged.
Desktop catalogs, page transfer, and remote MiniApp execution are deferred.

Run the local test and HAP build commands in `AGENTS.md`, plus:

```bash
node --test miniapps/*.test.cjs
```

Before claiming device verification, exercise local/offline launches, saved data
after relaunch, clipboard, keyboard input, compact/wide layouts, light/dark
appearance, and a live resize/fold transition on supported hardware.

### Home and launch presentation

Cold launches reuse the desktop contour mark and reveal the OpenBitFun wordmark
letter by letter in approximately 1.3 seconds. This presentation does not wait
for network/account initialization, is dismissed when backgrounded, and does not
replay on foreground. The system reduced-motion preference skips it where the
platform exposes that preference (API 23+). Native launch artwork and the app
surface both follow the system light/dark theme.

The welcome surface keeps connection actions at the bottom and offers bundled
MiniApps without a desktop connection. Connected, connecting, and empty wide
surfaces retain their existing remote capability and session routing behavior.

## 自部署远程桌面

侧栏的远程桌面入口使用独立配对服务，与 OpenBitFun 账号登录及聊天设备分开。
首次填写用户部署的 HTTPS 服务地址和配对密钥，之后使用 HUKS 加密保存的独立
设备凭据重连；查看与操作权限仍由被控电脑本机批准。登录或退出 OpenBitFun
账号不会改变这条连接。部署方式及当前实现边界见
[自部署说明](../../../../deploy/remote-desktop/self-hosted/README.md)。
Windows/Linux 被控适配及三系统实机链路仍未完成，当前普通输入开关保持关闭。
