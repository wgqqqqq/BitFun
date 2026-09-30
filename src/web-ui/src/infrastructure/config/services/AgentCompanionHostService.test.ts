import { afterEach, expect, it, vi } from 'vitest';
import { LogicalPosition } from '@tauri-apps/api/window';
import { getCompanionWindow, getCompanionPointerPosition } from './AgentCompanionHostService';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), main: { hide: vi.fn() } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => mocks.main, LogicalPosition: class { constructor(public x: number, public y: number) {} } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('keeps the existing window adapter for other hosts', () => {
  expect(getCompanionWindow()).toBe(mocks.main);
});

it('routes a HarmonyOS child surface to its float rather than hiding or moving the workbench', async () => {
  vi.stubGlobal('window', { __OPENBITFUN_COMPANION_HOST__: 'ohos' });
  mocks.invoke.mockResolvedValue(undefined);
  const host = getCompanionWindow();
  await host.hide();
  expect(mocks.invoke).toHaveBeenLastCalledWith('plugin:companion|operation', { request: { action: 'hide' } });
  await host.setPosition(new LogicalPosition(12, 34));
  expect(mocks.invoke).toHaveBeenLastCalledWith('plugin:companion|operation', { request: { action: 'move', x: 12, y: 34 } });
  expect(mocks.main.hide).not.toHaveBeenCalled();
});

it('keeps the same screen target as an OHOS window follows a touch', () => {
  const host = { __OPENBITFUN_COMPANION_HOST__: 'ohos', screenX: 600, screenY: 350 };
  vi.stubGlobal('window', host);
  const start = getCompanionPointerPosition({ clientX: 50, clientY: 40, screenX: 50, screenY: 40 });
  host.screenX = 700; host.screenY = 390;
  const end = getCompanionPointerPosition({ clientX: 150, clientY: 80, screenX: 150, screenY: 80 });
  expect({ x: end.x - start.x, y: end.y - start.y }).toEqual({ x: 200, y: 80 });
  host.screenX = 800; host.screenY = 430;
  expect(getCompanionPointerPosition({ clientX: 50, clientY: 40, screenX: 50, screenY: 40 })).toEqual(end);
});

it('retains native screen coordinates on other platforms', () => {
  expect(getCompanionPointerPosition({ clientX: 50, clientY: 40, screenX: -300, screenY: 400 }))
    .toEqual({ x: -300, y: 400 });
});

it('uses a stable identifier within a drag and a new one for the next gesture', async () => {
  vi.stubGlobal('window', { __OPENBITFUN_COMPANION_HOST__: 'ohos' });
  const host = getCompanionWindow();
  host.beginDrag?.();
  await host.setPosition(new LogicalPosition(12, 34));
  const first = mocks.invoke.mock.lastCall?.[1].request.dragId;
  await host.setPosition(new LogicalPosition(20, 40));
  expect(mocks.invoke.mock.lastCall?.[1].request.dragId).toBe(first);
  host.beginDrag?.();
  await host.setPosition(new LogicalPosition(21, 41));
  expect(mocks.invoke.mock.lastCall?.[1].request.dragId).toBeGreaterThan(first);
});
