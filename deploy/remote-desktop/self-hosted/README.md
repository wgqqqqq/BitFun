# 自部署远控服务

此服务独立于 OpenBitFun 登录 Relay。普通 Relay 默认不宣告远控能力，也不接受
`rd-*` 远控请求；自部署模式不提供 GitHub/邮箱登录、Page 或通用 Agent RPC。
它复用 Relay 的设备加密路由实现，但使用独立实例、数据库、配对密钥和设备凭据。
电脑与鸿蒙手机无需登录 OpenBitFun 账号即可配对。配对只允许发现和申请，查看与
操作仍由被控电脑在本机对设备公钥和显示器范围授权。

当前已接入三系统原生实现，正常 Desktop 构建默认选择 `remote-desktop-media`。
设备配对不会启动采集或授予输入；仍须本机授权、系统许可、明确连接与操作租约。
Windows/Linux 没有实机验收，本文不是三系统上架通过声明。

## 准备独立实例

在本目录复制 `.env.example` 为 `.env`，填写自己的 TURN 地址，并将 UID/GID 改为
用于运行服务的非 root 用户。`private/` 和 `data/` 必须由该 UID/GID 持有。
不要挂载账号 Relay 的数据库；启动时发现数据库用途不匹配会拒绝运行并保留记录。

```sh
mkdir -p private data
chmod 700 private data
umask 077
set -C
openssl rand -hex 32 > private/pairing-key
openssl rand -hex 32 > private/turn-secret
```

只在新目录生成密钥；已有部署保留原文件。将 `private/turn-secret` 的内容配置为
自有 coturn 的 REST shared secret，关闭匿名分配，设置中继端口、防火墙及资源预算。
私密文件权限必须为 0600，配对密钥与 TURN 签名密钥各自独立。

```sh
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:9701/health
curl --fail http://127.0.0.1:9701/api/info
```

容器只绑定本机地址。在自己的 HTTPS 反向代理中配置独立域名与证书，转发 HTTP 和
`/v1/updates/` WebSocket，并保留连接升级。TURN UDP/TCP/TLS 端口直接连接 coturn，
不经过 HTTP 反向代理。公网客户端只接受 HTTPS；loopback HTTP 仅供本机或隧道调试。
`/api/info` 应包含 `remote_desktop_pairing_v1`、`remote_desktop_route_v1` 与
`remote_desktop_turn_v1`；`/health.account_features` 应为 false。

## 客户端配对

电脑：左下角设备状态 → 远程控制电脑，也可从「设备与连接 → 远程电脑」打开。
填写服务 HTTPS 地址、配对密钥与本机名称。
鸿蒙：侧栏 → 远程桌面，填写同一个服务地址与配对密钥。配对密钥不会保存；设备的
私钥与独立访问凭据分别保存在电脑加密存储和手机 HUKS 加密存储中。
之后重连可留空配对密钥。设备凭据到期时再次提供配对密钥，保留原设备 ID/私钥
重新签发；换钥或重装不继承旧设备的本机授权。

在被控电脑的「本机访问权限 → 管理访问」中批准控制设备及显示器，再由控制端
从在线电脑列表打开「查看桌面」并选屏连接。账号 Relay
的设备列表和远控服务的设备列表分别管理；切换 Peer 工作区不改变远控目标。
当前鸿蒙保留一份独立服务配置，切换到不同地址会明确拒绝并保留原记录。

## 维护

保留 `data/`、`private/` 和客户端原有私钥。无法解析、离线或凭据过期都不应通过删除
数据库、设备记录或客户端存储修复。轮换配对密钥只影响新配对，不自动撤销已签发的
设备凭据；撤销设备及本机查看/操作授权是分别执行的操作。
升级先备份数据库和私密配置，固定已验证镜像，使用原挂载重建该实例；不要替换或
重启登录 Relay。客户端出现不支持的版本或平台时应显示明确状态，不回退到登录 Relay。

## 原生平台实现与待验收项

| 平台 | 当前实现 | 实机状态 |
|---|---|---|
| Windows 被控 | 稳定显示设备接口标识、持续 GDI/BGRA 采集和光标、物理像素与负原点坐标、SendInput 扫描码及 Unicode、独立松键账本 | 待验证；已做 Windows Rust API 跨目标类型检查，尚未做整包链接/运行 |
| macOS 被控 | ScreenCaptureKit、Quartz 前台键鼠及分块 Unicode；接回同一输入租约/GUI 互斥 owner | 独立服务的本机双实例画面及控制租约已验证；跨物理机完整键鼠仍待验收，见下文 |
| Linux X11 被控 | RandR/EDID 选屏、GStreamer ximagesrc 持续原始帧、XTest 物理键与按键映射后的 Unicode | 待验证；仅 Rust API 类型检查，无系统库链接和桌面运行证据 |
| Linux Wayland 被控 | 本机 Portal 单显示器授权、授权 FD 上的 PipeWire 原始帧、同会话的 RemoteDesktop 输入 | 待验证；需要支持对应 Portal、嵌入光标和可观测锁定状态的桌面 |
| Linux 控制端 | 原生 libwebrtc 解码、可靠 DataChannel、有界二进制 IPC 与沙箱 canvas 呈现；沿用共享输入/健康状态机 | 原生本机编解码、Chromium 画布及生产 opaque iframe/CSP 夹具通过；实际 WebKitGTK 待验证 |

### 2026-10-26 macOS 本机双实例测试

macOS 15.7.9 上使用当前代码构建两个独立 Desktop 进程、产品配置目录和私有 WebView
存储，经阿里云独立服务 HTTPS/WSS 配对，无 OpenBitFun 账号登录。实际走左下角入口、
设备列表、本机原生授权确认和生产采集/接收链路；不是模拟设备或生成视频替代画面。
两端重启后恢复了同一设备凭据和已保存的本机授权。

A 查看 B 的 UDP 直连连续解码超过 2,400 帧；反向 B 查看 A 的强制 TURN 连续解码超过
2,000 帧，双方所选候选均为 relay。两个方向都实际取得并续订了 host 签发的操作租约。
本机停止共享后，远端 attachment 清空、cleanup_pending 为 false，系统鼠标按键已释放。
另行运行的原生夹具通过了点击、双击、拖拽、物理键、松键、撤权拒绝以及中文/emoji
文本交付和取消；10 秒 ScreenCaptureKit 夹具收到 46 个样本并正常排空。这些夹具不能
替代跨设备键鼠交付验收。

实测修复了独立服务仍注册 Agent RPC 导致误报凭据失效的问题，以及 WebKit 操作按钮
未聚焦和实时视频 mediaTime 不推进导致的呈现健康误判。远控专用连接只注册 rd 通道；
呈现优先使用合成器 presentedFrames，重复、倒退或丢失计数不会借用解码增长续命。

本轮仍有明确限制：首次点击开始操作可能需等下一次健康探测后重试；同机回环共用
系统鼠标，测试点击激活了目标窗口，但未取得完整点击收据，并出现按键保持，已用本机
停止共享释放。反向 TURN 在切换前台后最终报告过一次 media_unreachable，原因仍待复测。
因此不宣告完整键鼠互控或后台切换稳定性通过，须用两台物理 Mac 继续验证持续输入、
Esc/失焦松键、断网重连和长时运行。Windows/Linux、鸿蒙及其他远程场景不属于本轮证据。
测试后已撤销两端本机授权、清除服务端两个临时设备及凭据，退出隔离实例；原开发实例
和登录 Relay 均未改动。

Linux 需要 GStreamer 的 PipeWire（Wayland）或 ximagesrc（X11）、videoconvert、appsink
插件，以及 RandR/XTest 和会话 D-Bus。无法观测锁定状态、缺插件、Portal 拒绝或撤销时
明确不可用；不会退回 XWayland、未经授权的 PipeWire 或其他显示器。Wayland 授权不保存
恢复 token，每次进程重启或主动停止后重新选择屏幕，并重新确认新的会话显示器标识。
X11 有 EDID 时按输出名与 EDID 固定标识；无 EDID 时授权仅适用于本次进程及当前拓扑。

Windows 仅支持当前用户已解锁的 Default 桌面，不切换桌面、提升权限或操作 UAC/登录
界面。GDI 是当前明确选择的 CPU 采集实现，不宣称 WGC/DXGI 硬件采集；多屏、高 DPI、
旋转、光标和高分辨率开销需要实际测量。Linux 无新原始帧时不会伪造“源仍空闲”的健康
证明，静态屏与停帧场景需要单独验收。

输入先登记本租约的按下状态，再提交原生调用；投递不确定、健康失效和断线先撤销
租约，再清理。未确认松键或源关闭时保留 GUI/媒体清理屏障，不允许下一连接接管。
保留 `--no-default-features` 作为不带原生媒体的最小宿主构建，相关入口会明确不可用。

独立服务上的 Windows/macOS/Linux 互控、鸿蒙分别控制三系统、直连/强制 TURN、长时
续期、锁屏/UAC、授权撤销、持键断线、休眠、热插拔和 compact/wide/折叠均是待验收项。
已有模拟、类型检查和合成帧证据不替代这些实机记录。

## 当前阿里云部署（2026-10-26）

- SSH：`aliyun_wgq`；客户端服务地址：`https://47.99.85.183`。
- 服务容器：`openbitfun-remote-desktop`；Compose project 同名。
- 部署目录：`/srv/openbitfun-remote-desktop`；仅监听 `127.0.0.1:19703`，
  复用服务器已有 HTTPS 入口和受鉴权 TURN，不额外开放信令端口。
- 数据库、配对密钥、TURN 配置副本独立保存在新目录；配对密钥为
  `private/pairing-key`，权限 0600，不写入源码、镜像或本文。
- 产物来自本地未提交源码快照 `c48aa6143d22`；完整源码归档、逐文件 hash、
  Rust/Zig 版本和二进制 hash 保存于 `releases/c48aa6143d22/`。
  运行镜像 digest、启动状态与脱敏验证收据在 `evidence/`。
- 原 `openbitfun-rd-trial-relay` 容器已移除；原数据库、镜像和回滚检查记录保留，
  新配对服务不复用旧账号数据库或旧设备访问凭据。账号试用客户端需要升级到独立配对入口。

查看配对密钥和运行状态：

```sh
ssh aliyun_wgq 'cat /srv/openbitfun-remote-desktop/private/pairing-key'
ssh aliyun_wgq 'cd /srv/openbitfun-remote-desktop && docker compose -p openbitfun-remote-desktop ps'
```

公网 TLS、健康与能力发现已验证；两个临时 X25519 设备经 HTTPS 配对、鉴权 WSS、
远控注册和不透明信令往返已检查，通用 Agent RPC 和公开登录被拒绝。
临时设备及其访问凭据在验证后清除。此部署检查不证明原生画面、键鼠或跨系统实机验收。
