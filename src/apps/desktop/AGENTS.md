[中文](AGENTS-CN.md) | **English**

# AGENTS.md

## Scope

This file applies to `src/apps/desktop`. Use the top-level `AGENTS.md` for repository-wide rules.

## What matters here

`src/apps/desktop` is the Tauri host / integration layer.

Main areas:

- `src/api/`: Tauri commands
- `src/lib.rs`, `src/main.rs`: app setup and wiring
- `src/computer_use/`: OS-specific automation support

If a change affects shared product behavior across runtimes, the implementation likely belongs in `src/crates/core`.

## Local rules

- Keep Tauri commands consistent: `snake_case` names, structured `request`
- Keep desktop-only integrations here; do not move them into shared core

Preferred command shape:

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

## Commands

```bash
pnpm run desktop:dev
cargo check -p bitfun-desktop
cargo test -p bitfun-desktop
cargo build -p bitfun-desktop
pnpm run desktop:build:fast
```

## Verification

```bash
cargo check -p bitfun-desktop && cargo test -p bitfun-desktop
```

If the change affects startup, WebDriver, browser/computer-use, or packaged behavior, also run:

```bash
cargo build -p bitfun-desktop
```
