# 远程桌面：协议与媒体

> 2026-10-26 产品范围调整：目标为 Windows/macOS/Linux 电脑互控，以及鸿蒙手机
> 控制这些电脑。远控改用用户自部署的独立设备配对服务，与 OpenBitFun 登录 Relay
> 分离；普通登录 Relay 默认不宣告或处理远控，自部署服务不提供账号登录和 Agent RPC。
> Desktop 的连接 owner、凭据存储与服务地址及鸿蒙的 HUKS/连接实例已独立接线。
> 本文原账号 Relay 联调记录保留为历史证据，不构成独立服务或三系统交付证据。
> Windows/Linux 被控适配、Linux 原生接收和原生输入已接线；独立服务与三系统实机链路仍未验收。
> 部署入口见[自部署说明](../../deploy/remote-desktop/self-hosted/README.md)。

状态：v1 设计提案；鸿蒙接收与 macOS 原生发送已完成受限可行性验证，产品尚未交付。更新：2026-10-20；代码基线 `c39bfb337`，RustDesk 参考 `0b5a3d74d`（1.5.1）。

[产品与交互](../features/remote-desktop-control.md) 定义体验与授权；[部署手册](../../deploy/remote-desktop/README.md) 定义试用主机操作。本文保留统一验收矩阵，不混入主机地址、操作记录和部署路径。

## 1. 决策、范围与威胁模型

自部署远控服务负责设备配对、发现、鉴权和加密信令，独立 TURN 按需转发 WebRTC 加密包。被控 Desktop 持有授权、捕获资源和操作权，不创建 Agent session。v1 每台 host 只允许一个 attachment、一块选定显示器、一条视频轨道和一条 reliable/ordered DataChannel。

非强制中继时，两端从已批准的 UDP TURN 地址派生同端点的 STUN 配置，允许 ICE 选择直连并保留 TURN 回退；不引入公共 STUN，不从 TCP/TLS-only 地址推导 UDP 服务。强制 TURN 时仍使用 relay-only 策略。是否 P2P 以实际选中的 candidate pair 为准，双方类型均已知且都不是 relay 才算直连；同一 Wi-Fi、关闭强制中继或首帧成功都不能单独作为证据。

手机先做 HarmonyOS：先探 ArkWeb 接收，再做 macOS 原生发送，随后接授权和输入。Android/iOS 后续复用窄的媒体 JS 模块，界面保持原生。不实现多观察者、抢占 AI、Background AI 并发或鸿蒙 PC 被控。

当前交付聚焦原生手机 App 和 Desktop 控制端，不新增 mobile-web 远程桌面入口；现有 mobile-web 会话控制保持原有范围。

### 安全前提

- 信任本机 OS、OpenBitFun 进程及本地授权入口；防范网络攻击者、未授权配对设备、旧请求/旧输入，以及正常断线、重启和异步竞态。OS 或已授权控制设备被完全攻破不在本协议的防护范围内。
- v1 信任用户自部署服务正确执行设备鉴权和首次公钥目录分发。[现有密钥获取](../../src/crates/services/services-integrations/src/remote_connect/account.rs) 复用目录协议，并非独立于服务的身份验证。首次本机授权固定设备指纹，后续密钥变化重新确认；这是依赖受信目录的首次信任，不宣称抵抗恶意服务首次替换公钥。若要覆盖该威胁，须另行设计双方带外指纹核验。
- 信令必须以已确认设备密钥认证加密，并绑定协议、双方设备、attachment 和连接标识；DTLS fingerprint 来自该信令。TURN 只转发，不获得屏幕明文；可观察流量元数据、丢包或阻断。v1 不额外增加 bind nonce，它不能弥补首次密钥信任问题。
- 配对不自动获得画面或输入。本机授权、OS 权限和 GUI reservation 都满足后才能操作；本机停止/撤销不等待网络 ACK。仅查看也需 view grant。
- 设备访问凭据撤销依赖受信服务通知；失联时存在有限的检测和停止延迟，不能承诺远端撤销零延迟。第 6 节定义故障策略，第 9 节验证上界。

## 2. 当前代码事实与新增工作

| 证据 | 已有实现 | v1 新增工作 |
|---|---|---|
| [Relay realtime](../../src/crates/services/relay-service/src/realtime/mod.rs)、[presence](../../src/crates/services/relay-service/src/realtime/presence.rs) | 从认证 socket 注入 sourceDeviceId；每 5 秒复核 token；在线设备广播；通用 RPC 比较 client_protocol | 版本化远控路由和注册；复用鉴权、来源、预算与生命周期，补失败时关闭的边界 |
| [设备模型](../../src/crates/services/relay-service/src/db.rs)、[目录](../../src/crates/services/relay-service/src/routes/devices.rs)、[KMP 过滤](../../src/apps/mobile/shared/core-feature/src/commonMain/kotlin/com/openbitfun/mobile/core/feature/account/AccountDevicePolicy.kt) | kind 已贯穿 KMP 网络目录和 UI 状态；明确类型优先，旧记录才按已知手机/手表名过滤；会话控制保留 desktop/cli host | 远程桌面入口仅面向 desktop，再 probe；CLI 对远程桌面返回 unsupported，历史空值保留未知态 |
| [设备加密](../../src/crates/services/services-integrations/src/remote_connect/device_crypto.rs)、[Desktop 入口](../../src/apps/desktop/src/api/remote_connect_api.rs) | 设备密钥派生、加密消息与接收路径 | 固定 grant 指纹，新增远控 handler；正文不能覆盖认证来源 |
| [Admission](../../src/apps/desktop/src/computer_use/control_session/admission.rs)、[facade](../../src/apps/desktop/src/computer_use/control_session.rs) | runtime session owner、action 准入和清理；无抢占 | 外部 reservation 与清理接口，覆盖全部 AI 准入路径；不迁移 owner/target 模型 |
| [macOS](../../src/apps/desktop/src/computer_use/macos_capture.rs)、[Windows](../../src/apps/desktop/src/computer_use/windows_wgc_capture.rs) 捕获 | 精确窗口捕获，macOS 禁止代换整屏 | 新显示器级 source 和连续 raw frame，三平台分别估算和验证 |
| [Linux 控制](../../src/apps/desktop/src/computer_use/linux_control.rs)、[策略](../../src/apps/desktop/src/computer_use/linux_control_policy.rs) | portal/PipeWire、Unicode keysym；未接恢复 token | 原始帧、授权恢复与按后端验证文本 |
| [共享预览](../../src/apps/desktop/src/computer_use/desktop_host/shared_preview.rs) | 带截图身份的 Base64 轮询 | 独立视频链路；不扩大旧窗口许可、不改旧截图接口含义 |

## 3. 模块与 GUI 准入

| Owner | 职责 |
|---|---|
| `contracts/product-domains` | 稳定 wire DTO、能力、错误和纯产品规则；Product Operation Registry 声明 |
| `apps/desktop/src/remote_desktop/`（拟新增） | host 编排、本机 grant、原生 capture/input/media adapters；按 OS 分模块，SDK 依赖只由 Desktop feature/target 引入 |
| 现有 `computer_use/control_session` | 全局 GUI 互斥与清理；向远控暴露窄的 reservation API |
| 现有 Remote Connect / Relay owner | 加密路由和设备生命周期；不拥有 GUI/媒体，通用复用逻辑留在原 owner |
| 各控制端 | 页面/状态/平台生命周期；Android/iOS 经 KMP core-feature，HarmonyOS 独立 MVVM |
| `src/shared/remote-desktop-media`（拟新增） | 探针通过后收敛 PeerConnection/video/DataChannel；不导入 App UI、账号存储或 OS API |

v1 不预建 Capture/DesktopControl/Media 三套 runtime-ports，也不把 SDK 放入 services-integrations 或增加 assembly 注册层。产品规则保持平台无关；可复用行为仍归下层 owner，Desktop 只持有实际 host 生命周期和平台适配，不把本方案当成通用逻辑上移的许可。

媒体页只加载随 App 打包的固定资源，限制 CSP 和导航，只暴露 typed 窄桥；离开允许的 origin 即销毁桥。原生层仅传协商数据与短时 TURN 凭据，账号 token、设备私钥和 grant 存储不进入 JS，UI 组件不直接调用平台 API。

Admission 仅增加外部 reservation，显示器、连接、控制代次留在远控模块。申请在同一仲裁锁内检查有效 AI owner、starting/awaiting_share、busy、cleaning 和已有 reservation；不能只检查 snapshot.owner 是否为空，停止后的 snapshot 可能保留旧 owner。

持有 reservation 时，`begin_start`、`request_share` 和 `admit`（包括初始状态直接建立 Background owner）均拒绝 AI 准入。人工释放先关输入、失效 control generation、清理本租约注入的键/按钮与在途 worker，再按 reservation token 释放；迟到的旧释放不能清掉新占用，清理失败不能放行下一 owner。watchdog 在 Desktop facade/远控生命周期层，以单调时钟运行；Admission 不增加 OS handle、timer 或 IO。

外部 reservation 的纯状态与 facade 窄口已准备：`reserve_external_control` 在原 GUI 锁内返回不可反序列化的 opaque ticket；`with_external_control` 按 native → GUI 顺序拿锁，等待后复核 ticket，并持锁执行本次原生投递，不能以单次布尔权限查询代替。回调不得递归进入仲裁器、await 或等待其他 worker；其 PC / grant / lease / media health 检查仍由远控 owner 执行。`release_external_control` 先失效 ticket，使用同一个 native cleanup 锁运行该租约的 drain，并在等待锁后重新核对 ticket。失败保留清理屏障，迟到的旧 release 不执行清理、不清掉新占用；锁中回调 panic 后按 poison 状态禁用后续投递 / 清理成功路径，不能自动清锁或重建 owner。已进入 OS 调用的事件不可撤回，释放等待该投递返回后再清理；撤销生效后，排队的旧 worker 不执行。控制连接、显示器和协议代次不进入 AI snapshot；Admission 没有新增 IO 或 timer。Desktop 输入 worker 已通过这些窄口接入逐次投递、watchdog 和清理；当前默认构建已选择原生输入，执行仍受本机授权、租约、媒体健康和 GUI 互斥约束；完整原生故障及跨设备验收继续单独标记。

2026-10-15 生产源码的隔离 harness 通过 72 项测试（1 项真实浏览器 payload 测试按原规则忽略），包括原准入测试和新增 8 项外部互斥/清理/竞争用例；Desktop control_session 的 23 项聚焦测试通过，包含失败 drain 与排队旧清理在 native 锁后失效的 2 项 facade 测试。它们没有请求 OS 权限、采集屏幕或注入事件，不能替代 Native Input 与跨设备验收。这些早期测试不等于已通过普通输入开放评审。无抢占；AI 活跃但暂时无 action 也须原 owner 主动停止。仅查看不占输入 reservation，但独立 source 的权限和资源另行校验。

持锁投递接口加入后，本轮纯 Admission 聚焦检查 18 项、Desktop control_session 26 项通过；新增 3 项 facade 用例覆盖投递 / 释放竞争、等待 native 锁的旧 worker 和 panic 后禁用。专用窗口 Native Input 探针也已通过实际 reserve → 持锁投递 → release / drain → 旧 ticket 拒绝的路径，确认键、按钮和坐标回执。此处证明 GUI / 本机 native 边界，不补足设备操作 grant、媒体健康、远控 watchdog 或手机接线的验收。

## 4. 路由、能力和设备授权

### 4.1 当前独立服务接线

同一 Relay binary 以显式配对配置运行独立实例；使用自己的数据库和私密配置。
普通登录模式不宣告远控能力，HTTP 远控路由返回 404，`rd-*` 返回
`remote_desktop_service_required`。配对模式只提供设备目录、远控与 TURN，拒绝
账号登录、Pages 及通用 Agent RPC；数据库角色不匹配时拒绝启动并保留数据。

`remote-desktop/connection.rs` 持有 Desktop 的独立连接与代次；凭据和授权按规范化
服务地址的 SHA-256 分目录，账号连接 owner 不初始化或销毁它。鸿蒙使用独立 client、
Preferences/HUKS namespace 和 ViewModel。主动断开保留身份与凭据，并保存不自动
重连的选择。无法解析或不支持的配置保留，服务切换不导入旧授权。

`remote_desktop_pairing_v1` 明确协商后才向配置的 HTTPS 服务提交配对密钥，禁止
重定向携带密钥。登记前持久化设备私钥、设备 ID 和幂等 request ID；响应丢失保留
原身份重试。服务仅对同一公钥续签凭据，换钥不能继承授权。配对密钥只用于登记，
不保存到客户端；OpenBitFun 登录凭据不进入此流程。

2026-10-26 的验证范围：本地独立服务 HTTP/Socket.IO、加密持久化、身份与断线
竞态、Desktop 命令注册和账号回归，鸿蒙 host-side 状态回归与 HAP 编译。未运行
跨电脑画面/原生输入、鸿蒙真机连接、远程工作区、Peer Device Mode 或 Detached
Dispatch 验收；ControllerLocal 注册检查不等于这些远程场景已实测。Windows/Linux
三系统原生接线见 §4.2，实机验收仍待完成。

### 4.2 三系统原生实现（2026-10-26）

Desktop 默认选择 `remote-desktop-media`，不以无测试机为理由留下空实现。业务授权、
单 attachment、源生命周期、控制代次、健康和 GUI reservation 继续由原 owner 管理；
新增平台模块仅提供显示器身份、原始帧和原生输入，不另建协议或权限系统。

- Windows：显示器接口 ID 的 SHA-256 固定授权范围；GDI 连续采集选定屏幕并合成系统
  光标，线程级 DPI scope 保证物理坐标；SendInput 使用物理扫描码、Unicode 成对投递
  和虚拟桌面绝对坐标。只接受当前 Default 输入桌面，禁止 UAC/登录界面和隐式切桌面。
- Linux X11：RandR 输出名和 EDID 固定屏幕；无 EDID 使用进程/拓扑身份，重启或拓扑
  变化重新授权。ximagesrc 持续采集 BGRA；XTest 映射 USB usage 到 evdev/X11 码，文字
  临时使用未占用映射并在松键后恢复。没有空映射槽不声明文字能力。
- Linux Wayland：独立 Portal RemoteDesktop/ScreenCast 会话只请求 MONITOR 和嵌入
  光标，PipeWire 使用授权 FD。选择/授权只能在本机入口进行；停止和服务退役可取消在途选屏并关闭系统会话，
  不等待授权对话框超时。会话、尺寸或权限失效不回退到其他源。未实现持久恢复 token，
  重新授权产生新显示器会话标识。
- Linux 需要可观测的 ScreenSaver/桌面锁定状态；D-Bus owner 失效禁用源与输入。Portal
  只授予查看时不声明控制。空拉取不等于原生 idle，不伪造持续 source/decoder 进度。
- 原生输入沿用逐次最终许可检查和单 worker；只有成功松键/关闭源才释放原有清理屏障。
  文本逐个有界 chunk 提交，不经剪贴板，不在未知投递后重放。

Linux 控制端的 `receiver.rs` 使用同一版本的原生 libwebrtc 接收/解码，验证收到的
DataChannel 确为 reliable/ordered。帧以有界二进制 IPC 交给隔离文档的 canvas，最多一
帧等待呈现 ACK；解码和呈现计数分开，不把收到二进制数据当成已呈现。原有共享
`receiver.js` / `control.js` 负责绑定、健康、焦点、操作租约和背压。原生桥只开放
open/send/stats/frame_ack/close，不向沙箱提供 Tauri、账号凭据或通用 invoke。
关闭、服务代次变化、迟到初始化和失活的 UI 不得恢复旧 PC；同一进程只保留当前接收器。

WebRTC SDK 的六个桌面 release 架构均记录上游静态库 hash，构建前核验；新增 hash
不代表 ABI/系统运行验收。RustDesk 本地源码仅用于参考原生平台处理方式，没有引入其
协议、运行时或复制 AGPL 实现。API 依据为 [Windows SendInput](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput)
和 [Portal RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)。

### 4.3 既有协议与历史账号链路记录

以下保留原账号 Relay 联调及协议细节；其中共用账号 socket、账号退出导致停流和
账号设备目录的描述已由 §4.1 的独立连接替代，历史验收不得用于证明新部署链路。

产品公网信令与凭据领取使用 HTTPS；loopback HTTP 仅用于本地或 SSH/USB 开发隧道。Rust TURN 领取入口已拒绝公网 HTTP，账号 bearer 不进入媒体 JS。

Relay `/api/info.capabilities` 增加 `remote_desktop_route_v1` 作为明确发现入口；不改 Handshake/Identity，不新增 routing_epoch。获取信息失败显示连接未知/失败；只有成功响应明确缺少能力时提示 `relay_upgrade_required`，不能把超时当版本判定。

新增版本化 `rd-register / rd-call / rd-request`，沿用 rpc-register 的认证 socket/房间生命周期与唯一 owner 规则。host 注册其设备的 v1 handler，Relay 从认证身份构造账号/设备作用域，禁止客户端任意加入别人的房间；连接断开即失去注册，重连重注册。Desktop 重连时新旧 socket 可能短暂重叠，此时的“multiple owners”/`target_unavailable` 只能按暂不可达重试，不能判为撤销或 unsupported。调用携带协议版本，Relay 路由与 host 分别校验。目标不在线/尚未注册返回 `target_unavailable`；只有明确 capability 结果才能判 `unsupported`。控制端通过成功的 v1 调用和 host probe 协商，无需另加握手能力字段。

专用路由不走通用 RPC 的 client_protocol 相等 gate，也不提供任意 skip_compatibility。复用同账号校验、来源注入、设备加密、超时和总预算；远控有独立子预算。host 用固定设备密钥解密后形成来源上下文，授权前重新校验本地 grant。未协商委托身份、匿名房间和通用 HostInvoke 不得进入此 handler。

Relay 路由实现见 [remote_desktop.rs](../../src/crates/services/relay-service/src/realtime/remote_desktop.rs)：`rd-register({version:1})` 仅注册认证 socket 自己的 host 设备，`rd-unregister` 仅释放该 socket；`rd-call({version:1,targetDeviceId,params:{encrypted_data,nonce},timeoutMs})` 派发为 `rd-request`，来源设备由 Relay 注入。密文请求/回复各限 128 KiB，超时至多 30 秒；独立账号/服务器子预算为 2/8 MiB，同时占用原总预算，并为回复预留空间。无唯一当前 owner 时返回 `target_unavailable`，派发后 ACK 丢失或身份失效返回 `delivery_unknown`，不会向新 socket 自动重发。两种挂载布局、不同通用 RPC 版本和旧 Handshake 已由真实 Socket.IO 测试覆盖。路由发现不授予屏幕权限；鸿蒙经真实账号和强制 TURN 的受限原生媒体证据见下文，公网 HTTPS、其他平台和完整故障矩阵仍未完成。

本机设置可从账号设备列表**提前授权**，也可响应首次请求，选择仅本次或记住设备。grant 绑定账号、设备 ID、公钥指纹、view/control 和显示器范围；名称不作身份。未知设备只得有限能力状态，授权前不发缩略图/视频。换密钥、设备重装导致 ID/公钥变化或账号改变重新确认；grant 不经同步自动授予另一台 host。

本机录屏授权通过 `remote_desktop_capture_consent` 暴露 `request` / `open_settings` 两种动作，声明 ControllerLocal 并复核当前本机 main 文档；内部复用现有 OS consent adapter，不能直接复用会被 Peer 代理的 Computer Use 命令。它不创建 view/control grant、不启动捕获，也不申请辅助功能。系统是否显示提示、是否需要重启由 OS 决定，刷新实际状态后再连接；手机协议仍不包含替本机确认 OS 授权的操作。

只读阶段的纯规则已落在 [product-domains/remote_desktop](../../src/crates/contracts/product-domains/src/remote_desktop.rs)：账号/设备/规范化公钥指纹与明确显示器 scope 匹配后才准入单 attachment；live 重试先于 CAS，本机停止先关逐帧闸门，清理确认前不创建下一连接，旧回调/迟到 detach 不影响新连接。传输准备与开始发送分开；host adapter 验证媒体绑定后才开放逐帧发送。失联宽限在逐帧闸门和重连复核中都校验，不能依靠延迟 watchdog 或晚到重连复活过期画面。grant 文件缺字段默认不授权，未知 schema 保留并禁用；Desktop 本机 view grant、原生确认和专用 handler 已接入；原生媒体 owner 已由可选 feature 接线；Relay attachment 关联和 Desktop 失效通知也已接入，隔离账号下的停流、恢复与资源回收证据见第 4、7 节及下文背压探针；不把纯规则当成已获得 OS 权限或完整验收。

[设备加密接线](../../src/crates/services/services-integrations/src/remote_connect/remote_desktop_device.rs)复用 X25519/HKDF/AES-GCM，并以固定 32-byte 公钥的 SHA-256 构造授权指纹；来源来自认证路由，不读密文正文中的自报身份。只读 DTO 已含能力、显示器列表、状态、attach/detach 和 `signal` answer；输入、本机授权和通用 Agent 命令不在这个 dispatcher 的协议中。Rust sender 与[鸿蒙 AccountRealtime](../../src/apps/mobile/harmonyos/entry/src/main/ets/services/AccountRealtime.ets)已增加显式能力 gate 的 `rd-call`，不走 invoke/bulk；Desktop 在成功发现专用路由后，通过既有账号 socket 注册只读 handler；CLI 等未注册 provider 的 host 明确不支持。自动重连的注册 ACK 与入站回调用本机 socket 对象编号隔离，不增加 wire 代次。隔离测试身份已通过这条账号路由完成 macOS → 鸿蒙只读呈现；邮箱 / GitHub 身份服务及公网 HTTPS 尚未纳入这次验证。

Desktop 的本机设置入口位于“我的设备 → 本机远程桌面”：明确选择账号设备和稳定显示器 UUID，原生确认框显示设备 ID、公钥指纹与授权 scope；确认前后复核账号、公钥和显示器，不能经 Peer/远端 mailbox 代批。授权文件沿 PathManager 的本机 data 目录保存，限制大小并原子替换，保留未知字段；损坏、新 schema 或外部改动不重置。撤销先使内存授权失效，保存失败禁用后续写入并明确报错，防止旧磁盘快照被下一次授权重新导入。可操作阶段接入前，本机授权确认必须先关闭并排空远控输入，防止已授权远控用 OS 点击替其他设备确认。默认构建仍返回 `media_backend_unavailable`；启用 `remote-desktop-media` 后，须具备原生录屏许可、可用 TURN 签发及安全信令入口，才开放只读 attachment。本机 UI 与存储测试不能代替真实账号媒体验收。

授权候选目录单独使用 `GET /api/remote-desktop/controllers`，以 `remote_desktop_controller_directory_v1` 协商；既有 `/api/devices` 继续只列可连接的 host。新目录要求完整设备凭据，仅列同账号、已登记公钥的 desktop/mobile，排除自身和委托凭据，不返回公钥或任何授权。最多 256 项、64 KiB，超限明确失败，不截断后假装完整。旧 Relay 缺能力时 UI 提示升级以授权手机；目录失败时保留本机停止和撤销，禁用新增授权。候选出现不证明在线、远桌兼容或已获授权，确认时仍重新读取公钥并固定指纹。

“停止共享”独立显示在本机远程桌面标题栏，管理区折叠、候选目录未就绪、设置读取或授权确认等待时均可发起；只对自身在途的停止请求防重复。停止使旧设置结果失效，失败明确提示并等待用户重试。原生停止只按当前账号代次进入远控 owner，不等待可能跨网络 IO 的账号操作锁；owner 内的代次校验与清理屏障继续生效。它不撤销已保存预授权，也不自动重新共享。

本机预授权现已区分 `remote_desktop_approve_view` / `remote_desktop_approve_control`，两者均为 ControllerLocal / CLI REFUSED 并校验当前 main 文档，RD wire 不提供此操作。现有 v1 grant 文件与 `display_ids` 保留原查看含义，新增 `control_display_ids` 默认空；只有同一账号 / 设备 / 公钥记录中同时允许查看和操作的显示器才有输入资格。重新确认仅查看明确写空操作范围，撤销设备删除整条记录，换钥不继承旧范围。当前参与者的授权范围变化先使旧绑定失效并清理，其他设备的预授权不打断当前流。UI 根据可选 `control_grant_supported` 显示独立入口，旧 host 缺字段时不调用新命令；当前 `control_available:false`，允许保存预授权但不开放输入，也不申请 OS 操作权限或创建租约。

原生确认前取得私有、无注入状态的 GUI reservation，保护确认期间的应用内 AI / 远控准入；有效 AI owner、已有远控或清理未完成时直接返回 busy，须先停止原操作。取消、账号 / 密钥变化或任务退出均释放该临时 reservation；它不持仲裁 mutex 等待用户，也不把 ticket 给输入 provider。此 guard 的测试不接受系统弹窗，隔离测试身份下的本机只读和操作确认已由操作者实际完成；输入退出后的 OS 队列排空和完整账号撤销链仍须验收，不能由存储测试替代。

控制端 Tauri sender 已接入 `remote_desktop_request({request:{target_device_id,payload,context?,attach_id?}})` 和 `remote_desktop_turn({request:{target_device_id,attach_id,context}})`，registry 声明 `Agnostic / ControllerLocal / REFUSED`，不跟随当前 Peer/SSH；两者均复核当前本机 main 文档。首次授权另走本机 UI 通道，禁止 Peer proxy、远端 permission-mailbox 自批；ControllerLocal 本身不是充分的安全校验。

首次仅允许无 context 的 capabilities 探测，返回 `{context,payload}`；后续请求保留此 context，不能重新探测以重试旧 mutation。context 固定本机账号 / 设备连接 / socket、目标和公钥指纹，计数使用十进制字符串，禁止持久化；它不是授权，仅用于拦截旧 UI 请求。原生桥在请求前后复核身份，响应返回前重新读取目录公钥；账号切换取消等待，旧 socket 或换钥的结果丢弃。context 不进入 Relay / DC，服务端和被控端继续执行自身授权。TURN 复用相同绑定，只返回该 attachment 的短时凭据；无降级到公共 TURN 或其他设备。网络失败使用有限错误码，不转发任意 transport 错误正文。

Rust 账号连接 owner 已补充控制端 `request_remote_desktop`：复用既有 socket，不要求控制电脑具备本机捕获 provider，也不注册被控路由。调用方在解析并固定目标公钥前取得本机连接凭据，整个 attachment 保留它；请求前后核对同一 owner、账号连接与 socket 代次，迟到成功 / 错误均不能作用于新连接。仅发送有界密文和显式目标 / attachment，不走通用 invoke 或自动重试。真实 loopback Socket.IO 延迟 ACK 测试已覆盖这些边界；此处不代表电脑端产品 UI 或 PC → PC 媒体已交付。

host probe 返回 `protocol_versions`、availability、实际 provider capabilities、codecs、授权状态与当前 state_revision。文本未验证不声明 `text_commit_v1`；Linux 可报告 system_picker，不伪造显示器列表。CLI 无 provider，明确 unsupported，原聊天功能继续原路径。

鸿蒙操作端已接入受能力协商约束的准备路径：只有 host 声明 `ordered_control_v1` 才展示申请入口，显式申请先读取当前 attachment 的 CAS，再经绑定的 DC 请求；界面保留 host 发出的 `control_generation`，原生输入意图同时固定本地 renderer 身份，发送前校验后移除此本地字段；即使新 PC 重用相同代次，旧手势 / 草稿也不能重新绑定。原生触控策略独立处理黑边、鼠标 / 直接触控、长按、双击按住拖动、滚动 / 捏合判定及本地缩放平移；切换模式先释放操作。手机虚拟键盘通过原生 IME 代理将确认的字词立即提交到远端焦点，无本地草稿/发送按钮；composing 不发送，缺 `text_commit_v1` 不开放文字输入。原生到 WebView 使用有界 FIFO，覆盖连续按下 / 松开，停止或释放丢弃尚未提交的旧输入，溢出结束连接。正常源码的执行 / 发现 acceptance gate 仍关闭；隔离试用构建可用于实际链路验收，不能据 UI 夹具宣称已支持远端操作。

键盘关闭先使本代输入与预编辑失效，再串行卸载本 owner 的 IME 回调并 detach。每个卸载独立处理平台错误，单项失败不跳过其余回调或 detach，不全局注销其他编辑器；旧回调保持无效，下一键盘等待旧 detach 完成。

延迟打开固定发起时的 renderer / control generation，执行时须仍在前台查看、控制有效且信令正常。输入、失败和隐藏回调同时核对该绑定、当前实例和面板的本地打开请求；收起同步使旧请求失效，不等待 ArkUI 参数传播或卸载，同一次界面刷新内收起再打开也不能复活旧请求。已取消但排队的 timer 不得替换新请求。这个请求只属于 UI 生命周期，不进入远控协议。

六类组件竞态先失败再修正；键盘 / 控制器 124 项聚焦测试、架构检查和签名构建通过。当前包真机宽 / 窄 × 浅 / 深与竖屏浅色五组 IME 检查通过。当前正常手机包与受限 macOS 发送端经真实账号 / 强制 TURN，分别完成单次键盘内的中文 → Backspace → Return，以及重开键盘、取消未确认拼音后继续编辑：拼音不外发，“你好”候选一次进入 Mac 输入框，退格 / 回车各一组按下 / 松开，最终为“你”加换行。停止后超过 5 秒无追加输入且保持查看；收尾恢复普通页面、关闭输入的 Mac 运行时及无按键残留。此前组合流程的 `control_delivery_unknown` 仍保留为未解释失败，新的单次成功不证明根因已修复，也不替代完整故障矩阵。平台卸载错误和组件调度竞态为模拟注入，真机输入与故障验收分别记录。

拖动中加入第二根手指，先结束旧按钮序列，再判定滚轮 / 捏合；取消同时清除双击历史。几何或绑定改变时，清理意图仍使用旧 renderer / generation，迟到的松手不能转成新租约下的点击。纯策略测试已覆盖这些转换；真机浅 / 深主题、宽 / 窄布局已验证原生直接触控坐标和双击后拖动的意图配对，此 UI 夹具不注入 OS 输入。

手势时长通过 [GestureClock](../../src/apps/mobile/harmonyos/entry/src/main/ets/services/RemoteDesktopGestureClock.ets) 把 ArkUI BaseEvent 的启动时间纳秒转换为毫秒，Down / Up 使用事件产生时刻，不使用 JS 处理时刻或日历时间。长按交给鸿蒙原生 LongPressGesture，避免 JS 定时器抢在排队的短按 Up 前误发右击。 原生回调作为已识别意图处理，不用其时间戳再次判断持续时间；[上游实现](https://raw.githubusercontent.com/openharmony/arkui_ace_engine/master/frameworks/core/components_ng/gestures/recognizers/long_press_recognizer.cpp)的回调可保留最近触摸时间。双击第二次按住即使长按回调晚于 Up，也保持主键意图，不改发右击。非法或回退的触摸时间取消手势并释放操作，不回退到处理时刻；同一查看上下文的释放确认不清除“操作已暂停”，新的显式申请才清除旧提示。迟到长按仍须匹配当前 renderer / generation、活动触摸和页面；旧事件不能操作后继手势。媒体凭据预算继续独立读取包含休眠的 live uptime，不混用触摸时间。

实际 viewport 处理器的反例已覆盖短按 Up 延迟处理、双击窗口被处理延迟拉长、长按回调晚于 Up、回调保留最近触摸时间，以及非法 / 回退时间、失败清理和迟到回调；短按误判、第二次按住误发右击、原生回调被重复计时三项均先失败复现再修正，125 项手势 / 控制器聚焦测试通过，未修改真机系统时间。 调度延迟为处理器模型注入；最终鸿蒙包另完成宽 / 窄 × 浅 / 深四组真实点击、双击拖动和长按检查，以及真实账号 / 强制 TURN 的 Mac 输入框点击、IME 重开、固定文字 / 退格 / 回车。没有在真机人为阻塞 UI 线程，原偶发 `input_suspended` 是否同因仍未确认。DEL-AL10/API 26 的宽 / 窄 × 浅 / 深原生夹具验证点击、双击拖动和长按配对，恢复原方向；此前真实账号 / 强制 TURN 弱网回归另收到 5 对可信按下 / 松开和 57 次拖动，结束无残留。这些证据不替代物理折叠、锁屏或 OS 权限撤销验收，普通输入 gate 仍关闭。

混合原生界面以 app 窗口为焦点边界：鸿蒙在 `WindowStage` 的 INACTIVE / HIDDEN 以及 Ability 后台 / 销毁时关闭当前连接。固定媒体页的 `native_focus` 只由这个原生 owner 设置，使原生工具栏 / 虚拟键盘取得焦点时不误判成离开 app；Web 控制端缺字段时继续检查实际 document focus，两者都要求媒体 document 可见。该原生窗口生命周期及实际输入 / 清理仍须端到端验证。

2026-10-15 隔离试用构建已通过真实账号 / 强制 TURN：鸿蒙显式申请租约后，原生本地草稿提交到临时 Cocoa NSTextView，固定中文、emoji、组合字符与长数字共 59 个 UTF-16 单元完整匹配，8 组按下 / 松开；随后物理左方向键另收到 1 组，文本保持匹配。草稿编辑期间 Mac 收据保持零输入。此轮只证明该窗口的文本和单键路径，收尾曾出现 `control_delivery_unknown` 并关闭连接。

释放边界已覆盖：原生层同步释放后，丢弃当前 PC 已退役租约的迟到状态，不恢复旧操作权；未知授权、取消后首次到达的未知授予仍关闭连接。共享 JS 在释放结果未知时保留原期限与串行屏障，重复释放不清掉等待，也不放行新申请。若 host 健康失效丢弃排队的 release，同一租约的 `control_revoked` 也可确认释放；client 在 pending 中保留该代次用于关联，不增加 wire 字段。缺少或不匹配代次的通知不能清掉 pending，尤其不能取消结果未知的 acquire；确认始终缺失仍按原预算关闭。控制端反例、真实 Chromium DataChannel 和下述真机故障注入分别覆盖这些边界。

2026-10-16，当前普通鸿蒙包经账号 / 原生屏幕 / 强制 TURN 完成三轮定向释放故障试验：隔离 Mac 构建仅丢弃成功的 release 回复，保留原生清理和后续撤权通知；手机每轮收到匹配撤权，跨过原 4 秒确认期限仍仅查看，下一轮由显式申请重新取得租约。其中一轮包含虚拟键盘开合。隔离构建在普通动作和 Unicode 提交前一律拒绝 OS 输入，未观察到输入请求，因此这是空租约 / 原生 owner 清理证据，不证明持键松手或真实文字投递。历史 `control_delivery_unknown` 的根因仍未定位；不能由此次定向成功宣称该偶发问题已修复。

修复后的鸿蒙真机 / 真实账号 / 强制 TURN 无输入联调连续完成两轮申请、续约、释放和再次申请：每轮持有超过 6 秒租约期限，释放后超过 4 秒 ACK 预算仍保持查看。随后重跑上述固定文字与左方向键，Mac 共收到 9 组匹配的按下 / 松开；显式停止操作后等待 5 秒，仍保持查看、可重新申请且无迟到输入。该轮自动化在文字提交后因工具栏滚动位置中止，校验既有原生收据后仅继续方向键和释放，未重发文字。以上覆盖文本、单键及释放确认；后续鼠标故障验证见下文，不能据此开放普通输入 gate。

同日另经测试人员确认，在专用原生窗口执行一次单击和按住拖动；Mac 收据确认按钮仍按住且已收到拖动事件后，在正常手势松手前强制退出鸿蒙试用 App。真实账号 / 强制 TURN 链路最终收到 2 次按下、2 次松开和 21 次拖动，合并会话的左键状态已释放，无迟到按下或重复松开，未发送键盘事件。从发起退出到收据确认约 5 秒，包含测试命令和轮询开销，不作为清理延迟或交互 P95。此轮只证明手机进程退出时的鼠标释放，不验收坐标准确性、按住键 / 修饰键、正常后台、冻结、撤销或全部故障路径。收尾关闭专用窗口，保留手机登录数据；源码及 Mac 运行时均复核操作 gate 已关闭，恢复只读。

随后补充正常后台：在隔离 Desktop 的空白内容区，经同一账号和强制 TURN 执行单击及按住拖动；Desktop 实际事件与 macOS 合并会话状态均确认左键仍按下后，通过手机 Home 返回桌面。手机进程保持原 PID，Mac 在该手势按速度计算的最早正常松手时间之前已收到释放；最终为 2 次按下、2 次松开，等待 5 秒无迟到事件，未发送键盘或文字。再次打开原手机进程，界面明确显示“已断开”，没有自动重连或取得操作权；被控端共享槽已排空。此轮覆盖正常后台的鼠标释放和前台不自动恢复，不替代按住键 / 修饰键、锁屏、撤销及冻结实验；未据测试命令耗时给出交互延迟结论。

补充按住键验收：同一隔离账号 / 鸿蒙真机 / 强制 TURN 路径，私有故障包只制造缺少松开的输入，不向普通产品添加测试入口。macOS 合并会话先确认 Shift 确实按住，再点手机“停止操作”，Shift 实际释放；再次申请后发送旧租约的方向键按下，再发送当前租约的 Shift 按下作为同一有序队列的处理屏障，观测到 Shift 按住而方向键未按住。随后通过正常手机键盘发出方向键，故障包仅丢弃对应松开；返回手机 Home 后方向键释放，手机 PID 保持，前台显示断开且不自动重获控制。显式重连、重新选择显示器并申请后，再确认 Shift 按住，强制退出手机 App 后 Shift 释放。未发送文字，独立安全 watchdog 未触发；收尾复核全部键与 Shift flag 已释放，恢复正常签名包、竖屏和关闭输入的运行时。此轮覆盖停止、正常后台、进程退出及旧代次拒绝，不替代按住键期间旋转、锁屏、冻结、授权撤销或完整故障矩阵。

## 5. 最小状态与命令

### 5.1 保留的四种 wire 标识

| 标识 | 作用与生命周期 |
|---|---|
| `attach_id` | 控制端 UUID，一次共享生命周期；host 绑定认证来源，单 attachment |
| `connection_id` | host 每个 PeerConnection 生成新的随机值；Relay 上的 SDP/ICE 据此关联，丢弃旧连接信令；替代 transport_epoch、negotiation ID |
| `state_revision` | host 全局不透明版本，授权/占用/媒体状态变更时更新，所有 CAS 共用；启动随机前缀 + 单调计数，重启不复用；合并 host_instance、slot/target/geometry/authorization revision |
| `control_generation` | attachment 内每次授予/撤销输入推进；输入携带以拒绝旧桥队列/worker，不因通道可靠而删除；整数在 JSON 中为十进制字符串 |

revision 不随心跳、统计或每帧更新。renderer 回调有效性由本地对象身份/取消标记保证，不增加 wire 代次。删除输入 seq、signal seq、bind nonce 和通用 request_window；请求响应相关性复用现有 RPC ACK，DataChannel 上的低频 mutation 串行执行，结果不明先查快照。

```json
{
  "version": 1,
  "op": "attach",
  "body": {
    "attach_id": "attachment-a",
    "expected_state_revision": "boot-random:12",
    "display_id": "display-a"
  }
}
```

attach 先校验当前认证来源和 grant，再做 live 幂等匹配，最后做 CAS：相同来源、attach_id 与初始 display 的 live 重试返回现状，不比较 revision（成功的 attach 本身已推进 revision），不重复建 PC；相同 ID 不同初始 display 拒绝；另一 attachment 占用返回 attachment_busy。`expected_state_revision` 不属于初始参数；槽位空闲但版本不符时返回 `stale_revision` 与新快照。v1 不自动替换 revision 重试，即使客户端仍保留连接意图：空槽无法证明此前没有成功创建后被本机停止。用户明确重新连接后，才读取当前 revision 并生成新的 attach_id。

鸿蒙断开页现提供显式“重连”：重连选择信息只含目标设备 ID、账号 ID 与 Relay 地址，不包含通道密钥、输入队列或租约；尚在途的旧 attach 仍由自己的旧通道完成有界清理。用户点击后重新读取设备目录，再通过现有 `capabilities` / `list_displays` 建立新通道上下文；停在显示器选择，明确选择后才生成新的 attachment / renderer，恢复仅查看。探测中重复点击不重复请求；账号或 Relay 改变、退出、后台与新的设备选择使迟到目录结果失效。此操作不新增 wire 命令，也不复用或自动重放旧 attach。已在同一鸿蒙真机进程中验证后台结束共享、返回断开页、显式重连、重新选择显示器及强制 TURN 新首帧，全程未申请操作权；最后显式断开，替换后的共享资源也已排空。

创建、关闭及本机停止均推进 revision，因此关闭后迟到的 attach（旧 revision）和 host 重启前的请求（旧启动前缀）都不能重新占槽。控制端作废已关闭或已取消的 attach_id，不再用它重试；响应未知先 get_state，只有同一 live attachment 才继续使用；空槽或版本冲突均等待用户重新连接，不自动换 ID 或 revision 重试。无需无限 tombstone。

只在 `delivery_unknown` 时查询 attach 快照；`stale_revision`、占用、清理中和授权拒绝保留原错误，不冒充 ACK 丢失。失联后的旧 attachment 已结束且原生清理完成时，用户重新打开的 `list_displays` 经 host 校验当前账号 socket、来源目录 / 公钥及 grant 后，可以清除空槽的失联状态，并推进 revision 拦住失联前的 attach；重复探测不反复推进。仍有 attachment 或清理屏障时，探测不能恢复旧媒体或操作权；旧 PC 的恢复继续要求匹配的 Relay ready 与绑定复核。

当前只读接线：attach 可带 `force_relay`（缺字段默认 false，live 重试不能改变）；先返回 binding 快照，路由关联 ready 后异步准备 PC。控制端以同一 attach_id 读取 `get_state.media.offer_sdp`，提交 `signal` body `{attach_id, connection_id, answer_sdp}`；相同 answer 幂等，不同 answer 拒绝。get_state 的同一 live 关联可显式重新验证，不创建新 attachment。输入与本机授权均不在 signal 中。准备/绑定有 60 秒总预算，当前 PC 非预期断开最多恢复 15 秒；清理完成前全局媒体槽不释放，账号替换也不能绕过。每个 PC 到 TURN 凭据到期即结束，并明确报告 `turn_credentials_expired`；领取时冻结剩余单调时间预算，逐帧与输入提交直接检查同一有效期，不能只靠异步轮询清理。系统时间前跳可提前结束，回拨不能延长预算；观察到失效后不可恢复。控制端已接入能力协商的提前重建，见下段；多周期长稳验收仍待完成。

续期复用现有 source 生命周期，不增加信令命令或并行 PC。host 同时广告 `source_lifecycle_v1` 和 `credential_rebuild_v1`，在 `get_state.media.credentials_remaining_ms` 返回当前 PC 的相对剩余时间；准备凭据前可为 null，已有 offer 时必须为有效毫秒数。鸿蒙和电脑控制端取 host 剩余预算与本端 TURN 到期预算的较小值，并扣除请求耗时；固定本地单调 / 墙钟期限，后续快照只能缩短，不能续活当前连接。仅在已呈现、信令恢复且预算尚未到期时，于剩余 60 秒内执行 suspend → 等待 `cleanup_pending=false` → resume；同一 attachment 使用新的 connection、renderer 和凭据，须等新首帧，恢复仅查看。手动暂停、后台、账号替换及退出不能因此被唤醒；身份 / 授权失败、已过期或新凭据不足 60 秒时明确结束，避免重建循环。旧 host 缺能力时沿既有到期错误路径，不假定支持续期。原生逐帧 / 输入到期闸门保持独立，控制端计时不授予权限，也不延长原 PC 寿命。

2026-10-16，225 项聚焦测试通过（鸿蒙控制器 / 传输 136、电脑控制器 64、host 生命周期 / source 25），鸿蒙签名包与 macOS 发送端构建通过。正常关闭输入的试用包在 DEL-AL10 → macOS 原生显示器、真实账号 / 强制 TURN 上运行约 9 分半：同一手机进程内自动重建一次，共两次真实首帧，新候选对仍为 relay/relay，原签发窗口结束后继续仅查看。收尾本机停止、原生清理完成、普通 App 重开，TURN relay UDP socket 为 0。观测脚本中途因 hilog 淘汰首帧记录更换计数器，未重启媒体或手机；后续事件按带时间戳的日志行去重。该只读结果不证明持键清理；下述探针单独覆盖正常网络的一次持键续期。弱网、多周期长稳和双电脑实机仍未通过，普通输入仍关闭。

2026-10-20，鸿蒙 → Mac 原账号 / 强制 TURN 连续观测未通过：同一手机进程在首帧约 7 分 41 秒后自动续期，约 2.6 秒收到新的 1280×828 首帧和 relay/relay 路径；约 81 秒后 `get_state` 返回 `invalid_request`，控制端在仅查看状态结束连接，未进入第二轮续期。未重启 Mac、Relay 或 TURN，未发送 OS 输入；这轮日志和原生控件状态不证明连续像素更新。错误来源尚未确定，不能据此归因于凭据到期。Desktop 请求校验增加固定的 `key_lookup / decrypt_request / attachment_route` 失败阶段日志，保留原拒绝行为，不记录密钥、信令或输入正文；桌面远控聚焦测试 76 项通过、7 项原生专项未执行。

随后部署 Mac 诊断版，在原设备密钥和原授权下重新收到强制 TURN 首帧，约 84 秒后接收器报 `media_unreachable`，尚未进入续期，Mac 没有对应的请求校验失败记录；这次错误不能与前一轮 `invalid_request` 合并归因。鸿蒙补充已有接收器事件的本地失败阶段日志，旧事件缺字段或未知值记为 `unknown`，退休连接不记日志，停止行为不变；139 项控制器测试和签名构建通过，已原位更新。后续发现真机界面树处于锁屏页，而截图仍显示先前应用画面；新包复测须先解锁并保持前台，锁屏与两次断开的因果关系仍待验证。鸿蒙多周期与完整长稳仍待验收。

同日电脑控制端完成有限双周期对照：一台 Mac 的两个隔离产品进程，经原账号、原生显示器与强制 TURN 运行约 13 分半；同一 attachment 连续重建两次，三个连接均呈现 1280×828 首帧并确认 relay/relay，保持仅查看。最后一次重建后继续观察 91 秒，解码增长；认证快照确认当前第三个连接仍 streaming、没有媒体错误。原生窗口截图也确认画面中的桌面时钟更新。旧通道关闭事件未终止后继连接；新增回归同时覆盖退休通道关闭与当前通道故障，52 项 source 生命周期测试通过。产品入口断开后，host 确认无 attachment / 媒体、busy=false、cleanup_pending=false，额外控制端退出；TURN 转发 UDP socket 归零。它不证明鸿蒙故障已修复、两台实体电脑、OS 输入或长期弱网表现。

另有一次真实持键续期：原账号 / macOS 原生显示器 / 鸿蒙 / 强制 TURN，临时受限包只投递一次 Shift-down，未额外注入 key-up 或重放输入。实际持键约 7.6 秒，自动流程产生一组可信 down/up，OS 键状态与修饰键标志清零；本机最终停止前已确认旧 Rust wrapper 排空、新 PC 呈现且继续解码，两个 PC 的所选候选均为 relay。手机进程保持，仅有一次操作权申请，重建后保持仅查看；独立 20 秒持键保护与外层恢复保护均未触发。原 GUI Admission / facade 44 项聚焦回归通过。收尾恢复普通关闭输入的两端包，原账号再次呈现，正常停止后 TURN 转发 UDP socket 为 0。此结果不隔离客户端 release 与 host 清理的各自贡献，不证明弱网、多周期、权限撤销或 C++ 析构；真实双屏当前无设备，继续保留待验收状态。

[切屏/暂停纯状态](../../src/crates/contracts/product-domains/src/remote_desktop/source.rs)已实现保留 attachment 的转换：`suspended` 快照保留旧 connection_id 仅供清理关联，不能用于 bind、送帧或操作；只有确认旧 PC 排空后，resume 才使用 host 新生成的 connection_id 进入 binding，恢复仅查看。迟到的旧 bind/close 不能启动采集、删除保留的 attachment 或关闭后继 PC；暂停期间停止/撤销保留已有清理屏障，清理完成后停止不虚构不存在的 PC。Desktop 媒体 actor 已具备对应的内部保留逻辑：输入与 native 回调全部排空后才确认可重建；无 PC 状态最多保留 60 秒，ready 通知不延长预算，旧 actor 不注销仍属同一 attachment 的 Relay 关联。60 秒保留已完成正常网络下的鸿蒙真机只读过期 / 重连验证；弱网预算仍待实验。[Desktop source handler](../../src/apps/desktop/src/remote_desktop/requests/source.rs)已接入 `suspend / select_display / resume`；ready provider 广告 `source_lifecycle_v1`。鸿蒙已接入能力协商的暂停 / 恢复入口：先废弃手机输入和旧 renderer 回调，保留旧 PC 到 host 确认 suspended，再关闭本地媒体并轮询实际排空；同一固定密钥通道读取新 CAS，resume 取得新的 connection / renderer，等待新首帧，恢复仅查看。丢 ACK 仅查一次同一 attachment 快照，旧 poll / media 回调不能作用于新阶段；退出等待在途 source mutation 完成后 detach。宽 / 窄和浅 / 深原生界面及定向竞态测试已覆盖；鸿蒙还已接入暂停后的显示器选择：重新读取当前允许查看的目录，序号只用于呈现，实际请求始终使用不透明 display_id；目录读取沿用不带 outer attachment 的发现请求形式，仍受固定账号 / 公钥通道和本地阶段隔离约束；select_display 与 resume 则带匹配的 outer attachment；选择前读取新的 state_revision，select_display 确认同一 attachment 的目标与排空状态后调用既有 resume。目录读取、取消、选择及恢复均隔离旧回调；取消保持暂停，丢 ACK 仅查快照，不重新选择或回退旧目标。物理双屏切换与双电脑实机验收仍未完成，以下既有真实账号证据只覆盖鸿蒙到 macOS。

2026-10-15，macOS 原生显示器 → DEL-AL10/API 26、真实账号与强制 TURN，正常鸿蒙界面在操作权与实际 IME 开启时执行“暂停共享”：电脑侧旧 PeerConnection 析构，手机键盘关闭，原手机进程保留。暂停期间更换测试图案后点“继续查看”，第二次新首帧呈现新图案，新的所选 candidate pair 再次为 relay/relay；界面仅查看，没有自动取得操作权。手动开启后的一次画面点击在 Mac 独立目标收到且仅收到一组 down/up 与一次 click，停止操作后等待 5 秒仍保持查看。该轮使用正常协议和产品入口，无故障包，不发送文字；收尾排空并恢复普通关闭的输入 gate。它不验证完整 60 秒保留期限、多显示器切换或弱网预算。

同日补充实际选屏入口：在相同账号 / 强制 TURN / 原生发送路径，暂停后重新读取目录，取消后仍留在暂停页，再次读取并选择“当前”项，经 select_display / resume 收到新首帧和新图案。恢复仅查看，显式重新开启后的点击收到一组 down/up 与一次 click；收尾清理成功。该真实目录仅有一块已授权屏幕，属于当前屏幕重选，不能计为物理双屏切换。两条显示器元数据下的选择、当前标记、取消和尺寸变化已用无账号原生 UI 夹具覆盖宽 / 窄、浅 / 深四种组合；包含发现请求 scope 拒绝的 89 项聚焦测试通过。

电脑控制端的 [RemoteDesktopController](../../src/web-ui/src/infrastructure/remote-desktop/RemoteDesktopController.ts) 与 [Viewer](../../src/web-ui/src/app/components/RemoteConnectDialog/RemoteDesktopViewer.tsx) 已复用上述 source 命令：能力缺失时隐藏入口；暂停立即停止本地输入，host 确认 suspended 后才关闭旧 PC，排空完成后显示继续 / 换屏。重新读取目录不带 outer attachment，选屏和恢复各自读取新的 CAS；取消保留暂停，未知 ACK 只查一次快照，失败不重放、不回退旧显示器。一个控制器内的本地 phase 隔离旧 poll / TURN / signal 回调，退出等待在途 mutation 后 detach；恢复保留同一隔离 iframe，重新生成 connection / renderer，并等待新首帧，仅恢复查看。设备列表入口现打开主内容资源标签；本地全屏见第 7.2 节，画质选择见第 7.3 节。

本轮电脑端控制器 / source 竞态 / 输入 / DOM / 账号入口 / Peer 路由聚焦检查 147 项通过，`check:web`（含 24 个主题色 surface）和 i18n 审计通过。Chrome 在真实隔离 iframe / WebRTC 中连接生成视频的双 source 夹具，宽 / 窄 × 浅 / 深四种组合均验证暂停、刷新目录、当前标记、取消、选择另一 source 及新首帧；同一 iframe 保留，未重建 attachment，恢复无自动 acquire。实际截图发现的选屏字段过窄已在原表单布局中修正。该夹具没有账号、原生捕获和 OS 投递，不能计为物理双屏或双电脑验收；当前 macOS 原生账号边界拒绝自连接、旧 context 和无 context 的 mutation，普通输入 gate 仍为 false。

同日补充保留期限实测：普通关闭输入 gate 的 macOS 原生发送，经同一账号和强制 TURN 到鸿蒙真机，暂停确认前后观察到旧 native PeerConnection 析构；暂停期间试用 TURN 转发 UDP socket 为 0。请求暂停后约 26.4 秒刷新目录并取消，仍保持暂停；持续读取没有延长 host 的固定保留期，也未产生新首帧。约 64.1 秒时手机收到 sharing_ended 并显示显式重连入口（时间含手机 UI 采样开销，不是精确的 host 计时测量）。点击重连后先停在新目录，明确选屏后才出现第二次强制 TURN 首帧，同一手机进程保留，没有请求操作权；最终本机停止并返回普通 App。该证据覆盖正常网络下的无 PC 保留超时与显式新连接，不覆盖弱网、Relay 中断、锁屏或持键清理。

### 5.2 命令归属

每条命令只有一条路径。划分规则：**必须与输入保持顺序的走 DC，其余全部走加密 Relay**。Relay 路径在 PC 建立前和 PC 失败后都可用；DC 承载输入、租约及其所需的媒体就绪/首帧确认。

| 命令 | 通道与行为 |
|---|---|
| `capabilities / list_displays / attach / get_state` | Relay；按授权返回能力、目标或快照，attach 默认观察 |
| `signal` | Relay；绑定双方、attach/connection；host 唯一 offerer，每个 connection 只接受一次匹配 answer，重复相同 SDP 幂等，不同内容拒绝；v1 使用完整 gathered SDP、不另发 trickle ICE，旧 connection 丢弃 |
| `select_display / suspend / resume` | 加密 Relay；host 已实现并通过 `source_lifecycle_v1` 协商；鸿蒙和电脑控制端已有暂停 / 恢复和显式选屏入口，真实多屏与双电脑验收待完成；用 state_revision CAS，换屏/暂停先失效输入，再关闭或重建媒体，恢复仅查看 |
| `set_quality` | `quality_presets_v1`；host 契约、发送端及鸿蒙 / 电脑暂停页已接线。仅暂停且原生排空后设置；固定三档、CAS、同偏好幂等，不改系统分辨率 |
| `detach` | Relay；重复无副作用。用户退出先停止本地输入并关闭当前 PC，再尽力发 detach；host 对当前 PC 的非预期终止清理 attachment，预期重建/暂停不触发 detach，详见第 6.1 节 |
| `acquire_control / release_control / 续约 / 输入` | DC；申请带 expected revision，返回 control_generation；释放只针对匹配 generation，结果未知不重放 |
| 本机停止/撤销 | 本地通道直接失效输入并清理，立即停流 |

后续请求由来源、attach 和适用的 connection 约束，统一进入同一串行状态 owner。响应为结果/快照或 `{code, retryable, action}`，由控制端本地化。控制代次的授予/撤销经 DC，携带对应 generation；控制端收到当前代次撤销即停输入，不等待 Relay 快照。单通道不提供本机撤销与双向消息的全局顺序，host 始终先失效自身授权。其他状态通知经 Relay，仅携带 revision，提示控制端串行读取权威快照；控制端不对不透明值排序、不直接应用迟到通知中的旧状态。旧绑定/已取消请求的响应丢弃。没有 take_control、跨观察者停止或 durable 事件重放，视频不入 Agent 历史。

## 6. 媒体绑定、输入和故障

### 6.1 单通道与授权边界

`rd` 一条 reliable/ordered DataChannel 承载低频控制、状态、心跳和全部输入。属性依据 [WebRTC 标准](https://www.w3.org/TR/webrtc/)。应用层不再重复网络序号/缺口检测，不逐条返回 accepted/submitted 等回执；仅返回控制命令结果、状态变化和导致暂停的错误。输入从不重试/重放；双击本身是两个合法动作，不能按内容去重。

host 将 PC 对象映射到认证来源、attach/connection 与已授权 source，核对信令中的 DTLS fingerprint；拒绝额外 DataChannel。在认证传输建成、双方媒体就绪握手完成且 grant 仍有效后才发画面，不另设一次性 nonce。每次新 PC 必须确认首帧可见，之后用户才能申请输入。

```json
{
  "control_generation": "8",
  "kind": "pointer_button",
  "body": {"button": "left", "down": true, "x": 0.42, "y": 0.31}
}
```

旧输入在**产生时**绑定 generation，不能在延迟发送时贴上最新 generation。host 入队及 OS 提交前都核对当前 PC、generation 与 reservation；撤销和重新授予清空两端待发/待执行队列，等待旧 worker 和按键清理。可靠有序只保证通道内交付，不能代替本机撤销与异步 worker 的隔离。

source、远端几何或 grant 范围变化时先失效输入并关旧 PC，用新 connection 重建，首帧后恢复观察。普通操作权释放不必重建 PC。host 在主动关 PC 前，先于串行状态 owner 中标记预期重建或暂停；关闭回调必须核对 attach_id、connection_id 与该关闭意图。旧 PC 回调只清理旧资源，不能 detach 新连接；预期关闭保留逻辑 attachment。只有当前 PC 非预期进入终止状态（closed/failed）才清理并结束 attachment；短暂 disconnected 先暂停输入并启动有界恢复计时，超时结束。没有 PC 的暂停/重建槽也须有有限保留期，避免退出时 Relay 不可用造成永久占槽；这些超时在探针中确定，恢复已结束的 attachment 需用户重新连接。单通道若在弱网下造成心跳误超时，才依据第 9 节证据评审拆通道；不预建不可靠 hover。

接收器自身的终止错误也立即停止当前 PC、视频轨道、画面和定时任务，不等待 App 异步处理错误；包括通道、PC、轨道、播放和周期统计失败。上报错误期间若 App 已启动后继连接，旧清理只能作用于旧连接；旧异步结果不得复活画面、误关后继或重新挂起统计任务。短暂 disconnected 保持上述有界恢复语义。

### 6.2 背压与坐标

桥队列和 `bufferedAmount` 都有界，合并尚未发送的相邻 move，不能跨 button/key/text/wheel；up 带最终坐标。相邻同修饰键 wheel 可合并。进入 SCTP 的消息不能撤回；积压超预算关本地输入并停止续约，尽力 release；host watchdog 兜底，不能让 release 排在积压后仍宣称立即送达。必要时关 PC，恢复不追赶旧动作。

[输入契约与待执行队列](../../src/crates/contracts/product-domains/src/remote_desktop/input.rs)已实现纯规则：单条 JSON 至多 32 KiB、文本至多 4096 UTF-8 bytes、队列至多 128 条 / 64 KiB；坐标和滚轮增量必须有限。只合并相邻移动，以及同锚点、同方向且合并后未超限的滚轮；修饰键变化由 key 事件形成边界。过载清空并暂停，迟到的旧代次不能破坏新队列或重新激活已暂停的代次。`control_generation` 必须是规范十进制字符串，拒绝 JSON 数字以避免 JS 精度损失；诊断格式不输出输入正文。Desktop 提交前仍须复核实际绑定、授权、媒体健康和 reservation；这里的类型校验不等于原生按键支持；原生接线与受限验收见下文，普通输入 gate 仍关闭。

Desktop 的 [control worker 回调队列](../../src/apps/desktop/src/remote_desktop/control_worker.rs)也复用上述合并规则：原生投递阻塞时，积压实际发生在这层队列，仅在 admission 中合并不足以保护入口。只合并相邻且同代次的待执行输入，不越过控制请求或键鼠边缘；替换后仍检查字节预算，无法合并的过载仍清空并撤销。回调不取得原生投递持有的 admission 锁。确定性回归覆盖阻塞与边界；本节下文另列真实账号 / 强制 TURN 的固定拖动对照及其未覆盖范围。

鸿蒙的 [renderer 桥队列](../../src/apps/mobile/harmonyos/entry/src/main/ets/pages/policy/RemoteDesktopRendererQueue.ets)同样只替换尚未发送的相邻移动：renderer、attachment、connection 和规范 control_generation 必须全相同，坐标必须有限且位于 source 内；保留完整的新命令，不给旧意图换代次。button/key/text/wheel、控制请求、start/stop 均是边界，未知或不合法命令不被合并。128 条 / 384 KiB 保守 UTF-8 预算在替换时也生效，无法合并的过载继续显式失败；释放 / 生命周期沿原路径清除旧输入。阻塞桥的 512 次移动、边缘保留、跨绑定拒绝合并、旧格式与字节回收已有定向回归。

坐标为选定 source 的归一化 `[0,1]`；控制端逆变换黑边/缩放/平移，host 映射权威尺寸、旋转、DPI 与负原点。物理键用 USB HID usage；IME 明确提交后发送一次 UTF-8 text_commit，不能与物理键双发。非法值/动作/超长文本拒绝。清理只针对当前控制代次注入记录，不宣称所有 OS 都能区分合并后的本机/软件按键。

共享输入契约的 `SourceGeometry` 已支持 provider 提供的显示器朝向、虚拟桌面原点、逻辑尺寸和像素尺寸；归一化边缘映射到 source 最后一像素，避免命中相邻显示器，不把手机屏幕尺寸当远端尺寸。[macOS foreground input adapter](../../src/apps/desktop/src/remote_desktop/macos_input.rs)已通过 control worker 接入 DC，普通构建仍不宣告操作能力：提交前检查 UUID / 几何 / 权限 / 当前控制许可，记录本次注入的键、按钮与滚轮小数余量；清理失败保留未释放状态。真实 Quartz 事件构造和清理账本测试不会向桌面投递输入，不能代替专用窗口的实际点击、双击、键盘与撤销测试。双击按系统时间间隔、相同按钮/锚点/修饰键计数；CapsLock 和未映射键明确不支持，文本的原生准备与未接通范围见下文。锁屏、会话切换和 Secure Event Input 检查亦须实测，不把锁状态的非公开 dictionary 字段当成跨 macOS 版本保证。

2026-10-15 已通过 `node scripts/test-remote-desktop-input.mjs` 的本机专用窗口验证：生产适配器实际投递单击 / 双击、拖动、物理键与 Shift，原生窗口确认坐标和修饰状态；撤销后实际释放本次注入的键 / 按钮，迟到输入不产生新事件。探针只用已有权限，逐次复核专用子进程、前台窗口 ID 和几何，不捕获屏幕或读取其他应用内容。首个 Quartz post 在本轮出现约 550–688ms 冷启动阻塞，因此双击从投递返回时计时；原生权限 / source 复核后才作最终租约许可检查。此证据只覆盖本轮 macOS 15.7.9 / arm64 的主显示器，不证明账号 / PC / GUI reservation 的整条控制链，也不证明多显示器、旋转、锁屏 / 权限撤销、文本或手机操作；保持产品只读。冷启动与完整交互 P95 仍须纳入第 9 节性能实验。

[原生文本分块](../../src/apps/desktop/src/remote_desktop/macos_input/text.rs)已用 `node scripts/test-remote-desktop-input.mjs --text` 在专用 Cocoa NSTextView 验证中文、emoji、组合字符和较长文本的准确到达。每块最多 8 UTF-16 units，不切开 surrogate pair；这是本适配器已测的事件分块策略，不是 Quartz 公布的上限。owner 须逐块持 GUI/native guard 并复核权限，节奏等待放在锁外；禁止与按住的键 / 按钮混发。已投递的 down 必须完成 up，释放不再受新输入租约许可限制；OS 无法释放时保留账本并阻断后续输入。撤销可留下已输入前缀，不自动重放剩余或整个 commit。固定目标的原生测试也验证了此前缀与撤销拒绝，收据只保存计数 / 匹配结果。鸿蒙 composing/commit 与实际控制 owner 已接线，并完成第 4 节的隔离真机验证；普通 `submit(TextCommit)` 与远程文本能力仍受关闭的 acceptance gate 保护，Chromium、终端及其他应用仍须另测。Apple 明确说明应用框架可能忽略事件里的 Unicode 字符串，见 [Quartz Unicode 事件](https://developer.apple.com/documentation/coregraphics/cgevent/keyboardsetunicodestring%28stringlength%3Aunicodestring%3A%29)，不能从 setter 成功推断通用文字输入支持。

### 6.3 画面健康、租约与 Relay 失联

保留首帧闸门，移除强制“每 2 秒新帧确认 + 静态画面编码保活”。探针验证实际呈现事件；inbound-rtp framesDecoded、track mute/ended 与 PC 状态只作健康信号，解码计数不等于已呈现。静态无帧、采集冻结、重复编码旧图及呈现冻结必须分别测试，必要时使用 host source 健康状态。确定可观测信号和检测阈值前只开放查看，不宣称能检测所有冻结。

明确报告源不可观测后，单独的 idle 回调不能恢复失效前的静态画面证据；须先收到有效且单调推进的原生样本，再接受 idle。它与单纯观察超时分开：没有明确失效时，新鲜的 provider idle 和接收回执可以恢复健康观察。恢复健康不恢复已撤销的输入租约，操作须由用户重新申请。 定向反例修复前会误恢复，修复后 12 项健康与 20 项 native 媒体测试通过。真实账号 / 鸿蒙 / 强制 TURN 的隔离回调故障注入也验证：一次不可观测后持续注入 idle，接收回执仍推进而源始终 unknown、操作权撤销；恢复有效采集与接收进展后仍仅查看，没有重连或自动申请。这轮不发送 OS 输入，不代表物理捕获冻结或权限撤销验收。

若当前内核没有可靠的持续呈现回调，仍须先证明本连接首帧可见，再同时满足**采集侧健康且接收侧健康**才能开放输入；任一侧不可观测、失效或超时都暂停输入，不能仅凭另一侧正常放行。动态画面下，采集进展和接收端解码进展都应在探针确定的阈值内；静态画面下，只有 capture provider 能独立确认采集仍活跃且内容未变时，才允许 framesDecoded 不增长，并持续检查 track、PC 和该 source 健康信息的有效性。不能从“没有新帧”反推“画面静止”。无法证明此静态路径的平台保持只读，待适配通过再开放。没有持续呈现回调的已验证降级路径须记录并向用户说明呈现冻结检测限制；提示文案不替代首帧或两侧健康条件。参考 [WebRTC Stats](https://www.w3.org/TR/webrtc-stats/)。

[媒体健康观察](../../src/crates/contracts/product-domains/src/remote_desktop/health.rs)现已接入原生 PC 和共享接收器；`media.health` 提供诊断，隔离试用的 control worker 同时以当前健康结果作为输入准入条件，普通输入 gate 仍关闭。host 在已绑定的 `rd` 通道每 2 秒发 `health_probe`，`echo` 是该 PC 的 host 单调发送时间字符串，仅用于本回合匹配，不是新增连接 ID 或权限 token；只有一个待回复回合，3 秒内接受一次匹配的 `health_reply`。接收器为该回合重新采样 stats，返回首帧、可见性、焦点、track / 播放状态及规范十进制解码 / 呈现计数；track 必须 live、未 muted 且明确 enabled，本地输入闸门使用同一条件，不能把已禁用的视频轨报告为正常接收；积压、旧回合、替换 / 关闭后的异步结果不能刷新观察。超时保持未知，不能因新探测已发出就恢复旧的正面状态；计数倒退需新 PC。接收端操作闸门使用单调时钟计算健康回执的 6 秒新鲜度，与委托焦点一致；缺少单调时钟、负值或非有限年龄按未知处理，不回退到系统时间延长旧回执的有效期。

host 只把单调推进的实际 native sample 当作源进展；显式 SCK idle 回调才提供静态观察，未识别 / blank / suspended 状态不表示健康。源采样进展在 SDK 提交前单独计数，不以 SDK 接帧成功为前提；新样本即使被 SDK 丢弃，也会使旧静态豁免失效。SDK 接收计数仍独立作为首帧已提交的信令证据，不把被丢弃的样本冒充首帧。捕获 adapter 在进入媒体 / SDK consumer 前校验 buffer 和单调时间戳；空 buffer、非法时间、重复 / 倒退样本立即报告不可观测，不再把旧样本送给编码器。原生 sample-buffer / 时间元数据无效也明确报告不可观测；cancel / fatal 后新到的 frame、idle 或 started 回调不能刷新健康，consumer panic 关闭同一入口并报告失败。这不等于已经识别内容不变但时间戳仍推进的重复编码或物理冻结。其含义见 [Apple SCFrameStatus](https://developer.apple.com/documentation/screencapturekit/scframestatus)。重复的接收端 `mediaTime` 不刷新呈现进展，解码增长不替代呈现增长。已确认静态且两侧健康时，第一份变化样本使旧静态豁免失效，并使用现有 6 秒进展预算等待解码和呈现；后续样本或 idle 回调不能重置预算，不能在新画面尚未送达时直接因旧进展超时撤销。失焦、回执超时、源不可观测等负面条件仍立即拒绝；此等待不延长输入租约，也不新增协议字段。6 秒是探针初值，弱网与冻结边界仍须分别验收。诊断 `candidate` 没有精确 RTP / 最新帧对齐证明，`requestVideoFrameCallback` 表示提交给 compositor，不能保证物理屏幕实际显示，依据 [API 规范](https://wicg.github.io/video-rvfc/)；因此不把该布尔值当作操作许可。当前 native capture 加入会话不可用 / 锁屏闸门，停止送新画面并报告 `host_locked`，仍须实测锁屏切换与权限撤销。

2026-10-16，捕获 / 媒体 / 保留生命周期的 14 项聚焦测试通过，其中 5 项捕获入口用例覆盖无效 buffer / 时间、重复 / 倒退样本、静态健康即时失效、取消 / fatal 后回调和 panic；另有媒体用例验证 SDK 丢帧不能保留旧静态豁免。这些回调 / 丢帧用例不请求权限、不创建 SDK 帧或注入输入。修改后真实 ScreenCaptureKit 的 10 秒受控图案采集得到 47 个推进样本、99 次显式 idle、0 次不可观测，确认 close 排空后无回调；同一新原生 harness 到鸿蒙真实共享接收器的强制 TURN UDP 通过。单独停止 source 后 PC / DC 仍在，receiver_observed=true 而 source_activity=unknown、candidate=false，最终排空。重建后的常规关闭输入测试版也通过真实账号 / 强制 TURN 到鸿蒙的 1280×828 首帧、暂停 / 新连接恢复和两次 native PeerConnection 析构，手机进程保留，未请求操作权。该轮是正常捕获、source-stop 和只读账号链路的回归，不是物理捕获 / 编码冻结、重复编码旧图或持键清理的新增验收；普通输入 gate 继续关闭。

同日补充真实账号 / 鸿蒙 / 强制 TURN 的持键验证：隔离故障包在明确申请操作后只发送一次 Shift down，屏蔽控制端 release；Mac 全局按键状态确认实际按住和松开，前台保持隔离测试应用。单独关闭原生采集、保留绑定 PC / DataChannel 后，提交计数停止，接收端仍可观测而 source 过期为 unknown；host 健康检查撤销操作，约 6.33 秒后确认松键，安全 watchdog 未触发，手机未自动重获操作权。收尾确认媒体槽排空、键 / 按钮释放，并恢复常规程序与关闭的普通输入 gate。此证据不覆盖物理采集冻结、重复编码旧图或弱网阈值验收。

另以真实 ScreenCaptureKit sampleHandlerQueue 暂停 10 秒做零输入故障注入，账号 / 鸿蒙 / 强制 TURN 与 PC 保持：连续约 8.7 秒源计数和最后回调时间不变，手机回执仍推进，且报告可见、聚焦与接收正常。首个源过期观测时，最后回调年龄约 6.4 秒，操作权已撤销；回调队列由独立计时器恢复后，新源帧、解码 / 呈现与健康状态恢复，仍仅查看，无自动重获操作权。该记录是轮询观测，不是 6.4 秒的最坏延迟保证；未发送 OS 输入，不证明冻结时的实际持键清理、物理显示 / 编码器冻结或权限撤销。


浏览器冻结实验已用同一共享接收器、实际 Chromium PeerConnection / DataChannel 和画布源验证：抑制应用的呈现观察回调后，真实 `framesDecoded` 仍增长而呈现计数停止；停止画布更新后，两者都停下来。探测回复来自真实绑定通道，不以模拟 stats 替代此证据。该 fault injection 冻结的是观察回调，画面可能仍由 compositor 显示，不能外推物理呈现冻结、SCK source idle、鸿蒙或 TURN；重复旧图与接收内核故障实验仍待完成。host 的出站 DataChannel 超过 64 KiB 时，诊断候选也立即拒绝，不能因旧回复尚未过期而显示正面状态。

同一共享接收器已补充鸿蒙 DEL-AL10 / API 26、真实账号、macOS 原生显示器与强制 TURN 的输入验证：Mac 动态图案持续采集，故障包在授予操作后停止更新应用的呈现观察，先确认 Mac Shift 实际按住；呈现计数固定为 55、解码计数从 85 增至 202，被控端撤销操作并实际松键。视频连接与手机 PID 保持，没有自动重获操作权，安全 watchdog 未触发。它验证的是呈现观察停止时的保护，画面可能仍在 compositor 中显示，不外推为物理屏幕 / 解码器冻结、静态豁免或全部健康故障；收尾排空并恢复正常包、竖屏和关闭的普通输入 gate。

随后补充视频轨禁用的真机反例：track 仍 live、未 muted，解码 / 呈现计数继续增长，但实际健康回执的 `receiving` 为 false；Mac 先观测到 Shift 按住，再确认其释放，同一手机进程只产生一次连接首帧，未自动重获操作权，安全 watchdog 未触发。共享接收器新增 `enabled === true` 检查，本地准入和健康回执同步收紧，无新增 wire 字段。单元反例修复前失败；修复后含真实 Chromium 禁用 track 的 31 项聚焦测试通过。该证据不替代捕获冻结、静态内容、锁屏或授权撤销验证。

生产 ScreenCaptureKit 适配器已有[选定显示器探针](../../scripts/test-remote-desktop-capture.mjs)：先列出 UUID，再在既有本机授权范围内短时采集；只保存计数和状态时间，不复制、编码或保存屏幕像素。macOS 原生运行已观察到推进的 sample、显式 idle 和成功的 callback drainage。动态→静态生成图案中，idle 与 complete 均可能交替出现，动态阶段也可有 idle；不能把单次 idle 或图案停止更新当作持续静态证明，仍须检查每次 provider 观察的新鲜度。此探针本身不含接收端、账号或 TURN。另一次真实账号 / 鸿蒙 / 强制 TURN 的零输入观察，确认显式 idle 新鲜、源 / 解码 / 呈现计数连续约 13 秒不变时仍保持操作权；恢复动态后先观察到源推进而接收计数尚未推进，随后解码 / 呈现追上，同一连接未撤销或重新申请操作权，观察超过 45 秒后主动停止并保持查看。它复现并修复了静态结束即误撤销的问题；12 项纯健康和 20 项 native 媒体测试通过（另 2 项需显式运行的原生探针未计入），未新增 wire 字段。这轮从未打开原生输入保护，不算 OS 输入、物理冻结、重复旧图或弱网边界验收。

[原生发送到共享接收页的探针](../../scripts/test-remote-desktop-native-media.mjs)已验证选定显示器 → 生产发送引擎 → Chromium 共享接收页的真实帧呈现、健康探测和清理。仅停止实际采集、保留绑定 PC / DataChannel 后，源观察过期为 unknown，接收端继续回复也不能保持正面候选。这里的私密文件信令仅供测试；不证明账号、鸿蒙、TURN、静态豁免或物理呈现冻结，也不开放输入。

[鸿蒙共享接收验证](../../scripts/test-remote-desktop-harmony-media.mjs)进一步复用了产品 `RemoteDesktopMediaView` 和同一生产发送引擎，在 DEL-AL10 / ArkWeb 7.0.0.107 上通过强制 TURN UDP / TCP：真实 relay/relay 所选候选对、两端实际 relayProtocol、首帧 / 解码进展、源单独停止后的观察失效及清理均已验证。host ICE 尝试未建立连接，不计为 P2P 通过。350 kbps 试验上限下首帧实际为 640×412，SDK 已做分辨率自适应；不是 1080p / 30fps 或均衡画质验收。DEBUG 入口只替换测试信令，未接账号或输入；完整产品授权、长时稳定、冻结 / 旧图、蜂窝与 TLS 仍待验证。

该探针发现默认 `NativeVideoSource::new` 在原生采集前发送黑色保活帧。生产发送端改用已锁定 libwebrtc 0.3.52 的无保活构造 `new_encoded`：该版本内部仍为同一 raw-capable native source，继续推原始 CVPixelBuffer 并使用普通编码器，未选择 PreEncoded backend。真实探针确认采集前无视频呈现、采集后正常编码。这个构造将 `is_screencast` 设为 false，编码质量 / 静态桌面策略仍须验证；SDK 更新必须重跑无占位帧及 raw-frame 兼容探针，不能仅凭方法名或版本号沿用此接线。

输入保留应用存活心跳，初始每 2 秒续约、6 秒无有效续约清理，按单通道探针调优。续约绑定当前 control_generation、可见性与媒体健康；旧续约不复活租约。watchdog 使用 host 单调时钟，撤销先关闸门再清理；不能只依赖手机发 up/release。

[InputAdmission](../../src/crates/contracts/product-domains/src/remote_desktop/input_admission.rs) 将租约与有界输入队列收敛为一个纯状态入口：到期、释放和过载同时清空排队事件，并使已出队事件的最终提交检查失效；实际排空确认前不得重授。原生鼠标 / 键盘 / 文本测试已改为经过该入口。[Desktop 输入 worker](../../src/apps/desktop/src/remote_desktop/control_worker.rs)已接媒体 owner：同一有界 FIFO 接控制与输入，回调不取原生提交锁；单 worker 负责 GUI reservation、逐次授权、文本分块、watchdog 和实际清理。授予 / 撤销推进 attachment 的 CAS revision，迟到 acquire 不能重授；断线和本机停止先撤销，再等待 worker 排空。真实 native DataChannel 已覆盖绑定前拒收、绑定后请求 / 回复、关闭后拒发；账号 / 手机到原生 worker 的受限投递证据见第 4 节与下文固定拖动探针，不代表完整故障矩阵通过。执行和能力发现共用关闭的 `CONTROL_AVAILABLE` 验收门，产品仍只读，不能据这些基础测试开放操作。释放诊断区分 worker 收到请求、开始 / 完成原生清理，以及结果 / 撤销是否进入本机 SDK 发送路径；排入 SDK 不等于控制端收到。只记录固定动作、错误码和布尔结果，不记录输入正文、身份或信令，不逐次输出成功续约或每次清理重试。

[共享控制端](../../src/shared/remote-desktop-media/control.js)通过同一 renderer 接控制命令，绑定当前 renderer / attach / connection，保留输入产生时的 generation。每两秒续约；请求未知、背压或媒体失效停止本地输入，必要时关闭 PC，不自动重放或重新申请。只有明确协商 `ordered_control_v1` 才启用，旧接收配置默认关闭。已有代次 / 迟到响应 / 续约 / 失焦 / 未知结果测试；鸿蒙工具栏、手势和 IME 的受限真机证据见第 4、7 节，完整故障矩阵及其他平台仍待验收。

[控制租约](../../src/crates/contracts/product-domains/src/remote_desktop/lease.rs)已实现单 attachment 的纯生命周期：授予 / 续约 / 撤销 / 等待清理，6 秒期限由 host 单调时间计算；续约基于 SDK 接收回调记录的本机时刻，邮箱排队与 host 锁等待消耗该预算，处理前仍以当前时刻复核旧期限，不能凭过期前收到的续约复活租约。接收时间只保留在 host 邮箱，不接受控制端时间或新增 wire 字段，也不另定义每条输入的年龄阈值。提交前直接校验期限，不依赖 watchdog 准时运行。到期续约先失效租约，不能复活；撤销推进代次，清理失败持续占槽，只有实际排空 worker 并释放注入状态后才结束清理。迟到释放或清理回调不能影响同一 owner 的后继租约；跨 attachment / PC 回调还须由 facade 校验对象身份。计时器、GUI reservation 和原生清理留在 Desktop，此模块不读取账号或授予设备权限。控制端须按当前 PC/代次验证续约结果，继续维持两侧媒体健康；尚未接线或通过真机输入验证的平台保持只读。

2026-10-16，鸿蒙 DEL-AL10/API 26 → macOS 原生发送、隔离账号与强制 TURN 的弱网探针发现：SDK 载荷日志关闭后，在模拟器尚未启用限速 / 丢包时也出现续约中断；试用 TURN 的旧限速低于发送器上限，早期批次同时存在这层额外限制，不能作为单一 1 Mbps 条件的验收。对齐[试用预算](../../deploy/remote-desktop/README.md#6-第-0-阶段复现与安全配置)后，在每方向 1 Mbps、每方向 100 ms 延迟（新增 RTT 约 200 ms，原网络 RTT 另计）和 1% 主动丢包下观察 112 秒：56 次空租约续约 ACK 的 P95 为 320 ms、最大 1219 ms，释放 ACK 为 274 ms；手机进程及 PC 实例保持，未出现 ICE disconnected 或自动撤销。发送端控制请求从收到到交回 SDK 最多 21 ms，交回不等于远端收到。原始失败证据保留在本地，预算修正后的单轮成功不证明所有历史中断的根因已确定。

此探针未发送鼠标 / 键盘 / 文本；续约 ACK 不等于交互到画面时延，不覆盖持续拖动、move 合并对照、host 输入队列年龄或松手误差。SDK verbose 已关闭，本轮以当前媒体槽、Rust 媒体 wrapper 和手机 PC 实例核对生命周期，不把 wrapper 回收表述为已观察到 C++ 析构。收尾恢复普通包和关闭的输入 gate，媒体槽排空、试用 relay UDP 端口归零；原生停止与 TURN 配额回收仍分别记录。

2026-10-16，在上述已对齐 TURN 预算下，对同一私有构建逐次开启 / 关闭 host 入口 move 合并：每轮手机 JS 控制器在显式 acquire 后产生约 125 Hz、90 秒的固定左键拖动，沿既有输入控制器 / 单一有序 DC / 原生 worker 投递到 Mac 测试程序自己的空白画布。每次 Quartz post 前复核前台 PID、实际内容窗口、命中窗口、坐标范围和有界期限；不发送键盘或文字。两轮均为真实账号、原生显示器、鸿蒙真机和强制 TURN；只对发送端 TURN UDP 施加每方向 1 Mbps、100 ms 延迟和 1% 丢包，账号信令不经限速器。

| 本轮观测 | 合并开启 | 合并关闭 |
|---|---:|---:|
| 产生 / 合并 / 原生投递的移动数 | 11211 / 3403 / 7808 | 11221 / 0 / 11221 |
| 保留移动入队 → 出队 P95 / 最大（ms） | 0.391 / 8.580 | 23.986 / 44.937 |
| 保留移动入队 → 原生投递完成 P95 / 最大（ms） | 3.142 / 25.525 | 24.611 / 75.120 |
| 46 次续约 ACK P95 / 最大（ms） | 550.3 / 815.8 | 615.9 / 899.1 |
| release ACK（ms） | 240.8 | 253.1 |
| 实际 mouseup 位置偏差（CSS px，含坐标取整） | 0.71 | 0.71 |

两轮均观察到实际按住、可信 DOM 拖动与配对松开，未出现输入溢出、误超时、自动撤销或 ICE 中断；结束后无鼠标 / 修饰键残留。各自保持一个手机 PC 实例和一个 Rust 媒体 wrapper，视频持续呈现，清理确认后恢复普通签名包及关闭的输入 gate。原始失败与成功证据均保留在本地，独立停止 watchdog 未触发。此为有日志探针的单次顺序对照；被合并掉的动作不计入保留动作的延迟，原生投递完成不等于应用呈现或画面回传。固定轨迹绕过原生手势 / ArkTS 输入桥，不替代其弱网验收、点击到画面延迟或更广网络矩阵；本轮没有支持拆分 DataChannel 的证据。

补充真实触摸入口：新版鸿蒙桥队列通过相同账号 / 强制 TURN / 1 Mbps、额外约 200 ms RTT、1% 丢包路径验证单击及左右两个方向的双击后按住拖动。触摸经过生产手势策略、service、ArkTS 桥、JS 控制器与原生 worker；Mac 自有空白画布实际收到 5 对可信按下 / 松开及 70 次拖动，观察到 OS 按住状态，未拒绝投递。两个拖动终点误差为 0.50 / 1.07 CSS px（含取整），release ACK 为 244 ms；未输入键盘或文字，结束后无残留，视频保持同一 PC 并继续呈现。宽 / 窄 × 浅 / 深的无账号原生手势夹具另行通过并恢复原方向；这不是物理折叠验收。此轮是短实际手势，仍不等于长时间连续触摸压力或点击到回传画面的时延测量。

另以 40 次真机点击测软件反馈闭环：手机原生 TouchUp 处理入口记录时间，Mac 自有画布只在可信 mouseup 后翻转不透明黑白色块，手机在实际 video 的呈现回调中读回固定色块像素。采样避开已捕获的鼠标光标；逐次匹配手机触摸、Mac 点击计数、颜色翻转和递增 mediaTime，一次只允许一个在途点击，未确认就停止而不重放。起终点均使用手机系统时钟，并对照 JS 单调时钟检查跳变，本轮差值跨度最大 1.2 ms。探针不增加 wire 字段或自动输入入口。

| 同一账号 / 原生捕获 / 强制 TURN | 样本 | 中位数（ms） | P95（ms） | 最大（ms） |
|---|---:|---:|---:|---:|
| 不启用模拟限速 / 延迟 / 丢包 | 20 | 350 | 384 | 443 |
| 每方向 1 Mbps、100 ms 延迟、1% 丢包 | 20 | 647.5 | 974 | 1119 |

40 次均取得对应反馈；Mac 收到 40 对可信按下 / 松开，无拖动、投递拒绝、误超时或残留，视频与输入保持同一 PC。Mac 本机入队到 Quartz 投递完成的 80 条边缘事件 P95 为 4.18 ms、最大 41.33 ms；它只覆盖本机这一段，不能据此定位其余延迟。上述反馈结果包含触摸策略、ArkTS 桥、输入传输、原生投递、画面捕获 / 编码 / 回传及像素读回开销，终点不是屏幕物理发光。这是各 20 次的单轮顺序探针，不是跨网络 / 冷启动 / 长期性能保证；后续先分解手机桥和媒体侧延迟，不据此新增通道。收尾恢复正常包和关闭的输入 gate，原生清理与试用 TURN 回收分别确认。

同路径补充 20 + 20 次分段观测，保持媒体参数不变，仅增加私有诊断点：手机原生 TouchUp → JS 已接受对应 pointer-up 发包的中位数为 8 / 7 ms、P95 为 16 / 14 ms、最大 17 / 15 ms（普通 / 弱网）。JS 发包 → 对应反馈像素的中位数为 327 / 651.5 ms；本轮完整反馈中位数为 334.5 / 661.5 ms。三个时间点均在同一手机，逐点击关联；桥侧耗时不能解释本轮主要延迟，因此保留既有串行桥与相邻移动合并。

接收端按 [W3C 统计定义](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-jitterbufferdelay)，使用阶段内累计计数差分计算均值；普通 / 弱网分别观察 399 / 501 个已出缓冲帧，平均 jitter buffer 停留 149.18 / 237.45 ms，平均解码 11.41 / 11.40 ms。总处理延迟均值 160.94 / 249.05 ms 包含前述阶段，不再次相加；这些是阶段内全部帧的均值，不能直接分摊点击样本的 P95。缺失字段保留为不支持，不按零处理。接收缓冲值得继续分析，但本轮尚不能区分发送突发、链路抖动与接收播放策略，也不把两轮反馈 P95 的波动当成优化收益。

不新增 rd-route-status 或第二套鉴权轮询。复用 Relay 每 5 秒的 token 复核、Socket.IO 存活检测和 device-presence；presence 只表示设备在线，不能证明建立本次 attachment 的 socket/token 仍有效。同设备替代连接在线时，旧 token 失效也可能不从投影消失。

最小连接授权关联已实现于 [associations.rs](../../src/crates/services/relay-service/src/realtime/remote_desktop/associations.rs)。attachment 请求的 `rd-call` 外层带可选 `attachId`；host 解密后校验它与 attach/detach 正文一致，普通能力 probe 不带此字段。Relay 暂存来源/host 的原始 socket、token 和公钥快照，不存媒体、SDP 或 Agent session。host 仅在真正接受 attachment 时给加密回复附加 `$rdAttachment: "accepted"`；该标记只供 Relay 使用，转发给控制端前移除。Relay 发 `rd-notice({version:1,attachId,kind:"ready"})`，host 回 `{ok:true,attachId}` 后才完成该路由响应；通知不是设备授权或 DTLS 绑定的替代。

专用 Rust 回复路径已绑定原请求的 socket、来源与外层 attachment，接受/结束标记只能匹配该请求；校验失败不消耗 ACK，重连后的旧回复不迁移。`rd-end` 供 host 在本机关闭后尽力结束关联，停止捕获不等它的网络结果。Desktop 只读 handler 已使用专用回复；可选媒体 owner 接受 attachment 后才生成标记，默认无 provider 时仍不接受。

Relay 的 [TURN 签发](../../src/crates/services/relay-service/src/remote_desktop_turn.rs)复用同一 attachment 关联：`GET /api/remote-desktop/turn?target_device_id=…&attach_id=…` 只接受原两端完整设备 token，关联须 ready，双方 token/公钥重新复核；委托身份、替代 token、未知/结束关联均不签发。配置成功才宣告 `remote_desktop_turn_v1`；缺配置或签发失败明确拒绝，不返回空 ICE 配置。凭据使用 coturn REST HMAC-SHA1，5–10 分钟有效且不超过双方 token 到期；同一五分钟窗口的重复读取复用 username，两端使用不同的匿名作用域。响应不缓存，签发密钥不进入客户端；复用 HTTP admission，另限每账号每分钟 60 次签发。TURN allocation 总量/单用户额度仍由 coturn 配置，凭据到期不代替 host 的逐帧授权或即时撤销。Rust 领取入口已加入能力与作用域校验；可选 macOS owner 已领取并用于独立 PC；鸿蒙原生层也已领取并校验短时凭据；两端控制器已接入到期前的排空 / 重建，鸿蒙 → macOS 已完成单次真实到期窗口及收尾回收；正常网络的一次持键续期见第 5 节；多周期、弱网持键与异常退出 allocation 寿命仍须分别验收。

现有 5 秒鉴权任务同时检查已关联的 token/公钥。明确失效发 `kind:"revoked"`，普通 socket 丢失或授权状态未知发 `kind:"unknown"`；host 处理后 ACK。发送失败、ACK 丢失或不匹配，在 5 秒通知预算后关闭**受影响的原 host socket**；不只移除 rd 注册、不关闭无关设备。presence 生成失败同样发送授权未知通知。显式 detach 的已关闭回复用 `$rdAttachment: "ended"` 清理；本机媒体关闭后用 `rd-end({version:1,attachId})`，只作用于认证 host 自己的关联。`rd-unregister` 先通知结束已有 attachment，再移除注册。

同设备的新 socket/token 不能覆盖旧关联。只允许显式恢复请求使用原 token 和原公钥对，在旧 socket 已断开、30 秒恢复窗口内重新关联；不会自动重放 attach。原始凭据上下文最多保留 120 秒用于阻止旧关联被替代及回收预算，这是 metadata 保留期，**不延长 host 的 30 秒视频宽限**。单 host 的已就绪/失联 attachment 仍占一个槽，临时关联计入独立及原总预算，未接受的请求随 RPC 生命周期回收。

Relay 的内存关联会在进程重启后丢失，不能仅凭同设备/公钥把旧 attachment 绑定到新 token。新增 `remote_desktop_credential_binding_v1` 能力：Relay 在 attachment 的 `rd-request` 外层注入 `credentialBinding`，按固定域标签、长度前缀和双方账号/设备/token/公钥及 attach ID 计算 SHA-256；控制端提交的同名字段不参与转发。Desktop 在首次接受 attachment 时固定该摘要，暂停和 Relay 重连保留；后续 scoped 请求必须一致，否则先停止旧共享，不回复 accepted。摘要不进入渲染器、输入热路径或持久化授权文件；它是受信 Relay 的凭据连续性依据，不是独立于 Relay 的认证。旧 Relay 仍可处理发现和原 RPC，但新 host 明确返回 `relay_upgrade_required`，不开放媒体。原 token 的重启恢复仍受原宽限与清理规则约束，摘要不能延长期限。新边界的路由及 host 回归不替代真机持键撤销验收。

2026-10-16 此修正的本机回归通过：Relay 账号路由 20 项、Rust 传输 14 项、Desktop 远控 65 项（另 7 项需显式原生探针，未执行）。覆盖新 router/相同数据库下原凭据摘要保持、旧 token 已失效时替代凭据不同、外层伪造值忽略，以及 active/suspended attachment 对变更/缺失摘要的停止、旧 owner 隔离和旧 Relay 明确降级。新增跨重启测试在旧实现中因缺少凭据依据而失败。

随后试用 Relay 与关闭输入的 macOS 测试版已更新到本修正；鸿蒙正常签名包未增加协议或测试入口。真实账号 / 原生显示器 / 强制 TURN 收到 1280×828 首帧，重启 Relay 后恢复查看，期间手机进程保持且无新增首帧事件；随后显式暂停 / 继续，通过新的鉴权往返收到第二次首帧。全程未申请操作权；本机停止后 owner 不再报告清理待完成，试用 TURN 的 UDP allocation socket 为 0，手机恢复普通页面。未以 SDK 日志缺失推断 C++ 对象析构，也未据此验收新 token 替换或实际持键撤销；普通输入 gate 保持关闭。

同日另完成真实持键撤销：隔离账号下，手机仅在私有包内存中使用短期完整设备 token A，同设备的独立 token B socket 保持在线；被控端收到一次显式申请后的 Shift down，系统键位/flag 与目标窗口可信事件均确认按住。故障接收包暂停已建流快照轮询并屏蔽 release，不发送 key-up；删除 A 后确认 A 已失效、B 仍有效在线，观察到被控端 `revoked` 通知、一次可信 Shift up、系统状态清除及原生槽排空，独立停止保护未触发。发起删除到观测松键约 1.77 秒，含 SSH 和采样开销，不作为时延上界。测试只发送一个修饰键，不验收手机键盘 UI；仅删除本次 A/B，原凭据、公钥和本机 grant 保持，恢复普通包后原账号再次通过强制 TURN 呈现，随后停止并回到普通页面。本轮未叠加 Relay 重启，普通输入 gate 不因此开放。

重启与换 token 的只读组合也已验证：A 建立原生画面后，在 Relay 进程停止期间撤销 A，再启动空的关联 registry；正常账号凭据保持，仅远控通道使用临时 A/B。故障接收端暂停已建流轮询，预置 20 秒后由 B 发起恢复；先以无 outer attachment 的读取确认旧 attachment 仍为 streaming，再带旧 attach ID 请求，被控端返回 `authorization_expired`。随后的权威快照确认 attachment 消失且 `cleanup_pending=false`，均在本机兜底停止之前；B 同设备 socket 仍在线。手机进程及单次首帧保留，21 次统计中译码数从 9 增至 306；预置等待和统计不作为时延实验。临时凭据已删除，普通包和原账号画面重新验证；本轮无输入，不把它与上一轮合并宣称“持键期间重启并换 token”已验收。

这条链已由真实 Socket.IO 测试覆盖两种挂载、换钥、同设备换 token、通知 ACK 丢失、普通失联恢复和 unregister；Rust/鸿蒙 sender 支持 scoped attach ID。Desktop 对匹配的失效通知更新纯规则后 ACK，丢弃旧 socket 的回调；无匹配媒体槽时 `ready` 仍拒绝；匹配的已认证 pending attachment 可以接受路由 ready，用于领取 TURN 并准备传输。它不开放画面：须收到同来源固定密钥认证的 answer 并完成当前 PC/单通道绑定后才开始捕获。失效通知在 ACK 前关逐帧闸门并发起匹配清理；实际 P2P 停流仍需实测。通知、故障检测和实际停流的全链路延迟仍须故障注入实测。

暂停期间的路由确认与媒体可用性分开：当前 attachment / connection 仍匹配，且处于 suspended 的原生清理阶段时，可以确认在途 `ready`，避免正常暂停被误判为路由失效。通知专用 lookup 仅确认仍占有原槽；普通媒体 lookup 继续拒绝清理中的 source。该确认不清除 canceled / cleanup_pending、不完成原生 drain、不开放帧或输入，也不允许新 PC；停止后和暂停保留期到期后仍拒绝迟到确认。


失联后的权威撤销由 host 执行：host 自身断线、绑定来源 socket 失联、来源从 presence 消失或收到授权未知通知时，立即失效 control_generation，不等待去抖。控制端自身 Relay 短暂断开不单独撤销 host 租约，但后台、失焦、媒体不健康和用户退出仍执行本地停输入/清理。v1 对普通失联的已授权视频保留最多 30 秒宽限，禁止新 attach/输入授予/切屏；从首次检测到失联或身份未知计，失败重连不重置，控制端自报在线不能恢复授权。纯 ICE 路径变化不触发 Relay 失联规则，但仍受媒体健康与租约约束。

30 秒是**检测后**的视频宽限，不是从真实撤销时刻开始的总上界。总延迟含 token 复核、失效通知/ACK 预算、Socket.IO 故障检测及调度；现有 ping interval/timeout 为 15/45 秒，须通过故障注入测量并按远控需求收紧。重连必须重新认证、注册、绑定来源并复核目录/公钥、grant 和快照，才恢复观察；操作由用户重新申请。本机撤销/停止、锁屏、OS 权限撤销，以及 host 收到明确的 Relay 授权失效通知，都立即停输入和视频，无额外宽限；通知未能送达时由关闭连接与检测后宽限兜底，不声称撤销即时到达。

控制端状态读取的暂时性失败现单独处理：仅已呈现且原 renderer / 来源仍有效的 observing 阶段，允许对明确的读取超时 / 暂不可达保留当前视频；立即退役本地操作，关闭键盘与新操作 / source mutation 入口。首次失败启动一次 30 秒计时，重复失败不续期；读取恢复须确认同一 attachment / connection / display 仍为 streaming，恢复仅查看。身份变化、解密 / 响应错误、明确拒绝及媒体错误立即结束；建立连接、暂停 / 选屏等 mutation 不重放，也不因此改为无限轮询。此等待不改变 host 授权宽限，不绕过电脑原生 context 的 socket / 公钥围栏或鸿蒙账号通道身份检查；跨凭据 / 密钥重绑定，以及撤销、半开等其他故障下的持键清理仍须分别验证。

鸿蒙建立连接的终止日志记录本地操作名（通道准备、能力 / 目录、attach / 快照、TURN、signal 或 renderer 派发）及经过筛选的错误码，区分同一 `invalid_request` 的发生位置；不记录请求体、标识符、凭据或 SDP，不改变失败与重放规则，退役代次的迟到失败不记作当前失败。一次准备阶段拒绝仍未定位，补诊断不等于修复。105 项控制器测试及签名构建通过，新包已用原账号 / macOS 原生显示器 / 强制 TURN 复验首帧和正常清理；本轮没有申请输入。

2026-10-19，真实手机 App 退出后新连接的 attach 拒绝已复现，手机加密通道确认 `target_unavailable` 来自 host 回复，诊断 Relay 未进入其拒绝分支。时序缺口是旧共享仍在失联宽限或原生清理中，新的目录已提前展示；原有 idle-route 恢复不能越过旧 attachment / 清理屏障。鸿蒙现对支持 `source_lifecycle_v1` 的 host，在目录前读取不带 outer attachment 的 `get_state`：仅等待原设备拥有的旧共享及清理结束，最多使用 60 秒单调时间预算；其他控制设备占用明确拒绝。期间不接受旧 attachment、不发送 detach / attach / 输入，不续 host 宽限；清理后重新读取目录取得新 CAS，仍由用户选屏创建全新共享。取消、账号变化、无效快照、等待期间时钟缺失 / 回退和超时均终止；旧 host 保留原准备流程。反例先复现提前选屏，再修正，含错误来源脱敏与本地化共 150 项聚焦检查通过。保留身份的鸿蒙与原 Mac 经真实账号 / 强制 TURN 连续两轮 App 退出重连，均实际进入等待、确认旧源结束，收到新 1280×828 首帧，未出现 host / Relay 拒绝，未申请操作权。约 26 秒含等待及测试命令开销，不作为精确清理延迟。 最终含等待 / 占用 / 清理提示文案的签名包又完成两轮同路径复验，原生布局确实显示“正在等待上次共享结束…”，两次均先结束等待再取得 TURN 新首帧；保留原身份和 grant，收尾仅查看、手动开启操作可用。电脑控制端的后续等价接线与证据见下一段；这些定向结果不代表所有重连故障已解决。

电脑控制端现由既有 `RemoteDesktopController` 执行相同的协商与准备：支持 source 生命周期时先读取 unscoped occupancy，等待本设备旧源和原生排空，60 秒单调预算、退役围栏与其他设备占用拒绝保持一致；旧 host 不增加读取，不改 Relay / DataChannel wire，也不把鸿蒙服务或界面引入 Web UI。137 项控制器 / iframe / 输入 / Viewer 检查、105 项账号入口 / Peer 适配 / Registry 检查、Web 检查、三语言审计及试用配置的生产前端构建通过。真实 Chrome 宽 / 窄 × 浅 / 深四组检查了等待文案、取消后无迟到目录、排空后新选屏、单次 attach 和共享 WebRTC 接收首帧；发送的是生成视频，账号及 host 状态为夹具。

随后在一台 Mac 的两个隔离进程、原本机预授权、真实账号与强制 TURN 中验证：手机正在查看时电脑控制端拒绝占用，手机画面保持；手机正常退出并排空后电脑选屏取得 1280×828 首帧。只结束该控制进程，再以保留的身份启动，新窗口实际显示等待旧共享，清理后才出现目录，显式选屏后再次呈现 1280×828 首帧，候选对均为 relay/relay。全程未申请输入、未重新授予本机权限；显式断开后 host 槽已排空，隔离控制进程退出。它是同机账号 / 原生 WebView / 捕获 / TURN 证据，不是两台实体电脑或其他 OS 的验收；测得等待阶段约 16 秒包含测试及进程启动开销，不作为清理延迟指标。手机恢复继续使用原试用版本和授权。

2026-10-16，正常关闭输入的 macOS 原生发送 → 鸿蒙 DEL-AL10/API 26，经真实账号与强制 TURN 验证信令读取故障：专用 Relay 进程暂停 26 秒期间，手机显示操作暂停提示、保留同一视频 / 原生 PC，恢复后继续仅查看；横竖屏均检查实际中文提示，未新增首帧或自动申请操作。暂停 46 秒时，手机在首次提示后约 31 秒采样到等待超时并关闭，Relay 恢复后未自动重连，原生 PC 排空；该时间包含 UI 轮询间隔，不作为精确停止延迟。两轮收尾恢复服务和普通客户端，未请求输入租约。此证据覆盖进程暂停造成的信令读取停顿，不覆盖重启 / socket 换代、账号撤销、持键清理或公网 HTTPS。两端聚焦状态测试另覆盖固定等待期限、迟到快照、身份 / 授权错误和恢复仅查看；鸿蒙原生 string 资源与 ETS 文案表的匹配检查防止打包后显示键名。

同日补充真实 Relay 容器重启：确认服务进程启动时间变化及电脑账号 socket 重新连接，原视频 / PC 保持超过 30 秒；随后通过手机正常入口暂停，确认旧 PC 析构，再继续查看，收到第二次真实首帧和新的 relay/relay 路径，手机 PID 保持，账号 socket 未因暂停再次断开。该路径发现并修复清理期间迟到 `ready` 被拒绝的竞态；新增反例修复前失败，修复后 16 项媒体生命周期测试通过，确认 ACK 不开放帧 / 输入、不完成清理、不复活已停止 attachment。最终两个原生 PC 均排空，普通输入 gate 保持关闭。该验收仅为同一凭据的鸿蒙 → macOS 只读恢复，不证明持键、重启期间撤销 / 换 token / 换密钥、电脑控制端 socket 换代或其他平台。

随后补充重启时的实际持键清理：鸿蒙真机 / 隔离账号 / 强制 TURN，故障包经手机“开启操作”入口申请成功后只发送一次 Shift down，并屏蔽控制端 release。Mac 合并会话的键位 / flag 及隔离应用中的可信键事件共同确认按住；重启专用 Relay 后，系统状态清除、目标收到一次对应松开，手机收到 host 撤销通知，独立安全停止未触发。同一 PC / 手机进程保留，松键后仍有健康视频，超过旧租约预算仍仅查看且不自动申请。原生焦点由一次受保护的本机点击建立，本轮不作为手机点选输入框的新证据。收尾确认原生 PC 排空、本次键鼠均已释放，源码和运行时恢复关闭输入的普通测试版，正常签名手机包也已恢复；不覆盖重启期间授权撤销、半开、锁屏、弱网或组合键。

host 重启关闭旧 PC/租约，state_revision 改变；持久 grant 也须复核账号和 OS 许可。退出回收捕获、编码和网络资源，不把 SDP、generation 或 live PC 持久化成可恢复操作权。

媒体 owner 的既有 60 秒启动预算从连接槽创建持续到首个真实 native 帧被 SDK 接受；采集 API 返回成功、传输绑定或接收端统计均不能提前结束预算。等待 Relay、准备传输和采集阶段共用同一超时检查；到期关闭输入 / 逐帧闸门，沿原清理路径排空后释放槽。检查先读取实际 SDK 接帧计数，避免首帧事件尚在邮箱中时误判；提交成功仍不代表编码或呈现成功。2026-10-16，媒体生命周期 15 项聚焦测试通过，覆盖绑定前 / 后无帧超时、排空前拒绝新连接及排空后恢复准入、首帧通知排队；这些确定性用例不启动 SDK 或采集。重建后的关闭输入测试版通过鸿蒙真实账号 / 强制 TURN 的首帧、暂停 / 新连接恢复及原生 PC 回收。

同日原生故障实测在有效 ScreenCaptureKit 样本进入 SDK 前阻断提交，手机隔离包仅将等待延长至 120 秒以区分停因；正式两端仍为 60 秒。真实账号 / 强制 TURN 下，PC / DataChannel 保持绑定且提交计数为 0，host 在槽创建后 60.002 秒触发启动超时，旧 PC 析构并清空媒体槽。未自动重试；明确重连后，同一电脑 / 手机进程收到新的 1280×828 首帧，最终两次 PC 均排空。此证据覆盖原生提交缺失，不代表物理采集 / 编码冻结；故障源码与两端测试包均已恢复，普通输入继续关闭。

## 7. 媒体与平台探针

### 7.1 被控端引擎比较

第 1 阶段的[独立 macOS 原生探针](../../src/apps/desktop/probes/remote-desktop/README.md)已在 macOS 15.7.9 arm64、DEL-AL10 / ArkWeb 7.0.0.107 跑通 ScreenCaptureKit 显示器 → NV12 CVPixelBuffer → 独立 PeerConnection → 鸿蒙首帧及持续呈现。固定 libwebrtc 0.3.52 / webrtc-sys 0.3.49 / `webrtc-89d790b` 静态库 hash；H.264/UDP、VP8/UDP、H.264/TCP 的强制 TURN 均有实际 relay/relay candidate pair、画面及 DataChannel echo 证据。采集输出 1280×830，编码/接收实际 1280×828，约 15 fps、350 kbps 上限、单次 60 秒；手动停止及限时停止均释放采集/handle，进程退出，TURN allocation 随后归零。无真实采集帧时不发布启动黑帧。信令仍是 loopback/USB，媒体经过真实网络与试用 TURN；完整记录与截图保持本地。

2026-10-15 隔离试用构建补充同端点 STUN 后，鸿蒙与 macOS 在非强制 TURN 模式下经真实账号信令显示 1280×828 首帧；接收端实际路径为 `prflx → relay / UDP`，仍是 TURN 回退，P2P 未通过。直连候选未观察到 ICE 应答，双向 ICMP 也未收到回复；即使操作者确认同一 Wi-Fi，这些证据仍不足以确定是 AP 隔离、防火墙还是其他路由策略。须在允许设备互通的网络复测，不通过降低授权或关闭安全边界排障。本轮未请求输入租约。

首轮引擎选用 LiveKit 的独立 `libwebrtc` 接线继续**鸿蒙只读闭环**，不引入 Room/SFU/Cloud。这不是最终发布选型：实测 H.264 为 OpenH264、VP8 为 libvpx 软件编码，显式请求 VideoToolbox 后仍回退，硬编未通过；当前图案负载和短跑不能证明 1080p/30fps、端到端交互时延或长时稳定性。硬编/profile 兼容、GPU/温升、分发许可证和其他架构/桌面平台仍须单独验证。实际 OS 权限撤销、冻结检测、蜂窝/P2P/TLS、产品鉴权及 OS 输入不由本轮证明，不因此开放输入。

Desktop 已开始独立适配：[显示器 source](../../src/apps/desktop/src/remote_desktop/macos_capture.rs)与 [PeerConnection provider](../../src/apps/desktop/src/remote_desktop/media.rs) 由非默认 `remote-desktop-media` feature 引入；[媒体 owner](../../src/apps/desktop/src/remote_desktop/media_session.rs) 已接入账号 host，仍须验证真实产品链路后才启用默认构建。构建按[产物 pin](../../src/apps/desktop/remote-desktop-media-artifact.json)校验实际链接静态库，仅接受已验证的 macOS arm64 release SDK。捕获只接受明确显示器 UUID，复核权限、身份及像素几何；逐帧借用 NV12，授权/连接闸门通过后提交 SDK。启动/排空在 worker，关闭先关闸门，排空失败保留资源与清理屏障。 macOS 捕获的 context 脱离和最终队列清理共用一次 8 秒单调等待预算；队列卡住时返回失败，晚到的队列工作不能释放句柄或代替 owner 宣告清理成功，后续重试仍核验原句柄。[原生排空反例](../../scripts/test-remote-desktop-capture-drain.mjs)直接编译生产 C 适配器，以两处独立队列阻塞验证超时保留和恢复后重试；不捕获屏幕、不调用输入或申请 OS 权限。原生帧提交与接收端实际呈现分别计证据，SDK 启动黑帧不能使产品进入可操作状态。这些适配代码和本机 PC 测试不替代真实账号与鸿蒙媒体验收。

| 候选 | 采用前必须证明的事实 | 决策 |
|---|---|---|
| LiveKit `libwebrtc` / `webrtc-sys` | 目标架构预编译包、独立 PeerConnection、raw frame source、codec/硬编、包体、license/更新及复现构建 | 优先探针；不能把 Room SDK 接入成功当作无需 LiveKit 服务的 P2P 已验证 |
| `webrtc-rs` | 自选 VideoToolbox / Media Foundation / 软件编码接线、RTCP 反馈、码率调整、关键帧和丢包恢复 | 对照候选；纯 Rust 传输不等于完整编码链，不能未测就断言拥塞控制较弱 |
| 自编 libwebrtc + 自有 C ABI | 三平台源码构建、链接、发布产物和维护成本 | 备选，只有前两项不能满足必要能力时再评审 |

LiveKit 源码提供 [NativeVideoSource](https://github.com/livekit/rust-sdks/blob/main/libwebrtc/src/native/video_source.rs)、[PeerConnection](https://github.com/livekit/rust-sdks/blob/main/libwebrtc/src/native/peer_connection.rs) 和 [webrtc-sys 构建接线](https://github.com/livekit/rust-sdks/blob/main/webrtc-sys/build.rs)；候选平台见 [项目说明](https://github.com/livekit/rust-sdks)。版本、下载产物和 ABI 必须在探针锁定，不依据 main 的说明直接宣称所有 target 都可用。[webrtc-rs](https://github.com/webrtc-rs/webrtc) 作为传输候选独立验证。v1 不因此引入 LiveKit SFU/Cloud，也不宣称这两项已支持 OHOS。

账号链路还发现试验 TURN 的容量预算不足：原生 SDK 分别为视频 / DataChannel 收集 UDP、TCP 候选，旧 allocation 限制及带宽预留会导致 486；手机可能收集完成却没有候选。调整试验预算后，手机获得 2 个候选并实际显示 1280×828 首帧，匿名 Allocate 仍返回 401；具体配置与预留语义见[部署手册](../../deploy/remote-desktop/README.md#6-第-0-阶段复现与安全配置)。共享接收器在 gathered SDP 缺少候选时立即关闭并报 `media_unreachable`，不提交无效 answer 或等待后续 trickle，也不改变授权或自动重连规则。

### 7.2 共享接收与平台例外

Desktop 和 Android WebView、WKWebView、ArkWeb 优先使用同一窄 JS 媒体模块。外层 App 的导航、手势、键盘与权限呈现保持原生；KMP 只暴露 UiState/Intent，原生 handle 和每帧数据不进入共享状态。

每个实际内核验证 RTCPeerConnection、H.264/VP8 接收、DataChannel、inline 播放、首帧回执、桥延迟、前后台与进程回收。[WebKit 的 iOS 14.3 说明](https://webkit.org/blog/11353/mediarecorder-api/)主要涉及 getUserMedia 开放，不能当作所有接收路径已验证的最低版本证明；只接收屏幕不申请手机摄像头/麦克风。失败返回 `media_backend_unavailable`；原生接收 SDK 仅作为有测量依据的后续替代，不默认维护三套栈。

#### Linux WebKitGTK 限制与下一步

2026-10-19 的 Debian 13 amd64 / WebKitGTK 2.54.0（4.1 API、GTK 3）原生探针得到明确反例：默认 `enable-webrtc=false`，显式设置为 true 后属性可读回，但主文档和 opaque iframe 的 `RTCPeerConnection` 仍为 undefined。页面按 Wry 0.56 的方式将 `tauri` 协议注册为安全上下文；主文档与 iframe 均报告 secure context，`requestVideoFrameCallback` 存在。HTTPS localhost base URI 对照组结果相同。三组均加载生产 `DesktopMediaFrame` 与原样共享接收器，确认缺 API 时返回 `media_backend_unavailable`，随后停止；没有分配 PeerConnection、请求媒体权限或进入媒体协商，不能计为 codec、DC、画面或 TURN 通过。

这与 [WebKitGTK 2.54 官方说明](https://webkitgtk.org/2026/09/16/webkitgtk-2.54-highlights.html)一致：该版本在 GStreamer → LibWebRTC 后端过渡期间禁用 WebRTC，旧版本也依赖实验性构建选项。因此不能仅增加 `set_enable_webrtc(true)` 就宣告 Linux 支持，也不为接收功能降级系统 WebKit 或自行维护整套 WebKit 构建。探针运行于 Xvfb 隔离容器，并非真实 Tauri/桌面 compositor；原生 API 报告 sandbox_enabled=false，未修改该设置，此结果不证明生产沙箱与桥隔离。

Linux Desktop 仍是交付目标，下一步沿用现有 `DesktopControllerPorts.renderer` 与事件入口实现 app-local 原生接收 adapter；不增加 Relay 协议、不修改手机接收栈。接收通道的[只读可靠性接口](../../third_party/libwebrtc/OPENBITFUN-PATCH.md)已准备：读取 native ordered、可选 lifetime / retransmit limit，保留 Some(0)，不新增 owner 或 observer。macOS 与 Linux 的六种真实通道属性已核对；产品必须确认唯一、可靠、有序的 `rd` 后才 bind，label 或对端自述不足以放行。

已验证的探针分层如下；细节、工具链、失败记录和复验边界统一放在[部署手册](../../deploy/remote-desktop/README.md#linux-webkitgtk-api-探针)。各层证据不能拼接为产品交付结论。

| 载体 | 已有证据 | 证据边界 |
|---|---|---|
| Linux 独立 SDK | 固定 libwebrtc 0.3.52 / webrtc-sys 0.3.49、`webrtc-89d790b` 官方预编译库；生成 VP8 消费 14 帧、变化 13 次、三次 DC 往返；三种不可靠通道在 bind 前拒绝 | 没有 UI；未从源码编译 WebRTC；早期协商失败和 GStreamer 关闭报错保留 |
| GTK3 / Cairo surface | 解码 worker 只替换单槽 BGRA，主线程持有 widget / draw / after-paint；窗口读回匹配；正常 / 取消 / 部分初始化三轮清理后 FD / 线程为 8 / 1；无显示环境明确拒绝 | 固定 320×180、私有 Xvfb；不代表物理呈现或产品页面 |
| Tauri 静态载体 | 仓库同版 Tauri 2.11.5 / runtime / tao；确认 WebView 父容器为 GtkBox；透明 WebView 下的色块与菜单可见，三处 trusted 点击；同进程三轮安装 / 移除后恢复父容器、widget 析构，FD / 线程为 23 / 19 | 没有 SDK 视频；静态共存不证明视频重绘时仍可见 |
| Tauri SDK 联合载体 | 生成视频消费 27 帧，媒体区读回 14 次、变化 13 次；正常、取消和三种通道拒绝检查通过，worker / widget 排空 | 像素比较排除了菜单区；trusted 点击只证明事件路由，未证明菜单持续可见 |
| 不透明祖先 / body Portal 载体 | 补齐视频、菜单、标题、画面外背景与独立进程的 Xvfb root 截图；同一产物三次启动、一次取消、三种通道拒绝通过。三轮消费 39–48 帧、完整核对 24–28 次、独立截图 14–15 次；停止后无追加 draw，帧槽、worker、widget 清理，原页面像素和点击恢复 | 固定几何仿真，不是实际 React 产品页；未验证裁剪、滚动、全屏、主题、DPI、Wayland、多 PC 长期回收或物理 compositor |
| 实际 React Viewer 布局载体 | 复用正式 Viewer、设计系统与纯视频几何；显式重绘 WebView 的三种载体分别通过十二阶段，含适配 / 原始尺寸、裁剪、滚动、主题、菜单、全屏及拆卸恢复；逐布局三帧核对，单 iframe，停止后无新增 draw | 控制器与媒体桥为替身，无账号接线；仅新视频帧驱动重绘的方案在停帧时菜单不可见，尚不具备产品接线条件 |

固定几何载体的失败对照暴露了安装时机：网页 ready 后重挂 WebView 会出现整层 DOM 不可见；windowless DrawingArea、扩大重绘或单独 CSS mask 未形成可靠通过。将安装提前到 Tauri `setup`、保留 DrawingArea 自有窗口，配合只裁去视频区的根节点 mask 后，三次启动通过。首次完整核对耗时 1.45–1.93 秒：探针以单调时间给首次呈现四秒预算，首次通过后任何缺失立即失败，显式拆卸后的像素恢复单独验证。合成器只加入探针镜像，默认硬件加速和 sandbox=false 未改；不计为平台安全验收。见[合成验真记录](../../deploy/remote-desktop/README.md#tauri-不透明背景与合成验真)。

实际 React 载体中，显式 WebView 重绘可使十二阶段通过，但仅由新帧触发的方案在停帧时菜单不可见。后续复验中，不初始化 SDK、不加 mask 的页面也失败，不能将异常归因于 SDK；补 Openbox 未解决。最小 GTK / Tauri CSS 动画各两次通过，启动时禁用 DMABUF 的 React-only 对照两次完成动画，但接原生视频后仍有严格窗口像素失败，尚不能认定完整修复。样式覆盖的单轮通过未稳定复现，没有进入产品。**本地菜单、工具栏与动画必须独立于远端新帧和媒体健康继续工作，DOM 动画完成不等于实际合成画面正确**。不将诊断环境变量、定时重绘或放宽像素检查直接提升为产品方案。几何计算独立于输入 / 租约状态，裁剪与平台呈现由 adapter 持有。详见[实际页面对照](../../deploy/remote-desktop/README.md#实际-react-viewer-布局对照)。

上述媒体仅使用生成视频，各探针均无账号 / TURN / 捕获 / OS 输入，协议健康始终为 presented=0 / receiving=false，不赋予操作权。GStreamer 关闭报错仍是已知问题，限定探针要求明确停止或预期拒绝、实际 CLOSED 与后续清理证据，不作为产品恢复策略。产品页面及账号接线通过前，Linux 入口保持明确不可用；不阻塞鸿蒙 → macOS。

Desktop 的 opaque 文档对本地 `bridge_ready` 附加 `receiver_api_available`：在该文档检查两个必需 API 的函数是否存在，不把它当作 codec 或媒体健康证明。控制器先等待本地报告，至多四秒，之后才访问 host；关闭、换号、失败或新 open 均结束旧等待，迟到 ready 不复活准备。明确缺失或格式错误拒绝后续准备与 attach；已在途 attach 遇 renderer 重载时，仍等待旧回复并按旧 context 清理，不重放。已确认的缺失在该 renderer 生命周期内保留，重复 ready 不能复活；旧桥不带字段保留既有路径。字段不进入 Relay/DC，不改变手机资源。109 项控制器 / bridge / source 回归、30 项界面回归和 TypeScript 检查通过；三组真实 WebKitGTK API 探针均在生产控制器先 open、后收到报告的顺序下，以计数 / 抛错的隔离 request/turn port 确认 host/TURN 调用为 0。此处没有真实账号，不计为远程或 Linux 媒体验收。

#### 鸿蒙优先接线

2026-10-14 已通过[独立调试探针](../../deploy/remote-desktop/probe/README.md)在 DEL-AL10 真机、OpenHarmony 7.0 / ArkWeb 7.0.0.107 验证 bundled rawfile 的 RTCPeerConnection、可靠有序 DataChannel、VP8/H.264 解码、requestVideoFrameCallback 首帧及持续呈现；强制 relay 的 TURN UDP 与 TCP 均有实际画面及 echo 证据，手机前后台与紧凑/横屏窗口也已检查。本轮发送端是 Chrome 浏览器捕获，信令经 loopback/USB 隧道；正常 ICE 使用了 TURN fallback，未证明 P2P。蜂窝、TURN TLS、物理折叠、Linux WebKitGTK、原生显示器捕获和产品鉴权仍未验证；不能由单台内核外推其他设备支持。探针只在 DEBUG 显式启动，不进入正常产品入口。

首轮使用鸿蒙 App 真机内嵌 ArkWeb，不能以手机浏览器打开测试页代替。已有 [WorkspaceTerminalView](../../src/apps/mobile/harmonyos/entry/src/main/ets/pages/components/WorkspaceTerminalView.ets) 证明项目具备本地 rawfile、窄 JS bridge、串行 `runJavaScript` 和外部导航拦截的接线；它没有验证 WebRTC、媒体播放或视频呈现。探针必须记录 OS/ArkWeb 版本、打包资源 origin、API 可用性和播放启动条件。若 rawfile 环境不可用，单独验证受限的本地资源加载方案，不改成加载任意远程网页。

以下 owner 已接线，位于 `src/apps/mobile/harmonyos/entry/src/main/ets/`；HarmonyOS 不依赖 KMP：

| Owner | 职责 |
|---|---|
| `services/RemoteDesktopService.ets` | 账号/设备绑定、加密路由、probe/attach/信令/授权状态与关闭；不改当前聊天连接或工作区 |
| `pages/state/RemoteDesktopState.ets` | 可展示状态、能力与 typed Intent；不存视频帧、WebView handle 或凭据 |
| `pages/viewmodel/RemoteDesktopViewModel.ets` | 连接状态投影、手势意图与媒体 adapter 协调、回调代次和生命周期；不导入组件 |
| `pages/components/RemoteDesktopMediaView.ets` | `@ComponentV2` 平台叶组件；ArkWeb 生命周期、安全桥、媒体事件；不拥有账号业务 |
| `pages/policy/RemoteDesktopTouchPolicy.ets` | 纯手势判定、viewport 逆变换与输入意图；手机、宽屏和折叠布局使用同一规则 |
| `pages/policy/RemoteDesktopRendererQueue.ets` | 有界桥接 FIFO；停止 / 释放先清旧输入，溢出关闭当前连接 |
| `pages/components/RemoteDesktopViewport.ets` / `RemoteDesktopKeyboard.ets` | 原生手势和远程虚拟键盘入口；固定 renderer / 租约身份，不搬运视频帧 |
| `services/RemoteDesktopKeyboardService.ets` / `RemoteDesktopKeyboardInput.ets` | 原生 IME 的串行挂接/解绑及纯组合策略；确认文字立即走既有输入通道，预编辑、旧回调和未知编辑动作不变成远端修改 |

鸿蒙操作状态也使用共享 receiver 的 App 内部 `control_epoch_v1`：复用 Service 的意图计数，命令与报告按创建时代次对应；更早租约的迟到授予或空释放不覆盖新状态。缺失、无效或未发出的代次结束当前连接，旧本地接收器保留仅查看；不增加 Relay / DataChannel 字段。媒体叶组件按解析后的事件类型识别 ready，允许新增能力字段；队列只合并同一绑定、代次与租约的相邻移动。控制层和原生桥的反例已修复。2026-10-19 保留既有试用身份更新签名包后，DEL-AL10 / API 26 经真实账号信令和强制 TURN UDP 呈现 macOS 原生画面（1280×828，双方 candidate 为 relay）；手机点击专用空白 Cocoa 输入框，逐次输入 `123`、退格为 `12`、回车为 `12\n`，共五组配对按下 / 松开，无额外键。显式停止后超过 5 秒无追加输入或残留按键，键盘关闭、手机保持查看，随后关闭测试窗口。本次首轮 attach 返回 `target_unavailable`，显式重新发现并连接后成功，原因尚未定位；不记为该连接故障已修复。此次新版验收覆盖基础点击 / 数字 / 退格 / 回车，不替代中文候选、多轮代次竞态、跨应用或完整输入清理矩阵；旧代次反例仍以聚焦测试为证。

虚拟键盘使用鸿蒙[自绘输入法接口](https://raw.githubusercontent.com/openharmony/docs/master/zh-cn/application-dev/inputmethod/use-inputmethod-in-custom-edit-box.md)代理输入，不保留已提交的远端全文。预编辑回调在挂接前订阅，编辑回调在挂接成功后订阅；关闭先同步失效本地输入闸门，再串行移除本 owner 的回调并解绑。每个实例固定 renderer / control_generation，旧实例、关闭后的组合确认及迟到平台回调不能输入新连接。点击新的远端目标前，按原绑定关闭键盘并丢弃预编辑；不新增输入框 ID，已确认文字与物理键由 host 投递到 OS 当前焦点。未知范围选择、扩展编辑与无法映射的批量删除明确暂停键盘/操作，不推算远端内容。

当前鸿蒙键盘在 DEL-AL10 / API 26 的无账号原生夹具完成五组实际 IME 检查：横屏宽 / 窄布局 × 浅 / 深主题和竖屏，确认文字无需“发送”即到达输入意图端口，退格 / 回车形成配对物理键，收起后保持接收上下文。点击、双击拖动、宽度变化释放与单 bridge 检查另有既有证据；当前键盘 / 控制器聚焦回归 118 项通过。无账号夹具不捕获桌面、不注入远端 OS，不能单独作为输入闭环证据。

2026-10-16 当前版本的实际输入闭环：DEL-AL10 保持正常签名包，通过隔离测试账号、加密信令和强制 TURN UDP 接收 macOS 原生显示器画面（1280×828），两端选中的 candidate 均为 relay。手机点击使专用 Cocoa 输入框获焦点，逐次确认 `1`、`2`、`3` 后内容准确为 `123`；退格后为 `12`，回车后为 `12\n`，原生记录共五组配对按下 / 松开，无额外键。无需本地草稿或发送按钮；同一手机进程内先收起 / 重开 IME，再输入上述序列，仍仅收到五组配对输入，没有重复提交。停止操作后超过 5 秒无追加输入、键盘关闭并保持查看；随后本机停止并确认清理，恢复普通 Mac、手机竖屏普通页，TURN 转发 UDP socket 为 0。Mac 测试产物仅允许指定输入框内的一次点击与固定键序列，窗口 / 焦点 / 时限不符即拒绝，普通输入 gate 未开放。此证据验证当前 IME 修正后的基础链路，不替代其他应用、显示器全域精度、组合输入、故障或跨平台矩阵。 补测另有一次首次点击返回 `input_suspended`、目标未记录到点击；冷启动复验未复现，来源仍未定位，不能记为已修复。内部日志现分别记录 native、GUI reservation 与最终 control 拒绝阶段，原生原因只使用固定枚举标签；不记录输入内容、OS 错误正文或身份，不改变 wire 错误、失效与禁止重放的规则。 已在真实账号 / 强制 TURN 下主动触发一次私有位置保护拒绝：日志分类与原 `input_suspended` 一致，目标零输入且 5 秒后无延迟投递或自动重连；随后正常输入及 IME 重开也通过。这验证诊断和拒绝路径，不解释前述偶发故障。

前序版本的 Desktop 搜索框另有中文 IME 证据（同一真机、隔离账号和强制 TURN）：手机输入 `nihao` 时，每一步电脑输入框仍为空；在手机候选栏明确点选“你好”后，电脑内容准确变为“你好”，没有重复提交。再输入未确认的 `n` 并退出手机 App，6 秒后电脑内容仍保持“你好”，被控端报告原生共享槽已排空。该证据覆盖当前鸿蒙输入法的中文确认及进程退出时丢弃组合，不替代其他输入法、emoji 编辑、多行输入或全部后台/故障场景；普通操作 gate 保持关闭。

设备入口复用 [AccountDeviceDirectory](../../src/apps/mobile/harmonyos/entry/src/main/ets/services/AccountDeviceDirectory.ets) 的显式目标寻址方式。[CloudAccountClient](../../src/apps/mobile/harmonyos/entry/src/main/ets/services/CloudAccountClient.ets) 已解析 `deviceKind`，[DeviceDirectoryViewModel.refreshActive](../../src/apps/mobile/harmonyos/entry/src/main/ets/pages/viewmodel/DeviceDirectoryViewModel.ets) 及目录状态现在保留它；旧 Relay 缺字段保持未知，不按名称补造 kind。[ConnectAccountDevicePage](../../src/apps/mobile/harmonyos/entry/src/main/ets/pages/components/ConnectAccountDevicePage.ets) 原聊天选择仍按 `HarmonyOS Phone` 名称过滤。新远控入口已按 kind 过滤（desktop 或旧服务端的未知类型），并通过专用路由能力 probe 确认只读 provider；旧通用 RPC 的 `compatible` gate 不替代远控协商，也不因此取消旧聊天入口的检查。

桥接分为两条路径：视频直接留在 ArkWeb 的 WebRTC/video 内解码呈现，不经 ArkTS/base64 搬运；原生触摸/键盘 → typed Intent → 输入 policy/adapter → 单一有界桥队列 → JS `rd`。低频 SDP/ICE、状态、指标和错误通过桥回到原生；手势不能绕过队列并发调用 JS，以免 down/move/up 乱序。输入在产生时绑定 control_generation，媒体 adapter 发送前再次核验，不给旧意图换上新授权。

就绪状态依次为 `bridge_ready → transport_connected → bound → first_frame_presented → observing`；用户申请成功才进入 `controlling`。`onPageEnd`、ICE connected 和收到 track 都不能冒充首帧。探针验证当前内核的 video 帧呈现回调及替代检测；首帧与持续健康策略按第 6 节探针通过后才开放输入。host 仍校验租约、scope 与 watchdog，接收端回执不替代授权。

原生 viewport policy 以 ArkUI vp 和实际视频宽高计算 contain 内容矩形、缩放和平移；ArkUI 对固定 WebView 应用同一变换，JS video 只负责 contain 呈现，不再叠加第二套缩放或矩阵 ACK。输入从原生触点换算为视频内归一化坐标，黑边不命中远端。几何变化取消正在进行的手势；窗口宽度变化还释放操作权并关闭键盘，保留查看，重新申请后按新几何命中。仅唤出键盘引起的高度变化保留当前操作权。旋转/折叠本身不换远端 source，也不重建 WebView；若接收器意外销毁，则关闭连接，由用户显式重连，不能继承旧操作权。

“更多 → 旋转屏幕”使用[鸿蒙窗口适配器](../../src/apps/mobile/harmonyos/entry/src/main/ets/services/RemoteDesktopOrientationService.ets)切换手机视口，不修改远端显示器几何，也不新增协议命令。切换前先关闭键盘和释放操作权；短横屏上的菜单可滚动，旋转和断开仍可达。适配器保存本视图原有的窗口方向策略，在退出时恢复；旧视图正在等待的旋转及恢复先结束，新视图才能读取自己的初始策略。迟到的窗口查询不再旋转，平台拒绝时显示失败，不报告假成功。

旋转相关验收分开记录，不能用 UI 夹具代替原生输入。账号路径使用 macOS 原生显示器、鸿蒙 DEL-AL10/API 26、隔离账号和强制 TURN；实际呈现为 1280×828。

| 路径 | 已验证 | 证据边界 |
|---|---|---|
| 无账号原生 UI | 浅/深主题双向旋转；IME 关闭、操作释放，进程/接收桥/显示器选择保持；重新申请后 (0.25, 0.75) 点击得到正确归一化坐标及配对按钮 | 不采集桌面，不执行远端 OS 输入 |
| 账号视频与租约 | 双向旋转前均开启操作及实际 IME；旋转后释放并保持查看超过 5 秒，实际收到被控端新换色画面；仅一次连接首帧、同一手机进程，短横屏菜单可滚动 | 未发送 Mac 键鼠/文字；主色变化只证明新帧，不验收精确 RGB/色域转换 |
| 竖转横持键 | 真实账号 / 原生显示器 / 强制 TURN 的受限包，仅允许一次 Shift-down；旋转前系统状态及目标可信事件确认按住，旋转后收到唯一对应松开，系统键位 / flag 清除；同一手机进程与 PC 继续解码并显示新色块，超过 5 秒仍仅查看，无自动重授，独立停止保护未触发 | 不隔离客户端 release 与 host drain 的贡献，不证明横转竖、组合键、物理折叠或弱网。普通包已恢复并复验画面，Mac 清理、关闭输入及 TURN socket 归零已确认；该次最终手机竖屏复核因 HDC 断开未完成；后续新版普通包已独立复验退出后的普通页面与竖屏恢复 |
| 横屏实际输入 | 旋转后手机点击 Mac Desktop 搜索入口，真实空输入框获焦点；逐次输入 `123`，退格后为 `12`；Backspace/Enter 各一组原生按下/松开；停止后超过 5 秒仍查看且键盘关闭 | 仅当前输入框，不以工具耗时推算交互延迟 |
| 未确认中文旋转取消 | 手机输入 `nihao`，每一步 Mac 仍为空；识别到“你好”候选但不选中，旋转后键盘/操作权释放；6 秒后真实输入框仍为空且保持查看 | 不替代其他输入法、确认文字后的编辑或按住输入清理 |
| 释放与撤销竞态 | 私有故障包丢弃 release，并将下一次真实健康回复设为失焦；真实 host 完成清理后发出撤销。连续两轮等待超过 4 秒仍保持同一视频连接，匹配撤销结束等待，显式再次申请成功 | 只申请/释放操作权，无 Mac 键鼠输入；不替代按住键清理。收尾恢复正常签名客户端，项目源码/正常包均无注入 |

此前账号测试收尾经本机停止确认资源排空，恢复竖屏及关闭的普通操作 gate；新增持键测试的收尾证据以对应表格为准。此前诊断中的单次 `control_delivery_unknown` 缺少完整通道轨迹，不能断言所有此类超时均来自已修复的竞态；普通负载和丢包等其他路径仍须分别验收。[IME adapter](../../src/apps/mobile/harmonyos/entry/src/main/ets/services/RemoteDesktopKeyboardService.ets)记录内部暂停原因，控制器记录等待释放/收到撤销，均不记录输入/预编辑正文。横转竖持键、组合修饰键、物理折叠及完整稳定性矩阵仍未验收，普通输入不因此开放。

IME 关闭先使旧回调失效，再独立尝试移除每一种平台回调；单个移除失败不能跳过其余移除和 detach，下一次 attach 继续等待前一次 detach。新版鸿蒙真机已通过横屏宽 / 窄、浅 / 深主题及竖屏共五组即时文字与配对退格 / 回车检查，收起保留接收上下文；该检查使用无账号 intent sink；真实账号输入按第 4 节逐项记录，不将 UI 检查作为远端 OS 输入证据。

每个异步回调捕获账号绑定、目标设备、attach/connection 与本地 renderer 对象身份，身份切换或关闭后丢弃旧结果。离开远控页先同步关本地输入闸门、使回调失效并关闭本地媒体，再等待动画、偏好保存和其他清理。若 attach 正在等待回复，待原请求结束后通过原 channel/attach_id 尽力 detach，再清除该通道密钥；不能让取消先于申请发送，也不能借新账号/新页面的通道清理旧请求。[EntryAbility](../../src/apps/mobile/harmonyos/entry/src/main/ets/entryability/EntryAbility.ets) 的后台、窗口销毁和 Ability 销毁已通知正式远控 owner；关闭路径同步退役输入与回调、关闭本地媒体并尽力 detach，由 host watchdog 与原生清理兜底；前台由用户重新连接。前台恢复不自动续上旧操作权。布局重组与用户关闭分别处理，不能把每次组件 disappear 都等同 detach。

2026-10-15 鸿蒙只读产品接线已落在上述 service/ViewModel/state/组件和 `src/shared/remote-desktop-media`。设备列表有独立“查看桌面”入口，不更改聊天 host/工作区；原生层重新取固定设备公钥，加密 probe/attach/answer，通过现有账号 socket 路由并领取 scoped TURN。attach ACK 结果未知只读权威快照，不自动重放 mutation。媒体桥只得到当前连接的 SDP 和短时 ICE，退出、后台及账号替换关闭本地媒体并失效旧回调；折叠宽度变化保持同一个 WebView。采集提交确认与当前 PC 的实际呈现事件分别收集；两者可能乱序，仅保留该 PC 的呈现尺寸元数据，静态首帧不要求额外编码。发送端不得提前编码占位黑帧；该前提及静态场景仍须在真实 native/account 闭环验证，当前不据此开放输入。

远控页由 AppRoot 全屏承载，设备选择 sheet 只负责入口；系统返回先退出远控。面板按窗口安全区布局，键盘采用 resize，避免工具栏落入系统导航区域。软键盘使可用高度过小时收起标题，操作按钮、收起入口及可横向滚动的特殊键共用一行，仍保留可见视频。键盘代理与手势层按 renderer / 租约绑定，不提供本地草稿编辑框；媒体 WebView 保持同一实例。

聚焦测试已覆盖后台取消、账号切换、迟到 TURN/answer、attach ACK 丢失、single DC 和旧 renderer 隔离；Chrome 真实回环验证共享接收页的帧呈现、bind、resize 与关闭。DEL-AL10 已安装调试包并检查固定 rawfile/窄桥、宽窄布局、浅深主题、工具栏滚动与本机信任提示；这些 UI fixture 不读取账号、不采集屏幕，不能替代正式账号链路、原生 source、强制 TURN 和撤销停流验收。物理折叠与手机后台的真实 P2P 资源回收仍须单独验证。macOS feature 和普通输入 gate 仍默认关闭；已接线的 reservation / 输入受限验证不代表完整交付，其他被控平台尚未实现。

#### Android 接收与原生控制

专用 Android 17 / API 37 模拟器、WebView 149.0.7827.5 已通过[正式原生适配器](../../src/apps/mobile/android/app/src/main/kotlin/com/openbitfun/mobile/app/ui/remote/RemoteDesktopWebView.kt)接收独立浏览器生成的 320×180 VP8 视频，原生窗口像素、可靠有序 DC、健康往返及 relay/relay UDP 已验证。[运行器](../../scripts/test-remote-desktop-android-media.mjs)要求四项实际执行且无跳过，覆盖停流 / 重建、新源确认、摄像头 / 麦克风拒绝、禁止导航、同源重载及退役回调。该证据不证明 P2P 或完整弱网稳定性。

共享接收页在安装 DataChannel 回调后，也检查通道是否已经 open；迟到 / 重复的 open 事件共用一次发送闸门，避免只依赖事件顺序而漏发或重发 bind。43 项接收 / 控制单元检查和 7 项真实浏览器检查通过，Android 三项强制 TURN 检查也已复验。测试发送端按源使用独立连接 / 短期凭据，并在重建前关闭自身旧 PC；不提高试用 TURN 配额来掩盖 allocation 拒绝。鸿蒙签名 HAP 已编译并核对三个接收资源与共享源一致，架构检查通过；2026-10-19 已更新既有试用包并完成上述基础原生输入验证，不补足其他桌面接收端的原生验收。

三个共享接收文件已以独立目录打包到 Android 主 APK，终端原有资源保留。适配器只加载固定本地资源和窄桥，不接受账号 IO；[Compose 层](../../src/apps/mobile/android/app/src/main/kotlin/com/openbitfun/mobile/app/ui/remote/RemoteDesktopMediaView.kt)经 core-feature 的 UiState / Intent 接线，停止先隐藏画面并退役回调，再显式关闭 PC，最多等 2 秒销毁原生 WebView，不等待网络 ACK。上述测试直接使用正式 WebView 类和媒体 UiState / Intent，信令仍是经认证的 ADB/loopback fixture；没有证明 KMP store 到真实账号、macOS 原生源及手机的闭环。真实账号服务与 macOS 原生源联调、真实 Android 手机、OS 输入及公开 HTTPS 仍待验证，鸿蒙首条交付顺序不变。

[原生只读页面](../../src/apps/mobile/android/app/src/main/kotlin/com/openbitfun/mobile/app/ui/remote/RemoteDesktopScreen.kt)已实现选屏、连接进度、失联提示、逐类失败原因、断开与显式重连，复用现有移动主题、语义字号、系统安全区和中英文资源。账号层提供固定目标的 store，页面不选择 Agent 会话、不授予键鼠权限。首次进入可见生命周期才 Load，后台 / 页面销毁 Close，返回前台不自动重连；同一 composition 的布局更新不重建 WebView。14 项原生入口 / 页面回归覆盖独立目标按钮、不可达提示、UiState / Intent 呈现与生命周期，另检查放大字体下的 compact 浅色 / wide 深色布局；这是受限视口测试，不是物理旋转、折叠或真实账号媒体闭环。账号设备列表已接独立“查看桌面”入口；按 shared policy 过滤目标，再由 host probe / grant 确认，不更改聊天设备。重新连接向账号工厂申请新 store，不复用后台退役的实例。

[Android 账号 / 媒体集成运行器](../../scripts/test-remote-desktop-android-account.mjs)的六项检查已通过：实际调用公共账号工厂和平台安全存储，经 X25519 / AES-GCM、OkHttp / Socket.IO、独立远桌 store 与原生页面，通过强制 TURN 呈现 320×180 生成视频；同一 attachment 暂停后关闭旧媒体，继续查看使用新的 connection / renderer 并等待新首帧；另验证断开后显式创建新 store、重新选屏、等待新画面，最终 detach，聊天目标保持不变。暂停选屏一项刷新两源目录，取消后仍暂停，再选择另一源，要求新的 connection / renderer、480×270 画面及新的黄 / 青像素，中继仍为 relay/relay，未重新 attach；这不是物理双屏验收。自动续期一项仅缩短模拟 host 报告的预算，使用真实短期 TURN 凭据；再次确认新绑定、原生窗口像素及 relay/relay，没有重新 attach，不属于真实凭据到期或长期稳定性验收。拒绝查看授权一项确认没有枚举屏幕、attach 或领取 TURN。新增两项控制检查：手动开启后实际原生点击仅发送一组归一化左键按下 / 松开，黑边及仅查看状态不发输入；原生对话框造成失焦时，执行时的 native predicate 拦截排队 JS 点击并释放租约，恢复焦点及暂停 / 新 PC 恢复都不自动开启操作。拒绝操作授权仍可查看，没有指针事件。认证服务、Relay 和被控主机均为隔离回环夹具，不打开外部登录页、不复用现有设备身份 / grant；它证明生产模块接线，不替代真实账号服务、Relay 授权关联、macOS 原生 source、Android 真机、权限撤销或 OS 输入验收。

KMP 账号传输已有[专用远桌绑定](../../src/apps/mobile/shared/core-transport/src/commonMain/kotlin/com/openbitfun/mobile/core/transport/RemoteDesktopRpc.kt)和[账号加密通道](../../src/apps/mobile/shared/core-transport/src/commonMain/kotlin/com/openbitfun/mobile/core/transport/RemoteDesktopAccountChannel.kt)：发现 route / TURN / credential-binding 能力后固定账号、目标、公钥和认证 socket 代次，不借用 Agent invoke、bulk 或密钥缓存，不迁移旧请求或自动换钥。通道拥有加密生命周期，[HTTP owner](../../src/apps/mobile/shared/core-transport/src/commonMain/kotlin/com/openbitfun/mobile/core/transport/RemoteDesktopMetadata.kt)负责有界读取与禁止重定向，[TURN owner](../../src/apps/mobile/shared/core-transport/src/commonMain/kotlin/com/openbitfun/mobile/core/transport/RemoteDesktopTurnCredentials.kt)负责凭据结构和纯校验；公网要求 HTTPS，回环允许试验隧道。JVM 46 项、Android host 36 项传输回归通过，包含实际 OkHttp / loopback Socket.IO 和真实加解密的模拟 HTTP / socket；不是手机账号媒体验收。

`core-feature` 的 [RemoteDesktopSetupStore](../../src/apps/mobile/shared/core-feature/src/commonMain/kotlin/com/openbitfun/mobile/core/feature/remotedesktop/RemoteDesktopSetupStore.kt) 已接账号工厂，显式选屏和 attachment 不改变聊天目标；CLI / 手机 / 离线目标不进入远桌准备，历史空类型仍 probe。store 拥有账号 / attachment 生命周期，功能内窄通道负责 v1 JSON 映射，[MediaSession](../../src/apps/mobile/shared/core-feature/src/commonMain/kotlin/com/openbitfun/mobile/core/feature/remotedesktop/RemoteDesktopMediaSession.kt)负责只读 SDP / TURN、应答、首帧和失联宽限，[CredentialBudget](../../src/apps/mobile/shared/core-feature/src/commonMain/kotlin/com/openbitfun/mobile/core/feature/remotedesktop/RemoteDesktopCredentialBudget.kt)负责不可延长的单调 / 墙钟期限。`Attached` 只表示逻辑关联；`Viewing` 还需本 PC 的源确认、应答及实际呈现，强制中继另验 relay/relay；候选元数据未知时等待，明确直连则拒绝。媒体 UiState 只携带短期 ICE / SDP，脱敏输出，不携带账号凭据。关闭先同步清空媒体状态，再等在途 attach / signal 结束，用原绑定尽力 detach；账号工厂的替代 store 也等待旧 owner 的 attach / detach 清理完成后才开通道，后台或账号 owner 已销毁时不创建。ACK 未知只查权威状态，不重放 mutation。

KMP / Android 的暂停 / 恢复已按 `source_lifecycle_v1` 协商接入。暂停先隔离旧媒体回调与轮询，收到相同 attachment / connection 的 suspended 确认后再关闭本地 PC，并等待 `cleanup_pending=false`；恢复先读取新的 CAS，复用 attachment，但必须取得新 connection，再创建 renderer 并等待新画面。丢 ACK 只读取一次权威快照，不刷新 CAS 重放 mutation。退出等待媒体与 source 请求都结束后再 detach；暂停 / 排空从首次请求起最多保留 60 秒，手动暂停不自动恢复。旧 host 不显示暂停入口；恢复始终仅查看。暂停后可重新读取授权目录并选屏：发现请求不带 outer attachment，取消隔离迟到目录并保持原保留期限；select_display 和 resume 各读新的 CAS，经同一绑定确认目标与排空状态，丢 ACK 只查一次，不重放或回退。Android 窄 / 宽及浅 / 深截图已核对，当前屏有标记，取消固定在顶部。共享层用延迟 / 丢 ACK / 旧回调 / 超时用例验证，Android 模拟器经模拟认证 / 主机、生成视频和实际 TURN 验证 PC 关闭 / 新源重建；不能替代真实 Relay 故障、原生捕获、长时保留或真机输入验收。

KMP 自动凭据重建复用同一 source owner，要求同时具备两项生命周期 / 续期能力、已经呈现和实时信令可用。剩余预算进入 60 秒内时按上述顺序重建，不增加命令或并行 PC；手动暂停在 suspend、排空及已发出 resume 期间均优先，后者确认后重新暂停新 PC，不向界面发布它。账号退出、授权拒绝、超时或到期立即结束；新凭据不足 60 秒拒绝，避免循环。Android 在过渡期间也保留暂停入口，已就绪的 WebView 可显式准备新连接，不依赖再次收到文档 ready 事件。共享测试覆盖上述竞态；多周期实际到期、真实账号 / 原生发送源和 Android 真机续期仍待验证。补充复现确认：JS 已见通道 / SCTP / PC 连接，但 bind 首发出现原生异步 INVALID_STATE。接收器现于事件回调后的下一任务只发送一次，停止取消待发任务，失败不重试；44 项共享单元、7 项浏览器及两轮各 4 项 Android 底层检查通过，账号集成 3 项再次通过。Android 文档代次改为加载前固定，避免跨线程就绪消息误丢弃，同源重载仍关闭文档。Chromium 内部根因及长期稳定性仍未验收，不能由这些复验推出已完全解决。

KMP 已呈现 PC 的 Relay 故障保留视频最多 30 秒；只读恢复新建信令绑定，并复核原账号对象、目标、公钥及同一 live connection，不重建 attachment、PC 或延长原凭据。换账号、换钥、错误连接、显式媒体终止及凭据过期立即结束；未呈现的准备仍有 60 秒总预算。JVM / Android host 各 147 项远桌 / 账号回归通过，覆盖模拟 feature 通道与 host 形状解析、首帧乱序、迟到回调、关闭 / 取消、失联恢复、续期和时限；不证明 native WebView 画面或真实网络撤销。iOS 接收桥和设备目录入口的准备见下文；两端真机账号媒体仍待验证，不能据此广告 Android/iOS 远控能力；鸿蒙首条交付顺序不变。

KMP 的 [ControlSession](../../src/apps/mobile/shared/core-feature/src/commonMain/kotlin/com/openbitfun/mobile/core/feature/remotedesktop/RemoteDesktopControlSession.kt) 已接入 setup store，集中处理当前 PC 的输入准入和退役；JS 继续持有租约请求、ACK 时限、续约与 DC 顺序。开启前读取同一 attachment / connection / display 的 streaming 快照和新 CAS；点击保留创建时的本地意图代次及 control_generation。host 广告 ordered_control_v1 还不够，渲染器必须明确确认支持事件创建时的代次回传和排队输入退役；本地代次不进入远控输入协议。释放确认前不重新申请，未知 acquire 关闭 PC，不猜代次；暂停、换屏、尺寸变化和退出退役输入，有界原生意图出口遇到压力即失败。

Android 已接通显式开启 / 停止与触点点击。原生桥只处理焦点、手势和 JS 执行，core-feature 负责意图准入，共享 JS 负责租约；不另建输入协议或授权 owner。接收器以可选 control_epoch_v1 声明事件创建时的本地代次回传，兼容未使用该字段的旧适配器；代次不进入 DataChannel 正文。操作须等 host 能力、有效首帧几何及原生焦点应答就绪；执行每条输入前再同步读取当前绑定、租约与焦点。排队原生 JS 有界，超时或压力关闭当前 PC。新 PC 创建新文档，布局变化保留同一 WebView。

47 项接收 / 控制单元、7 项浏览器、6 项 Android 账号 / 媒体集成及 14 项原生界面检查通过，宽窄浅深截图已核对；鸿蒙签名 HAP 编译并核对共享资源，未替换手机现有试用包。直接触控手势接线见下段；键盘基础接线见下文。模拟输入 sink 不证明 Android 真机、真实 host 设备授权、macOS OS 投递或完整故障矩阵。

Android 的[原生手势策略](../../src/apps/mobile/android/app/src/main/kotlin/com/openbitfun/mobile/app/ui/remote/RemoteDesktopGesturePolicy.kt)已接长按右键、双击第二次按住 / 移动拖动、双指平移滚轮和本地 1–3 倍捏合缩放。类型判定后锁定，黑边不能起始远端输入；缩放后的触点先逆映射到原始视频 contain 坐标，工具栏不缩放。手势取消、视口 / 源变化、增加手指或失焦时，按下按钮的拖动以原绑定 / 代次释放租约，不猜测新坐标补发；旧视图的焦点回调不能释放后继控制。仅相邻移动按帧合并，按钮 / 按键 / 滚轮维持顺序，继续走原有输入协议及执行时权限校验。12 项纯手势与 3 项原生桥测试通过；独立强制 TURN 手势用例在竖屏 / 宽屏分别通过，生成源确认右键、拖动、滚轮、缩放后点击及取消后的空租约 / 按钮账本。宽屏首轮因测试预期漏算两侧黑边而失败，修正 contain 预期后通过；原始失败保留。这些是模拟认证 / host、生成画面和内存输入 sink 的证据，不能代替 Android 真机、原生 OS 拖动 / 双击语义或完整故障矩阵。随后更新后的完整九项账号 / 媒体集成全部通过，另有 22 项原生界面 / IME / 输入桥回归通过；这些通过不抵消下段既有的间歇重连失败，也不证明长期稳定性。鼠标模式、拖动锁定、移动画面工具及真实旋转 / 折叠仍待实现和验收。

后续在鸿蒙试用同时在线时，Android 底层连续重建复验仍有未通过项：新连接无 ICE 候选，原生诊断确认 TURN 返回 486（分配配额已满）；新建 WebView 也会发生，不能归因于文档复用。初轮另观察到一次内核异步 INVALID_STATE / bind 未送达，既有下一任务发送措施不能视作完全修复。保持试用配额与用户手机连接，不通过重放 bind、提高配额或重启服务取得绿灯；立即回收和长期重连稳定性仍须补齐。

Android 远程键盘已接[原生 InputConnection](../../src/apps/mobile/android/app/src/main/kotlin/com/openbitfun/mobile/app/ui/remote/RemoteDesktopKeyboardView.kt) 和原有有序输入桥，文字须协商 `text_commit_v1`，不支持时禁用文字键盘并提示，特殊键仍可用。预编辑只留手机；commitText 确认的 Unicode 直接按原租约发送，finish / 隐藏 / 失焦 / 关闭丢弃未确认内容；旧连接回调不能重标为新租约。[共享纯函数](../../src/apps/mobile/shared/core-feature/src/commonMain/kotlin/com/openbitfun/mobile/core/feature/remotedesktop/RemoteDesktopKeyboardIntent.kt)统一 4096 字节 UTF-8、NUL 与非法代理项校验，文字意图的诊断输出脱敏。退格、回车、Tab、Esc 和方向键使用配对 HID 事件，不维护新的按住键状态；不镜像远端文本、不读取剪贴板，不猜测多字符删除范围。输入法可见性在执行回调时再次检查。

键盘弹出后原生页面按 IME insets 留出空间，收起标题，把停止 / 收起操作固定在工具栏，特殊键横向滚动；深色文字使用现有 onSurface token，系统栏跟随原生 App 主题。已通过独立的强制 TURN 键盘集成：实际账号工厂 / 加密通道 / 原生页面，程序调用 InputConnection 的中文和数字确认到达生成源，退格 / 回车配对，停止后旧回调拒绝；没有执行真实 OS 输入。该运行只执行一个明确标记的键盘用例，不能代替此前六项集成或更新后的完整八项套件。原生 IME 检查覆盖预编辑取消、非法提交、实际键盘避让及系统返回；宽窄显示配置分别启动、浅深截图单独核对，不当作真实旋转 / 折叠或人工候选词选择验收。

Android 输入法上下文已补正：本机缓冲只包含预编辑，不能据其为空推断远端处于句首。原生代理初始化本地选择为 0，清空预编辑后恢复该选择，getCursorCapsMode 返回未知上下文的中性值 0；用户通过 Shift 明确提交的大写字符保持原样。原生回归先复现了基类报告非零大写模式，再验证修复，IME 五项检查在窄屏及宽屏通过。

新增真实 Gboard 触摸检查：专用 API 37 模拟器、Gboard 17.5.6.917159154，读取当前输入法窗口的按键几何并实际触摸，不手工替换它的 InputConnection。经公共账号工厂 / 加密通道 / 强制 TURN，逐字小写、Shift 后大写、配对退格 / 回车在生成源按序接收；停止后租约消失、没有自动重授。两轮竖屏及一轮宽屏通过，宽屏另验证打开键盘时原生画面继续交替更新两种测试颜色。它仍不证明 Android 真机、中文输入法候选词选择、真实账号服务、Mac 原生注入或长期稳定性。早期有一次等待超时，另一次记录到发送端拒绝输入；原始细节不足，不能将其全部归因于上述大小写问题或记为已完全修复。完整八项套件未据此算作通过，失败记录留在本地。

#### iOS 接收、入口与输入

iOS 已接独立设备入口、[原生 model](../../src/apps/mobile/ios/OpenBitFun/Features/RemoteDesktop/RemoteDesktopModel.swift)、[WK 接收器](../../src/apps/mobile/ios/OpenBitFun/Features/RemoteDesktop/RemoteDesktopReceiver.swift)、左键点击和[原生键盘](../../src/apps/mobile/ios/OpenBitFun/Features/RemoteDesktop/RemoteDesktopKeyboardView.swift)。入口复用 KMP device-kind / capability 策略，固定设备的 store 不改变聊天选择。KMP 继续持有信令、CAS、预算与清理，JS 继续持有租约 / ACK / 续期；原生层只接生命周期、手势和 IME。新 PC 使用新文档，普通布局变化保留当前文档。离开、inactive、后台先退役本机输入和媒体，再关闭 store；前台须显式重连，不恢复操作权。高级手势仍待接入。

WK 从 Bundle 子目录读取同一共享源的三个资源，使用非持久化存储和原 CSP，验证 secure context / RTCPeerConnection，拒绝导航、重载、popup 和音视频采集权限。桥不含账号 token、设备密钥或通用 JS 调用。输入命令最多 8 项、2 秒单调时钟期限；JS 串行执行整条命令，每个 body 执行前经一次性 ID / 索引回到原生层复核实时 KMP 绑定、代次和窗口 / 前台焦点。标记不进入 wire；旧请求拒绝，已准入的在途输入不能撤回，桥接未知 / 异常结束 PC 且不重放。点击复用 contain 投影，触点开始固定授权，几何 / viewport / 权限变化取消手势；初始 null 媒体是尚未准备，真实 media → null 才退役。已关闭或缺失的 renderer 明确失败，不吞输入。

键盘需 `text_commit_v1` 并显式打开。UITextView 仅作 IME 代理，不展示本地草稿或保存远端文本；确认 Unicode 经现有校验提交，预编辑留在手机。退格先改本地预编辑，否则发送成对按键，工具条提供编辑 / 导航键。每次打开固定原绑定 / 租约代次及本机生命周期 token；回调同时检查实时 KMP 快照、first responder、key window 和 app 活跃状态。收起先同步作废 token，再让 UIKit 结束编辑，旧代理不能借新权限补发。紧凑高度将工具条与操作栏合成一排，保留至少一半键盘外可用高度给画面；竖屏分排。未增加剪贴板能力或协议字段。

专用 iPhone 17 / iOS 26.3.1 模拟器通过十一项[账号 / 媒体 / 输入原生回归](../../scripts/test-remote-desktop-ios-account.mjs)，无跳过。使用公共账号工厂、真实 Keychain、X25519 / AES-GCM、Darwin HTTP / WebSocket、KMP store 和产品页；媒体用例通过强制 TURN 呈现生成像素。覆盖暂停换屏保留 attachment / 更换 PC、显式新开、后台结束活跃租约、拒绝查看不枚举或分配媒体、拒绝操作保留视频、detach 后账号 socket 保持到登出，以及聊天目标不变。输入覆盖点击 / 黑边 / 连续按下松开顺序、停止、真实 WK 排队后的原生窗口失焦拒绝、乱序 / 重复 / 旧代次 / 过期请求和队列边界。

键盘检查分别覆盖 UIKit preedit API、真实英文软键、系统简体拼音候选栏：拼音输入和本地退格期间主机输入为 0，点实际候选词后只提交一次确认文字；系统 Delete / Return 在确认后各产生一对远端按键，收起新的预编辑不补发。中英文用例通过原生菜单显式选输入法，不依赖上次选择。带画面收起键盘、竖转横再重开时 attachment / PC 不变；最终紧凑布局与触摸区另有定向复验。已有两项底层媒体检查、四项打包 WK bootstrap 的纯 JS 检查及一项两种启动方向的布局检查；这些范围不能相互替代。命令与配置要求见 [iOS README](../../src/apps/mobile/ios/README.md#remote-desktop)。

账号服务、主机回复、grant 和画面源仍是合成的，不证明真实账号 / 本机授权 / macOS 原生源或 OS 输入。iPhone/iPad 真机、持续预编辑中旋转、其他方向 / 折叠、第三方输入法和长期续期尚待验收。早期 `_UIReparentingView` 与 `ice_no_candidates` 记录保留，根因未完全隔离，后续通过不等于已证明长期稳定或逐 PC 回收。限定 TURN 元数据观察见过 lifetime=0 的成功回复，未保存原始包；TCP 中途加入 / 未完整重组限制使其不能证明逐 PC 回收。测试使用各自短期 TURN 用户名，不改变服务器配额；模拟器安全存储须带本地应用身份签名，失败不换成内存存储或重置数据。下一步补真机与真实账号 / macOS 输入联调。

#### 电脑控制端接线

2026-10-16 已在同一台 Mac 的两个隔离 Desktop 实例中，用不同持久化设备 ID、独立密钥和同一测试账号走通实际产品查看页：新增设备未授权时拒绝显示器枚举且不分配 TURN；被控端本机确认仅查看后，ScreenCaptureKit 原生桌面以 1280×828 持续呈现，ICE 两端均为 relay / UDP。暂停后实际排空，恢复保留 attachment、创建新 connection 并等待新首帧；原始尺寸 / 适配窗口切换不重建媒体。该证据补齐 macOS 主内容页的原生呈现路径，不能计作两台物理电脑、其他桌面 OS 或电脑端 OS 输入验收；普通输入仍关闭。

Web UI 的[独立控制器](../../src/web-ui/src/infrastructure/remote-desktop/RemoteDesktopController.ts)复用上述原生 sender，设备列表另设“查看桌面”，不切换 Peer / 聊天 host / 工作区，也不使用通用 Peer 版本相等检查代替远控 probe。主内容页复用 OpenBitFun Field、Select、Switch、Button、StatusPill、Textarea、主题 token 和既有 Appearance 注册；显示器须显式选择。普通被控构建仍关闭输入；只有 host 声明 `ordered_control_v1`，且用户显式申请当前 attachment 的 CAS，才允许接收租约。仅查看不申请操作权。

[媒体 adapter](../../src/web-ui/src/infrastructure/remote-desktop/DesktopMediaFrame.ts)将同一共享 receiver 打包进无同源权限的 sandbox iframe，以 nonce CSP 和窗口 / token 绑定的窄消息桥隔离；不加载远端 URL，不提供 Tauri、账号 token 或设备私钥。SDP / 短时 ICE 只进入 adapter，不进入可展示状态。原生账号变化、后台、退出立即停本地媒体并尽力 detach；attach 在途时先失效本地回调，待原请求结束再清理同一 attachment，避免 detach 跑到 attach 前面；保留旧 context，禁止换身份清理或自动重放旧操作。桥因错误销毁后，显式重连创建新 iframe / bridge / controller，重新 probe 和选择显示器；旧桥回调不更新新页，不恢复旧租约。

PC 输入的[纯策略](../../src/web-ui/src/infrastructure/remote-desktop/DesktopInputPolicy.ts)负责视频矩形逆变换、黑边拒绝、拖动边缘、滚轮单位与物理 HID 键；DOM 叶组件仅在操作画面转发物理键，文字在本地编辑、显式发送。操作画面聚焦时，应用快捷键和浏览器快捷键拦截让普通按键进入该画面，不关闭全局快捷键系统；本地关闭标签显式保留，用户自定义绑定仍有效。焦点移到工具栏 / 本地编辑器后使用原有本机快捷键；Esc 和平台保留动作仍留在本地，不承诺捕获 OS 保留组合键。

鼠标多键同时按住时，后续按钮边缘从 `pointermove.buttons` 对账，只作用于已经由本页按下的同一 pointer；不接管画面外开始或本地清理后的按住状态。捕获拖动离开画面时按 source 边界映射，失焦释放每个已注入按钮。2026-10-20 的 154 项控制器 / 输入 / DOM 回归与 Web 检查通过；生产 React 输入叶组件和纯策略另用 Chromium trusted 鼠标事件验证左右键交替释放、拖出画面与失焦后的迟到事件。该浏览器检查使用内存 sink，无账号、媒体或 OS 注入，不替代电脑端原生输入验收。

意图固定 renderer / control_generation，旧清理也使用原绑定，不能释放新租约。共享 receiver 另须声明 App 内部 `control_epoch_v1`：控制器复用现有意图计数给命令加代次，报告按创建时代次比对；迟到旧授予 / 释放不能改变新状态，缺失或未发出的代次终止当前连接。旧本地 renderer 保留仅查看；该字段不进入 Relay / DataChannel。

失焦或取消先松开本次输入再释放；布局变化结束当前操作，紧凑窗口将画面与编辑区并排。跨 iframe 队列有字节 / 条目上界和执行 ACK，只合并同代次相邻移动；释放清除旧输入，背压或超时关闭，不能丢弃键 / 按钮边缘。主页面焦点通过当前健康探测逐次问答，回执超时、错代或过期均不能保持输入，不把 iframe 自身焦点或缓存正值当作操作者焦点。

2026-10-15 控制器 / 输入 / DOM 聚焦测试 30 项、包含账号入口 / Peer 路由 / Appearance 的组合检查 130 项、共享媒体与鸿蒙控制回归 41 项通过。Chrome 与当前 macOS Desktop WebKit 均在实际沙箱内呈现生成的视频帧；Chrome 的真实 OpenBitFun 页面通过模拟被控端收到配对鼠标 / 方向键、显式文字及缩放 / 失焦释放。标准 / 紧凑布局已检查。此验证没有第二台电脑的真实账号、原生捕获或 OS 注入，不能计为 PC → PC 完整验收；Linux WebKitGTK、Windows WebView2、实际电脑键鼠和故障矩阵仍待验证。

电脑入口现通过 [openRemoteDesktopResource](../../src/web-ui/src/app/components/RemoteConnectDialog/remoteDesktopResource.ts) 创建 `remote-desktop` 内容资源：scope 固定本机、无 workspace / SSH connection，key 包含账号和目标设备；重复打开只聚焦原标签，不切换 Peer 或创建 Agent session。资源中只有账号 / 目标展示元数据，不保存 PC、设备密钥、凭据、租约或草稿，也不创建 EditorDocument。sceneStore 将这些控制端标签与每个 Peer 的文件标签分开保存，切换设备后不混入文件来源；恢复时不自动选中远控标签。资源视图核对当前账号，登出 / 换号会退役原 controller 并显示身份变化，保留标签元数据。

隐藏已观察的页面时，现有 controller 的 `setVisible` 立即失效输入并暂停 source；显示页面后等待实际排空，再用新 connection / renderer 和新首帧恢复仅查看。用户手动暂停不自动恢复；旧 host、协商中断、保留超时或快速隐藏正在恢复的页面，转为显式重新探测 / 选屏，不重放 attach 或租约。关闭中键、Ctrl+W、批量关闭等沿用 `registerContentCloseGuard`；退役在等待后继 session 导航前发生，而不是等 React 卸载才关闭。上述路径由资源 / 账号 / 隔离控制器 / DOM 及既有工作台回归验证；不计为新主内容页的原生可视验收或双电脑实机通过。

电脑查看页已增加本地“适配窗口 / 原始尺寸”：原始尺寸以当前接收帧像素对应 CSS 尺寸，可滚动查看，切换比例 / 滚动先释放操作，不重建媒体连接。共享 receiver 在已呈现后通过 App 内部 `frame_resized` 通知当前尺寸，先退役输入，再同步电脑与鸿蒙视口；不改变 Relay / DataChannel wire，也不重复触发首帧。旧 renderer 回调不更新新页面，尺寸元数据无效不能进入观察。电脑主标签的文字编辑区现按同一 viewer root 识别焦点，离开画面进入本地编辑区只松开已按的键，保持本次租约；离开该 viewer 才释放。比例 / 焦点由 68 项电脑聚焦测试覆盖，尺寸通知另有真实 Chromium 视频变分辨率证据；新版鸿蒙通过真实账号 / 强制 TURN 的首帧、暂停恢复和回收。该轮未完成电脑主页面原生视觉或双电脑验收，画质选择见第 7.3 节。

全屏由控制端 `DesktopFullscreen` 持有当前 document 的元素全屏，不向目标电脑发送窗口命令。进入 / 退出先退役输入，过渡期间禁止开启操作；Esc 优先在本地退出，不让外层 Dialog 同时关闭远控页。打开选屏器先等待本页退出全屏，避免全屏层遮住设计系统的菜单。隐藏、退出、身份变化和 controller 替换立即取消本页申请；在途 native 请求保持 document 占用，迟到成功后排空，不能叠到后续 viewer 下或退出其他 surface 的全屏。即使 DOM 已清除全屏元素，所有退出调用者仍须等待同一原生退出请求结束，才能交接 document 或展示选屏器；平台拒绝时显式显示失败，由用户再次发起，不自动重试。聚焦测试覆盖重复退出等待、取消后原生请求被拒绝及后续显式重试。macOS 实际 WebKit 已用真实本机点击验证进入 / 退出、页面可见性及原窗口全屏状态保留；普通窗口的内容视口从 1200×800 扩至 1512×922。该适配器实测不包含媒体、账号或远端输入租约，不能替代完整远控页视觉、双电脑或其他 OS 验收。

### 7.3 捕获和编码

macOS 新增显示器级 ScreenCaptureKit source；Windows 新增 monitor source；Linux 使用授权 portal/PipeWire source。保持既有单窗口/background 契约；独立估算三平台原始帧、光标和清理工作。

流程为 authorized source → 原始 BGRA/RGBA/GPU frame → 有界转换/缩放 → 编码 → WebRTC，禁止 JPEG/base64 再解码。首版允许有界 CPU 拷贝，分别量测捕获、转换、编码、接收和呈现。一个 attachment 只需一条编码链，native 资源预算按实测判断，不引用固定 NVENC 会话数替代具体 GPU/驱动能力。

互操作候选为 H.264 Constrained Baseline、VP8，实际 profile/level 和 packetization 通过 SDP 协商；首选实测可用的硬编，其他路径须达标。标准依据 [RFC 7742](https://www.rfc-editor.org/info/rfc7742/)；标准必选项不等于当前嵌入式内核已可用。

初始目标：省流长边 1280 / 15fps / 0.8–1.5Mbps；均衡 1080p 范围 / 30fps / 2–4Mbps；清晰 1440p 范围 / 30fps / 4–8Mbps。保持宽高比、不修改系统分辨率；网络弱时主动降档。画面包含真实光标，本地指针预测有独立视觉语义。

画质参数集中在 [quality](../../src/crates/contracts/product-domains/src/remote_desktop/quality.rs) 纯策略，macOS 捕获尺寸、采集帧率及 WebRTC 码率 / 帧率上限从同一档位取得。当前设置为省流 1280 长边 / 15fps / 起始 0.8、上限 1.2Mbps，均衡 1920×1080 范围 / 30fps / 起始 2、上限 4Mbps，清晰 2560×1440 范围 / 30fps / 起始 4、上限 8Mbps；竖屏交换长短边，不放大原始画面，输出按偶数像素取整。这些是配置边界，实际尺寸 / 帧率 / 吞吐仍由源与网络决定，不算性能达标。

macOS 的显示器目录和画质缩放使用 `CGDisplayMode` 的渲染像素尺寸，输入继续按 Quartz 坐标映射，两者不混用。本机 HiDPI 模式实测为 1512×982 逻辑尺寸、3024×1964 渲染像素；此前按逻辑尺寸计算会过早限制均衡 / 清晰档。捕获启动验证当前像素范围与宽高比，逐帧同时检查显示器身份、逻辑边界和渲染像素尺寸，缩放模式变化也会使旧源失效。已显式运行显示器元数据测试并通过 74 项 Desktop 远控检查；这不等同于实际切换系统缩放模式的验收。

捕获适配器的原生输出上限现按长边 3840 / 短边 2160 校验，横竖屏使用同一像素预算；偶数尺寸与 1–60fps 限制保留。此前按宽 3840 / 高 2160 写死会拒绝清晰竖屏的 1440×2560，虽然 SDK 编码参数探针通过，实际采集入口仍进不去。该反例已先失败复现；修复后同一测试覆盖三档 × 横竖屏的捕获入口校验及真实 SDK sender 参数，另验证换向不放宽最大分配、奇数尺寸或帧率。75 项 Desktop 远控检查及带媒体 feature 的普通开发构建通过，7 项原生专项仍须显式运行；当前试用进程和二进制保持原版，未部署该修复。这些配置测试不提交像素，不代表物理竖屏显示器采集、旋转映射或帧率验收。

`quality_presets_v1` 与 `source_lifecycle_v1` 协商后，控制端沿用 suspend → 确认排空 → `set_quality {attach_id, expected_state_revision, quality}` → resume；quality 仅接受 `data_saver / balanced / clear`。host 在暂停且没有清理屏障时才更新偏好，变更推进 revision，同偏好重试不重复更新；未暂停、未排空、旧 CAS 或身份不符均拒绝。attachment 快照新增 quality，旧快照缺字段按省流读取，旧 attach wire 保持原样。恢复时保留 attachment / TURN 策略，重新解析显示器并用新 connection 应用画质，旧 PC 的设置不变，输入须在新首帧后重新申请。当前已完成纯状态、macOS 发送链路及鸿蒙 / 电脑暂停页接线，并更新隔离试用发送端完成鸿蒙三档真实首帧 / TURN 流量采样；目标帧率、高动态画面及完整性能验收仍未完成。

2026-10-19，领域远控 79 项及 Desktop 远控 74 项通过，另 7 项需单独授权 / 运行器的原生专项未执行。新增用例读取真实 libwebrtc sender 的三档 max_bitrate / max_framerate（包含竖屏清晰档），未提交像素；host 夹具验证固定来源 / outer attachment、暂停设置、新 PC 的实际配置以及原保留期限不被延长。旧 attach 重试不重置画质或恢复媒体，旧 snapshot / reader round trip 通过。这些证据不代表三档真实捕获 / 编码呈现、达成目标帧率 / 吞吐或输入清理；跨平台和控制端交互仍待完成。边界检查被工作区既有 OHOS 失效 `.so` 链接阻断，未改变该目录或放宽检查。

鸿蒙暂停页现仅在两项能力同时协商后显示三档选择器；设置前重新读取 CAS，确认同一已排空 attachment、connection、display 与目标 quality 后继续暂停，由用户显式恢复。请求在途不接收重复设置 / 恢复；丢 ACK 只查一次快照，不确认目标档位就结束连接，不回显假成功。退出立即停止本地输入，等在途设置结束后用原通道 detach，迟到结果不修改后继。140 项控制器 / 本地化 / 导航 / 键盘与桥生命周期聚焦检查、架构检查、主题色审计和签名 HAP 构建通过；保留试用身份升级后的 DEL-AL10 / API 26 在无账号原生预览中，通过宽 / 窄 × 浅 / 深四组实际选择、当前档位翻译、暂停保持、显式仅查看恢复与 live resize，接收桥始终为同一实例。该 UI 预览没有采集、编码、TURN 或 OS 输入，不能代替新 host 三档实际媒体验收；物理折叠也未验证。

随后新版手机与未声明画质能力的既有 macOS 试用发送端，经原账号 / 强制 TURN UDP 恢复 1280×828 真实画面；暂停页正确隐藏画质入口，显式继续查看后同一手机进程呈现新首帧，实际所选候选仍为 relay/relay。全程未请求输入租约，收尾保持查看。此结果仅证明新手机与旧发送端的兼容及原媒体路径，未更改或验证实际画质档位。

电脑控制端已接相同的暂停页流程，使用现有设计系统 Select / Field，旧 host 隐藏入口。画质设置在途显示进度并移除设置 / 恢复入口，CAS 拒绝不回显目标档位；关闭、隐藏和 context 失效等待原请求清理，迟到结果不修改后继。支持画质的连接从本页元素全屏暂停时，先等待退出全屏，再暴露文档弹层，避免菜单被全屏层遮住。225 项电脑控制器、接收桥、DOM、资源 / 账号入口及 Peer 适配器聚焦检查、`check:web` 和三语言本地化审计通过。真实 Chrome 的宽 / 窄 × 浅 / 深四组检查运行正式 Viewer、设计系统、隔离 iframe 与共享 WebRTC receiver：三档经 attachment / CAS 请求确认后继续暂停，显式继续取得新 PC 的首帧、保留同一 iframe，不自动重授操作权；实际全屏退出和菜单截图也已检查。发送端为生成视频 / 模拟账号与原生适配器，未采集桌面或注入 OS 输入，不计为新原生 host 的三档画质 / 吞吐、双电脑实机或其他远程场景验收。后续已更新 Mac 隔离试用发送端，真实三档结果见下文。

2026-10-19，保留原测试身份及设备 grant 更新隔离 macOS 发送端后，鸿蒙通过真实账号 / 强制 TURN 完成三档暂停设置、显式恢复及新首帧，实际候选对均为 relay/relay。当前屏幕各档首帧与服务器 10 秒采样如下：

| 档位 | 实际首帧 | 服务器入站 / 出站 Mbps |
|---|---|---|
| 省流 | 1280×828 | 0.35 / 0.40 |
| 均衡 | 1660×1080 | 0.64 / 0.67 |
| 清晰 | 2216×1440 | 0.60 / 0.64 |

采样为整机网卡流量，含信令 / SSH / 后台，桌面内容未控制；不能据此比较编码效率或承诺档位固定带宽。试用服务器带宽有限，未验证高动态画面、目标帧率、4–8Mbps 上限或蜂窝 / P2P。UI 调试取布局两次超时，其中一次等待导致暂停保留期到期；另一次重新 attach 返回 `target_unavailable`，随后重新确认账号路由并新建连接成功，原因仍待定位，不能记作无缝重连通过。收尾恢复新省流连接，未改变账号或 grant。 同一更新后的 Mac 发送端与鸿蒙随后通过原账号 / 强制 TURN，在临时 Cocoa 空白输入框验证一次手机点击选中、键盘逐次提交 123、退格、回车及五组完整按下 / 松开；明确停止操作后等待 5 秒，无迟到输入或持键，收尾保留查看及手动开启操作入口。这只证明该屏幕 / 应用的固定输入链路，不代表中文候选词、全屏坐标精度或其他平台验收。

### 7.4 OS 授权限制

Wayland 的持久化需探测 RemoteDesktop portal 版本和后端，按其 `SelectDevices` 设置 `persist_mode=2` 并安全保存 Start 返回的 restore token；组合捕获/输入会话的持久化由 RemoteDesktop 管理。token 单次使用后保存新值，失效/撤销重新选择；请求持久化不保证后端准许。依据 [portal 官方契约](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)。当前仓库尚未接线此恢复路径。

portal 的 keysym 不等于通用 IME commit；仓库已有 Unicode keysym 实现，需测试 compositor × 布局 × 应用的中文/emoji/组合字符。只有已验证 provider 才广告文本能力；AT-SPI EditableText 的特定节点测试不能替代全桌面文字输入证明。

macOS 录屏/辅助功能需本机授权，系统可能再次要求确认，按所用 API、OS 版本和签名实测；不硬编码所有 macOS 15 的提示频率。Apple 的 [Persistent Content Capture entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)需申请，不能写入配置就假定已获免提示资格。三平台都不承诺登录屏、安全桌面或永久无人值守。

## 8. 中继、兼容与远程场景

2026-10-20 公网单手机试用：阿里云 IP 的可信 HTTPS/WSS 入口已配置，证书自动续期启用；同一账号下，鸿蒙经原生本机授权后收到 macOS 显示器 1280×828 首帧及 relay/relay UDP，手机截图确认真实桌面。手机 19703 / 19704 USB 转发均已移除，测试身份服务关闭，公网代理拒绝自动测试登录。用户随后确认物理拔线后手机画面正常，当前 Wi-Fi 下的无线查看通过。此次没有注入 OS 输入，不证明公网长期稳定性、P2P 或蜂窝网络。运维与证据边界见部署手册。

复用 `relay-service` 的账号/设备/加密命令能力；TURN 使用独立进程与带宽预算，候选 [coturn](https://github.com/coturn/coturn)。直连优先，中继时视频与 DataChannel 一同走 WebRTC 路径，逐次键鼠不经 Socket.IO。TURN 转发职责依据 [RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html)。

短时 TURN 凭据由已认证接口签发，只授予网络资源；host 仍校验设备 grant、认证 PC 和输入租约。签发频率、allocation、带宽和账号总预算分别约束；凭据到期不被当作业务停止的充分证据。任何共享停止首先关闭 host 采集和输入，不能等 allocation 超时。TURN 的服务端资源回收另行验证：正常 PC 关闭尽力发送零寿命 Refresh，客户端崩溃 / 进程退出可能只能等剩余分配寿命；本地句柄排空、TURN 配额归还和业务授权停止不是同一个判据。账号 Relay 不记录 SDP/输入正文，TURN 不解码/保存屏幕。原生 SDK 的 packet dump / verbose 输出也不得记录 DataChannel 正文。[webrtc-sys 0.3.49 的窄补丁](../../third_party/webrtc-sys/OPENBITFUN-PATCH.md)在创建任何 PC 前将原生 sink 限制为 warning/error，避免 verbose 触发直接输出明文的 SCTP packet observer；保持引擎归档及哈希不变，依赖来源检查阻止后续更新静默绕过本地补丁。上层 DTO 脱敏或 Rust 日志过滤不能代替 SDK 输出检查。

2026-10-16，[原生日志隐私探针](../../scripts/test-remote-desktop-log-privacy.mjs)在启用 SDK 调试日志的独立进程中，使用真实双向 DataChannel 把固定文本送入内存 sink、把固定结果送回，检查 stdout/stderr 的报文转储及明文 / 十六进制标记。修复前明确失败，修复后通过；不启动捕获或 OS 输入。媒体生命周期回归 19 项通过，2 项原生专项探针仍须显式运行，其中日志探针已单独执行。重建后的 macOS arm64 普通测试版与原鸿蒙正常包，经隔离账号 / 强制 TURN 完成首帧、暂停 / 新连接恢复及正常退出；同一手机进程呈现两次 1280×828 首帧，运行时组合日志无 SCTP 转储，输入 gate 保持关闭。此证据不替代其他 OS、全部 SDK 故障日志、弱网持键或完整输入矩阵。

部署先上路由能力与 TURN，再发布有 provider 的 host 和控制端。旧字段加默认值；可选响应字段宽容读取，未知 mutation 显式拒绝。保存设备 grant 和偏好时保留未知字段、不可读数据；显示器失效须重选，不能放宽到所有显示器。旧 executable/window grant 不迁移为显示器 grant；live lease、connection、SDP 不持久化为可恢复操作权。

| 远程场景 | 契约 |
|---|---|
| Remote workspace | 显式目标 device ID；SSH/容器路径不影响远控目标，也不降级抓取控制端本机 |
| Peer Device Mode | sender 保持 controller-local，目标不随当前 surface 二次代理 |
| 手机/IM 控制 | 手机按本协议；bot 明确不支持实时远控，不经聊天消息注入键鼠 |
| Detached Dispatch | headless CLI 无 Desktop provider，返回明确 unsupported，不等待本机 picker |

主要错误：`device_approval_required`、`permission_required`、`unsupported`、`relay_upgrade_required`、`protocol_unsupported`、`attachment_busy`、`control_busy`、`stale_revision`、`lease_expired`、`target_lost`、`host_locked`、`media_backend_unavailable`、`media_unreachable`、`target_unavailable`、`input_suspended`。具体恢复动作由错误字段携带。

## 9. 实施与唯一验收矩阵

### 2026-10-26 当前证据与待验收标记

| 项目 | 代码/自动检查状态 | 系统与跨设备验收 |
|---|---|---|
| Windows 原生被控/输入 | 原生模块通过 x86_64-pc-windows-msvc Rust API 类型检查 | **待实机**：整包链接、GDI/光标、高 DPI/负原点、扫描码/Unicode、UAC/锁屏、持键断线与句柄回收 |
| Linux X11/Wayland 被控/输入 | 原生模块通过 x86_64-unknown-linux-gnu Rust API 类型检查 | **待实机**：真实系统库链接、GStreamer/Portal/XTest、静态画面/停帧、撤销、锁屏、重启/热插拔、文字映射恢复 |
| Linux 原生接收 | 本机实际原生编解码/DC/二进制背压与 Chromium canvas、生产 opaque iframe/CSP 夹具通过 | **待实机**：WebKitGTK 打包、呈现、颜色/旋转、内存/CPU、焦点和冻结/断开 |
| 原生输入与独立服务 | 共享租约/清理回归通过；默认构建接入三平台 provider | **待实机**：三系统互控、鸿蒙逐一控制、输入落点和松键、AI 互斥、真实 TURN/弱网/长时续期 |

Linux 跨目标检查使用临时的系统包元数据检查 Rust bindings，没有链接或运行 GStreamer；
Windows 跨目标检查同样不构成整包链接或系统行为证据。原有实机测试的 ignore 保留。
Remote workspace、Peer Device Mode 和 Detached Dispatch 本轮未实测；新增接收命令
由注册表声明 ControllerLocal，CLI/远程代理明确拒绝，不能据此声称远程场景已验收。

### 历史实施阶段与完整判据

先验证风险，再扩展平台。以下是实现依赖和发布门槛；探针结果留在本地证据，不把目标写成已验证支持。

0. **鸿蒙接收可行性**：使用桌面 Chrome getDisplayMedia 等现成发送端，接真实鸿蒙 App 内的 ArkWeb；先直连，再隔离试验 TURN。测实际打包 origin、RTCPeerConnection、至少一种协商视频 codec、DataChannel、首帧与前后台。结果为可行、受限或不可行，并附内核/OS/证据；不可行先评审鸿蒙接收适配，不继续堆原生发送代码。Chrome 屏幕采集标记为“浏览器捕获”，只有生成的测试图案才叫合成帧。同阶段尽早探 Linux 实际 Tauri/WebKitGTK；不通过只阻塞该平台入口，不阻塞鸿蒙。
1. **macOS 原生发送**：新增显示器 source，优先验证 LiveKit libwebrtc 独立 PC/raw frame，必要时对比 webrtc-rs；以第 0 阶段鸿蒙接收端验证真实画面和资源回收，锁定首轮引擎、架构/codec 与构建产物。三桌面平台 SDK 矩阵逐项验证，不要求先完成全部平台才推进鸿蒙。
2. **鸿蒙只读闭环**：接真实账号路由、设备授权/预授权、原生界面与生命周期；视频直接呈现，不开放 OS 输入。验证单连接、重放拒绝、媒体健康、直连/TURN、旋转/折叠与撤销。临时探针信令和测试凭据不能作为产品鉴权交付。
3. **鸿蒙可操作**：reservation 专项评审及旧路径等价/竞争测试通过后接输入；验证 control_generation、队列背压、AI 互斥、清理和 Relay 故障。完成鸿蒙 → macOS 首个可试用闭环；无需等待 Android/iOS。
4. **其他平台与电脑控制端**：完成电脑控制电脑的产品 UI、Windows/Linux 被控适配及 Android/iOS 原生 App 接收。逐平台开放通过验收的能力；诊断网页不等于 Desktop 产品交付。mobile-web 不在本轮远程桌面交付范围内。

2026-10-15 受限联调结果：隔离测试身份下，macOS arm64 与 DEL-AL10 / API 26 使用各自设备 token 和密钥，通过既有账号 Relay 完成加密信令、单显示器本机只读确认和实际首帧呈现；明确开启强制中继后仍保持查看状态，真实 TURN 已启用鉴权。这次信令走 SSH / USB 回环隧道，媒体走公网 TURN；不证明邮箱 / GitHub 身份服务、公网 HTTPS、P2P、TURN TLS 或长期续期。后续文字 / 单键和空输入账本的两轮租约联调见第 4 节；完整输入清理、故障、撤销及生命周期矩阵仍待验收，普通输入保持关闭。

所有阶段仅在本机测试人员明确授权后捕获选定屏幕。第 0 阶段 DataChannel echo 不证明 OS 注入；模拟器、浏览器、合成帧均不能代替后续原生捕获/真机输入。

| 范围 | 必须具备的证据与判据 |
|---|---|
| 接收探针 | 鸿蒙真实 ArkWeb 优先，Linux 实际 WebKitGTK 单独记录；API、codec、打包 origin、播放和 DC 往返通过；失败只禁用对应路径 |
| 原生媒体/SDK | raw frame 到真机首帧/持续画面；CPU/GPU/内存、codec、许可证、构建与清理证据，固定版本；其他平台逐项补齐 |
| 公网与部署 | 蜂窝 + 另一外部终端，普通 ICE/强制 relay 的 candidate pair、画面/DC；3478 UDP/TCP 与 TLS 分项验证；旧 Relay 健康、数据和资源不受影响 |
| 设备信任 | 预授权/首次授权只能本机完成；未授权、换公钥、伪造来源/SDP 均无画面与输入；撤销按第 6 节区分本机即时与远端检测延迟 |
| 重试/代次 | 延迟 attach、关闭后重放、host 重启、旧 SDP/ICE 和同尺寸切屏；不复活旧连接、不占新槽、不执行旧输入；统一 revision 的 CAS 冲突返回快照；live 幂等匹配先于 CAS；特别注入 attach 成功但 ACK 丢失后本机停止，客户端不得自动刷新 revision/ID 重新共享 |
| GUI reservation | 旧 admission 测试原样通过；start/share/隐式 Background admit 全覆盖；并发申请仅一方成功，清理未完成/失败不转交，旧释放不影响新占用 |
| 授权输入 | 撤销后继续发送、快速重申、旧桥回调/worker 延迟注入；用测试输入 sink 独立记录 generation 与执行，旧代次执行必须为 0；不能用百万次无复现替代不变量检查 |
| 单通道/背压实验 | 限速 1Mbps、200ms 延迟并叠加丢包，持续拖动和续约；记录队列年龄、心跳 P95、误超时与松手误差；有/无 move 合并对照，仅证明确有通道阻塞问题才拆通道 |
| 画面健康实验 | 分别注入静态屏、捕获冻结、重复编码旧图、解码/呈现冻结；记录 stats/呈现/source 健康可观测性及停止延迟，确定阈值后才开输入；无持续呈现回调时仍须首帧可见及两侧健康；逐侧失效/不可观测均暂停输入，静态画面必须有独立 source 健康证据，不能仅据 framesDecoded 停滞判断 |
| Relay 故障实验 | 登出/删设备/换钥、旧 token 失效但同设备新 socket 仍在线、presence 失败、通知发送失败/ACK 丢失、半开连接、Relay 重启及网络切换；旧关联必须失效，单独移除注册不能算停止；记录故障到暂停/停流总延迟和共用 socket 重连影响；普通失联宽限不被重置，明确撤销收到即停，v1 输入撤销不去抖 |
| 交互/生命周期 | 单双击、拖动、滚轮、物理键/按能力文本；失焦/后台/锁屏释放，compact/wide/动态折叠、高 DPI/负原点坐标准确；预期切屏/暂停保留 attachment，旧 PC 关闭回调不影响新连接，当前 PC 异常及无 PC 保留超时最终清槽，Relay 不可用时退出仍回收资源 |
| 跨版本/远程场景 | 旧 Handshake/RPC 原样可用；缺路由能力与暂不可达分别呈现；legacy/default DTO 与 old-payload round trip；SSH/Peer 不改显式目标，CLI/dispatch/bot unsupported |
| 平台权限/性能 | Wayland 恢复 token 与实际文本、macOS 许可、Windows 安全桌面拒绝；实测时延/手机温升/带宽计费，限流不挤占原 RPC |

性能实验用于选择实现；安全机制删除必须先说明替代不变量，再用定向反例验证，不能仅凭“未出现错误”删除。bind nonce 的移除前提是固定设备密钥与完整信令/DTLS 绑定；不把恶意 Relay 首次换钥测试误当作本威胁模型已覆盖。

初始性能目标：参考硬件 1080p 均衡档、LAN RTT≤30ms 时交互到可见反馈 P95≤150ms，动态画面接近 30fps；TURN RTT≤100ms 时 P95≤300ms。记录硬件/OS/codec/帧率/带宽和端到端时间证据；RTP RTT 不能替代交互时延。第 6.3 节已有受限 TURN 点击回传测量（普通网络 P95 384 ms、模拟弱网 P95 974 ms）；它们尚未达到上述目标，也不证明参考 1080p / LAN 条件。

实施时在最近 owner 的 AGENTS 中补 focused test 入口，按变更运行相应校验；只改文档不执行 native 测试。当前已有鸿蒙真机浏览器媒体接收及试验 TURN UDP/TCP 的受限证据，详见第 7.2 节；其余验收项及四类产品远程场景未因此完成。现有 Computer Use 状态以 [其 SPEC](computer-use-control.md) 为准。

## 10. 参考与后续独立决策

代码归属遵循 [产品架构](product-architecture.md)、[Rust 依赖边界](rust-build-dependency-boundaries.md)、[Runtime 部署模型](agent-runtime-deployment-design.md) 和 [移动端规范](../../src/apps/mobile/AGENTS.md)。

RustDesk 对照版本为 `0b5a3d74d`（1.5.1）。手机实现是 Flutter + Rust FFI 的原生远控链路，不能作为鸿蒙 ArkWeb/WebRTC 支持的证明。下列路径均相对 RustDesk 仓库；只借鉴逻辑和边界，不移植其 session、完整 wire 或原生解码栈。

| 源码证据 | 借鉴到 OpenBitFun 的规则 |
|---|---|
| `flutter/lib/mobile/pages/remote_page.dart`：`initState`、首帧 callback、`dispose` | 连接、加载、首帧分别处理；退出先发起 session close 再做异步清理，避免后台挂起导致旧连接泄漏。OpenBitFun 对应先关输入/发 detach，再等待 UI 清理 |
| `flutter/lib/models/model.dart`：`ImageModel.decodeAndUpdate/update/webOnRgba` | 异步解码后校验当前目标，过期画面丢弃；Web RGBA 队列取最新帧。OpenBitFun 使用 PC/renderer 身份防旧回调，有界流水线防画面积压，不复制 RGBA 跨桥路径 |
| 同文件：`handleSwitchDisplay`、`CanvasModel`、`CursorModel` | 远端显示器几何、本地 viewport、指针分别管理；切屏不能沿用旧坐标。OpenBitFun source 改变按第 6 节重建绑定 |
| `flutter/lib/models/input_model.dart`：`sendMouse/moveMouse/enterOrLeave` | 正常输入检查权限，失焦释放键和修饰键。OpenBitFun 撤销后由 host 注入记录完成清理，不能让权限 gate 阻断必要的释放 |
| `flutter/lib/common/widgets/remote_input.dart`：双指缩放、三指滚轮；`remote_page.dart`：软键盘处理 | 分离画布手势与远端事件。OpenBitFun 保持产品文档的双指滚轮/捏合判定；文本采用显式 commit，不照搬剪贴板辅助输入 |

RustDesk 上述页面的前台回调包含剪贴板同步，不是“后台必定释放操作权”的证据；OpenBitFun 的后台停输入、恢复仅查看是本方案另行定义的行为。服务端参考仍包括 `src/client.rs`、`src/rendezvous_mediator.rs`、`src/server/connection.rs`、`src/server/video_service.rs`、`src/server/video_qos.rs` 和 `libs/base/protos/message.proto`；未初始化的 hbb_common 不作为验证依据。

待独立决策：媒体引擎和精确 target/codec 矩阵由探针决定；GUI 外部 reservation 接线需专项评审；AI 抢占、Background 并发、多观察者、simulcast/多码流、不可靠 hover 和鸿蒙 PC 被控均不作为 v1 前提。
