/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useShortcut } from './useShortcut';
import { shortcutManager } from '../services/ShortcutManager';

vi.mock('@openbitfun/ui', () => ({ hasOverlayLayers: () => false }));
it('updates the local escape permission even when its key and callback stay unchanged', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
  shortcutManager.clear(); shortcutManager.setEnabled(true); shortcutManager.loadUserOverrides({});
  const callback = vi.fn(), host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  function Surface({ local }: { local: boolean }) {
    useShortcut('fixture.local', { key: 'q', ctrl: true, allowInExclusiveInput: local }, callback);
    return <div tabIndex={0} data-shortcut-exclusive="true" />;
  }
  try {
    await act(async () => root.render(<Surface local={false} />));
    const input = host.firstElementChild as HTMLElement; input.focus();
    const key = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', ctrlKey: true, bubbles: true, cancelable: true }));
    key(); expect(callback).not.toHaveBeenCalled();
    await act(async () => root.render(<Surface local />));
    key(); expect(callback).toHaveBeenCalledOnce();
    await act(async () => root.render(<Surface local={false} />));
    key(); expect(callback).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); host.remove(); shortcutManager.clear(); vi.restoreAllMocks(); }
});
