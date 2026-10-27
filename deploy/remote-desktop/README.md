# 远程桌面试用中继部署手册

> 2026-10-26 部署更新：SSH `aliyun_wgq` 上的旧
> `openbitfun-rd-trial-relay` 已按用户要求停止并移除，原数据目录保留。
> 当前公网入口改为独立配对服务 `openbitfun-remote-desktop`，不提供账号登录或
> Agent RPC。现有 HTTPS 与 TURN 继续运行；以下账号试用记录仅为历史证据。
> 当前部署、连接和维护方式见[自部署服务](self-hosted/README.md)。

状态：试用 Relay / TURN 当前用于单路联调；已完成鸿蒙真机 UDP/TCP 媒体验证及凭据绑定版本的只读重启恢复。隔离测试身份已通过账号路由完成 macOS → 鸿蒙原生画面、受限键鼠输入及三档画质首帧；当前手动试用输入已按用户要求开放，普通源码默认输入 gate 仍关闭。公网 HTTPS/WSS 已于 2026-10-20 通过单手机试用；TURN TLS 与邮箱 / GitHub 身份服务尚未验证。更新与检查日期：2026-10-19；每次恢复前重新核实运行状态。

设计入口：[产品与交互](../../docs/features/remote-desktop-control.md)、[协议与媒体](../../docs/architecture/remote-desktop-control.md)。统一验收矩阵仅维护在协议文档第 9 节；本文负责具体主机的资源、操作和回滚，不声明产品已交付。


## 公网入口配置（2026-10-20）

已在同一试用服务器新增独立 `openbitfun-rd-trial-https` Nginx 容器，HTTPS/WSS 反向代理到原 `127.0.0.1:19703`；Relay / TURN 容器未重建、未重启。公网 IP 的 Let’s Encrypt 证书已签发，首次到期为 2026-10-26；证书、私钥和配置位于服务器 `public-entry/`，不进入仓库。`openbitfun-rd-cert-renew.timer` 每日检查三次，续期服务已实际执行成功。TCP 80 仅提供 ACME 验证文件，其余请求返回 404，不承载登录或明文信令。

服务器内已验证 TLS 证书、健康检查、能力发现，以及 `/v1/updates/` WebSocket 101 升级。安全组 TCP 443 已获用户确认并提交，公网 HTTPS 健康检查和 `/v1/updates/` WSS 101 升级均已从 Mac 验证，未跳过证书校验。鸿蒙公网包已原位登录同一测试账号并发现 / 连接 Mac，手机的 19703 / 19704 USB 转发已移除；10:18 真机通过“远程控制 → 选择在线电脑”收到 Mac 原生显示器 1280×828 首帧及 relay/relay UDP，已核对手机截图为真实桌面；手机 USB 数据转发为零。用户随后确认已物理拔掉 USB，手机画面仍正常，当前 Wi-Fi 下的拔线查看验收通过；本轮未新增点击、键盘或蜂窝网络验收。公网代理明确拒绝自动测试身份使用的 `/api/auth/github/start`、`/api/auth/github/poll`、`/api/auth/login`，已有设备令牌的受鉴权请求正常通过。测试身份签发服务已停止，不向公网开放；当前试用登录不是公开产品登录服务。

控制台同时确认带宽计费为 **3 Mbps 固定带宽**，此前“计费方式待核实”的记录已更新。

## 1 已核实的环境

用户已指定 SSH 配置中的阿里云服务器作为试用中继。2026-10-13、2026-10-14 通过本机 SSH 别名 `aliyun_wgq` 完成只读检查；连接使用现有 SSH 配置，本文不复制私钥、公网地址或认证材料。`LEGACY_RELAY_CONTAINER` 从现有部署检查取得实际容器名，不重命名旧资源。

| 项目 | 检查结果 |
|---|---|
| 系统 | Alibaba Cloud Linux 3，x86_64 |
| CPU / 内存 | 2 核，约 1.83 GiB 内存；检查时约 1.2 GiB 可用 |
| 磁盘 | 根盘 40 GB，约 22 GB 可用 |
| 容器环境 | Docker 正常运行 |
| 原 Relay | 已退役：旧容器停止并移除，TCP 9700 无监听 |
| 原协议基线 | 退役前版本 `0.2.15`、`protocol_version: 2`，未声明新远控路由能力 |
| 原数据 | `/app/data` 和 `/app/room-web` 的 Docker volumes 保留，未用于新实例 |
| 新 Relay | `openbitfun-rd-trial-relay`，版本 1.0.5，仅 `127.0.0.1:19703`；空闲内存约 10 MiB |
| TURN | 独立 `openbitfun-rd-trial-turn`，coturn 4.6.3 固定 digest，配置保留于独立目录 |
| 地域 / 公网限制 | 云控制台确认华东 1（杭州）、3 Mbps 固定带宽（2026-10-20） |
| 已测端口 | 用户放行 TCP/UDP 3478、UDP 49160–49179；公网 STUN 及真实强制 TURN 视频/DC 成功 |
| 尚未验证 | 蜂窝网络、公网 HTTPS、TURN TLS、多路容量及原会话业务回归；IP 证书已签发 |

这台机器适合开始单路功能探针；能否满足均衡画质取决于真实公网带宽和端到端测试。CPU/内存余量不代表公网吞吐能力。当前已部署新试用 Relay 和独立 TURN 配置；启动、停止及空闲回收前均须核实实际连接。鸿蒙只读产品入口已用隔离测试身份通过账号路由与原生画面呈现；完整身份服务、长时连接及故障矩阵尚未通过验收。原 Relay 在先前媒体探针前后健康检查正常，随后退役；退役状态不能再以 `/health` 在线作为验收条件。

## 2 试用拓扑和部署隔离

产品层面复用同一套 Relay 实现、账号体系与设备协议；原实例已退役，新实例仍使用独立数据，避免让旧数据库执行新版本迁移。隔离实例不代表创建第二套远控账号产品。

```text
阿里云试用服务器
├─ 原 Relay 数据卷             退役后保留，无运行容器，TCP 9700 空闲
├─ openbitfun-rd-trial-relay     新试验 Relay，127.0.0.1:19703
├─ 试验 HTTPS 入口              独立域名和 TLS，转发到 19703
└─ openbitfun-rd-trial-turn      独立 coturn，直接提供 TURN 网络入口

电脑/手机 ── HTTPS/WSS ── 试验 Relay ── 被控 Desktop
电脑/手机 ══ WebRTC 直连或 trial TURN ══ 被控 Desktop
```

拟采用 Compose project `openbitfun-rd-trial`，部署根目录 `/srv/openbitfun-rd-trial/`。TURN 容器及 `turn/turnserver.conf` 已创建；新 Relay 通过下述独立容器启动脚本部署，数据/secret/产物目录已创建。HTTPS、Compose project 和网页控制端静态资源仍是后续约定；原生账号联调暂走 SSH 隧道。

| 目录 | 内容及生命周期 |
|---|---|
| `releases/<source-id>/` | 已提交源码或受控试验快照的逐文件校验清单、二进制、固定镜像及启动脚本；正式发布仍须可追溯提交 |
| `relay/data/`、`relay/assets/` | 新 Relay 的独立数据；不指向旧 volume |
| `relay/static/` | 与试验客户端/服务端契约匹配的 mobile-web 产物 |
| `turn/` | TURN 非敏感配置和证书挂载定义 |
| `secrets/` | 凭据签发密钥等，仅部署账号可读，不进 Git、镜像或日志 |
| `evidence/` | 脱敏健康检查、协议验证和测试指标；不保存屏幕、输入正文或令牌 |

在已有构建机或 CI 生成并固定 Relay 镜像和 coturn 镜像 digest，再部署到试用机；2 核小内存服务器不承担整个 Rust/native WebRTC 编译。新容器设置各自的内存、CPU、PID、文件描述符和日志轮转预算，初始只准入一个试验远控连接；通过实测再增加并发。

2026-10-19 并行验证的容量边界：保留鸿蒙手工试用时，第二条 Android 生成源链路的连续重建收到 ICE 486。现有 user-quota=4 / total-quota=8 未调整；140 秒内 71 次 UDP socket 采样从 4 起、峰值 8、最后为 3，连接关闭后可回落。总数没有逐 allocation 归属，不能单独证明每条连接均返还，也不足以判定永久泄漏。原生 PC 关闭与 TURN 分配回收分别记录；连续重建及完整并发验收仍保留失败项。独立的一次 Android 键盘 / 强制 TURN 用例通过，只证明该单连接范围；采样、源码 / 构建指纹与测试结果保存在本地证据，未停止手机、重启服务或扩大配额。

原有 [Relay 部署指南](../relay-v1/README.md) 提供隔离数据、回滚和代理头规则，但其中官方域名、生产目录和监听端口必须改为本试用环境值。不得直接套用生产 Compose 去操作 `LEGACY_RELAY_CONTAINER`。

### 当前 loopback 联调实例

2026-10-15 使用当前工作区的独立源码快照构建，不冒充已提交 release。精简 standalone lock 的所有包版本与工作区锁文件一致；Rust 1.96.0 在本机 Linux 构建容器交叉编译 `x86_64-unknown-linux-gnu`。Docker Hub frontend 拉取超时后使用本机缓存 builder 和官方 toolchain 下载，服务器只打包二进制，不承担 Rust 编译。运行时复用服务器缓存并固定 ID 的 Debian 13 镜像；新容器的 CMD 指向新 Relay，旧 Relay 容器未恢复。

快照 `7827e125d32c…` 的完整文件清单及 `artifact.json` 保存在 `releases/snapshot-7827e125d32c/`。二进制 SHA-256 为 `964bbbecbab9cdf501134df8e60519f8a2773a18042fe99a32f453f73d9e0812`；本轮运行镜像 ID 为 `sha256:7541b4133f293e2a80675b2ff7ce2d75ee1966f7ca4f16489b1c9bd800f25a07`。后续更新必须重新核对清单，不能只按日期 tag 拉取。

[run-relay-trial.sh](run-relay-trial.sh) 在服务器执行，要求显式 immutable image ID 和已准备的独立 `relay/data`、`relay/assets`、0600 环境文件及 UID 10001 所有的 0600 TURN secret 文件。密钥仅从现有私密 coturn 配置派生文件，未写入镜像、源码或输出。脚本限定 loopback 19703、非 root、只读根目录、无 capabilities、768 MiB/1 CPU/128 PID、日志轮转及 `restart=no`；继承的 room-web volume 也明确绑定新 assets，避免创建未使用的匿名卷。旧 volumes 从未挂载。

当前静态 fallback 指向镜像内空目录，不提供旧匿名配对网页。`/health` 返回 1.0.5 healthy，`/api/info` 同时宣告 `remote_desktop_route_v1` 与 `remote_desktop_turn_v1`；无 token 的 TURN 领取请求返回 401。SSH loopback 转发已验证相同能力。上述结果不证明已授权屏幕、有效 attachment 凭据、TURN allocation 或任何像素到达。

2026-10-16 已更新凭据连续性版本，另宣告 `remote_desktop_credential_binding_v1`。本机构建 Docker 镜像读取失败后，改用独立临时工具环境中的 [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild) 0.23.4 / Zig 0.17.0 与 Rust 1.96.0 生成 `x86_64-unknown-linux-musl` 静态产物；standalone lock 的包版本仍与工作区锁一致，36 个源文件的原始/试用快照哈希和工具版本随产物保留，不改生产登录实现。独立空数据库候选实例先通过健康、新能力和未鉴权 TURN 401 检查，再替换试用 Relay，保留原配置、数据库挂载和 TURN secret。

当前镜像为 `sha256:d4d0bd6f7fb441f42b660c004956e9ad11d55ebe218843b7a79a0047492496d3`，二进制 SHA-256 为 `8aab6557f6fa45f88fa1e48a531f7d4e9d0f645cf2d4122a55b347a65e7cfb64`；清单在 `releases/credential-binding-8aab6557f6fa/`。上一容器保留为 `openbitfun-rd-trial-relay-before-credential-8aab6557f6fa`，处于停止状态；回滚时先停当前容器，再恢复该容器，不能让两者同时使用同一数据库和监听端口。配套关闭输入的 Mac 测试版已更新，鸿蒙正常包保持；实际强制 TURN 首帧、Relay 重启恢复及显式暂停/继续通过。随后另以两枚 15 分钟临时 token 完成同设备仍在线时的单 Shift 撤销验证；两枚 token 均已移除，原凭据和本机授权保持，普通包恢复后原账号再次呈现。该故障包的证据边界见[协议与媒体第 6 节](../../docs/architecture/remote-desktop-control.md#6-媒体绑定输入和故障)。收尾 Relay/TURN 运行，TURN UDP allocation socket 为 0；公网 HTTPS 与组合故障矩阵仍待验收。

本机联调转发（先确认本地端口空闲）：

```bash
ssh -o ExitOnForwardFailure=yes -N \
  -L 127.0.0.1:19703:127.0.0.1:19703 aliyun_wgq
```

手机开发隧道与两端试验构建都必须使用该 loopback 端点，重新通过真实账号注册，不能把官方 Relay token 当作新数据库凭据。端点/存储隔离须在联调客户端准备时核实，当前未替换普通用户安装的官方账号连接。结束本轮隧道后停止该 SSH 进程；TURN 等实际媒体测试时再按第 6 节恢复，不能由签发能力宣告推出 TURN 当前在线。公网 HTTPS 仍等域名、证书和外网验证。

### 两端隔离联调构建

同一电脑并行启动两个 Desktop 做路由联调时，除独立数据目录和 WebDriver 端口外，还必须在新建的测试配置中预置不同的持久化设备 ID：当前首次 ID 由主机名和 MAC 派生，仅换目录仍会撞号。两端分别通过测试身份注册并生成自己的设备密钥，禁止复制现有会话或密钥，也不要改写已有安装的设备 ID。新增控制端仍需被控端本机确认查看授权；同机双实例的结果不能计作双电脑实机验收。

2026-10-15 已准备固定 `http://127.0.0.1:19703` 的两端开发构建。Desktop 通过现有产品定义/resolver 选取 `openbitfun-rd-trial` product/data namespace 和独立 bundle identity，避免仅设置测试 HOME 后仍复用 macOS 全局 identity vault；实际测试启动另外使用空的工作区、数据与 frontend snapshot。开发程序可运行，完整 App bundle 被现有图标构建 guard 拒绝：本机缺完整 Xcode 26/actool。尚未通过正式打包验收，不能把这个依赖邻接资源的原始可执行文件独立分发。

HarmonyOS 保持已签名的[既有安装标识](../../src/apps/mobile/harmonyos/entry/src/main/ets/services/HarmonyUpgradeIdentityContract.ets)和已安装版本号，仅在本次构建快照中给所有 store/database/HUKS/handoff 标识加独立 trial 前缀；新会话和设备密钥不会读写旧安装的存储。普通 HAP 已另存用于恢复，构建源文件在 finally 中逐字节复原；不卸载 App，也不改动生产 identity contract。临时编译端点和存储隔离不是新的产品配置格式或面向用户的服务器选择器。

手机 USB reverse 与 SSH 隧道已接通该 loopback 端点。首次进入隔离 Desktop 的远程连接页面仍展示现有免责声明。本轮按操作者要求使用下文的独立测试身份，已验证两端登录和设备发现；本机设备 / 显示器授权仍由测试人员确认。SDK/OS consent、账号设备认证、view grant、媒体绑定和实际呈现分别验收，不能从登录成功推出画面可用。联调私密产物、恢复 HAP、源码 hash 与进程信息留在本地证据目录，不写入架构文档。

2026-10-16 续期试用版本：macOS 关闭输入的产物 SHA-256 为 `b4d942c4898b4ac037a3b8fe668f6e98a27e2513f1f665a640e26f47a7ac5c74`，鸿蒙签名 HAP 为 `647fa49b18ae3d9be9367556474d9941271aaf5ffca5d1e95882a5bb26c377ac`；保留原安装身份、数据及授权。发送端沿用已验证的 Desktop frontend 快照，新的电脑控制器仅有定向代码测试，本轮真机控制端是鸿蒙。Relay / TURN 镜像和配置未变。正常包强制 TURN 观察约 9 分半，跨过原签发窗口并自动重建一次，手机进程保持；本机停止后原生不再等待清理，TURN 转发 UDP socket 为 0。手机 hilog 的早期记录被淘汰后，仅更换独立观测进程，后续首帧和路径事件按完整时间戳行去重；媒体 / App 未重启。原始采样、接管说明、前后截图及构建 / 源码指纹留在本地凭据续期证据中。该结果不覆盖弱网 / 持键重建、多周期、双电脑或异常退出的分配寿命。回退客户端可使用保留的上一正常产物；无需回退服务端或删除授权数据。

持键续期补充：同一正常版本基线下，受限试用包在原生提交处仅允许一次 Shift-down，并封住独立 Unicode 提交；文本能力不宣告，原生 drain 保留。真实账号 / 强制 TURN 自动重建时观察到约 7.6 秒持键后可信松键，旧 Rust wrapper 先排空、新 wrapper 后准备，第二个 PC 呈现并继续解码，两侧均为 relay，未自动重授。没有触发保护性本机停止，收尾才显式停流。已恢复普通包、原始测试恢复脚本和关闭的输入 gate，原账号实画面复验及 TURN UDP socket 归零通过；源码 / 产物指纹、受限包、键回执与逐 PC 统计保留在本地持键续期证据中。一次准备阶段曾返回 `invalid_request`，当时未请求操作权；私有包增加仅记录操作名的诊断后未复现，原因尚未定位，不能记为已修复。同一 PC 的 TURN UDP/TCP 路径切换也已观察到，路径日志数不能当作 PC 数。该结果只覆盖正常网络下一次转换，双屏目前无设备。

## 3 地域、计费、域名与网络前置检查

先从云控制台或已授权只读 API 核实实例地域、公网 IP/EIP 关联、带宽计费方式、出网峰值、当前业务基线和试验预算，不能凭 IP 或 SSH 成功推断。2026-10-14 云控制台已确认杭州地域及 3 Mbps 上限，计费方式和域名备案仍待核实；SSH 检查不能证明这些云端事实。按固定带宽和按使用流量都需检查实际出网限制，后者还需要有界测试时长及流量预算。依据：[阿里云公网带宽计费](https://help.aliyun.com/zh/ecs/public-bandwidth/)。

例如 3 Mbps 单向视频转发 10 分钟，媒体有效负载出网约 225 MB，另加协议开销；若只有 3 Mbps 固定带宽，不能承诺稳定承载 2–4 Mbps 均衡档并保留旧 Relay 的余量。先低码率、短时、单连接探针，逐级测试；记录旧 RPC 响应延迟，出现竞争就降码率或停止媒体试验。同机容器限额不能隔离共享公网出口。不自动购买带宽、变更计费或创建付费资源。

若实例位于中国大陆，试验域名及接入备案状态须按阿里云要求核实，不能默认未备案域名的公网 HTTPS 可用；80/443 的实际可达性还需外网检查。没有可用的合规域名时，TURN UDP 探针与受控本机/隧道信令可独立推进，但不算公网手机 HTTPS 链路验收，也不通过换端口宣称绕过备案要求。依据：[阿里云备案说明](https://help.aliyun.com/en/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview)。

试验 HTTPS 和 TURN 域名在部署时确定，配置中使用 `TRIAL_RELAY_HOST`、`TRIAL_TURN_HOST` 占位；它们是部署变量，不新增面向普通用户的服务器设置页。测试客户端使用统一的试验构建配置，桌面、KMP、HarmonyOS 和 mobile-web 的账号设备入口必须一致；不能让设备分别注册在旧 Relay、官方 Relay 和新试验 Relay 后假定互相可见。

| 入口 | 初始试用规划 | 验证要求 |
|---|---|---|
| SSH | 沿用现有连接 | 保持现有规则及可用管理连接 |
| 原 Relay | TCP 9700 已空闲 | 退役后无监听；新实例不复用原数据卷 |
| 新 Relay upstream | TCP 19703，仅 loopback | 公网不可直接连接，仅本机反向代理访问 |
| 新 Relay HTTPS/WSS | TCP 443 | 正确证书、明确 CORS origins、Socket.IO 升级和超时正常 |
| TURN/STUN | UDP/TCP 3478 | 外网完成真实 ICE/TURN 验证，不能只测 TCP connect |
| TURN over TLS | TCP 5349 | 证书主机名匹配，并能建立 relay candidate 的真实连接 |
| TURN relay sockets | UDP 49160–49179，初始有界范围 | 主机防火墙和云安全组一致放行，地址映射正确；范围是探针预算，不是并发承诺 |

TURN 客户端到服务器的 TCP/TLS 候选不等于把全部中继端口改成 TCP；具体转发行为按选定实现和 ICE 验证。云服务器存在私网地址到公网地址映射时，配置正确的 advertised external address，不能向公网控制端仅返回私网 relay candidate。

单公网 IP 首轮以 HTTPS 443 加 TURN 3478/5349 验证基础链路；该配置不能宣称覆盖“只允许 TLS 443”的网络。后续需要这种网络覆盖时，给 TURN 独立公网 IP/节点并启用 TLS 443 候选。TURN 端口直接连接媒体节点，不通过仅支持 HTTP 的 CDN/WAF 或 `/turn` 反向代理路径。

部署前读取实际安全组和防火墙规则，仅添加该试验所需规则；本机无监听冲突、firewalld 未运行均不能证明阿里云安全组已经放行。缺少云控制台权限时记录明确的端口规则缺项；未完成外网连通验证前不标记公网可用。

## 4 TURN 凭据和授权接线

### 单连接带宽与流量估算

以服务器为参照，入网是电脑上传到 TURN，出网是 TURN 发到控制端。单路转发的两方向各约一份视频数据；不能把两份相加后当成出网计费量。直连成功时，视频不占 TURN 流量，只留下账号信令。

按十进制 GB，恒定视频码率 B Mbps 的每小时每方向媒体量为 `B × 0.45 GB`。初步容量规划可另预留 20% 协议/反馈开销；它不是当前测试负载的实测比例，重传和弱网可能需要更多余量：350 kbps 约 0.19 GB/h，2 Mbps 约 1.08 GB/h，4 Mbps 约 2.16 GB/h，入网/出网分别计算。当前探针的简易动态图案远低于码率上限，不能按它预算普通桌面、滚动或视频场景。

试用实例已核实的出网规格为 3 Mbps；一路约 2 Mbps 的视频已接近需要保留余量的容量，4 Mbps 档超出规格。早期 coturn 的 per-allocation `max-bps=100000` 仅约 0.8 Mbps，适合 350 kbps 探针，却低于账号链路发送器的 1.2 Mbps 上限。当前试用值已对齐为 `max-bps=250000`（bytes/s，约 2 Mbps），为码流及协议开销留出余量；发送器上限仍为 1.2 Mbps，未调整云端套餐。提高测试画质前须同时评估云端带宽、TURN 限额与实际开销，不能只改客户端码率。

2026-10-20 的有限双周期对照使用一台 Mac 的两个隔离产品进程、原生显示器与强制 TURN。服务器整机网卡连续采样 697.89 秒，平均下行（接收）0.756 Mbps、上行（发送）0.764 Mbps，按当时内容折算约 0.34 GB/小时出网；包含 SSH、信令和后台流量。画面包含同机窗口递归，不能代表高动态桌面、手机或多路容量。试验结束走产品断开，host 原生清理完成，TURN 转发 UDP socket 归零；原 Relay / TURN 容器身份和启动时间保持，重启次数为零，额外控制端及本次临时身份服务、SSH 身份转发均已停止。

2026-10-15 生产 macOS 发送引擎 → 鸿蒙产品共享接收页的短时 TURN/TCP 采样，服务器网卡统计窗口约 54.07 秒，入网增加 0.360 MB、出网增加 0.335 MB（十进制，含 SSH 等主机流量）。其中约 8 秒采集，随后约 9 秒保留媒体连接验证源停止；原生所选候选对在采集结束前记录发送 231647 bytes、接收 6551 bytes。首帧为自适应后的 640×412，350 kbps 是上限，不是恒定负载。UDP / TCP 均有两端实际 relayProtocol 与 relay/relay 证据；测试结束恢复普通试用 App 并停止空闲 TURN。私密原始记录留在本地，不包含在发布文档；这不是普通桌面 / 高清视频的流量基准。

阿里云固定公网 IPv4 的入网免费，出网按固定带宽/实际出网流量之一计费；购买值小于 10 Mbps 时，文档给出的入网上限为 10 Mbps。实例实际计费模式与地域单价需在控制台确认，流量制估算为 `每小时出网 GB × 使用小时 × 并发路数 × 出网单价`，带宽制按购买规格和时长；不在运行机器内从网卡累计字节推算账单。[公网带宽规则](https://www.alibabacloud.com/help/zh/ecs/user-guide/network-bandwidth)、[计费说明](https://www.alibabacloud.com/help/en/ecs/public-bandwidth)。

### 凭据签发与授权

在新 Relay 增加已认证的 TURN 配置接口，接口路径于实现时与现有 API 风格统一。请求绑定路由上下文中的账号/来源设备和显式目标设备，服务端验证同账号目标及试用配额，返回允许使用的 ICE server 列表、短时凭据、期限和配置版本。客户端不能提交任意 TURN 地址供服务端代理或签名。

选用 coturn 的临时凭据机制时，由服务端保存签发密钥，客户端仅拿短时凭据；具体有效期、续签提前量和时钟容差由 TURN 探针确定。allocation、带宽和签发频率分别设置限额，不能把单个临时用户名限额误当作账号总限额。coturn 本身不理解 OpenBitFun 账号，账号总预算由 Relay 签发/准入和媒体节点统计共同约束。

凭据到期不是业务会话立即断开的证明：已有 allocation 的刷新和失效行为必须实测。本机停止/撤销、锁屏、OS 权限撤销或 host 收到 Relay 明确授权失效通知时，立即停止输入与采集并关闭 PeerConnection。账号侧撤销有通知/检测延迟；通知发送失败或 ACK 超时须关闭受影响 host socket 兜底，普通失联最多保留检测后 30 秒视频，不得等 TURN 凭据自然到期才停止。远控和聊天共用 socket 时，此故障路径可能触发聊天传输重连，需记录影响。密钥轮换需要验证新凭据签发、旧凭据窗口以及现有 allocation 生命周期。

媒体探针阶段允许单独签发给测试人员的短时凭据，但不把这种探针接线当成完成账号鉴权。第一次开放公网 TURN 就必须禁用匿名转发，并配置拒绝访问 loopback、管理网段和云元数据地址的转发规则；产品入口再接通真实账号、按设备 grant、远控路由和授权检查。日志不输出完整 TURN 密码、SDP、输入内容或 Authorization。

## 5 部署、验证和回滚步骤

1. **保存基线**：完成第 3 节的地域、备案、带宽/计费检查；仍有旧服务时记录其 image ID、挂载、健康和资源使用，已退役则核实旧卷保留与端口释放。仅保存脱敏输出。核对试验目录/端口无冲突、磁盘余量及 SSH 可用性。
2. **准备配置**：确定试验域名、TLS、固定镜像和独立数据目录；从受控部署环境生成密钥，限制文件权限。只为试验实例建立新配置，不修改旧数据库或复用旧卷。
3. **第 0 阶段：鸿蒙接收与 TURN**：先以桌面 Chrome getDisplayMedia 等现成发送端，直连真实鸿蒙 App ArkWeb；再启动独立 TURN，验证未认证请求被拒绝、短时凭据可用、公网 candidate 正确。两个外部终端中至少一个使用蜂窝网络，记录普通 ICE/强制 relay 下的实际画面和单 DataChannel 往返。受控探针信令不依赖新产品 Relay，不能当成完成产品鉴权。Linux 实际 WebKitGTK 同期探测；鸿蒙不可行先评审接收适配，Linux 失败只阻塞该平台。
4. **接通原生发送与新 Relay**：接收探针通过后实现 macOS 显示器 source 并选定首轮媒体引擎。新远控路由通过 focused tests 后部署到 loopback 19703，检查 `/health`、`/api/info.capabilities` 的 `remote_desktop_route_v1` 及版本化注册/调用，再开放试验 HTTPS。Handshake 保持原样；仅部署当前 main 不会获得未实现能力。
5. **鸿蒙只读闭环**：两端使用同一试验端点登录和注册，验证固定设备指纹、本机授权或预授权、attach/connection 信令绑定，然后启用原生视频。已有旧实例的设备凭据不复制到新数据库。此阶段不开放 OS 输入，验证停止、旋转/折叠和前后台清理。
6. **输入及平台扩展**：按[唯一验收矩阵及实施顺序](../../docs/architecture/remote-desktop-control.md#9-实施与唯一验收矩阵)记录证据；reservation 评审与测试通过后，先完成鸿蒙 → macOS 输入、AI 占用拒绝和故障清理，再完善电脑控制端和其他平台。用现有 presence/鉴权、连接失效通知及重连复核测量撤销总延迟；覆盖同设备新 socket 在线但旧 token 失效、通知发送失败/ACK 丢失及强制关闭兜底。30 秒只计普通失联检测后的媒体宽限，明确授权失效收到即停；不部署 rd-route-status 轮询。不能以模拟器、合成帧或抓包替代真实画面和输入。
7. **确认隔离**：仍保留旧服务时对比其健康、资源与原有会话功能；已退役则确认旧卷未被新实例挂载。记录试验进出带宽、失败率及残留 allocation。完成后降低或停止无人使用的试验资源。

回滚只停止 `openbitfun-rd-trial` 的新服务、撤回试验代理入口和专用新增网络规则；精确定位资源，不能用模糊名称停止其他容器。新数据和日志先保留用于诊断，不执行删除卷、重置账户或改动旧数据卷的操作。仍运行的旧服务复测健康；已退役的旧服务不由试验回滚自动恢复。常规 TURN 镜像回退可能中断正在使用的媒体连接，客户端按已定义的断线规则释放输入并恢复观察。


## 6 第 0 阶段复现与安全配置

接收端及浏览器发送端入口见 [probe/README.md](probe/README.md)。本轮每次单连接、350 kbps、最多 60 秒，只捕获明确选择的测试标签页；信令通过本机 loopback 与 hdc reverse，媒体通过真实网络。普通 ICE 使用 TURN fallback，强制 relay 分别通过 VP8/UDP、H.264/UDP、H.264/TCP；TCP 指客户端到 TURN，relay socket 仍为 UDP。本轮不是蜂窝/P2P/TLS 或产品账号链路验收。脱敏指标和测试页画面只保存在本地被忽略的 `.openbitfun/remote-desktop-probe/`，不写入服务器日志或 Git。

试验容器使用 host 网络、专用 UID/GID `34348`、192 MiB 内存、0.5 CPU、128 PID、5 MiB × 2 日志轮转。镜像 digest 见 probe 说明；关闭 CLI/TLS/DTLS/TCP relay（本轮未启用这些入口），使用私网 relay address 与正确 external address。配置文件含 TURN 签发密钥，权限 0600，属主必须与容器 UID 一致；先检查该 UID 可读，再验证匿名 Allocate 返回 401。配置不可读时 coturn 可能以缺失鉴权配置启动，因此“容器运行”不算检查通过。

当前试验配置：`use-auth-secret`、发送/接收各自短时用户名、`user-quota=4`、`total-quota=8`、`max-bps=250000`（bytes/s）、`bps-capacity=2000000`、`max-allocate-lifetime=90` 秒和 UDP 49160–49179。初始浏览器探针用 max-bundle 和单 TURN transport，每端 2 个、总计 4 个 allocation；不能把这个预算直接套到当前原生发送端。固定的 libwebrtc 0.3.52 Rust 配置没有暴露 bundle policy，原生 offer 会为视频与 DataChannel 分别收集候选；同时配置 UDP/TCP 时每端可能申请 4 个 allocation。

2026-10-15 账号链路的原生发送端已遇到 `Allocation Quota Reached`；仅增加 allocation 数量仍不足：手机诊断两次收到 486、最终 0 个候选，Mac 此时已经成功分配 4 个。[coturn 4.6.3 的 Allocate 路径](https://github.com/coturn/coturn/blob/4.6.3/src/server/ns_turn_server.c)还会按 `max-bps` 为每个 allocation 预留带宽，预留失败同样返回 486。该轮历史配置同时为 8 个 allocation 预留 `8 × 100000` bytes/s；当时未调整单路视频码率或单 allocation 限速，带宽预留不是实际流量或已测并发容量。重启后复核匿名 Allocate 仍返回 401，鉴权与网络限制保留。关闭 PC 不保证立即删除 allocation，前次资源未释放仍可能耗尽预算；应检查实际候选、残留和失败原因，不靠重复连接掩盖容量问题。 本轮实际画面复测结束后，继续观察到试验 relay 端口上的 UDP socket 归零，未为清理而重启 TURN。

2026-10-16 后续对照在弱网模拟器未启用时仍出现续约 / ICE 中断；核对发现试用 `max-bps=100000` 低于当前发送器上限。[coturn 4.6.3 的说明](https://github.com/coturn/coturn/blob/4.6.3/README.turnserver#L402-L410)明确按输入 / 输出分别限制 bytes/s，超限可直接丢弃或抑制报文。因此测试不能同时把旧 TURN 限额当作无损基础设施。确认无活动 allocation、保存受限权限备份后，仅将专用 TURN 的 `max-bps` 调为 `250000`、`bps-capacity` 调为 `2000000`；其余配置及鉴权字节保持，账号 Relay 进程未重启，匿名 Allocate 仍返回 401。容量值对应 `8 × 250000` bytes/s 的 admission 预留，不代表实例实际带宽或并发容量。

修正预算后，同一 SDK / 私密采样版本在每方向 1 Mbps、额外约 200 ms RTT 和 1% 丢包下保持 112 秒空输入租约，56 次续约 ACK 的 P95 为 320 ms；基线中代理发往 TURN 的约半秒采样窗口峰值为 164 KB/s，高于旧限额。此对照排除了已知配置不匹配，但不据单次通过认定所有旧中断的根因；早期混有限流的 P95 不与这次数据作为单因素对照。普通客户端及 SDK 日志保护已恢复，未为清理而重启服务，relay UDP 端口最终为零。

2026-10-16 的 macOS 原生发送 / 鸿蒙真机弱网对照发现：1% 丢包复测结束、两端普通包恢复、原生 PC 已析构后，仍有一个发送端 allocation 占用 relay UDP 端口。原生 SDK 最后一次成功 Refresh 后报告下次刷新为 540 秒；该 allocation 在最后一次成功刷新约十分钟后才观察到自然回收（采样间隔约 32 秒），未重启 TURN 或强制删除分配。服务当前仍配置 `max-allocate-lifetime=90`；[该版本的寿命调整代码](https://github.com/coturn/coturn/blob/4.6.3/src/client/ns_turn_msg.c#L1227-L1242)存在先采用默认值 / 最小值的路径，[最小值为 600 秒](https://github.com/coturn/coturn/blob/4.6.3/src/client/ns_turn_msg_defs.h#L58-L63)，不能把这个低于最小值的配置当作统一的 Refresh / 异常退出回收上界；须以实际分配寿命、残留端口与配额为准，不靠放宽配额掩盖资源积累。两分钟空租约窗口不是长时凭据续期或异常退出资源回收的完整验收。

回收对照补充：同一正常 macOS / 鸿蒙包、真实账号和强制 TURN 的只读正常断开中，6 个分配均观察到 `Refresh lifetime=0` 请求及成功回执，其中一个 UDP 分配的释放比其余当前分配晚约 17 秒。另两次短只读会话在退出手机 App 后由本机停止确认媒体排空；其中一次额外确认旧手机 PID 已消失，持续观察未见正寿命 Refresh，后续 relay UDP socket 归零。元数据采样含 UDP / TCP，内核丢包和 TCP 解析缺口均为 0；没有保存包、身份字段或媒体载荷。这些证据区分正常关闭与进程退出后的服务端寿命，不把它们当成所有历史残留的根因、即时回收或精确超时上界。未申请操作权、修改 SDK / 配额或重启 TURN。


拒绝 loopback、multicast、RFC1918、link-local/元数据及 CGNAT 转发。两个 relay candidate 使用同一个 NATed TURN 节点时，其公网地址可能被 coturn 映射回自己的私网 relay address。本轮仅允许**当前节点自己的 relay 私网 IP**，同时安装专用 UID 的 OUTPUT 规则，将该 IP 的 UDP 访问限制在 relay 端口范围；规则实际拒绝 49159 的测试请求。不得扩展为允许整个私网段，或仅加 `allowed-peer-ip` 而缺少端口保护。

重新启动前核对 `TRIAL_RELAY_PRIVATE_IP` 来自当前节点配置，确认 UID 专用，并确保下面规则存在（先 `iptables -C`，不存在才 `-I`）；占位变量从私密部署环境填写，不从客户端请求读取：

```sh
iptables -I OUTPUT -p udp -d "$TRIAL_RELAY_PRIVATE_IP" \
  -m owner --uid-owner 34348 -m udp ! --dport 49160:49179 \
  -m comment --comment openbitfun-rd-trial-self-peer -j REJECT
docker start openbitfun-rd-trial-turn
```

启动后复测匿名 401、规则计数和真实媒体；规则不持久化，应在恢复流程中检查，不依赖机器重启后仍存在。完成试验先停 TURN，再用相同参数、`-D OUTPUT` 代替 `-I OUTPUT` 删除这条专用规则；保留容器和 0600 配置供下次恢复。不要删除用户在云控制台添加的安全组规则，不改动旧 Relay 或 SSH。手机 force-stop 后不带探针参数启动普通 App，移除本次 hdc reverse，关闭本机信令和测试页。

## 7 隔离测试账号

本轮按操作者要求使用独立测试身份，不要求邮箱或 GitHub 登录。身份服务只监听服务器 `127.0.0.1:19704`，经本机 SSH 与手机 USB reverse 访问；试用 Relay 仍在 `127.0.0.1:19703`。它只签发固定 `test-rd-trial-…` 账号，授权启动窗口 30 分钟、最多 8 次，access / refresh 凭据分别存活 15 / 60 分钟，进程最多运行两小时。私密票据、凭据和设备私钥不写入文档或日志。

这是本地构建快照的测试 provider：独立 Relay 镜像只信任该回环身份端点，Desktop 试用构建识别测试账号前缀，手机试用构建仅额外接受精确回环测试登录地址。普通源码在构建后逐字节恢复，普通发布仍使用原身份服务。两端通过既有登录 / 设备登记路径产生自己的设备密钥、领取不同设备 token；测试身份不代替本机 display / control grant，不开放匿名远桌。

已验证电脑和 DEL-AL10 登录同一测试账号，手机目录能看到电脑。随后实际本机确认保存了单显示器的只读授权，鸿蒙产品入口进入“正在查看桌面”，证明原生 source 经账号信令完成实际呈现；这不证明邮箱 / GitHub 身份服务或手机输入已通过。账号联调发现并修复了 Desktop 将 `Arc<PathManager>` 按裸类型读取导致的初始化 panic；重启后测试身份恢复，设备连接调用正常返回，远桌 host 返回 ready 和一个真实显示器。DEL-AL10 / API 26 已通过真实加密 capability 请求，未获本机 grant 时明确返回 `device_approval_required`，没有启动捕获。

开启手机“强制中继”后，选择 1512 × 982 显示器，真实账号路由下再次呈现并保持查看状态；两侧共享 renderer 使用 relay-only ICE，健康校验要求双方候选均为 relay。此轮尚未分别锁定 UDP / TCP；不能沿用早前探针结果当成本次两种传输都通过。服务器网卡 10.01 秒采样约接收 0.637 Mbps、发送 0.675 Mbps，包含 SSH / 信令，仅代表当时单路桌面内容，约每小时接收 0.29 GB、发送 0.30 GB；计费方式仍须在云控制台确认。

后续输入联调使用仅在隔离构建中开启的输入 gate、本机人工确认的单显示器操作授权及专用临时 Cocoa 窗口；真实文字 / 单键结果和剩余问题见[协议与媒体](../../docs/architecture/remote-desktop-control.md)。本轮结束已关闭手机媒体和临时窗口，停止试用 TURN，并实际恢复 `control_available:false` 的 Desktop 试用运行时；保留测试账号、设备密钥和人工授权，不卸载或重置手机数据。Relay 继续运行，后续联调按本手册检查后恢复 TURN。

本机授权页使用独立控制设备目录，避免既有 host 目录隐藏手机。试用 Relay 已更新该能力，原镜像另保留为 `openbitfun-rd-trial-relay-before-controller-directory`；回退测试身份环境时使用它，结束整个测试身份环境仍恢复 `openbitfun-rd-trial-relay-pre-test-identity`。目录升级不改变账号凭据、设备密钥或 grant，不能代替本机确认。

非默认端口的账号 WebSocket 曾被 Origin 校验拒绝。真机修复使用 SDK `supportOriginPort: true`，保留 SDK 生成 Origin 中的端口；追加自定义 Origin 头未解决该问题。实现依据见 [OpenHarmony WebSocket ParseHost](https://github.com/openharmony/communication_netstack/blob/master/frameworks/js/napi/websocket/websocket_exec/src/websocket_exec.cpp)，本机 SDK 将该选项标为 API 26 起提供。服务器校验未放宽；旧 API 的非默认端口兼容性仍需单独验证。

旧试用 Relay 容器保留为 `openbitfun-rd-trial-relay-pre-test-identity`，新镜像保留只读 rootfs、原用户、挂载和网络配置。整个测试身份环境结束时，先撤销该测试账号的 Relay 设备凭据，再停测试身份服务并恢复原容器；仅停止身份服务不会撤销已签发的 Relay token。测试构建、进程配置和脱敏收据保存在操作者本地临时目录，不作为可发布身份实现。

连接诊断补充：鸿蒙正常签名包已更新为 `ba8f5463c82daa6736a00880ca3f2698da6a5072c43480878b37f78b1e5956e9`，仅补充建立连接各操作的终止日志来源；保留原安装身份、账号与授权，不增加协议字段。105 项控制器测试、架构检查及构建通过；原账号 / 原生显示器 / 强制 TURN 收到 1280×828 首帧，未申请输入，停止后原生清理完成、普通 App 重开、TURN 转发 UDP socket 为 0。macOS 与服务端产物保持上述版本。偶发 `invalid_request` 仍待捕获具体来源。

2026-10-19 更新保留原身份的鸿蒙试用包后，首轮 attach 返回 `target_unavailable`，显式重新发现 / 连接后基础原生输入验证通过，详情见协议文档。现有运行日志不足以归因。Relay 源码新增该拒绝的 DEBUG 原因：`host_registration_missing`、`host_registration_ambiguous`、`host_identity_missing`、`request_emit_failed`、`host_registration_not_ready`、`attachment_creation_raced`、`attachment_registry_retired`。仅记录固定标签，不输出账号、设备、attach ID、凭据、密文或底层错误正文；保持 wire 错误及禁止自动重放的行为。排查时只对 `openbitfun_relay_service::realtime::remote_desktop` 启用 DEBUG，不打开完整 socket / WebRTC 报文日志。2026-10-19 已将仅含这些日志改动的镜像更新至试用实例：保留原测试身份验证器、数据库、挂载、只读 rootfs 和非 root 用户；旧容器保留用于回滚。隔离空数据库预检、未认证 TURN 拒绝及 15 项路由检查通过，Mac 自动重新注册后鸿蒙首帧恢复。手机增加固定 `relay_response / host_response` 来源日志，不输出任意错误正文，退役通道不记录迟到结果。实际 App 进程退出后重连已复现来自 Mac 加密回复的 attach 拒绝，Relay 七种原因均为零；不能再把该次失败归因于 Relay 路由注册。

持键旋转补充：复用已核验的单 Shift 原生 guard（普通键与独立 Unicode 路径均受限），新受限手机包验证竖屏转横屏，唯一可信 down/up 与系统松键一致，同一 PC 显示新色块并保持仅查看；未触发保护停止。恢复上述普通两端包后原账号画面复验通过，Mac 输入关闭、按键清除、TURN 转发 UDP socket 为 0。最后手机页面复核遇到 HDC 设备断开；HDC 此时返回 0 但输出 `[Fail]`，故最后的普通 App 重开 / 竖屏状态未计为通过，本地驱动已改为拒绝这类结果。持键验证通过与收尾页面待复核分别记录，不扩大为双向旋转或折叠验收。

键盘专项验证所用鸿蒙签名 HAP 为 `da0d9ecf95c7e4ae440a2ad27b320235524d1e46818351c18ef4c4ba0cdd0f0b`，保留身份、账号、数据和授权原地升级。键盘延迟打开与回调绑定 renderer / 操作代次、当前实例和本地打开请求，收起同步退役旧请求；六类反例先失败再修正，124 项键盘 / 控制器、架构检查、签名构建，以及宽 / 窄 × 浅 / 深和竖屏浅色五组真机 IME 检查通过。测试驱动须先确认中文模式，等待申请完成与画布几何稳定，再计算点击；不能放宽原生坐标 / 窗口保护来适应旧尺寸。

上述键盘专项手机包与当时受限 Mac 经真实账号 / 强制 TURN，分别完成中文直接编辑和含 IME 重开 / 未确认拼音取消的组合流程。固定“你好”一次提交，Backspace / Return 各一组原生按下 / 松开，最终为“你”加换行；停止后超过 5 秒无追加输入并保持查看。另有约 70 秒空输入租约和三次键盘开合，显式释放后保持查看，host 收到请求、排入结果并完成清理。空租约观察始终没有打开私有原生输入保护，不能算 OS 输入证据。此前 `control_delivery_unknown` 失败仍保留，后续两轮成功不表示根因已定位；公网 HTTPS、P2P 和完整故障矩阵仍未验收。

当前 macOS 普通发送端为 `d3746c702e4ea2f8bb90808b4e2e3c45dc11de4dcc5418f9b4e30c21ac1d8a28`，输入 gate 关闭。捕获 context 脱离与最终队列清理改为共用一次 8 秒单调等待预算；两处阻塞反例均先失败，再验证超时保留句柄及恢复后重试。真实账号 / 鸿蒙 / 强制 TURN 的零输入探针将实际采集回调队列暂停 10 秒，观测源超时撤权、恢复画面但不恢复操作，最终清理通过；该专项使用旧 frontend `bundled-96850b63dad50dbd` 和上述键盘专项手机包。未改 SDK、协议或服务器配置，不把回调暂停当作物理显示 / 编码器冻结或实际松键验收。

当前正常试用客户端的共享接收器已统一媒体终止处理：鸿蒙签名 HAP `6d3f638a2ffafc6a4e65ae8131547776336db1fa4eb5a21d7e066ca3638a4b97`，桌面 frontend `bundled-51c1b75793230336`；Mac 原生二进制保持上述版本。bind 发送抛错、通道错误 / 意外关闭、PC 失败 / 关闭、轨道结束、播放拒绝或周期统计失败均立即清理当前媒体，不等待外层 App。错误回调中启动后继连接不会被旧清理关闭；停止后不再挂起周期统计。八项新增定向用例中七项先失败再修正，共享接收 / 控制 / 实际浏览器测试 48 项、鸿蒙控制器 / 桥队列测试 112 项通过；短暂 disconnected 的既有恢复语义保留。

鸿蒙原地升级保留账号和授权，包内三项接收资源与源码逐字节一致；鸿蒙真机和同机隔离 Desktop 控制端分别经原账号、原生屏幕和强制 TURN 的 relay ↔ relay / UDP 路径，完成 1280×828 首帧、暂停 / 新连接重新呈现及断开清理。Desktop 实际 iframe 包含新修复；此处仅是一台 Mac 的两个隔离进程，不作为两台实体电脑验收。两端全程只查看，未请求输入租约，原本机 grant 保留；既有中文输入、回调队列冻结证据仍归属各自旧产物，不扩大为此次新版重测。

前版 `4deddbdf…` 的 12 项纯健康 / 20 项 native 媒体测试、静态结束恢复和显式源失效后 idle 拒绝仍保留原证据范围；更早的中文 OS 输入和 worker 12 项属于 `b412bbe1…`，位置保护拒绝 / 本机停止 UI 属于 `be40ea11…`，不扩大为新版完整输入或故障矩阵验收。

收尾恢复普通 Mac、手机竖屏普通页，测试的按键 / 按钮已释放，原账号与本机授权保留。源码临时修改均恢复，Relay / TURN 未改版本、配置或配额。两服务继续运行。客户端已确认媒体排空并恢复普通版本；后续正常断开 / 进程退出只读对照结束，服务器 relay UDP socket 已自然归零，未为回收重启服务或改配额。USB 重接后先检查既有 HDC 转发，仅补试用 Relay 所需任务。

## Linux WebKitGTK API 探针

先检查实际 API，再准备媒体发送源。以下工具只加载固定页面，编译生产 `DesktopMediaFrame` 与共享接收器，不调用账号、TURN、捕获或输入接口；不安装依赖或改变引擎安全设置。准备阶段需要仓库的 Node/Vite 依赖；运行阶段需要 Linux、Python GI、GTK 3、WebKit2 4.1 typelib 和图形 display。

```bash
rd_probe_dir="$(mktemp -d)/receiver"
node scripts/test-remote-desktop-webkitgtk-api.mjs "$rd_probe_dir"
python3 scripts/fixtures/remote-desktop-webkitgtk-api.py --html "$rd_probe_dir/fixture.html"
python3 scripts/fixtures/remote-desktop-webkitgtk-api.py --html "$rd_probe_dir/fixture.html" --enable-webrtc
python3 scripts/fixtures/remote-desktop-webkitgtk-api.py --html "$rd_probe_dir/fixture.html" --enable-webrtc --https-origin-control
```

无桌面的隔离环境可用 `dbus-run-session -- xvfb-run -a python3 ...`，其结果只算 headless WebKitGTK 观测。跨机器准备时只传 fixture、sources 清单和 Python runner；复制后校验 `sources.json` 中的页面 hash，不传账号或安装数据。输出中的 `api_available` 只说明 secure context、PeerConnection 与呈现回调 API 是否存在，`media_verified` 始终为 false。缺 API 时还要求生产接收器明确拒绝并停止；API 存在后仍须另做 codec、DC、持续呈现、健康/停止、真实 Tauri 与实体桌面验收。

fixture 还包含生产 Desktop 控制器的本地预检，request/turn 使用只计数并抛错的隔离 port，不访问账号或真实 host。`controller_preflight_verified=true` 要求缺 API 后进入 media_backend_unavailable，且两项调用计数均为 0；这证明本地拒绝路径，不证明远程 RPC。sources 清单同时固定控制器与画质规则源文件。旧 fixture 没有此报告时不计该项证据。

新版 fixture 在 iframe 就绪前即调用控制器 open，以复现产品挂载顺序；控制器在四秒本地等待内收到缺 API 报告后直接结束。`controller_startup_race_verified=true` 另外要求 `opened_before_ready=true` 和 host/TURN 调用计数为 0，旧 fixture 的普通拒绝结果不替代这一项。默认、显式 enable-webrtc 与 HTTPS origin 三组均已通过；关闭、换号、超时和替换等待的聚焦回归也已通过。具备 API 的环境只取消这次无 host 准备，API 存在本身仍不算媒体通过。

2026-10-19 已在试用机独立、非 root、只读根目录、无额外 capabilities、768 MiB / 0.75 CPU 上限的容器中完成三组观测。Debian 13 amd64 / `libwebkit2gtk-4.1-0` 2.54.0-1~deb13u2 均无 `RTCPeerConnection`；显式启用属性和 HTTPS origin 对照不改变结果，共享接收器返回 `media_backend_unavailable` 并停止，无媒体权限请求。原生 API 报告 sandbox_enabled=false，未调整该设置，不算生产安全验收；WebKitGTK 官方已说明 2.54 禁用 WebRTC。未运行后续生成视频发送源，不把此结果记为 WebRTC 成功。隔离探针全部退出；Relay / TURN 的容器 ID、镜像、启动时间与重启次数保持原值，未改端口、配额或客户端试用包。镜像与逐文件 hash、完整结果仅保留在本地/试用环境，不作为可发布运行时。

### Linux 原生 SDK 接收实验

另行使用已有 SDK 的 Linux x64 官方预编译归档，不改变上述 WebKitGTK 结论，也不替换试用客户端。固定 `webrtc-89d790b` 归档 SHA-256 为 `b167adad5291cea0e4d66a0454d9d52d2ad714e6b0ed70f4410317d3ebde70c5`；静态库为 `daa499c9769ac884380dff248a533b8d1adb9a6c33e1a04f8e605dc0012bcb21`。绑定须使用 SDK 随附的 hermetic libc++ / libc++abi 头和 `std::__Cr` ABI，当前构建脚本要求 Clang 21.1 以上。实验工具链仅在私有工作目录与隔离镜像内，不安装到服务器系统；源码、依赖清单、哈希和失败日志保留在本地。

原生工厂 / PeerConnection 烟测及独立生成 VP8 收帧 / DataChannel 实验已通过限定检查。加入接收通道属性校验后，普通通道消费 14 帧、内容变化 13 次、往返三次；无序、零重传、零存活期通道均在 bind 前拒绝，零健康回复。只读 SDK 接口另以六种真实通道重复检查属性和清理，Linux 线程 / FD 回到预热基线；macOS 产品测试程序也通过同一 fixture。测试源、SDK 包装与二进制哈希随结果固定，试用客户端不更新。

容器使用内部网络、无发布端口、只读根目录、非 root、768 MiB / 1 CPU 上限；不访问 Relay / TURN，不采集桌面或注入输入。接收进程退出、发送管线停止，但受控关闭时仍报告 SCTP 发送错误，尚未完成无错误关闭与长期回收验证。它不含图形呈现或真实账号接线，不能作为 Linux 产品支持证据。探针容器和专用网络已退出 / 删除，Relay / TURN 的运行状态保持原值。

### 独立 GTK surface 实验

同一隔离环境已用 GTK3 / Cairo / Xvfb 显示原生 SDK 解码的固定 320×180 VP8 图案。主线程持有 widget、回调和定时器，worker 只替换一个待绘制 BGRA frame；窗口 after-paint 后读回的像素与对应帧一致。保存的 PNG 来自该探针窗口读回，仅用于验真，源代码、截图、二进制和逐文件哈希保留本地。

窗口关闭时先隐藏和清空帧槽，再异步排空媒体；带真实 PeerConnection 的取消检查确认隐藏成功、无追加 draw、窗口已析构、回调与帧槽清理。纯 surface 预热后再运行三轮正常 / 取消 / 部分初始化，FD / 线程均回到 8 / 1；无显示环境按预期失败。此阶段不走账号 / TURN，不捕获桌面或注入输入，健康回复仍为 presented=0 / receiving=false。只代表 headless X11 的独立窗口，不包含 Tauri 承载、真实 compositor、Wayland 或 DPI 验收；产品入口保持不可用，前述 SCTP 关闭错误也未消除。试用手机、Mac 与 Relay / TURN 不替换。

GTK / WebKitGTK 层级对照使用同一 headless 环境内的固定合成色块、DOM 菜单及 XTest 点击，点击仅限该次私有 Xvfb 的自有窗口。原生 widget 在上层的反例中，菜单被覆盖、视频区点击进入 native widget；透明 WebView 在上层的对照中，画面 / 菜单像素及三处 DOM 原生点击均通过。两组均无媒体权限请求，未接 SDK / 账号 / TURN，也不算 Tauri 或产品页验收；默认 sandbox=false 仅记录，未调整安全设置。截图、源文件与镜像哈希随本地结果保留。新增 Cairo / GTK 开发依赖只在探针镜像内，未安装到服务器系统；Tauri 载体构建另行验证。

2026-10-20 在服务器构建独立 Tauri 载体时，`gtk` crate 两次被内存限制终止，768 MiB / 1 GiB 均记录 `OOMKilled=true`。随后在 Mac 使用 Rust 1.96、Zig 0.15.2、固定依赖与原运行镜像的 GTK / WebKit sysroot，离线交叉编译 Linux amd64 探针；不再提高试用服务器的构建内存上限。工具、源码归档、链接元数据、二进制哈希及失败日志留在临时试验目录，不作为发布工具链。

实际 Tauri 2.11.5 载体在同一非 root、只读根目录、无网络的 768 MiB / 0.75 CPU 隔离容器通过三轮同进程检查：GtkBox 中放置 native underlay，透明 WebView 保留原生色块与 DOM 菜单；窗口像素读回和三处 trusted 点击均匹配。每轮移除原生层后，WebView 恢复原父容器、widget 弱引用失效，页面再次收到 trusted 点击后才进入下一轮；三轮清理后 FD / 线程均为 23 / 19。截图来自私有 Xvfb 的该窗口。载体没有 SDK / 视频 / 账号 / TURN，默认 sandbox=false 只记录、不修改；产品背景、全屏、真实 compositor、Wayland 与 DPI 仍待验证。探针已退出并清理容器，Relay / TURN 容器身份、启动时间与重启次数保持原值，现有手机和 Mac 试用包未更换。

### Tauri 原生视频联合探针

2026-10-20 在同一进程接入固定 `webrtc-89d790b` SDK、单槽 BGRA 缓冲和 Tauri / GTK 下层。Mac 上使用 Rust 1.96 与 Zig 0.16 的 Clang 21 编译绑定，沿用 SDK 的 hermetic libc++ / `std::__Cr`，不编译 WebRTC 引擎。交叉编译包装器明确处理 Rust target 拼写、C 源的语言选项及 C++ / C 头搜索顺序；仅用于临时探针，不改变产品构建工具链。实际运行使用已有镜像的非 root、只读根目录、768 MiB / 1 CPU 限额和独立 internal 网络，无发布端口或公网访问。

原生接收、GTK 呈现和 Tauri 承载分模块：SDK worker 只替换一个 BGRA frame，所有 widget / draw / after-paint 与回调注册均在主线程。窗口读回逐像素对照同一已绘制帧，排除固定 DOM 菜单区；PNG 来自该窗口。这一版没有持续核对菜单像素，trusted 点击只证明事件路由；持续合成验真见后续对照。正常通道消费 27 帧、解码内容变化 26 次、窗口核对 14 次且变化 13 次，三次 DC 往返、菜单 / 视频 / 标题的 trusted 点击均通过。停止先关帧入口、清缓冲并移除 UI 回调，再等 worker / PC 清理；恢复原父容器和 widget 析构后，再次通过 DOM 点击确认页面响应。主循环使用 `run_return`，随后等待 Tokio task 并结束 runtime，失败结果不会随事件循环被当成进程成功。

取消分支消费 17 帧、窗口核对 5 次，停止后新增 draw 为 0，迟到帧拒绝，worker、缓冲与 widget 清理；无序、零重传和零存活期三组均在 bind 前拒绝，零绘制、零健康回复。五组使用同一固定二进制与 sender 源码哈希，最终均通过限定检查。旧失败日志保留：先前仅在加载后设置 WebView 透明背景的载体出现整片白底与像素失败；创建时启用透明窗口、RGBA visual / app-paintable 后完成上述检查，未放宽像素比较。产品页面的祖先背景、裁剪和全屏仍需独立验证，不能直接把主窗口改透明当作完成接线。

GStreamer 关闭期间仍报告 `sctpenc0 / gst-resource-error-quark / 10`，未记为无错误退出。该唯一类别只延迟判定两秒，必须同时证明本机已关帧入口并请求关闭，或 native 确认预期的不可靠通道拒绝；随后须在发送源停止或进程终止前观测实际 CLOSED，且 native 拒绝 / 清理与退出码完全匹配。其余错误立即失败；缺少后续证据也失败。日志保留错误及关闭见证，不把这个探针的条件判断当成产品故障恢复策略。

这些检查只使用生成视频和私有 Xvfb，不包含 OpenBitFun 产品页面、真实账号 / TURN / 桌面捕获、OS 输入、物理 compositor、Wayland、DPI 或长时 / 同进程多 PC 回收。健康回复仍声明 presented=0 / receiving=false，不赋予操作权；前述无媒体载体的 FD / 线程基线不能外推到联合 SDK。源码归档、哈希、二进制和截图保留在临时试验目录；测试容器 / 网络均清理，既有 Relay / TURN、Mac 与手机试用包保持原状。

### Tauri 不透明背景与合成验真

2026-10-20 以同版 SDK / Tauri / GTK / WebKit 建立固定 840×520 载体：三层不透明祖先包含 320×180 视频区，菜单独立挂在 body 下，对应设计系统 Portal 的宿主关系。它是布局仿真，不是实际 React 产品页。原生 after-paint 同时核对解码像素、菜单、标题与画面外背景；另一进程在同一私有 Xvfb 从 root 读取屏幕，持续至少一秒核对菜单 / 标题 / 背景，再执行自有窗口的 trusted 点击。独立截图只在严格匹配 PID / XID 后读取；从未读取 Mac 桌面或发送本机输入。

失败对照保留：网页 ready 后重挂 WebView 可出现整层 DOM 不可见，菜单仍能收到点击，因此点击成功不足以证明画面正确；windowless DrawingArea、扩大父容器重绘、仅加 CSS mask、仅启动合成器均未形成可靠通过。硬件加速 `Never` 的独立诊断也未通过，没有采用为产品修复。无合成器与合成器环境分别保存结果，不能把它们合并为同一平台证据。

最终载体把原生层安装提前至 Tauri `setup`，保留 DrawingArea 自有窗口，以固定 mask 只从应用根节点裁去视频区域，body 级菜单不受影响。使用 [Debian xcompmgr 1.1.8-1](https://packages.debian.org/trixie/amd64/xcompmgr) 的独立衍生镜像，确认其取得 X11 合成器 selection、测试期间存活且结束后回收；未改宿主系统、默认硬件加速 `Always` 或 sandbox=false。每次运行仍为非 root、只读根目录、768 MiB / 1 CPU、独立 internal 网络且无发布端口。

同一二进制与发送脚本通过七组限定检查：三次独立进程启动、一次 UI 取消，以及无序 / 零重传 / 零存活期通道拒绝。三轮正常启动分别消费 39 / 48 / 44 帧，完整窗口核对 24 / 28 / 26 次，独立合成截图 14 / 15 / 15 次；首次完整核对分别等待 1454 / 1925 / 1687 ms。初次呈现以单调时间限制为四秒，期间不发布探针的 `media-ready` 回执；首次完整通过后，任何菜单、标题、背景或视频不符立即失败。截图只在首个等待或最终失败保存，避免反复编码 PNG 干扰首次绘制。所有协议健康仍为 presented=0 / receiving=false。

正常和取消检查均验证停止后新增 draw 为 0、帧槽为空、worker 排空与 widget 弱引用失效；恢复原 WebView 后另等可见像素连续三次通过，再以 trusted 点击确认响应。独立屏幕核对仅在活跃呈现阶段运行，显式拆卸后的短暂重绘由单独的四秒恢复预算验证，不能误记为播放中丢失。三个通道反例仍在 bind 前拒绝，零绘制、零健康回复。早期错误与 GStreamer 关闭报错记录保留，本轮不宣称解决其根因。

代码、逐文件 hash、SDK / 编译器来源、镜像 ID、每轮 PID / XID 与结果保存在本地临时目录，临时容器和网络已回收，Relay / TURN 的身份、启动时间及重启次数逐轮核对未变。此结果不覆盖产品 UI 的滚动、裁剪、全屏、主题、DPI、物理 compositor、Wayland、多 PC 长期回收、真实账号 / TURN、捕获或输入；尚不能开放 Linux 产品入口。窗口内 GTK owner 仍为候选方案，须先通过实际产品 viewport 检查，再接账号链路，不把固定 mask 提升成全局产品样式。

### 实际 React Viewer 布局对照

2026-10-20 的私有载体直接打包正式 React Viewer、设计系统和主题，复用纯 `DesktopVideoGeometry` 计算 contain 内容矩形；输入策略使用同一计算，平台裁剪保持独立。控制器、账号端口和 iframe 媒体桥为布局替身，账号 / TURN 端口被调用即失败；原生 SDK 独立接收生成的 480×270 VP8。没有打通正式控制器到原生接收器的协议，也没有增加产品入口。协议健康仍为 presented=0 / receiving=false。

初版前六阶段通过，菜单收到 trusted 点击但停在透明状态。随后分离绘图窗口类型与重绘来源：windowless + 50 ms WebView 重绘、自有窗口 + 同一重绘，以及自有窗口 + 新帧触发 WebView 重绘三种载体，分别通过十二阶段。阶段含适配宽屏、原始尺寸、紧凑裁剪、实际横向滚动、紧凑适配、深色主题、菜单 / 选择、全屏 / 退出、恢复宽屏 / 浅色和断开后的页面恢复；逐布局三帧严格像素核对，另有 root 截图与 trusted 点击。三组均保持一个 iframe，停止后 draw 增量为零、worker 排空、widget 析构，恢复页面像素和点击通过。这是各方案的一次限定通过，不是长期稳定性验收。

停帧反例阻止上述结果被当作完整修复：在发送管线中关闭帧闸门，确认 RTP 包数不增长、连续三次 DC 健康回执的解码计数相同，再点击菜单并等待至少 1.5 秒。新帧驱动重绘的方案此时两层菜单 opacity 均为 0；源包数与解码计数持续不变。单独 `begin_updating`、GTK widget tick 中重绘以及关闭该 Xvfb 窗口的 frame sync 三组也未通过停帧检查。固定周期重绘尚未做同样的停帧验收，不能用它替代产品修复。每组失败记录保留，未放宽像素比较或关闭产品动画。

帧同步开关只用于无窗口管理器的私有 Xvfb 对照，没有进入产品或系统配置；[GTK 文档](https://docs.gtk.org/gdk3-x11/method.X11Window.set_frame_sync_enabled.html)说明未由窗口管理器直接管理的窗口可能需要禁用帧同步，但当前反例不足以把故障归因于这一点。保留原 WebView 句柄的 GtkLayout、物理限制原生窗口范围和关闭硬件加速的早期尝试，也均未形成完整通过。

原 GtkBox、不安装原生视频层的早期对照曾观察到未初始化 SDK 时菜单正常、初始化后 opacity 约 0.29；后续同一二进制的无初始化、有 / 无 mask 复验均出现 opacity=0，因此早期差异不能证明 SDK 是根因。独立镜像补入 Openbox 3.6.1-12+b2，核对 WM selection、EWMH 自检及合成器存活后，原 React 页面仍失败。最小 GTK/WebKit 和最小 Tauri CSS 动画各两轮通过；后者包含已链接但未初始化的 SDK，不加载 React、媒体或账号。最小页面通过不代表完整 Viewer 通过，factory 组的进程退出也不证明 worker 排空。

启动前设置 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 的 React-only 对照连续两次完成菜单动画。该变量在 [WebKitGTK 2.54 源码](https://raw.githubusercontent.com/WebKit/WebKit/webkitgtk-2.54.0/Source/WebKit/UIProcess/gtk/AcceleratedBackingStore.cpp)中由一次性初始化读取，不能与页面已创建后设置硬件加速策略的旧对照等同。它仅用于隔离探针，没有写入产品启动器或宿主环境；不据此宣称真实 GPU、Wayland 或软件后端的产品支持。

完整视频载体在上述启动环境下，停帧后三次解码计数一致，菜单两层 opacity 均为 1，但独立 root 截图仍读到原生灰底而非界面背景，整体失败。windowless DrawingArea 和单层 SVG mask 对照也发生窗口像素失败；未放宽采样或把 DOM 回执当作呈现证明。移除几何同步、隐藏占位 iframe、延迟隐藏阶段动画或去掉重复内层动画的诊断也没有形成稳定验收；其中样式变体曾单轮通过，随后复验失败，没有修改产品组件。

运行对照仍使用私有 Xvfb、自有 PID / XID、非 root、只读根目录、768 MiB / 1 CPU 和无公开端口的 internal 网络；不操作用户 Mac 或手机。Openbox 只安装在独立镜像内，构建容器另限 512 MiB / 0.5 CPU，不改宿主包。八组重绘及后续十九组隔离记录逐轮核对 Relay / TURN 运行身份、启动时间及重启次数，全部探针容器和网络已回收；源码、镜像、二进制与结果仅保留本地 / 试用目录。下一步分别验证真实桌面图形后端和原生层合成；实际页面完整通过后再接正式 renderer 和账号链路，当前候选 GTK / CSS 改法不进入产品，Linux 入口保持不可用。
