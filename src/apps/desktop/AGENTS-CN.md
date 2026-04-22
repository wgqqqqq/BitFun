**中文** | [English](AGENTS.md)

# AGENTS-CN.md

## 适用范围

本文件适用于 `src/apps/desktop`。仓库级规则请看顶层 `AGENTS.md`。

## 这里最重要的内容

`src/apps/desktop` 是 Tauri 宿主 / 集成层。

主要区域：

- `src/api/`：Tauri commands
- `src/lib.rs`、`src/main.rs`：应用启动与装配
- `src/computer_use/`：操作系统相关自动化支持

如果改动影响多个运行时共享的产品行为，真正实现通常应放在 `src/crates/core`。

## 本模块规则

- 保持 Tauri command 一致：名称使用 `snake_case`，调用使用结构化 `request`
- 桌面端专属集成留在这里，不要下沉到共享 core

推荐命令形状：

```rust
#[tauri::command]
pub async fn your_command(
    state: State<'_, AppState>,
    request: YourRequest,
) -> Result<YourResponse, String>
```

```ts
await api.invoke('your_command', { request: { ... } });
```

## 命令

```bash
pnpm run desktop:dev
cargo check -p bitfun-desktop
cargo test -p bitfun-desktop
cargo build -p bitfun-desktop
pnpm run desktop:build:fast
```

## 验证

```bash
cargo check -p bitfun-desktop && cargo test -p bitfun-desktop
```

如果改动影响启动、WebDriver、browser/computer-use 或打包行为，还需要运行：

```bash
cargo build -p bitfun-desktop
```
