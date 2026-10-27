/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteDesktopInputSurface, RemoteDesktopTextComposer } from './RemoteDesktopInputSurface';
import type { RemoteDesktopController } from '@/infrastructure/remote-desktop/RemoteDesktopController';
import { shortcutManager } from '@/infrastructure/services/ShortcutManager';
import { handleBrowserShortcut } from '@/app/browserShortcutPolicy';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@openbitfun/ui', () => ({
  hasOverlayLayers: () => false,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Field: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Textarea: ({ onValueChange, ...props }: { onValueChange(value: string): void } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
    <textarea {...props} onChange={event => onValueChange(event.target.value)} />,
}));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  shortcutManager.clear(); shortcutManager.setEnabled(true); shortcutManager.loadUserOverrides({});
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  container = document.createElement('div'); container.dataset.openbitfunComponent = 'remote-desktop-viewer'; container.dataset.openbitfunPart = 'root';
  document.body.append(container); root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);
  HTMLElement.prototype.setPointerCapture = vi.fn(); HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { act(() => root.unmount()); container.remove(); shortcutManager.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function owner() { const input = vi.fn(), releaseControl = vi.fn(); return { input, releaseControl, value: { input, releaseControl } as unknown as RemoteDesktopController }; }
function pointer(element: Element, type: string, down: boolean) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, button: 0, buttons: down ? 1 : 0, clientX: 500, clientY: 250 }); element.dispatchEvent(event);
}
it('keeps mouse/key edges on the captured lease and cleans them before app blur', async () => {
  const f = owner(); await act(async () => root.render(<RemoteDesktopInputSurface owner={f.value} renderer="r" generation="6" width={2000} height={1000} />));
  const surface = container.querySelector('[role="application"]')!;
  await act(async () => { pointer(surface, 'pointerdown', true); surface.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', bubbles: true, cancelable: true })); });
  expect(f.input.mock.calls[0][0]).toMatchObject({ renderer_id: 'r', control_generation: '6', kind: 'pointer_button', body: { x: 0.5, y: 0.5, down: true } });
  await act(async () => window.dispatchEvent(new Event('blur')));
  expect(f.releaseControl).toHaveBeenCalledWith({ renderer: 'r', generation: '6' });
  expect(f.input.mock.calls.slice(-2).map(call => call[0])).toMatchObject([
    { kind: 'pointer_button', body: { down: false } }, { kind: 'key', body: { usage: 225, down: false } },
  ]);
  const stopped = f.input.mock.calls.length; pointer(surface, 'pointerdown', true); expect(f.input).toHaveBeenCalledTimes(stopped);
});
it('keeps focused remote keys ahead of app search and typography capture handlers', async () => {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
  const f = owner(), localSearch = vi.fn(), typography = vi.fn();
  shortcutManager.register('fixture.search', { key: 'f', ctrl: true, allowInInput: true }, localSearch);
  const capture = (event: KeyboardEvent) => handleBrowserShortcut(event, false, typography, 'Win32');
  window.addEventListener('keydown', capture, true);
  try {
    await act(async () => root.render(<><RemoteDesktopInputSurface owner={f.value} renderer="r" generation="6" width={2000} height={1000} /><input /></>));
    const surface = container.querySelector<HTMLElement>('[role="application"]')!; surface.focus();
    for (const [key, code] of [['f', 'KeyF'], ['p', 'KeyP'], ['r', 'KeyR'], ['=', 'Equal']]) {
      surface.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true }));
      surface.dispatchEvent(new KeyboardEvent('keyup', { key, code, ctrlKey: true, bubbles: true, cancelable: true }));
    }
    expect(localSearch).not.toHaveBeenCalled(); expect(typography).not.toHaveBeenCalled();
    expect(f.input.mock.calls.map(call => [call[0].body.usage, call[0].body.down])).toEqual([
      [9, true], [9, false], [19, true], [19, false], [21, true], [21, false], [46, true], [46, false],
    ]);
    const editor = container.querySelector('input')!; editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(localSearch).toHaveBeenCalledOnce();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: '=', code: 'Equal', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(typography).toHaveBeenCalledWith(1);
  } finally { window.removeEventListener('keydown', capture, true); }
});
it('forwards chord transitions carried by pointermove and releases capture after the final button', async () => {
  const f = owner(); await act(async () => root.render(<RemoteDesktopInputSurface owner={f.value} renderer="r" generation="6" width={2000} height={1000} />));
  const surface = container.querySelector('[role="application"]')!;
  const send = (type: string, button: number, buttons: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, button, buttons, clientX: 500, clientY: 250 });
    surface.dispatchEvent(event);
  };
  await act(async () => { send('pointerdown', 0, 1); send('pointermove', 2, 3); send('pointermove', 0, 2); send('pointerup', 2, 0); });
  expect(f.input.mock.calls.map(call => call[0]).filter(input => input.kind === 'pointer_button').map(input => [input.body.button, input.body.down]))
    .toEqual([['left', true], ['right', true], ['left', false], ['right', false]]);
  expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledOnce();
  expect(f.releaseControl).not.toHaveBeenCalled();
  await act(async () => surface.dispatchEvent(new Event('lostpointercapture')));
  expect(f.releaseControl).not.toHaveBeenCalled();
});
it('clears held keys into its embedded local editor without depending on a dialog ancestor', async () => {
  const f = owner(); await act(async () => root.render(<><RemoteDesktopInputSurface owner={f.value} renderer="r" generation="6" width={2000} height={1000} /><input /></>));
  const surface = container.querySelector<HTMLElement>('[role="application"]')!, editor = container.querySelector('input')!;
  surface.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true, cancelable: true }));
  surface.dispatchEvent(new FocusEvent('blur', { relatedTarget: editor }));
  expect(f.input.mock.calls.at(-1)![0]).toMatchObject({ kind: 'key', body: { usage: 4, down: false } });
  expect(f.releaseControl).not.toHaveBeenCalled();
});
it('releases authority when focus moves to another viewer instead of treating it as the local editor', async () => {
  const f = owner(); await act(async () => root.render(<RemoteDesktopInputSurface owner={f.value} renderer="r" generation="6" width={2000} height={1000} />));
  const other = document.createElement('input'); document.body.append(other);
  try {
    const surface = container.querySelector<HTMLElement>('[role="application"]')!;
    surface.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', bubbles: true, cancelable: true }));
    surface.dispatchEvent(new FocusEvent('blur', { relatedTarget: other }));
    expect(f.input.mock.calls.at(-1)![0]).toMatchObject({ kind: 'key', body: { usage: 225, down: false } });
    expect(f.releaseControl).toHaveBeenCalledWith({ renderer: 'r', generation: '6' });
  } finally { other.remove(); }
});
it('keeps composition local until explicit submit and discards a draft across lease changes', async () => {
  const f = owner();
  await act(async () => root.render(<RemoteDesktopTextComposer key="r:6" owner={f.value} renderer="r" generation="6" />));
  const editor = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '你好🙂');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(f.input).not.toHaveBeenCalled();
  await act(async () => container.querySelector('button')!.click());
  expect(f.input).toHaveBeenCalledWith({ renderer_id: 'r', control_generation: '6', kind: 'text_commit', body: { text: '你好🙂' } });
  await act(async () => root.render(<RemoteDesktopTextComposer key="r:7" owner={f.value} renderer="r" generation="7" />));
  expect(container.querySelector('textarea')!.value).toBe(''); expect(container.querySelector('button')!.disabled).toBe(true);
});
