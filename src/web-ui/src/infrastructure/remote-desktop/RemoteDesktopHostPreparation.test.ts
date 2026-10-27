import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteDesktopController, type DesktopControllerPorts, type DesktopViewState } from './RemoteDesktopController';

const context = { account_generation: '1', connection_id: '2', socket_generation: '3', target_device_id: 'mac', public_key_fingerprint: 'a'.repeat(64) };
const oldAttachment = { attach_id: 'old', connection_id: 'old-pc', display_id: 'display', phase: 'streaming' };
function fixture(lifecycle = true) {
  let invalidate = () => {};
  const states: DesktopViewState[] = [];
  const host = { snapshot: { state_revision: 'host:1', busy: true, cleanup_pending: false, attachment: oldAttachment as unknown }, uptime: 100 };
  const request = vi.fn<DesktopControllerPorts['request']>(async (_target, payload) => ({ context: { ...context }, payload: payload.op === 'capabilities'
    ? { availability: 'ready', authorization: 'view', protocol_versions: [1], capabilities: ['read_only_video_v1', 'gathered_sdp_v1', ...(lifecycle ? ['source_lifecycle_v1'] : [])] }
    : payload.op === 'get_state' ? { state: { ...host.snapshot } }
      : { state_revision: 'fresh:catalog', displays: [{ display_id: 'display', width: 1280, height: 720 }] } }));
  const ports: DesktopControllerPorts = { request, turn: vi.fn(), renderer: vi.fn(), update: state => states.push(state),
    onInvalidated: callback => { invalidate = callback; return vi.fn(); }, identifier: () => 'new', focused: () => true,
    now: () => Date.now(), monotonicNow: () => host.uptime };
  const controller = new RemoteDesktopController(ports);
  void controller.receive({ kind: 'bridge_ready' });
  return { controller, ports, request, host, state: () => states.at(-1)!, invalidate: () => invalidate(),
    open: () => controller.open({ device_id: 'mac', device_kind: 'desktop', online: true }) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const settle = async () => { for (let step = 0; step < 10; ++step) await Promise.resolve(); };

it('waits for the old owned share and native cleanup before fetching a fresh catalog; never adopts or detaches it', async () => {
  const f = fixture(); const opening = f.open(); await settle();
  expect(f.state().stage).toBe('waiting_for_host');
  expect(f.request.mock.calls.map(call => call[1].op)).toEqual(['capabilities', 'get_state']);
  await f.controller.attach('display', false);
  f.host.snapshot = { state_revision: 'host:2', busy: false, cleanup_pending: true, attachment: null };
  await vi.advanceTimersByTimeAsync(350); expect(f.state().stage).toBe('waiting_for_host');
  f.host.snapshot.cleanup_pending = false;
  await vi.advanceTimersByTimeAsync(350); await opening;
  expect(f.state()).toMatchObject({ stage: 'choose_display', controlState: 'viewing' });
  expect(f.request.mock.calls.at(-1)?.[1].op).toBe('list_displays');
  expect(f.request.mock.calls.every(call => call[3] === undefined)).toBe(true);
  f.controller.close();
  expect(f.request.mock.calls.some(call => ['attach', 'detach', 'resume'].includes(call[1].op))).toBe(false);
  expect(f.ports.turn).not.toHaveBeenCalled();
});
it('refuses another controller occupancy without adopting it or polling', async () => {
  const f = fixture(); f.host.snapshot.attachment = null;
  await f.open(); expect(f.state()).toMatchObject({ stage: 'failed', error: 'attachment_busy' });
  expect(f.request.mock.calls.map(call => call[1].op)).toEqual(['capabilities', 'get_state']);
});
for (const action of ['close', 'hide', 'invalidate', 'replace'] as const) {
  it(`fences ${action} during preparation without a late catalog or attachment`, async () => {
    const f = fixture(); const opening = f.open(); await settle();
    expect(f.state().stage).toBe('waiting_for_host');
    if (action === 'close') f.controller.close();
    else if (action === 'hide') f.controller.setVisible(false);
    else if (action === 'invalidate') f.invalidate();
    else {
      f.host.snapshot = { state_revision: 'host:2', busy: false, cleanup_pending: false, attachment: null };
      await f.open();
    }
    const count = f.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000); await opening;
    expect(f.request).toHaveBeenCalledTimes(count);
    expect(f.request.mock.calls.some(call => ['attach', 'detach', 'resume'].includes(call[1].op))).toBe(false);
    expect(f.state().stage).toBe(action === 'replace' ? 'choose_display' : action === 'invalidate' ? 'failed' : 'closed');
    f.controller.close();
  });
}
for (const cleanup of [false, true]) {
  it(`bounds the setup wait using monotonic time while cleanup=${cleanup}`, async () => {
    const f = fixture(); f.host.snapshot.cleanup_pending = cleanup;
    const opening = f.open(); await settle();
    vi.setSystemTime(new Date('2000-01-01')); f.host.uptime = 60100;
    await vi.advanceTimersByTimeAsync(350); await opening;
    expect(f.state()).toMatchObject({ stage: 'failed', error: cleanup ? 'cleanup_pending' : 'attachment_busy' });
    expect(f.request.mock.calls.some(call => call[1].op === 'list_displays')).toBe(false);
  });
}
for (const uptime of [99, NaN, Infinity]) {
  it(`refuses an invalid or regressing wait clock (${uptime})`, async () => {
    const f = fixture(); const opening = f.open(); await settle(); f.host.uptime = uptime;
    await vi.advanceTimersByTimeAsync(350); await opening;
    expect(f.state()).toMatchObject({ stage: 'failed', error: 'invalid_response' });
    expect(f.request.mock.calls.some(call => call[1].op === 'list_displays')).toBe(false);
  });
}
it('rejects an incomplete occupancy snapshot instead of offering a display', async () => {
  const f = fixture(); delete (f.host.snapshot as Partial<typeof f.host.snapshot>).cleanup_pending;
  await f.open(); expect(f.state()).toMatchObject({ stage: 'failed', error: 'invalid_response' });
});
it('keeps the legacy host setup on its existing discovery path', async () => {
  const f = fixture(false); await f.open();
  expect(f.state().stage).toBe('choose_display');
  expect(f.request.mock.calls.map(call => call[1].op)).toEqual(['capabilities', 'list_displays']);
  f.controller.close();
});
