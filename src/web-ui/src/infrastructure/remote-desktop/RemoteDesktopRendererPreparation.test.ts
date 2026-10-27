import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteDesktopController, type DesktopControllerPorts, type DesktopViewState } from './RemoteDesktopController';

function fixture() {
  const states: DesktopViewState[] = [];
  let invalidate = () => {};
  const context = { account_generation: '1', connection_id: '2', socket_generation: '3', target_device_id: 'mac', public_key_fingerprint: 'a'.repeat(64) };
  const request = vi.fn<DesktopControllerPorts['request']>(async (_target, value) => ({ context, payload: value.op === 'capabilities'
    ? { availability: 'ready', authorization: 'view', protocol_versions: [1], capabilities: ['read_only_video_v1', 'gathered_sdp_v1'] }
    : { state_revision: 'boot:1', displays: [{ display_id: 'display', width: 1280, height: 720 }] } }));
  const turn = vi.fn<DesktopControllerPorts['turn']>();
  const unsubscribe = vi.fn();
  const owner = new RemoteDesktopController({ request, turn, renderer: vi.fn(), update: state => states.push(state),
    onInvalidated: close => { invalidate = close; return unsubscribe; }, identifier: () => 'id', now: Date.now, focused: () => true });
  return { owner, request, turn, unsubscribe, state: () => states.at(-1)!, invalidate: () => invalidate(),
    open: () => owner.open({ device_id: 'mac', device_kind: 'desktop', online: true }) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('waits for local readiness before contacting a host, including an unavailable receiver', async () => {
  const f = fixture(), opening = f.open(); await Promise.resolve();
  expect(f.request).not.toHaveBeenCalled();
  await f.owner.receive({ kind: 'bridge_ready', receiver_api_available: false }); await opening;
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'media_backend_unavailable' });
  expect(f.request).not.toHaveBeenCalled(); expect(f.turn).not.toHaveBeenCalled();
  expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});

it.each([{}, { receiver_api_available: true }])('prepares once after a late valid or legacy readiness report: %j', async availability => {
  const f = fixture(), opening = f.open(); await Promise.resolve();
  expect(f.request).not.toHaveBeenCalled();
  await f.owner.receive({ kind: 'bridge_ready', ...availability }); await opening;
  expect(f.state().stage).toBe('choose_display');
  expect(f.request.mock.calls.map(call => call[1].op)).toEqual(['capabilities', 'list_displays']);
  expect(f.turn).not.toHaveBeenCalled(); f.owner.close();
});

it('rejects malformed readiness without contacting a host', async () => {
  const f = fixture(), opening = f.open(); await Promise.resolve();
  await f.owner.receive({ kind: 'bridge_ready', receiver_api_available: 'true' }); await opening;
  expect(f.request).not.toHaveBeenCalled(); expect(f.turn).not.toHaveBeenCalled();
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'invalid_response' });
});

it('settles a closed preparation and ignores late readiness until another explicit open', async () => {
  const f = fixture(), opening = f.open(); f.owner.close(); await opening;
  await f.owner.receive({ kind: 'bridge_ready', receiver_api_available: true });
  expect(f.request).not.toHaveBeenCalled(); expect(f.state().stage).toBe('closed');
  await f.open(); expect(f.request.mock.calls.map(call => call[1].op)).toEqual(['capabilities', 'list_displays']); f.owner.close();
});

it('invalidates an account while waiting without starting a discovery on the next readiness report', async () => {
  const f = fixture(), opening = f.open(); f.invalidate(); await opening;
  await f.owner.receive({ kind: 'bridge_ready', receiver_api_available: true });
  expect(f.request).not.toHaveBeenCalled(); expect(f.state()).toMatchObject({ stage: 'failed', error: 'controller_context_changed' });
  expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});

it('bounds the local wait and never revives it on late readiness', async () => {
  const f = fixture(), opening = f.open();
  await vi.advanceTimersByTimeAsync(3999); expect(f.request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await opening;
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'media_backend_unavailable' });
  await f.owner.receive({ kind: 'bridge_ready', receiver_api_available: true });
  expect(f.request).not.toHaveBeenCalled(); expect(f.turn).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('settles a replaced preparation and starts discovery only for the current one', async () => {
  const f = fixture(), first = f.open(), second = f.open(); await first;
  expect(f.request).not.toHaveBeenCalled();
  await f.owner.receive({ kind: 'bridge_ready', receiver_api_available: true }); await second;
  expect(f.request.mock.calls.map(call => call[1].op)).toEqual(['capabilities', 'list_displays']);
  expect(f.state().stage).toBe('choose_display'); f.owner.close();
});
