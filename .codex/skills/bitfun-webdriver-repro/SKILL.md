---
name: bitfun-webdriver-repro
description: Use this skill when working on BitFun desktop WebDriver/WDIO repro tasks in dev mode.
---

# BitFun WebDriver Repro

Reproduce real desktop-app workflows in `debug/dev` mode and collect evidence the user can inspect.

This skill is not only for writing or updating WDIO repro scripts. It is specifically for:

- reproducing a concrete user operation or failure path against the real desktop app
- capturing screenshots for key states and final outcomes
- collecting relevant runtime logs from the repro
- analyzing the screenshots when image understanding is available, so the run result is judged from both assertions and visible UI state

## Rules

- Do not use `release` unless the user explicitly asks for it.
- Prefer existing WDIO helpers and screenshot helpers under `tests/e2e/`.
- Prefer stable `data-testid` selectors over CSS class selectors when both exist.
- Treat screenshots as validation artifacts, not proof by themselves. Always assert the UI state that the screenshot is supposed to show.
- After taking screenshots, inspect them. If left nav still shows `暂无普通工作区`, the repro is wrong even if backend assertions passed.
- Keep the repro evidence set complete: script behavior, screenshots, and the logs needed to explain what happened during the run.
- If multimodal inspection is available, use the screenshots as an additional debugging signal and call out mismatches between asserted state and visible UI state.

## Critical pitfall

Opening a workspace by calling backend `open_workspace` directly from the test is usually wrong for frontend repro scripts.

- `window.__TAURI__.core.invoke('open_workspace', ...)` updates backend state.
- It does **not** guarantee frontend `workspaceManager` state is refreshed.
- If frontend state is stale, left nav may still show `暂无普通工作区`, and `FlowChatManager.currentWorkspacePath` may still point to the assistant workspace.
- Then clicking `+ Code` can create a session against the wrong workspace context.

For frontend-correct repros, open the workspace through the frontend state layer:

```ts
await browser.execute(async (workspacePath: string) => {
  const module = await import('/src/infrastructure/services/business/workspaceManager.ts');
  return module.workspaceManager.openWorkspace(workspacePath);
}, projectPath);
```

Prefer the shared helper when it exists:

```ts
import { openWorkspace } from '../helpers';

await openWorkspace(projectPath);
```

## Recommended flow

1. Create the test directory with Tauri/backend commands if needed.
2. Open the workspace through `workspaceManager.openWorkspace(...)` or the shared `openWorkspace(...)` helper.
3. Wait until all three conditions are true:
   - `get_current_workspace` returns the target path
   - `get_opened_workspaces` contains the target path
   - left nav DOM shows the project label
4. Only then click the session creation button.
5. Wait for `.bitfun-session-scene` and `[data-testid="chat-input-container"]`.
6. Save screenshots for the key steps.

## Markdown Inline AI recipe

When reproducing markdown inline AI continue flows, prefer the shared helpers under `tests/e2e/helpers/markdown-helper.ts`.

Recommended sequence:

1. Open the workspace and ensure a Code session exists.
2. Open the markdown file with `fileTabManager.openFile(..., mode: 'agent')`.
3. Wait for the markdown editor to appear.
4. Create a trailing empty paragraph before triggering inline AI.
5. Press space to open inline AI.
6. Click the primary continue action.
7. Wait for preview status to become `ready` or `error`.
8. Capture preview text before accepting.
9. Accept the generated content.
10. Assert that preview disappears and editor text length increases.

Why step 4 matters:

- Triggering inline AI from a non-empty trailing block is less stable.
- A trailing empty paragraph gives a deterministic insertion point.

Stable selectors now available for this flow:

- `[data-testid="md-inline-ai-panel"]`
- `[data-testid="md-inline-ai-continue"]`
- `[data-testid="md-inline-ai-preview"]`
- `[data-testid="md-inline-ai-preview-content"]`
- `[data-testid="md-inline-ai-accept"]`
- `[data-testid="md-inline-ai-reject"]`
- `[data-testid="md-inline-ai-retry"]`

## Minimal assertions

After opening workspace, verify both backend state and DOM:

```ts
await browser.waitUntil(async () => {
  const currentWorkspace = await tauriInvoke<WorkspaceInfo | null>('get_current_workspace', {});
  const openedWorkspaces = await tauriInvoke<WorkspaceInfo[]>('get_opened_workspaces', {});
  const labelTexts = await browser.execute(() =>
    Array.from(document.querySelectorAll('.bitfun-nav-panel__workspace-item-label'))
      .map(element => element.textContent ?? '')
  );

  return currentWorkspace?.rootPath === projectPath
    && openedWorkspaces.some(workspace => workspace.rootPath === projectPath)
    && labelTexts.some(text => text.includes(projectName));
});
```

## Session creation note

Top-left `+ Code` / `+ Cowork` buttons depend on frontend workspace state. Do not click them before the workspace assertions above pass.

## Dev-mode prerequisites

- Ensure the debug app binary exists.
- Ensure Vite dev server is running.
- If the frontend shows stale dependency resolution errors, restart Vite with `--force`.

Typical dev server command:

```bash
TAURI_DEV_HOST=127.0.0.1 pnpm --dir src/web-ui exec vite --force --host 127.0.0.1 --port 1422
```

## Good outputs

- One startup screenshot
- One workspace-opened screenshot where the left nav shows the project
- One editor-opened screenshot if the repro involves file editing
- One preview-finished screenshot if the repro involves inline AI
- One final session screenshot where the header and chat input match the target workspace
- One final inserted-content screenshot if the repro accepts generated text
- Relevant runtime logs that explain the path to the reproduced state or failure
- A short analysis of what the screenshots show, and, when multimodal inspection is available, whether the visible UI matches the expected state
