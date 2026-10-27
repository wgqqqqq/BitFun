/** @vitest-environment jsdom */
import React, { act, createContext, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ContentResourceView from './ContentResourceView';
import { useContentResourceStore } from './contentResourceStore';
import { requestContentClose } from './contentResourceLifecycle';
import { shortcutManager } from '@/infrastructure/services/ShortcutManager';

const mocks = vi.hoisted(() => ({ accountId: 'a', resolved: true, signedIn: true, getDocument: vi.fn(), retired: vi.fn(), stopped: vi.fn(), closeScene: vi.fn() }));
vi.mock('@/infrastructure/remote-desktop/RemoteDesktopService', () => ({ useRemoteDesktopService: () => mocks.resolved ? ({
  connected: mocks.signedIn, service_id: mocks.accountId, generation: '1',
}) : null }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/stores/sceneStore', () => ({ useSceneStore: Object.assign(
  (selector: (state: { activeTabId: string | null }) => unknown) => selector({ activeTabId: `content:${id}` }),
  { getState: () => ({ closeScene: mocks.closeScene }) },
) }));
vi.mock('@/tools/editor/services/EditorDocument', () => ({ getEditorDocument: mocks.getDocument,
  releaseEditorDocument: vi.fn(), EditorDocumentContext: createContext(null) }));
vi.mock('../components/panels/base/FlexiblePanel', () => ({ default: () => <div data-testid="document-panel" /> }));
vi.mock('@openbitfun/ui', () => ({ hasOverlayLayers: () => false, Alert: ({ message }: { message: string }) => <p role="alert">{message}</p> }));
vi.mock('../components/RemoteConnectDialog/RemoteDesktopViewer', () => ({ RemoteDesktopViewer: ({ device, isActive, embedded, onClose, registerRetirement }: {
  device: { device_id: string }; isActive: boolean; embedded: boolean; onClose(): void;
  registerRetirement(retire: () => void): () => void;
}) => {
  useEffect(() => () => mocks.retired(device.device_id), [device]);
  useEffect(() => registerRetirement(mocks.stopped), [registerRetirement]);
  return <button data-target={device.device_id} data-active={String(isActive)} data-embedded={String(embedded)} onClick={onClose}>close remote</button>;
} }));
let host: HTMLDivElement, root: Root, id: string;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks();
  shortcutManager.clear(); shortcutManager.setEnabled(true); shortcutManager.loadUserOverrides({});
  mocks.accountId = 'a'; mocks.resolved = true; mocks.signedIn = true;
  useContentResourceStore.setState({ resources: {} });
  id = useContentResourceStore.getState().open({ type: 'remote-desktop', title: 'Remote',
    data: { serviceId: 'a', generation: '1', device: { device_id: 'mac' } } }, { surfaceId: 'local' }, 'a:mac');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); shortcutManager.clear(); useContentResourceStore.setState({ resources: {} }); vi.restoreAllMocks(); });
const render = (isActive = true) => act(async () => root.render(<ContentResourceView resourceId={id} isActive={isActive} />));
it('renders the dedicated embedded controller without creating an editor document and forwards visibility/close', async () => {
  await render();
  expect(mocks.getDocument).not.toHaveBeenCalled(); expect(host.querySelector('[data-target="mac"]')?.getAttribute('data-embedded')).toBe('true');
  await render(false); expect(host.querySelector('button')?.getAttribute('data-active')).toBe('false');
  expect(mocks.retired).not.toHaveBeenCalled();
  await act(async () => host.querySelector('button')!.click());
  expect(mocks.closeScene).toHaveBeenCalledWith(`content:${id}`);
  await act(async () => useContentResourceStore.getState().remove(id));
  expect(mocks.retired).toHaveBeenCalledOnce(); expect(host.querySelector('button')).toBeNull();
});
it('retires the old controller on service replacement or disconnect without deleting its resource metadata', async () => {
  await render(); mocks.accountId = 'b'; await render();
  expect(mocks.retired).toHaveBeenCalledWith('mac'); expect(host.querySelector('button')).toBeNull();
  expect(host.textContent).toContain('remoteDesktop.viewerIdentityChanged');
  expect(useContentResourceStore.getState().resources[id].content.data.serviceId).toBe('a');
  mocks.accountId = 'a'; mocks.signedIn = false; await render(); expect(host.querySelector('button')).toBeNull();
  expect(mocks.getDocument).not.toHaveBeenCalled();
});
it('waits for the independent service status before mounting any remote controller', async () => {
  mocks.resolved = false; await render(); expect(host.querySelector('button')).toBeNull();
  expect(host.textContent).toContain('remoteDesktop.viewerPreparing');
  mocks.resolved = true; await render(); expect(host.querySelector('[data-target="mac"]')).not.toBeNull();
});
it('retires controller authority in the shared close gate before resource removal or fallback navigation', async () => {
  await render(); const closing = requestContentClose(id);
  expect(mocks.stopped).toHaveBeenCalledOnce();
  expect(useContentResourceStore.getState().resources[id]).toBeDefined();
  expect(mocks.retired).not.toHaveBeenCalled(); expect(await closing).toBe(true);
});
it('keeps explicit local tab close reachable inside exclusive input, including a user binding override', async () => {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
  host.dataset.shortcutScope = 'canvas';
  shortcutManager.loadUserOverrides({ 'tab.close': { key: 'q', alt: true } });
  await render();
  const input = host.querySelector('button')!; input.dataset.shortcutExclusive = 'true'; input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', altKey: true, bubbles: true, cancelable: true }));
  expect(mocks.closeScene).toHaveBeenCalledExactlyOnceWith(`content:${id}`);
  await render(false);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', altKey: true, bubbles: true, cancelable: true }));
  expect(mocks.closeScene).toHaveBeenCalledTimes(1);
});
