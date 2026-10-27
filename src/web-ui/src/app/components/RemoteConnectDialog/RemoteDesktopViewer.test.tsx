/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopRendererCommand } from '@/infrastructure/remote-desktop/RemoteDesktopController';
import type { RemoteDesktopSignalRequest } from '@/infrastructure/api/service-api/RemoteDesktopAPI';
import { RemoteDesktopViewer } from './RemoteDesktopViewer';

const mocks = vi.hoisted(() => ({ request: vi.fn(), turn: vi.fn(), commands: [] as DesktopRendererCommand[],
  receive: undefined as undefined | ((value: unknown) => void), dispose: vi.fn(),
  frames: [] as { receive(value: unknown): void; fail(code: 'renderer_reloaded'): void }[] }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${Object.values(values).join(' ')}` : key, formatNumber: String }) }));
vi.mock('@/infrastructure/remote-desktop/RemoteDesktopService', () => ({ remoteDesktopService: { subscribe: () => () => {} } }));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', () => ({ deviceDisplayName: () => 'Remote Mac' }));
vi.mock('@/infrastructure/api/service-api/RemoteDesktopAPI', () => ({ remoteDesktopAPI: { request: mocks.request, turn: mocks.turn } }));
vi.mock('@/infrastructure/remote-desktop/DesktopMediaFrame', () => ({ DesktopMediaFrame: class {
  private disposed = false;
  constructor(_frame: unknown, receive: (value: unknown) => void, failed: (code: 'renderer_reloaded') => void) {
    mocks.receive = receive;
    mocks.frames.push({ receive, fail: code => { this.dispose(); failed(code); } });
  }
  send(command: DesktopRendererCommand) { if (!this.disposed) mocks.commands.push(command); }
  dispose() { if (!this.disposed) { this.disposed = true; mocks.dispose(); } }
} }));
vi.mock('@openbitfun/ui', () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Button = ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button>;
  return { Dialog: ({ children, closeOnEscape }: { children?: React.ReactNode; closeOnEscape?: boolean }) => <div role="dialog" data-close-on-escape={closeOnEscape}>{children}</div>,
    OverflowText: Box, DialogBody: Box, DialogHeader: Box, DialogHeaderActions: Box, DialogHeading: Box, DialogTitle: Box, DialogClose: Button, Button,
    Alert: ({ message }: { message: string }) => <p role="alert">{message}</p>, StatusPill: Box,
    Field: ({ children, label }: { children: React.ReactNode; label: string }) => <label>{label}{children}</label>,
    Select: ({ value, options, onValueChange, ...props }: { value: string; options: { value: string; label: string }[]; onValueChange(value: string): void; placeholder?: string }) =>
      <select {...props} value={value} onChange={event => onValueChange(event.target.value)}><option value="" />{options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>,
    Switch: ({ checked, onCheckedChange, ...props }: { checked: boolean; onCheckedChange(value: boolean): void }) =>
      <input {...props} type="checkbox" checked={checked} onChange={event => onCheckedChange(event.target.checked)} />,
    Textarea: ({ onValueChange, ...props }: { onValueChange(value: string): void } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
      <textarea {...props} onChange={event => onValueChange(event.target.value)} />,
  };
});
const context = { account_generation: '1', connection_id: '2', socket_generation: '3', target_device_id: 'mac', public_key_fingerprint: 'a'.repeat(64) };
const device = { device_id: 'mac', device_name: 'Remote Mac', device_kind: 'desktop', online: true };
let container: HTMLDivElement, root: Root, lifecycle: boolean, selected: string, phase: string, revision: number, attachId: string;
let quality: string | undefined;
let fullscreenElement: Element | null;
const snapshot = () => ({ context, payload: { state: { state_revision: `host:${revision}`, cleanup_pending: false,
  attachment: { attach_id: attachId, connection_id: `pc${revision}`, display_id: selected, phase, ...(quality === undefined ? {} : { quality }) } },
  media: phase === 'streaming' ? { offer_sdp: 'offer', force_relay: false, source_first_frame: true } : undefined } });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T10:00:00Z')); vi.clearAllMocks(); mocks.commands.length = 0; mocks.frames.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: vi.fn(function(this: Element) {
    fullscreenElement = this; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve();
  }) });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: vi.fn(() => {
    fullscreenElement = null; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve();
  }) });
  vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('attachment').mockReturnValueOnce('renderer1').mockReturnValue('renderer2');
  lifecycle = true; selected = 'screen:a'; phase = 'streaming'; revision = 1; attachId = 'attachment'; quality = undefined;
  mocks.request.mockImplementation(async (_target: string, request: RemoteDesktopSignalRequest, _context: unknown, attachment?: string) => {
    if (request.op === 'capabilities') return { context, payload: { availability: 'ready', authorization: 'view', protocol_versions: [1],
      capabilities: ['read_only_video_v1', 'gathered_sdp_v1', 'ordered_control_v1', 'text_commit_v1', ...(lifecycle ? ['source_lifecycle_v1'] : []), ...(quality === undefined ? [] : ['quality_presets_v1'])] } };
    if (request.op === 'list_displays') {
      expect(attachment).toBeUndefined();
      return { context, payload: { state_revision: 'catalog:1', displays: [{ display_id: 'screen:a', width: 1512, height: 982 }, { display_id: 'screen:b', width: 1920, height: 1080 }] } };
    }
    if (request.op === 'get_state' && attachment === undefined) return { context, payload: { state: { state_revision: 'host:0', busy: false, cleanup_pending: false, attachment: null } } };
    if (request.op === 'attach') attachId = request.body.attach_id;
    if (request.op === 'suspend') phase = 'suspended';
    if (request.op === 'select_display') selected = request.body.display_id;
    if (request.op === 'set_quality') quality = request.body.quality;
    if (request.op === 'resume') { ++revision; phase = 'streaming'; }
    return snapshot();
  });
  mocks.turn.mockImplementation(async () => ({ target_device_id: 'mac', attach_id: attachId, expires_at: 2000000000,
    ice_servers: [{ urls: ['turn:example.invalid'], username: 'short', credential: 'scoped' }] }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const key of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen']) Reflect.deleteProperty(document, key);
  Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
});
const button = (key: string) => Array.from(container.querySelectorAll('button')).find(node => node.textContent === `remoteDesktop.${key}`);
const click = async (key: string) => { const node = button(key); expect(node, key).toBeDefined(); await act(async () => node!.click()); };
const select = async (value: string) => { await act(async () => {
  const field = container.querySelector('select')!; field.value = value; field.dispatchEvent(new Event('change', { bubbles: true }));
}); };
async function receive(event: Record<string, unknown>) {
  const start = [...mocks.commands].reverse().find(command => command.kind === 'start');
  const latest = [...mocks.commands].reverse().find(command => command.kind === 'control');
  await act(async () => { mocks.receive!({ ...(event.kind === 'control_state' ? { control_epoch: latest?.kind === 'control' ? latest.control_epoch : start?.kind === 'start' ? start.control_epoch : '0' } : {}), ...(start?.kind === 'start' ? { renderer_id: start.renderer_id, attach_id: start.attach_id, connection_id: start.connection_id } : {}), ...event }); });
}
async function connect() {
  await act(async () => root.render(<RemoteDesktopViewer device={device} onClose={() => {}} />));
  await receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] }); await select('screen:a'); await click('viewerConnect');
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  await receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
}
it('shows negotiated quality only while paused and changes it without resuming or replacing the frame', async () => {
  quality = 'data_saver'; await connect();
  const iframe = container.querySelector('iframe');
  expect(container.querySelector('[aria-label="remoteDesktop.viewerQuality"]')).toBeNull();
  await click('viewerPause');
  const field = container.querySelector<HTMLSelectElement>('[aria-label="remoteDesktop.viewerQuality"]')!;
  expect(field.value).toBe('data_saver');
  expect(Array.from(field.options).filter(o => o.value).map(o => o.value)).toEqual(['data_saver', 'balanced', 'clear']);
  await act(async () => { field.value = 'clear'; field.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="remoteDesktop.viewerQuality"]')?.value).toBe('clear');
  expect(mocks.request.mock.calls.filter(call => call[1].op === 'set_quality')).toHaveLength(1);
  expect(mocks.request.mock.calls.some(call => call[1].op === 'resume')).toBe(false);
  expect(container.querySelector('iframe')).toBe(iframe); expect(button('viewerResume')).toBeDefined();
  await click('viewerResume'); await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  await receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  expect(container.querySelector('[role="application"]')).toBeNull();
  expect(button('viewerStartControl')).toBeDefined(); expect(container.querySelector('iframe')).toBe(iframe);
});
it('hides quality for an older host that still supports ordinary pause/resume', async () => {
  await connect(); await click('viewerPause');
  expect(container.querySelector('[aria-label="remoteDesktop.viewerQuality"]')).toBeNull();
  expect(button('viewerResume')).toBeDefined();
});
it('exits local element fullscreen before exposing the negotiated quality popup', async () => {
  quality = 'data_saver'; await connect(); await click('viewerFullscreen');
  expect(document.fullscreenElement).not.toBeNull();
  await click('viewerPause');
  expect(document.fullscreenElement).toBeNull();
  expect(container.querySelector('[aria-label="remoteDesktop.viewerQuality"]')).not.toBeNull();
  expect(mocks.request.mock.calls.some(call => call[1].op === 'set_quality')).toBe(false);
});
it('removes quality/resume controls during a pending setting and exposes no unconfirmed preference', async () => {
  quality = 'data_saver'; await connect(); await click('viewerPause');
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  const pending = new Promise<ReturnType<typeof snapshot>>(done => { resolve = done; });
  const normal = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((...args) => args[1].op === 'set_quality' ? pending : normal(...args));
  await act(async () => {
    const field = container.querySelector<HTMLSelectElement>('[aria-label="remoteDesktop.viewerQuality"]')!;
    field.value = 'balanced'; field.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(button('viewerResume')).toBeUndefined();
  expect(container.querySelector('[aria-label="remoteDesktop.viewerQuality"]')).toBeNull();
  expect(container.textContent).toContain('remoteDesktop.viewerSettingQuality');
  await act(async () => { quality = 'balanced'; resolve(snapshot()); });
  expect(container.querySelector<HTMLSelectElement>('[aria-label="remoteDesktop.viewerQuality"]')?.value).toBe('balanced');
  expect(button('viewerResume')).toBeDefined(); expect(mocks.request.mock.calls.some(call => call[1].op === 'resume')).toBe(false);
});
it('rebuilds a failed media bridge only on explicit reconnect and requires a fresh display choice', async () => {
  await connect();
  const previous = mocks.frames[0], iframe = container.querySelector('iframe');
  const start = mocks.commands.find(command => command.kind === 'start')!;
  await act(async () => previous.fail('renderer_reloaded'));
  expect(button('viewerReconnect')).toBeDefined(); expect(mocks.dispose).toHaveBeenCalledTimes(1);
  expect(mocks.frames).toHaveLength(1);
  await click('viewerReconnect');
  expect(mocks.frames).toHaveLength(2);
  expect(container.querySelector('iframe')).not.toBe(iframe);
  expect(mocks.request.mock.calls.filter(call => call[1].op === 'capabilities')).toHaveLength(1);
  expect(mocks.request.mock.calls.filter(call => call[1].op === 'attach')).toHaveLength(1);
  expect(button('viewerConnect')).toBeUndefined();
  await act(async () => previous.receive({ ...start, kind: 'failed', code: 'media_unreachable' }));
  expect(button('viewerReconnect')).toBeUndefined();
  await receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] });
  expect(mocks.request.mock.calls.filter(call => call[1].op === 'capabilities')).toHaveLength(2);
  expect(button('viewerConnect')?.disabled).toBe(true);
  await select('screen:a'); await click('viewerConnect');
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  await receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  expect(button('viewerStartControl')).toBeDefined();
  expect(container.querySelector('[role="application"]')).toBeNull();
  expect(mocks.commands.filter(command => command.kind === 'start')).toHaveLength(2);
  expect(mocks.commands.some(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toBe(false);
});
it('focuses explicit control activation in WebKit while retaining the document focus gate', async () => {
  await connect();
  expect(document.activeElement).not.toBe(button('viewerStartControl'));
  await click('viewerStartControl');
  expect(document.activeElement).toBe(button('viewerStopControl'));
  expect(mocks.commands.some(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toBe(true);
  await receive({ kind: 'control_state', control_generation: '6', code: 'ok' });
  await click('viewerStopControl');
  const acquired = mocks.commands.filter(command => command.kind === 'control' && command.body.kind === 'acquire_control').length;
  vi.mocked(document.hasFocus).mockReturnValue(false);
  await click('viewerStartControl');
  expect(mocks.commands.filter(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toHaveLength(acquired);
  expect(container.querySelector('[role="application"]')).toBeNull();
});
it('exposes pause, fresh display selection/cancel and view-only resume while retaining the isolated frame element', async () => {
  await connect(); const iframe = container.querySelector('iframe');
  const inputButton = button('viewerStartControl')!; inputButton.focus(); await click('viewerStartControl');
  await receive({ kind: 'control_state', control_generation: '6', code: 'ok' });
  expect(container.querySelector('[role="application"]')).not.toBeNull(); expect(container.querySelector('textarea')).not.toBeNull();
  await click('viewerPause');
  expect(container.querySelector('[role="application"]')).toBeNull(); expect(container.querySelector('textarea')).toBeNull();
  expect(container.querySelector('iframe')).toBe(iframe); expect(iframe!.closest<HTMLElement>('[data-openbitfun-part="viewport"]')!.hidden).toBe(true);
  expect(button('viewerStartControl')).toBeUndefined(); expect(button('viewerResume')).toBeDefined();
  await click('viewerChangeDisplay');
  expect(container.querySelector('select')?.textContent).toContain('remoteDesktop.viewerCurrentDisplay');
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(button('viewerResume')?.disabled).toBe(true);
  await click('viewerCancelDisplay'); expect(button('viewerChangeDisplay')).toBeDefined();
  expect(mocks.request.mock.calls.some(call => call[1].op === 'resume')).toBe(false);
  await click('viewerChangeDisplay'); await select('screen:b'); await click('viewerResume');
  expect(mocks.request.mock.calls.filter(call => call[1].op === 'select_display')).toHaveLength(1);
  expect(button('viewerStartControl')).toBeUndefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  await receive({ kind: 'first_frame_presented', width: 1280, height: 720 });
  expect(button('viewerStartControl')).toBeDefined(); expect(container.querySelector('[role="application"]')).toBeNull();
  expect(container.querySelector('iframe')).toBe(iframe); expect(mocks.dispose).not.toHaveBeenCalled();
  expect(mocks.commands.filter(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toHaveLength(1);
});
it('keeps source actions absent for an older host while its normal viewing controls remain usable', async () => {
  lifecycle = false; await connect();
  expect(button('viewerPause')).toBeUndefined(); expect(button('viewerChangeDisplay')).toBeUndefined();
  expect(button('viewerStartControl')).toBeDefined(); expect(button('viewerDisconnect')).toBeDefined();
});
it('opens an embedded inactive resource only on first activation, and hides/resumes without replacing its frame', async () => {
  const render = (isActive: boolean) => root.render(<RemoteDesktopViewer device={device} onClose={() => {}} embedded isActive={isActive} />);
  await act(async () => render(false));
  expect(mocks.request).not.toHaveBeenCalled(); expect(container.querySelector('[role="dialog"]')).toBeNull();
  await receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] });
  await act(async () => render(true)); await select('screen:a'); await click('viewerConnect');
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  await receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  const iframe = container.querySelector('iframe');
  await act(async () => render(false));
  expect(button('viewerResume')).toBeDefined(); expect(iframe!.closest<HTMLElement>('[data-openbitfun-part="viewport"]')!.hidden).toBe(true);
  await act(async () => render(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  await receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  expect(container.querySelector('iframe')).toBe(iframe); expect(button('viewerStartControl')).toBeDefined();
  expect(mocks.request.mock.calls.filter(call => call[1].op === 'attach')).toHaveLength(1);
  expect(mocks.request.mock.calls.filter(call => call[1].op === 'resume')).toHaveLength(1);
  expect(mocks.commands.some(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toBe(false);
});
it('shows explicit reconnect after hiding an older host and does not reattach until another display choice', async () => {
  lifecycle = false; await connect();
  await act(async () => root.render(<RemoteDesktopViewer device={device} onClose={() => {}} embedded isActive={false} />));
  expect(button('viewerReconnect')).toBeDefined();
  const before = mocks.request.mock.calls.length;
  await act(async () => root.render(<RemoteDesktopViewer device={device} onClose={() => {}} embedded isActive />));
  expect(mocks.request.mock.calls).toHaveLength(before);
  await click('viewerReconnect');
  expect(button('viewerConnect')).toBeUndefined();
  await receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] });
  expect(button('viewerConnect')).toBeDefined(); expect(button('viewerConnect')!.disabled).toBe(true);
  expect(mocks.request.mock.calls.filter(call => call[1].op === 'attach')).toHaveLength(1);
});
it('exposes a narrow immediate retirement hook for tab close before the view unmounts', async () => {
  const registration = vi.fn(), stop = vi.fn();
  const registerRetirement = (retire: () => void) => { registration(retire); return stop; };
  await act(async () => root.render(<RemoteDesktopViewer device={device} onClose={() => {}} embedded registerRetirement={registerRetirement} />));
  await receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] }); await select('screen:a'); await click('viewerConnect');
  await act(async () => { await vi.advanceTimersByTimeAsync(350); }); await receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  await act(async () => registration.mock.calls[0][0]());
  expect(mocks.commands.at(-1)).toEqual({ kind: 'stop' });
  expect(mocks.request.mock.calls.filter(call => call[1].op === 'detach')).toHaveLength(1);
  expect(container.querySelector('iframe')).not.toBeNull(); expect(mocks.dispose).not.toHaveBeenCalled();
});
it('switches fit/actual presentation locally without replacing media or negotiating another attachment', async () => {
  await connect(); const iframe = container.querySelector('iframe');
  const requests = mocks.request.mock.calls.length, starts = mocks.commands.filter(command => command.kind === 'start').length;
  expect(button('viewerFit')!.getAttribute('aria-pressed')).toBe('true');
  await click('viewerActualSize');
  const canvas = container.querySelector<HTMLElement>('[data-openbitfun-part="canvas"]')!;
  expect(canvas.style.width).toBe('1280px'); expect(canvas.style.height).toBe('828px');
  expect(button('viewerActualSize')!.getAttribute('aria-pressed')).toBe('true');
  expect(mocks.request).toHaveBeenCalledTimes(requests); expect(container.querySelector('iframe')).toBe(iframe);
  expect(mocks.commands.filter(command => command.kind === 'start')).toHaveLength(starts);
  await receive({ kind: 'frame_resized', width: 640, height: 414 });
  expect(canvas.style.width).toBe('640px'); expect(canvas.style.height).toBe('414px');
  await click('viewerFit'); expect(canvas.style.width).toBe(''); expect(canvas.style.height).toBe('');
  expect(mocks.dispose).not.toHaveBeenCalled();
  await click('viewerActualSize'); await click('viewerPause'); await click('viewerResume');
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  await receive({ kind: 'first_frame_presented', width: 640, height: 414 });
  expect(button('viewerFit')!.getAttribute('aria-pressed')).toBe('true');
  expect(canvas.style.width).toBe(''); expect(container.querySelector('iframe')).toBe(iframe);
});
it('retires control before changing scale or scrolling a larger canvas and never reacquires it automatically', async () => {
  await connect(); button('viewerStartControl')!.focus(); await click('viewerStartControl'); await receive({ kind: 'control_state', control_generation: '6', code: 'ok' });
  expect(container.querySelector('[role="application"]')).not.toBeNull();
  await click('viewerActualSize'); expect(container.querySelector('[role="application"]')).toBeNull();
  expect(mocks.commands.at(-1)).toMatchObject({ kind: 'control', body: { kind: 'release_control' } });
  button('viewerStartControl')!.focus(); await click('viewerStartControl'); await receive({ kind: 'control_state', control_generation: '7', code: 'ok' });
  await act(async () => container.querySelector('[data-openbitfun-part="viewport"]')!.dispatchEvent(new Event('scroll')));
  expect(container.querySelector('[role="application"]')).toBeNull();
  expect(mocks.commands.filter(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toHaveLength(2);
  expect(mocks.commands.at(-1)).toMatchObject({ kind: 'control', body: { kind: 'release_control' } });
});

it('fullscreen keeps the same media, retires control and retains visible exit/disconnect controls', async () => {
  await connect(); const iframe = container.querySelector('iframe');
  button('viewerStartControl')!.focus(); await click('viewerStartControl'); await receive({ kind: 'control_state', control_generation: '6', code: 'ok' });
  await click('viewerFullscreen');
  expect(document.fullscreenElement).toBe(container.querySelector('section')); expect(container.querySelector('iframe')).toBe(iframe);
  expect(container.querySelector('[role="application"]')).toBeNull(); expect(button('viewerExitFullscreen')).toBeDefined(); expect(button('viewerDisconnect')).toBeDefined();
  expect(container.querySelector('[role="dialog"]')!.getAttribute('data-close-on-escape')).toBe('false');
  expect(mocks.request.mock.calls.filter(call => call[1].op === 'attach')).toHaveLength(1);
  await click('viewerExitFullscreen'); expect(document.fullscreenElement).toBeNull(); expect(container.querySelector('iframe')).toBe(iframe);
  expect(mocks.commands.filter(command => command.kind === 'start')).toHaveLength(1);
});
it('exits only its fullscreen on resource hiding and immediate close retirement', async () => {
  let retire!: () => void; const registerRetirement = (callback: () => void) => { retire = callback; return () => {}; };
  const render = (isActive: boolean) => root.render(<RemoteDesktopViewer device={device} onClose={() => {}} embedded isActive={isActive} registerRetirement={registerRetirement} />);
  await act(async () => render(true)); await receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] }); await select('screen:a'); await click('viewerConnect');
  await act(async () => { await vi.advanceTimersByTimeAsync(350); }); await receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  await click('viewerFullscreen'); await act(async () => render(false)); expect(document.fullscreenElement).toBeNull();
  await act(async () => render(true)); await act(async () => { await vi.advanceTimersByTimeAsync(350); }); await receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  await click('viewerFullscreen'); await act(async () => retire()); expect(document.fullscreenElement).toBeNull();
  expect(mocks.commands.at(-1)).toEqual({ kind: 'stop' });
});

it('leaves fullscreen before presenting the design-system display picker', async () => {
  await connect(); await click('viewerFullscreen'); await click('viewerPause');
  expect(document.fullscreenElement).not.toBeNull();
  await click('viewerChangeDisplay'); expect(document.fullscreenElement).toBeNull();
  expect(container.querySelector('select')).not.toBeNull(); expect(button('viewerResume')).toBeDefined();
});
it('starts fullscreen retirement synchronously on page exit instead of waiting for React unmount', async () => {
  await connect(); await click('viewerFullscreen'); expect(document.fullscreenElement).not.toBeNull();
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  expect(document.fullscreenElement).toBeNull(); expect(mocks.commands.at(-1)).toEqual({ kind: 'stop' });
});
it('retires fullscreen when replacing the viewer controller even if its DOM root stays mounted', async () => {
  await connect(); await click('viewerFullscreen');
  await act(async () => root.render(<RemoteDesktopViewer device={{ ...device, device_name: 'Renamed Mac' }} onClose={() => {}} />));
  expect(document.fullscreenElement).toBeNull(); expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(button('viewerConnect')).toBeUndefined();
  await receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] });
  expect(button('viewerConnect')).toBeDefined();
});

it('shows bounded signaling recovery, disables remote mutations and keeps local disconnect and the same iframe', async () => {
  await connect(); const iframe = container.querySelector('iframe');
  const regular = mocks.request.getMockImplementation()!;
  mocks.request.mockRejectedValue('delivery_unknown');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(container.textContent).toContain('remoteDesktop.viewerSignalingInterrupted');
  expect(button('viewerStartControl')!.disabled).toBe(true); expect(button('viewerPause')!.disabled).toBe(true);
  expect(button('viewerDisconnect')!.disabled).toBe(false); expect(container.querySelector('iframe')).toBe(iframe);
  mocks.request.mockImplementation(regular);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(container.textContent).not.toContain('remoteDesktop.viewerSignalingInterrupted');
  expect(button('viewerStartControl')!.disabled).toBe(false); expect(container.querySelector('iframe')).toBe(iframe);
});

it('shows the prior-share wait without display or input actions, then offers fresh display choices after drain', async () => {
  lifecycle = true;
  let setup = { busy: true, cleanup_pending: false, attachment: { attach_id: 'old', connection_id: 'old-pc' } as unknown };
  const normal = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((target, request: RemoteDesktopSignalRequest, fence, attachment) => request.op === 'get_state' && !attachment
    ? Promise.resolve({ context, payload: { state: { state_revision: 'host:old', ...setup } } }) : normal(target, request, fence, attachment));
  await act(async () => root.render(<RemoteDesktopViewer device={device} onClose={() => {}} />));
  expect(mocks.request).not.toHaveBeenCalled();
  await receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] });
  expect(container.textContent).toContain('remoteDesktop.viewerWaitingForHost');
  expect(container.querySelector('select')).toBeNull();
  expect(button('viewerStartControl')).toBeUndefined();
  setup = { busy: false, cleanup_pending: true, attachment: null };
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(container.textContent).toContain('remoteDesktop.viewerWaitingForHost');
  setup.cleanup_pending = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(container.querySelector('select')).not.toBeNull();
  expect(button('viewerConnect')).toBeDefined();
  expect(mocks.request.mock.calls.some(call => ['attach', 'detach'].includes(call[1].op))).toBe(false);
  expect(mocks.turn).not.toHaveBeenCalled();
});

it('keeps disconnect available during setup wait and ignores late cleanup', async () => {
  lifecycle = true;
  const closed = vi.fn(), normal = mocks.request.getMockImplementation()!;
  let busy = true;
  mocks.request.mockImplementation((target, request: RemoteDesktopSignalRequest, fence, attachment) => request.op === 'get_state' && !attachment
    ? Promise.resolve({ context, payload: { state: { state_revision: 'host:old', busy: false, cleanup_pending: busy, attachment: null } } }) : normal(target, request, fence, attachment));
  await act(async () => root.render(<RemoteDesktopViewer device={device} onClose={closed} />));
  expect(mocks.request).not.toHaveBeenCalled();
  await receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] });
  expect(container.textContent).toContain('remoteDesktop.viewerWaitingForHost');
  await click('viewerDisconnect'); expect(closed).toHaveBeenCalledOnce();
  busy = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(container.querySelector('select')).toBeNull();
  expect(mocks.request.mock.calls.some(call => ['list_displays', 'attach', 'detach'].includes(call[1].op))).toBe(false);
});
