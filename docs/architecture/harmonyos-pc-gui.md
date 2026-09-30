# HarmonyOS PC GUI 适配

状态：已生成并安装实验 HAP，完整功能适配仍在开发中。本文只覆盖 PC 本地 GUI；不替代
[原生 CLI/TUI 平台规约](platform-portability-design.md)，也不改变手机 Remote App。

当前工程入口是 [`src/apps/ohos`](../../src/apps/ohos/README.md)，在 DevEco Studio 中打开该目录。
它加载当前 `src/apps/desktop` 的 `libopenbitfun_desktop_lib.so`，使用当前 Desktop 的
`com.openbitfun.desktop` 标识；不会覆盖旧 PC 应用安装。
旧包数据迁移仍待实现，不能把新包独立安装当作原位升级验证。

当前新增的宿主代码已通过 ArkTS 编译。Desktop 的 OHOS 原生入口也通过独立编译检查，
会在 ArkWeb 初始化前注册新版 `openbitfun-ui` 协议。ArkTS `NativeAbility` 和原生框架均固定于
`openharmony-ability` 的 `295a276a699ba2352addc69b8cacb6acd3be6ab1`，通过初始化上下文传递
应用目录和资源管理器。旧版 `RustAbility` 不能直接替代这份桥接。

框架补丁现保存于 `scripts/ohos/patches`；`node scripts/ohos/prepare-framework.mjs` 可按固定
基线重新准备隔离依赖，生成 `target/ohos-framework/cargo.toml`。源码缓存位于用户的
`.cache/openbitfun/ohos-framework`，避免嵌套 Cargo workspace 误继承产品依赖；可通过
`OPENBITFUN_OHOS_FRAMEWORK_DIR` 指定仓库外的缓存目录。该配置同时包含 log、fs 和 opener 的
固定版本补丁。编译通过不代表这些框架方法都已实现或通过真机验证。

针对该隔离依赖树的每一条 Cargo 命令都必须带上 `--config target/ohos-framework/cargo.toml`。
不带该配置执行 `cargo update` 或 `cargo check` 会按产品依赖重新解析 `Cargo.lock`，
把 `wry`、`tauri-plugin-fs` 等抬到补丁源之外的版本，整组 `[patch.crates-io]` 随之静默失效
（锁文件中出现 `[[patch.unused]]`），OHOS 编译退回未打补丁的 registry 实现并报缺失符号。
出现这种情况时应恢复与补丁源版本逐一吻合的锁文件，而不是修改补丁。

## 目标与依据

目标是在 HarmonyOS PC 本机运行当前 OpenBitFun 的 React 工作台、Rust Agent、工作区和工具，
以 PC 应用安装、启动和升级。已有移动端 Remote App、开发机代执行及 `hdc shell` 探针不构成此目标的验收。

2026-09-14 的代码比较基线：

- OpenBitFun：`833973d79`，产品版本 `1.0.0-beta`。
- GitCode 的 OpenHarmonyPCDeveloper 旧版 PC 适配仓库：
  `77d26f3329ac46f7b021b277e907df07e117f185`；PC HAP 元数据为 `1.0.7`。
- 旧适配使用 ArkTS `EntryAbility`、`@ohos-rs/ability`、NAPI 与 Tauri/Wry OHOS 分支，
  将旧版 Desktop 动态库装入 HAP。它是本地 GUI 的参考实现。
- 旧适配的 Tauri 锁定于 `richerfu/tauri` 的
  `c818cc1de4eae70a14273cf8a4f81283987a42b7`（2.8.5）。当前产品依赖 Tauri 2.11，
  并使用上游 `7cc68e74ff6981f5c50a52a67d56c5eb2d227188` 的 Runtime 修复。
  不能用旧 fork 全量替换当前平台依赖。

## 迁移边界

| 范围 | 旧适配 | 当前迁移要求 |
|---|---|---|
| 窗口和 WebView | OHOS Tauri/Tao/Wry fork | 将 OHOS 后端迁到当前框架基线，保留其他平台的修复；固定可复现 revision 并验证 ABI |
| Rust/ArkTS 通信 | `core::util::register_arkts_function` 全局注册 | NAPI、ArkTS 回调、窗口生命周期放在 Desktop host；服务通过所属 port 获取平台能力，不把 NAPI 放回 Assembly |
| 前端资源 | `resfile/dist` 和旧 Tauri `frontendDist` | 当前入口是 `bootstrap-ui`、独立 `frontend/dist` 与 `openbitfun-ui://` 协议；验证动态 import、重载、资源路径和 Creation 工作台 |
| 凭据 | AssetStoreKit 及旧 `SecureCredentialVault` | 当前 credential owner 已变化；按消费者接入，保留旧 alias/数据可读性，不用空凭据表示读取失败 |
| 文件选择、分享、窗口控制 | ArkTS bridge 与新增 `_ohos` 命令 | 对接当前 typed adapter 和 Product Operation Registry；ControllerLocal 操作留在控制机，远程文件操作使用目标机路径 |
| 语音、截图、浏览器 | ArkTS 语音/截图、ArkWeb 平台实现 | 按当前 service/host owner 迁移；能力不可用时明确报告，不返回伪造结果 |
| Page Functions | OHOS 禁用 rquickjs | 使用目标 SDK 生成绑定，验证执行、Promise、超时中断及真实目标链接后再确认运行支持 |
| 终端、Git、网络、扩展 | OHOS shell/PTY 和运行环境适配 | 重验 shell、子进程、取消、Git/TLS、Node/Bun/MCP 和文件监听；不把 OHOS 的 Linux cfg 当成桌面 Linux 支持 |
| 安装升级 | 旧 bundle id、证书和权限 | 分别验证新装与原位升级；保留用户数据，签名身份和受限权限须与目标设备及发行渠道匹配 |

不能直接复制旧版的更新 URL、遥测授权、账户服务、业务提示词或用户数据路径。
旧工程声明 `CUSTOM_SANDBOX`、`ALLOW_EXTERNAL_NATIVE_CODE` 等权限，这些声明本身不能证明
新签名配置或目标设备允许对应能力。开发 HAP 与面向用户的发行须分别验证。

## 当前可重复执行的代码验证

[Rust 官方 OHOS 工具链说明](https://doc.rust-lang.org/rustc/platform-support/openharmony.html)
要求 SDK Clang、目标 sysroot 和 Rust target。仓库的开发入口只配置本次 Cargo 子进程，
不改用户的全局 Cargo 配置，不隐式安装 SDK，也不运行交叉编译的测试程序：

```bash
rustup target add aarch64-unknown-linux-ohos
# macOS 默认使用 DevEco Studio 内置 SDK；Linux/WSL 设置对应主机 SDK 的 native 路径。
export OPENBITFUN_OHOS_NDK=/path/to/sdk/native
node scripts/ohos-cargo.mjs check --locked -p terminal-core
node scripts/ohos-cargo.mjs check --locked -p openbitfun-page-function-runtime
node scripts/ohos-cargo.mjs test --locked -p openbitfun-page-function-runtime --no-run
node --test scripts/ohos-cargo.test.mjs
```

2026-09-14 在 macOS、Rust 1.96.0、DevEco OHOS native SDK 26.0.0.23 上：

- `terminal-core` OHOS `cargo check` 通过。
- Page Function Runtime 首次失败于缺少 `rquickjs-sys` 的 OHOS 预生成绑定；仅在 OHOS target
  启用 `rquickjs/bindgen` 后，`check` 和测试程序的交叉链接均通过。其他 target 不启用该新增 feature。
- Page Function Runtime 的 5 个现有测试在 macOS 上通过，包括 KV、Promise 和两种无限循环中断。
- `openbitfun-core --no-default-features --features agent-runtime,git` 的 OHOS 编译检查通过。
  单独 `agent-runtime` 的探针遇到 Worktree 工具未选择 `git` 的 feature 组合问题，不能归因于 OHOS。
- 临时移植的 Tauri 2.11.5 / Tao 0.36.0 / Wry 0.56.0 已通过最小宿主的 OHOS 检查和
  AArch64 动态库链接，也通过同一最小宿主的 macOS 检查。该探针只构造框架对象，未启动应用。
  框架补丁尚未接入产品：旧后端的部分窗口和 WebView API 仍需真实实现及能力核对；
  新版历史导航 API 暂以明确 unsupported 返回，单 Ability 后端不宣称多窗口支持。
- 上述底层检查本身不构成真机验证；后续实验包启动结果单列于下文，远程验证仍未进行。

### 完整宿主的编译诊断

在独立集成工作树中，以本页框架基线覆盖依赖进行 Desktop OHOS 检查，避免改变正常平台的
产品依赖。已排除桌面 Linux 的 GTK、AT-SPI、OCR 依赖，并定位了以下插件差异：

- `tauri-plugin-opener` 2.5.4 自己的 build script 未识别 OHOS，与框架产生相互矛盾的
  desktop/mobile cfg，导致重复方法和缺失句柄。实验补丁消除冲突；后续 HTTP(S) 浏览器桥接
  见“账户与状态栏适配”。打开本地文件仍未实现。
- `tauri-plugin-fs` 2.5.1 未选择 OHOS 实现入口。实验补丁选择标准文件系统实现，仍须由
  Tauri ACL 和系统沙箱控制访问。真机文件授权及 URI 转换已于 2026-09-16 验证，
  见“沙箱外工作区访问专题”。
- WebDriver 的原生窗口操作不能直接调用移动宿主缺失的方法。实验补丁返回协议的
  unsupported operation，并取消 `setWindowRect` 能力声明；窗口几何不可用时不伪造尺寸。

当前工作目录及隔离集成树均已通过完整 Desktop 的 OHOS `cargo check`；当前 Rust 代码的 ARM64 动态库已实际链接成功。
当前源码已接入以下平台边界：

- Ability 在原生产品线程启动前提供私有数据目录、打包资源目录和初始系统主题。
- 最小化、最大化切换、显示和状态读取通过 NAPI 调用系统 Window API；Rust 等待 ArkTS Promise
  完成，传播异常和超时。尚未完成真机行为验证，也未覆盖前端所有旧窗口调用入口。
- 自动启动、系统通知、旧桌面更新器、计算机操作、截图、通用辅助 WebView、
  前端替换确认窗口及本地 Sherpa 语音识别暂不可用，对应调用明确返回错误。
  这不是完整功能对齐，需继续接入原生实现和前端能力展示。
- 桌面宠物已接入独立 TYPE_FLOAT 容器和现有宠物页面，完整交互验收仍待真机；详见文末。
- 前端替换在复制资源和修改事务前拒绝；鸿蒙窗口几何读取尚未实现，因此不覆盖既有窗口状态文件。
- PC 使用独立 Tauri capability 文件；其他平台继续使用现有权限配置。没有给尚未实现的
  原生窗口插件调用开放权限。远程命令注册与既有持久化 DTO 保持原契约。

macOS 上窗口状态的 14 个现有测试、系统接口的 7 个测试和更新缓存的 6 个测试通过；
这些结果只用于已有平台回归，不构成鸿蒙运行或远程场景验证。

在当前仓库中准备依赖并检查完整宿主：

```bash
node scripts/ohos/prepare-framework.mjs
node scripts/ohos-cargo.mjs check --config target/ohos-framework/cargo.toml -p openbitfun-desktop --lib
```

隔离框架覆盖会改变 Cargo 的锁文件解析；提交前应恢复正常产品依赖的锁文件解析，
不能将临时路径依赖作为其他平台的默认交付依赖。

## 实验包真机启动

2026-09-14 已通过 DevEco 自动签名并用 HDC 安装 `com.openbitfun.desktop`，版本 `1.0.0-beta`。
签名配置仅保留于本机忽略文件，公开 build profile 不含证书密码。

真机迭代修复了三个启动问题：宿主没有声明可加载的页面路由；ArkUI 回调触发 Rust setup 时缺少
Tokio 当前运行时上下文；ArkWeb 默认关闭 DOM storage，使前端 localStorage 初始化失败。
修复后的应用日志报告界面可交互、核心系统初始化完成和 Monaco 初始化成功。
此结果不代表所有工具均可用。当时发现的 Linux secret-service 凭据路径、终端脚本目录和
托盘问题已继续适配，后续进展见下文；辅助窗口及其他桌面集成仍有缺口。
未验证模型请求、完整工具回合、外部工作区访问、旧版数据迁移或四类远程场景。

## 后续调试与验收顺序

真机连接检查（2026-09-14）：HDC USB 已授权并显示 Connected。目标报告
`OpenHarmony-6.0.2.130`、`2in1`、`aarch64`，内核为 HongMeng Kernel 1.11.0。
Page Function 测试 ELF 已传输到独立调试目录，但执行时返回 `Permission denied`，即使文件已有
执行位；测试尚未运行，拒绝执行的具体原因仍需核对，不能把交叉链接通过算作真机测试通过。
下一步需验证该系统支持的签名和应用调试部署路径。此探针只用于底层诊断，不代表 PC 系统终端、
HAP 沙箱或远程场景已经可用。

1. 框架：以当前 Tauri/Tao/Wry 为基线移植 OHOS 后端，先编译最小宿主；检查新增平台分支不改变
   Windows/macOS/Linux 的依赖与行为。开发补丁通过后才接入产品构建。
2. 宿主：接回 ArkTS Ability、NAPI 生命周期、前端协议和必要平台 provider，构建当前版本 Rust 动态库及 HAP。
3. 本地流程：真机验证启动、模型请求、流式事件、工作区读写、shell/PTY、权限应答、取消、退出重启和数据恢复。
4. 远程：分别验证 Remote Workspace、Remote Control、Peer Device Mode 和 Detached Dispatch；
   未验证的场景保持未验证，不用本机测试推导支持。
5. 交付：验证签名、依赖资源、安装和升级数据兼容；以可下载且在目标机运行过的包作为交付证据。

框架编译、Rust 动态库、HAP 打包、签名安装和产品运行是不同状态，不能以任一前置步骤成功宣称适配完成。

## HAP 内嵌终端专题（2026-09-15）

本专题只适配当前 GUI 的本地终端，不声明系统终端中的原生 CLI/TUI 已交付。
当前验证顺序：修正终端脚本到产品 PathManager 的应用私有 temp 目录；由 Ability 提供的
resourceDir 注册已打包 mobile-web；在已签名产品进程内测试既有 terminal-core 的 PTY 创建、
输入输出、窗口 resize 和退出。HDC shell 的执行权限不作为应用进程权限的替代证据。

诊断仅在 debug 构建中、由开发者显式传入 Ability 启动参数后运行固定命令；不用探针输出替代
用户终端验收。若系统拒绝 PTY/exec，保留明确失败及系统错误，核对官方 PC 权限和签名要求，
不通过开发机或远程 shell 代执行。普通桌面和远程工作区的路径与执行策略保持不变。

官方资料与当前设备边界：

- [IDE 插件二进制权限与签名 FAQ](https://developer.huawei.com/consumer/cn/doc/doccenter-dev-faq/faqs-access-control-23)
  说明外部二进制需要签名，IDE 弱沙箱及用户开启外部扩展是该场景的前提。它不等价于
  所有本地系统 shell 都需要同一权限，也不能据此直接授予广泛文件访问。
- [2026 年 8 月官方月刊](https://developer.huawei.com/consumer/cn/monthly/202608)
  链接了 [PC HAP 集成 bin 指南](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/hap-bin)。
  已读取正文：API 24 起支持 HAP 内集成 ELF；二进制置于 `libs/arm64-v8a`，通过
  `executableBinaryPaths` 声明，并启用 `extractNativeLibs` 和 `nativeLib.collectAllLibs`。
  此方案作为新系统的可选路径；用户要求兼容旧版，不把 API 24 升级设为终端的统一前置条件。
- 真机 `const.ohos.apiversion=22`。本机 SDK 的 permissions.d.ts 标注
  `ALLOW_EXTERNAL_NATIVE_CODE` 从 API 23 提供，因此未复制旧项目此权限；当前包仍只声明网络权限。
- 应用进程可创建既有 terminal-core 的 PTY，收到回显及 resize 确认。但 zsh 的动态加载器报告
  缺少 `libncursesw.so.6`、`libtinfo.so.6`；`spawn` 返回 PID 并不等于 shell 可运行。
  `/system/bin/sh` 仅用于诊断；当前默认 zsh 的预检会明确报告加载失败，
  最终目标是按官方 API 24 方案打包 zsh，尚未完成该方案的真机验收。
  系统 shell 与第三方下载的开发工具是不同执行来源，前者成功不能证明后者可执行。


## 沙箱外工作区访问专题（2026-09-16）

鸿蒙把应用限制在自身沙箱内。授权前 `/storage/Users/currentUser` 及其 `Documents`、`Desktop`、
`Download` 一律返回 permission denied；`hdc shell` 访问同样被拒，说明这是系统层面的用户目录
隔离，不是应用特有限制。产品要打开沙箱外的项目目录，只能由用户经系统选择器逐个授权。

当前实现：`picker.DocumentViewPicker.select()` 以 `DocumentSelectMode.FOLDER` 取得目录 URI，
`fileShare.persistPermission` 持久化该授权，`fileShare.activatePermission` 在每个进程中重新激活。
持久化授权在激活前是不可用的，跳过激活会得到 13900001。因此产品在运行间隔中保存的是 URI
而不是路径，路径由 `fileUri.FileUri(uri).path` 在激活后导出。ArkTS 侧见
`src/apps/ohos/entry/src/main/ets/WorkspaceAccess.ets`，Rust 侧桥接见
`src/apps/desktop/src/ohos/workspace_access.rs`，清单声明 `ohos.permission.FILE_ACCESS_PERSIST`。
两个 syscap（`SystemCapability.FileManagement.AppFileService.FolderAuthorization` 与
`SystemCapability.FileManagement.UserFileService.FolderSelection`）在使用前逐一 `canIUse`，
后者是 2in1 专有能力。

不走受限权限路线：`READ_WRITE_DOCUMENTS_DIRECTORY` 一类需要 AGC 邮件申请、ACL 批准以及签名
profile 的 `allowed-acls`，且一次授予整类目录。用户逐目录授权与产品既有的工作区语义一致，
也不要求用户为打开一个项目而放开整个文档目录。

2026-09-16 真机结果（HPR-W72，API 24，OpenHarmony 6.1.0.135，debug 签名包）：

- 两个 syscap 均报告可用；`FILE_ACCESS_PERSIST` 通过安装校验。
- 授权前四个用户目录全部 permission denied，授权后该基线不变，说明授权精确作用于所选目录，
  没有放开沙箱。
- 授权目录导出为普通 POSIX 路径 `/storage/Users/currentUser/Documents/<目录名>`，
  `read_dir`、写入、读回、同目录 `rename` 均成功。`rename` 是编辑器与 git 都依赖的操作。
- 子进程继承该授权：`/system/bin/sh` 子进程在授权目录内 `cd`、`ls`、写文件、读回均成功，
  退出码 0；从无关 cwd 列该目录同样成功。Agent 的 shell 与外部工具因此可以在授权目录中工作。
- 授权在应用重启后仍然有效：重新激活记住的 URI 即可恢复访问，不再弹出选择器，
  且能读到上一次运行创建的文件。

尚未验证：授权目录中的文件监听（inotify）行为、git 的完整操作、多目录同时授权、
用户在系统侧撤销授权后的产品表现、符号链接与大目录遍历性能。

产品接线（2026-09-16）：前端选目录的唯一入口是
`src/web-ui/src/infrastructure/peer-device/pickWorkspaceDirectory.ts` 调用的
`open({ directory: true })`，打开项目、新建项目、欢迎页和工作区路径设置共 5 处都经过它。
鸿蒙以 `src/apps/desktop/src/ohos/dialog.rs` 就地实现同名 `dialog` 插件顶掉无鸿蒙实现的
`tauri-plugin-dialog`，沿用既有 `ohos/opener.rs` 的替身写法：返回值仍是 `string | string[] | null`，
取消仍返回 null 而不是错误，因此前端和 `open_workspace(path)` 都不必改动。
插件命令由 `build.rs` 的 `InlinedPlugin` 生成 `dialog:allow-open`，在
`ohos-capabilities/main.json` 声明。

授权目录的记录与恢复分属两侧：`src/apps/desktop/src/ohos/workspace_grants.rs` 在每次授权后把
URI 追加进 `harmony-workspace-grants.json`（临时文件加 rename 原子替换，只存 URI 不存路径）；
`WorkspaceAccess.activateRemembered()` 在 `EntryAbility.onCreate` 里、`super.onCreate` 之前读取该
文件并重新激活全部授权。必须放在 ArkTS 启动路径上：Tauri 的 `setup` 运行在 ArkUI 主线程且已经
处于 `block_in_place`，在那里等待 ArkTS Promise 会死锁；而子进程只继承父进程当时已持有的授权，
晚于产品运行时启动就来不及了。

2026-09-16 的产品路径真机结果：

- 菜单“打开项目”弹出系统选择器（提示“安全访问文件 / 仅可访问所选项目”），选定后授权文件
  写入 URI，所选目录作为项目出现在会话列表。
- “新建项目”对话框的父目录预填授权目录，在其中创建的新项目成为当前工作区，位置在沙箱外。
- 完全退出并重启应用后，无需再次选择，`activate_remembered` 日志报告授权已恢复，
  两个沙箱外项目仍在会话列表中。
- 仅由 ArkTS 启动恢复、Rust 侧从未激活过的授权也能被子进程使用：同一次运行的基线里
  `/storage/Users/currentUser` 与 `Desktop`、`Download` 仍是 permission denied，而
  `Documents` 可列目录；`/system/bin/sh` 子进程在 `Documents` 及其中的项目目录内
  `cd`、`ls -la`、写文件、读回、删除全部成功，退出码 0。Agent 的 bash 工具走的就是这条链路。

边界要说清楚：能到达的是“用户授权过的每一个目录”，不是任意路径。未授权目录仍然拒绝，
系统选择器有时会把授权范围放大到所选目录的父目录（本次选子目录得到的是整个 `Documents`），
授权会一直累积，只能由用户在系统设置中撤销。

### 进程 HOME（2026-09-16）

系统给应用进程的 `HOME` 是 `/storage/Users/currentUser`，即设备用户目录：在沙箱之外，且
选择器根本选不到它（只能选 Documents 这类公共目录）。因此所有 `~/...` 一律 EPERM，
`dirs::home_dir()` 之上的一切随之失效——产品日志里表现为 Skill 监听器每分钟数次
`Failed to watch Skill source root /storage/Users/currentUser: Permission denied`，
git、ssh、node 同样读不到任何配置。

`configure_data_directory` 现在把 `HOME` 指向应用私有存储下的 `<filesDir>/home` 并按需创建。
选独立子目录而不是 `filesDir` 本身，是为了让第三方工具的点文件与产品自身的 `config/`、
`projects/` 分开，两边的清理和迁移互不牵连。`OPENBITFUN_HOME` 保持为 `filesDir` 不变，
`path_manager` 的 `product_home_override` 先于 `dirs::home_dir()` 生效，产品数据位置不受影响。
终端只读取 `HOME` 不覆盖，子进程继承同一个值。

代价是 `~/Documents` 不再指向设备用户的文档目录。这个取舍是划算的：原先的 `~` 连
`ls` 都是 EPERM，对任何 unix 工具都是坏的，而工作区路径本来就以绝对路径传递。

真机结果（同一次启动的调试探针）：`process home=/data/storage/el2/base/haps/entry/files/home
readable=true`，`child process home=<同一路径> inherited=true`；Skill 监听器告警归零；
授权目录在子进程中的可达性不变（`Documents` 与其中的项目目录 `status=Some(0) inherited=true`）。

附带澄清：此前 agent 报告的“`find` 行为不正常、像是 alias”并非产品问题。日志中 `find` 对
授权目录返回了正确结果，那一次的空输出来自一个空目录。

诊断只在 debug 构建中、由 Ability 启动参数 `openbitfun.workspaceAccessDiagnostic` 显式触发，
不用探针输出替代产品路径的验收。


## 系统窗口装饰

鸿蒙 PC 保留系统默认标题栏和最小化、最大化/还原、关闭三键区。当前 Desktop 在前端启动前
注入本地 `nativeWindowControls: false` 能力；启动页不显示自绘按钮，工作台不注册 Tauri
窗口控制及拖动行为，由系统标题栏承担这些交互。业务导航和场景标签保留。
该能力属于控制端，不随 Peer Device 的执行端切换；旧宿主未提供字段时保持原有行为。
参考[官方自由窗口沉浸式说明](https://developer.huawei.com/consumer/cn/doc/best-practices/bpta-multi-device-window-immersive)。
此处保留默认非沉浸布局，不隐藏系统标题栏或让网页覆盖系统三键区。


### API 22 兼容性调查边界

旧版优先核验应用内调用系统 shell：现有签名 HAP 已收到 PTY 创建、回显及 resize 事件，
但这不是命令已执行成功的证据。系统 zsh 的阻断点为 ncurses/tinfo 依赖加载；需进一步验证
依赖的合法打包及应用进程加载方式。系统 sh 可作为基础交互候选，尚未完成应用内验收；
现有 `ShellType::Sh` 不支持 shell integration，因此不能以交互成功宣称 Agent 命令完成、
退出码和取消语义已经支持。Git、Node 等外部工具也需独立验证。

[受限权限官方说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/restricted-permissions)
中 `kernel.LOAD_INDEPENDENT_LIBRARY` 从 API 22 对普通应用开放，但限定生态开发工具场景，
作用是加载二进制证书签名共享库，并非任意执行程序或获得全盘权限的通用许可。
旧适配清单中的 `CUSTOM_SANDBOX` 当前文档限定华为内部开发工具，不能作为普通应用普适方案。
当前最低 SDK 保持原值，API 22 兼容性尚待实际产品进程测试，不要求用户降级已经更新的系统。


主 ArkWeb 禁用手势缩放（`zoomAccess(false)`）与根页面过滚动回弹
（`overScrollMode(OverScrollMode.NEVER)`）；不拦截所有触摸或滚动事件，页面内部滚动容器
继续工作。该设置局限于 PC 主 WebView，不修改手机端或嵌入网页。

2026-09-15 真机升级后报告 API 24，仍以最低 API 21 的兼容包验证，未启用 API 24 bin 打包：
应用内系统 sh 完成固定命令输出、PTY resize、退出码 0；产品 sh 会话输出及历史回放通过。
这是 API 24 实测，不能作为 API 22 执行成功证据。默认优先探测系统 zsh，不可用时记录原因并
选择实际报告为 Sh 的基础终端。无 shell integration 的会话在结构化命令执行前明确拒绝，
防止 Agent 发出无法观察完成的命令后无限等待；交互输入仍可使用。


鸿蒙 shell 发现包含 `/system/bin`，并通过固定的 `-c printf` 执行探测决定可用性；
不把版本参数失败等同于不可用，也不把二进制存在等同于可执行。元数据不可见时仍可进行
该有超时的探测，缓存短期过期，避免永久缓存无法观察文件变化的结果。设置与终端会话
共用发现结果及稳定 shell ID；其他系统沿用原有发现与版本探测策略。


## 账户与状态栏适配

GitHub 身份的授权协议保持不变。OHOS 凭据后端使用 API 11 起的 Asset Store C API，
以应用隔离别名存储原有 JSON，首次解锁后可访问；更新使用原子覆盖，不做删除再写入，
读取失败保留资产并返回具体错误码。当前单条 JSON 受官方 1024 字节限制，超长时明确失败。
授权链接通过本地 opener 插件转到 UIAbilityContext.openLink；只接受 HTTP(S)，不记录链接。
尚需真实账户授权确认保存、刷新与重启恢复，不能以凭据库读取成功替代登录验收。

PC 状态栏采用 `@kit.DesktopExtensionKit`，对应[官方应用接入状态栏指南](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/statusbar-extension-guide)。
菜单和快捷面板恢复本应用 EntryAbility，初始化等待系统回调后才返回成功，未读数通过悬停
提示更新。状态栏随应用进程退出而消失，不代表获得无限后台保活能力。关闭到托盘仍是独立
生命周期能力，在完成验证前继续明确不支持。状态栏扩展只显示恢复窗口入口，不接收凭据。

mobile-web 的生产连接流程要求先完成共享 GitHub 账户身份，不能为了验证静态资源绕过登录。
资源打包与加载已验证；完整配对、WebSocket 重连及远端控制应在账户授权后分别验证。

OHOS 的 LAN 地址枚举使用 API 11 起的 NetworkKit C API：`OH_NetConn_GetAllNets` 与
`OH_NetConn_GetConnectionProperties`，避免沙箱中失败的 Linux netlink 路径。需要已声明的
GET_NETWORK_INFO 权限。保持接口名称/IP 结构、地址排序与 relay URL 不变，SDK 错误码明确上报。

2026-09-15 的 API 24 真机验证：凭据库空记录读取成功；NetworkKit 枚举到 1 个接口；
状态栏注册回调成功，图标和快捷面板实际显示，通过面板按钮恢复已最小化的主窗口。
同包 sh 的输出、PTY 尺寸调整、退出码和产品会话历史回放均通过。尚未进行账户授权后的
保存/刷新/重启恢复、mobile-web 配对/重连，以及 API 22 运行和四类远程场景验证。

## 桌面宠物窗口边界

2026-09-15 在 API 24 真机安装了独立 UIAbility 的原生窗口探针，动画、隐藏标题栏三键、
跨应用置顶和工作台最小化后保留窗口均已观察到。整窗禁用输入后 Close 不响应，10 秒恢复
输入后可关闭；未验证点击是否落到指定下层控件，也未验证透明像素级命中。

透明度对照结果：设置透明内容背景及 `setWindowContainerColor('#00000000', '#FF000000')`
时，窗口焦点态透明，失焦态为黑底；完全移除容器颜色设置后，焦点态和失焦态均出现系统
灰白容器。因此，移除人为黑底不能解决透明桌宠的要求。预览 GIF 自身的白底与容器背景是
两个问题，修改素材不能解决窗口容器限制。

[官方 Window 文档](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-window-window)
规定 API 20 `setWindowContainerColor` 的非焦点态 Alpha 固定为 FF；`setWindowMask` 仅限
子窗口和全局悬浮窗，不能用于该主窗口。API 26 的 `setWindowContainerModalColor` 还需要
SET_WINDOW_ALPHA 权限，不能作为当前 API 22/24 的兼容实现。全局悬浮窗权限的适用场景须
遵循[受限权限说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/restricted-permissions)，
不得把桌宠伪装成会议或录屏应用申请。

框架另有独立阻断点：当前固定版本 Tao OHOS 的 `WindowId` 是单位结构，转成 u64 恒为 0，
`Window::new` 忽略窗口属性。直接解除 `appearance.rs` 的 OHOS 拒绝分支并调用第二个
`WebviewWindowBuilder` 会共享原生窗口身份，不能据此接入正式宠物。后续窗口适配需要独立
原生窗口身份、ArkWeb 生命周期和定向事件/操作路由，继续复用产品现有设置、角色及任务协议。
窗口操作保持 ControllerLocal，不能转发到 Peer 执行端。当前探针没有验证四类远程场景，
不作为生产宠物支持或完整适配的依据。

官方文档复查（2026-09-15）：`TYPE_FLOAT` 技术上具备跨应用置顶、后台继续显示及透明/
异形窗口能力，但 SYSTEM_FLOAT_WINDOW 当前受限场景仅包含 PC 多人视频通话和屏幕共享；
尚无桌宠场景可获批的官方依据。`SET_WINDOW_ALPHA` 已在受限权限清单明确列出，从 API 26
起仅向虚拟机应用开放，因此升级系统本身不能证明普通桌宠可使用新透明度接口。
[子窗口开发指导](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/subwindow-guide)
新增的独立子窗 `zLevelAboveParentLoosened` 从 API 26 起支持，不跟随主窗切换前后台，但
文档未据此承诺跨应用置顶，也不覆盖 API 22/24。
结论限定为“尚未找到官方支持的普通应用完整透明桌宠方案”，不泛化为鸿蒙在技术上无法实现。

随后 API 24 真机验证 `TYPE_FLOAT`：未声明权限的测试包在 `createWindow` 返回 201；临时
声明 SYSTEM_FLOAT_WINDOW 的测试包构建和签名成功，但安装返回 9568289，明确报告该权限
授权失败。测试后撤回受限权限声明，恢复可安装签名包并重新启动工作台。此结果只证明现有
开发签名没有该权限，不能推断已获官方授权的包也无法创建悬浮窗；尚未验证 TYPE_FLOAT 的
实际透明显示、拖动或后台交互。

调试签名更正：按照[自动签名文档](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto)
在 DevEco 中重新执行未关联注册应用的自动签名，确认 ACL 提示后，新生成 Profile 的
`acls.allowed-acls` 已包含 SYSTEM_FLOAT_WINDOW，有效期 14 天。此前 9568289 只能证明
旧 Profile 未授予权限，不能证明调试授权不可申请。当前 manifest 保留该权限以继续调试；
发布仍需另外审核，不把调试证书当作桌宠发布场景已获批。新证书构建签名成功时真机已离线，
后续设备验证须明确区分模拟器与真机。

真机重新接入后的结果：带新 Profile 的包在 API 24 PC 安装成功，TYPE_FLOAT 创建和显示
成功（320×300），所属探针主窗口最小化后继续显示；切换文件管理应用后保持置顶和透明
内容区域，无主窗口方案的失焦黑底。故透明桌宠的调试技术路线已成立；此前“没有普通应用
完整方案”的结论应限定为发布授权尚未确认，不能作为阻止开发验证的依据。正式宠物开关、
角色渲染、任务协议集成、透明区域命中及远程场景仍需单独实现和验收。

正式接入采用 ControllerLocal 的独立 WebView（`agent-companion-pet`）加 ArkTS TYPE_FLOAT
容器，复用既有宠物页面、角色资源、设置和任务事件，不启动第二个 Tauri 主窗口。
当前 Tao OHOS 窗口标识不区分多个原生窗口，直接新建 WebviewWindow 会混淆主工作台；
因此只扩展框架的子 WebView 创建/关闭入口，原生悬浮窗的尺寸、位置和生命周期由
`CompanionWindow` 管理。窗口操作插件按 WebView 标签授权，主窗口不能借此操作宠物。
前端窗口适配器将隐藏、聚焦和指针拖动路由到该容器；鸿蒙不调用不支持的全局光标轮询。
关闭开关销毁子页面及原生窗口，Ability 退出时同样清理。诊断 Ability、页面和 GIF 已移除。

集成包已通过前端类型检查、10 项窗口适配相关测试、7 项宿主检查、Rust 编译及 HAP 签名。
检查最终 HAP：只有 EntryAbility，没有探针页面/动画资源。构建过程中真机断开，尚未安装
该集成包；角色渲染、拖动、开关重开及任务气泡交互不能视为已通过真机验证。四类远程场景
均未执行验证；选择性透明区域点击穿透和窗口外光标跟随仍未接入。

真机后续验收（2026-09-15）：集成包已安装到 API 24 PC。修复了隐藏窗口尚未触发页面初始化
就创建子 WebView 的时序错误：先显示透明原生容器，再等待页面生命周期就绪。另将主窗口
从最小化恢复改为 restore()，showWindow() 本身不能完成该操作。
已验证猫咪动画及透明背景、主窗口最小化后继续显示、注入触控拖动产生位移、长按菜单、
切换为 OpenBitFun 角色并切回猫咪、菜单关闭、设置开关在同一进程内关闭后重开，以及从
宠物菜单恢复最小化的工作台并打开宠物设置。未验证鼠标拖动精度、真实任务气泡及远程场景。
原有 app.keybindings 缺失、自动启动和主窗口可见性权限日志仍存在，不属于本次宠物修复。

拖动比例修复（2026-09-15）：真机 ArkWeb 触控 PointerEvent 的 screenX/screenY 等于窗口内
clientX/clientY，不能当作屏幕坐标。旧实现随着窗口移动扣掉自身位移，导致跟随距离约减半。
鸿蒙专用前端适配器改用 window.screenX + clientX、window.screenY + clientY，保持 CSS
逻辑像素契约；按下、移动和松手使用同一转换，其他平台保持原路径。
安装修复包后的触控注入结果：目标 (+500,+200) 像素，实测 (+500,+200)；反向目标
(-500,+200)，实测 (-501,+200)；快速拖动目标 (+500,-200)，实测 (+500,-200)。
9 项坐标/拖动测试、类型检查、7 项宿主测试及 HAP 构建通过。本次仅验证本地 API 24 PC，
不作为远程场景和真实鼠标硬件手感的证据。

### 桌宠大小交互（2026-09-15）

桌宠浮窗增加独立的 0.75–2 倍图像缩放；双指接管手势时取消单指拖拽，直到所有触点抬起才允许再次拖动或单击。图像与命中区域同时缩放，原生窗口的尺寸请求合并为一个在途请求与最新待处理值，避免快速捏合积压历史尺寸。菜单在最小尺寸下临时扩展窗口，提供放大、缩小及恢复默认大小。

缩放偏好由前端基础设施以 `openbitfun.companion.window-scale.v1` 保存于本机 WebView 存储，属于控制端窗口展示状态；旧安装无记录时使用 1 倍，异常值容错读取且不删除原数据。该设置不进入远端产品配置或改变主工作台 WebView 的 zoomAccess 策略。

真机 API 24 调试触控注入验证：原始约 96×104 CSS 像素、2 倍约 192×208、0.75 倍约 72×78；继续捏合不会突破下界。原生浮窗随之调整尺寸，长按菜单可用，重建窗口保持保存的大小。缩放后拖拽的本轮自动测试遇到同时发生的额外触点，不能作为单指跟随精度证据；此前拖拽坐标修复的独立测试结果仍保留。远程场景未在本轮执行。

### 桌宠靠近折痕转移（2026-09-15）

采用应用自己的边缘转移行为，不依赖系统甩屏资格。前端基础设施为每次受控拖拽生成独立 dragId，经现有 companion move 操作传递；ArkTS 宿主读取半折叠状态、实际 creaseRects、存活显示设备及 convertRelativeToGlobalCoordinate，识别紧邻折痕下缘的目标屏。CompanionFoldTransfer.ts 使用物理坐标判断朝折痕运动、48vp 接近距离、24vp 落点间距和窗口大小边界。转移调用 moveWindowToGlobal 并显式指定 displayId，等待生效并核对属性。成功后忽略同 dragId 后续移动，防止捕获中的旧触控事件拉回窗口；下次拖拽重新启用。

真机确认：Display API 上屏高度为1608，下屏高度1606、原点y=1690，不能使用上屏height作为整个折叠面板高度，也不能把下屏坐标作为上屏坐标继续累加。上下双向原生桥转移及同手势锁定通过；单指 HDC 拖拽由上屏实际触发下屏转移，手指未经过折痕。透明显示及原有2倍大小保持。相关本地测试为 scripts/ohos-companion-fold.test.mjs 和 AgentCompanionHostService/PointerDragService tests。未验证 API22 真机、键盘/折叠状态在拖动中变化或远程运行场景。

### 同源原生触点与拖动诊断（2026-09-15）

仅以window.screenX + clientX补偿ArkWeb的局部screenX仍存在事件时序风险：单向500px实测中合成坐标发生约20vp反向跳变，导致12vp转向防抖被错误触发。现在Companion宿主监听ArkUI原生TouchEvent，保存displayX/Y和按下时windowRect，move操作使用该同源坐标计算物理位置；返回pointer/grabX供前端判断朝向。前端仍保留12vp反向行程阈值，方向变化不重建动画节点。开始拖动前窗口尚未移动，使用8vp启动阈值确定初始朝向，避免沿用上次方向造成起步闪动。

原生触点按dragId绑定，双指或取消标记无效，松开保留终点用于最后一次移动；新手势不得重用上次原生触点。跨屏成功返回transferred通知前端丢弃后续移动。新增返回字段可选，无原生响应时保留旧路径。诊断限制为按下/结束与每次最多4条大偏差记录，非逐帧日志。API24真机正反向500px最终回归通过；本轮下屏不可用，未建立跨屏成功的新证据。
