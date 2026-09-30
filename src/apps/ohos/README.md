# OpenBitFun HarmonyOS PC

This is the current repository's native PC host, under development. Open this directory in DevEco Studio. It loads `libopenbitfun_desktop_lib.so` built from `../desktop`, using the same-version NativeAbility bridge. It is not the phone Remote App and does not launch a remote runtime.

An experimental ARM64 HAP has been built, signed, installed and started on a connected HarmonyOS PC. Device logs confirm frontend initialization and Monaco startup. Full feature parity is not complete. No generated native library is checked in; do not substitute a legacy library or a framework probe.

From the repository root on macOS with DevEco Studio installed:

```bash
node --test scripts/ohos-host.test.mjs
# Build frontend before applying the isolated Cargo dependency overrides.
pnpm run build:web
pnpm run plugin-host:build
node scripts/ohos/prepare-framework.mjs
# Select the pinned OHOS filesystem patch when the normal lock contains a newer upstream plugin.
cargo update --config target/ohos-framework/cargo.toml -p tauri-plugin-fs --precise 2.5.1
node scripts/ohos-cargo.mjs build --config target/ohos-framework/cargo.toml -p openbitfun-desktop --lib
node scripts/ohos/stage-runtime.mjs
node scripts/ohos/hvigor.mjs --sync -p product=default --no-daemon
node scripts/ohos/hvigor.mjs --mode module -p product=default -p module=entry@default default@CompileArkTS --no-daemon
node scripts/ohos/hvigor.mjs --mode module -p product=default -p module=entry@default assembleHap --no-daemon
```

The packaging command intentionally fails if the current ARM64 native library or staged workbench/extension resources are missing. The check also runs when Hvigor has an older cached package. ArkTS-only compilation and IDE sync do not require those generated runtime files. Set `OPENBITFUN_DEVECO_CONTENTS` for a non-default DevEco installation.

The application id follows the current Desktop identity: `com.openbitfun.desktop`. It does not overwrite the legacy PC install. Legacy data migration is not implemented; keep the existing app and its data.

Configure automatic development signing for this project in DevEco Studio's Project Structure > Signing Configs. Then run `node scripts/ohos/save-signing.mjs` to move generated signing configuration into ignored `signing.local.json`. The Hvigor wrapper temporarily injects it for a build and restores the public profile afterward. Private key and certificate files remain in DevEco's local storage. Never commit the local signing file.

Internet and network-state permissions are declared at this stage. Native-code execution, user filesystem access, clipboard, capture, and other restricted permissions must be introduced with their corresponding platform implementations and device validation. Do not use this initial declaration as evidence these features work.

The native window bridge handles minimize, maximize toggle, show and state reads through system Window APIs. Startup uses this bridge on the device; individual maximize/minimize interactions still need manual verification. Secondary WebViews, pets, notifications, desktop updater and local Sherpa speech models currently report unsupported. The startup theme is supplied by ResourceManager; live system-theme changes are not yet validated. Existing window geometry records are preserved until the native geometry adapter is implemented.

The first device iterations fixed a missing page route, a missing Tokio context on the ArkUI setup callback, and ArkWeb DOM storage being disabled. The host advertises that Desktop updates are unavailable, so startup does not restore pending Desktop packages or show an update-failure dialog, and About does not offer Desktop update checks. Deploy updates as signed HAPs. This capability belongs to the local controller, even when connected to a peer; older Desktop hosts without the capability field retain their existing update behavior.

Remaining gaps include complete account login validation, terminal/shell integration, external runtime binaries, native pickers, and frontend gating of other unsupported desktop integrations. The private app directory is initialized, but user-selected external workspace access and all four remote scenarios remain unverified.


The PC host retains system window decorations and disables duplicate Web UI window controls.
The main ArkWeb disables pinch zoom and root overscroll; embedded pages and the mobile host
keep their own interaction settings. The local terminal checks system zsh first and falls back
to the available system sh with an explicit log and Sh session type. Basic sh supports interactive
input; structured Agent command execution requires shell integration and otherwise reports an
unsupported state before sending the command. On a connected API 24 PC, the compatibility HAP
verified sh output, resize, exit status, and product session history. API 22 execution remains
unverified; no API 24 executable-bin requirement has been added to this package.

GitHub credentials use the native Asset Store provider; reading an empty store has passed on
the API 24 device. Authorization links use the system browser. Saving real credentials, token
refresh and restart recovery still require an authorized login. Native status-bar registration
uses DesktopExtensionKit; registration, icon/panel display and restoring a minimized window
have passed on the API 24 device. Close-to-tray remains explicitly unsupported. Bundled mobile-web
resources load on device; authenticated pairing and reconnect remain unverified. LAN interface
discovery uses NetworkKit rather than Linux netlink on OHOS and enumerated one interface
on the API 24 device.

The companion uses a native TYPE_FLOAT container for the existing product WebView,
including role selection, task bubbles and session actions. The diagnostic Ability,
buttons and preview GIF have been removed. This integration requires a development
Profile whose ACL includes SYSTEM_FLOAT_WINDOW. Regenerate automatic signing in
DevEco Project Structure > Signing Configs; signing with an old Profile does not
request a new grant. Save generated credentials with
`node scripts/ohos/save-signing.mjs` before using the build wrapper.

The refreshed Profile installed on the physical API 24 PC. Native transparent
floating content stayed visible above File Manager after its owner minimized.
This confirms the native debug route. The product integration passed TypeScript
checking, 10 focused frontend tests, 7 host checks, Rust compilation and signed
HAP packaging. The integrated package was subsequently installed on the physical API 24 PC.
Device testing fixed content initialization before child-WebView attachment and
restoring a minimized main window with restore(). Transparent animated roles,
background display, touch-injected movement, context menus, role switching,
closing and reopening in the same process, and opening settings from a minimized
workbench passed. Mouse drag precision, real task bubbles and remote scenarios
remain unverified. Selective transparent-region click-through and off-window
cursor tracking are not implemented. The debug ACL grant is not release approval for desktop pets.
API 22 and remote scenarios have not been exercised for this integration.

ArkWeb touch drag coordinates are normalized from client coordinates plus the
window screen origin; PointerEvent.screenX/Y were window-relative on the PC.
The installed fix tracked 500-pixel forward/reverse and fast injected drags with
0–1 pixel endpoint error on the API 24 device. Physical mouse feel remains unverified.

桌宠支持双指捏合缩放，范围为原始尺寸的 75%–300%；长按菜单也提供放大、缩小和恢复默认大小。大小作为当前设备的窗口偏好保存，切换角色或重开宠物后继续使用，不修改远端配置。缩放只作用于宠物图像，工作台 WebView 仍禁止页面缩放。双指结束后须全部松手，再开始单指拖拽。

2026-09-15：API 24 PC 上通过 ArkWeb CDP 注入双指触控，确认 200% 和 75% 边界、最小值保持、窗口随尺寸变化；HDC 长按验证最小尺寸菜单完整可用；关闭并重新创建宠物窗口后保存的缩放保持。手指实际操作的连续跟随手感仍需人工确认。此次缩放验证仅覆盖本地窗口，未执行远程工作区、远程控制、Peer Device Mode 或 Detached Dispatch。

在折叠电脑的半折叠双屏形态下，拖动宠物朝折痕靠近、宠物边缘距离折痕约 48vp 时，会转移到另一半屏并留出 24vp 间距。一次拖拽只转移一次，松手后可在目标屏继续拖动；双指缩放仍独立处理。识别依赖系统折痕区域、存活屏幕及屏幕坐标转换，不把普通外接屏或屏幕中线当作折痕。

2026-09-15 API 24 PC 验证：系统报告上屏 0、下屏 999，折痕 y=1608–1690px。原生桥验证上下双向转移及同手势锁定；HDC 单指拖动中，手指终点仍在上屏 y=1290px 时，宠物已转移至下屏 y=43px。下屏截图确认透明宠物正常显示。几何测试 4 项、前端拖拽与宿主测试 10 项通过；本轮未执行远程场景。

2026-09-15 桌宠拖动视觉稳定性：保留连续跑动动画，去除额外的整体旋转和上下晃动。朝向采用12个逻辑像素的反向行程阈值，细微偏移不触发转身，明确反向后才切换，且保留同一动画节点避免重播；该阈值不用于窗口移动，每次位置更新仍正常执行。此前固定静态姿势的实现已撤回。13项渲染/拖拽测试及check:web通过，远程场景未执行。

防抖版真机验证：API24 ArkWeb连续6次触控微调中，拖动动画帧持续推进、朝向行保持不变、额外transform为none；松手正常恢复反馈动作。新版签名HAP已覆盖安装。

鸿蒙桌宠缩放上限现提高到300%，下限仍为75%。API24真机触控注入验证3倍上限及大小保存，约288×312vp图像完整容纳于浮窗；3倍大小下原生桥上下双向折痕转移及同手势锁定通过。其他桌面宿主保留原上限，避免超过其现有原生窗口高度限制。

2026-09-15 拖动反向闪动根因修正：真机单向拖动时，ArkWeb clientX与window.screenX异步更新，拼接出的坐标会发生约19–20vp的反向跳变。宿主现在通过ArkUI onTouch记录同一原生事件的displayX/Y及按下时窗口位置，直接计算拖动目标，并将原生触点回传供前端朝向防抖使用；连续动画不变。转移完成后前端停止本次移动队列，取消或双指接管后不再使用旧触点移动。旧宿主/无原生事件时仍兼容原有路径。

诊断日志包含Native drag touch down/ended、Corrected asynchronous drag coordinates（每次拖动最多4条大偏差记录），前端记录Drag facing changed。最终真机左右各500px触控拖动均精确到位，动画朝向未出现反向闪动；13项宿主/拖拽测试、check:web及HAP宿主检查通过。本轮真机下屏处于键盘模式，未复测双屏转移；远程场景未执行。

2026-09-15 顶部栏采用官方自由窗口沉浸方案：在页面挂载完成后隐藏系统标题文字区域，保留原生三键，45vp 高度与工作台工具栏对齐。`WindowChrome` 在主 WebView 初始化、聚焦及尺寸变化时读取实际三键区域，动态设置工作台顶部栏右侧避让；API24真机测得123vp，进入会话、最大化及还原均保持工具按钮分离。按钮明暗由工作台背景同步。顶部空白区域通过原生onTouch调用startMoving，交互按钮、标签页及弹出菜单区域不触发拖窗；真机注入100×70px拖动通过。桌宠保持独立宿主。本次check:web、HAP构建及宿主测试通过；API22、完整深色主题切换和远程场景尚未验证。

官方方案：https://developer.huawei.com/consumer/cn/doc/best-practices/bpta-multi-device-window-immersive
