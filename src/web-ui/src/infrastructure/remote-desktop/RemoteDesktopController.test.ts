import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteDesktopController, type DesktopControllerPorts, type DesktopRendererCommand, type DesktopViewState } from './RemoteDesktopController';
import type { RemoteDesktopControllerContext, RemoteDesktopSignalRequest } from '../api/service-api/RemoteDesktopAPI';

const context: RemoteDesktopControllerContext = { account_generation: '1', connection_id: '2', socket_generation: '3',
  target_device_id: 'mac', public_key_fingerprint: 'a'.repeat(64) };
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(control = false, ready = true) {
  let invalidated: (() => void) | undefined;
  let sequence = 0;
  const commands: DesktopRendererCommand[] = [], states: DesktopViewState[] = [];
  const snapshot = () => ({ state: { state_revision: 'revision:2', attachment: { attach_id: 'id1', connection_id: 'pc', display_id: 'display' } } });
  const payload = (request: RemoteDesktopSignalRequest): Record<string, unknown> => {
    if (request.op === 'capabilities') return { availability: 'ready', authorization: 'view', protocol_versions: [1],
      capabilities: ['read_only_video_v1', 'gathered_sdp_v1', ...(control ? ['ordered_control_v1', 'text_commit_v1'] : [])] };
    if (request.op === 'list_displays') return { state_revision: 'revision:1', displays: [{ display_id: 'display', width: 1512, height: 982 }] };
    return { ...snapshot(), media: { offer_sdp: 'gathered offer', force_relay: false, source_first_frame: true } };
  };
  const request = vi.fn<DesktopControllerPorts['request']>(async (_target, value) => ({ context: { ...context }, payload: payload(value) }));
  const turn = vi.fn<DesktopControllerPorts['turn']>(async () => ({ target_device_id: 'mac', attach_id: 'id1', expires_at: Math.floor(Date.now() / 1000) + 300,
    ice_servers: [{ urls: ['turn:approved.example:3478'], username: 'short', credential: 'scoped' }] }));
  const stopInvalidation = vi.fn();
  const ports: DesktopControllerPorts = { request, turn, renderer: command => commands.push(command), update: state => states.push(state),
    onInvalidated: close => { invalidated = close; return stopInvalidation; }, identifier: () => `id${++sequence}`, now: () => Date.now(), focused: () => true };
  const controller = new RemoteDesktopController(ports);
  if (ready) void controller.receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] });
  const open = () => controller.open({ device_id: 'mac', device_kind: 'desktop', online: true });
  const connect = async (epochs = true) => { await controller.receive({ kind: 'bridge_ready', capabilities: epochs ? ['control_epoch_v1'] : [] }); await open(); await controller.attach('display', false); await vi.advanceTimersByTimeAsync(350); };
  const receive = (event: Record<string, unknown>) => controller.receive({ ...(event.kind === 'control_state' ? { control_epoch: [...commands].reverse().find(command => command.kind === 'control')?.control_epoch ?? '0' } : {}), renderer_id: 'id2', attach_id: 'id1', connection_id: 'pc', ...event });
  return { controller, open, connect, receive, request, turn, commands, states, payload, snapshot, stopInvalidation, ports,
    invalidate: () => invalidated!(), state: () => states.at(-1)! };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T10:00:00Z')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('refuses a known unavailable local receiver before contacting or occupying the host', async () => {
  const f = fixture();
  await f.controller.receive({ kind: 'bridge_ready', receiver_api_available: false, capabilities: ['control_epoch_v1'] });
  await f.open(); await f.controller.attach('display', false);
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'media_backend_unavailable' });
  expect(f.request).not.toHaveBeenCalled(); expect(f.turn).not.toHaveBeenCalled();
  expect(f.commands.filter(command => command.kind !== 'stop')).toEqual([]);
  // Another readiness report cannot make APIs appear in this same renderer.
  await f.controller.receive({ kind: 'bridge_ready' });
  await f.controller.receive({ kind: 'bridge_ready', receiver_api_available: true });
  await f.open(); expect(f.request).not.toHaveBeenCalled();
});

it('retires pending attach on renderer reload and detaches only after its old reply', async () => {
  const f = fixture(), pending = deferred<{ context: RemoteDesktopControllerContext; payload: Record<string, unknown> }>();
  f.request.mockImplementation(async (_target, value) => value.op === 'attach' ? pending.promise : { context: { ...context }, payload: f.payload(value) });
  await f.open(); const attaching = f.controller.attach('display', false);
  await f.controller.receive({ kind: 'bridge_ready', receiver_api_available: false });
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'renderer_reloaded' });
  expect(f.request.mock.calls.filter(call => call[1].op === 'detach')).toHaveLength(0);
  pending.resolve({ context: { ...context }, payload: f.snapshot() }); await attaching;
  await Promise.resolve();
  const detach = f.request.mock.calls.filter(call => call[1].op === 'detach');
  expect(detach).toHaveLength(1); expect(detach[0][2]).toEqual(context); expect(detach[0][3]).toBe('id1');
  expect(f.turn).not.toHaveBeenCalled();
  expect(f.commands.filter(command => command.kind !== 'stop')).toEqual([]);
});

it('rejects a malformed local API availability report without a host mutation', async () => {
  const f = fixture(false, false), opening = f.open();
  await f.controller.receive({ kind: 'bridge_ready', receiver_api_available: 'true' }); await opening;
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'invalid_response' });
  await f.controller.attach('display', false);
  expect(f.request).not.toHaveBeenCalled();
  expect(f.turn).not.toHaveBeenCalled();
});

it('keeps the fixed native context, scopes TURN, and counts only an authenticated presented frame', async () => {
  const f = fixture(); await f.connect();
  expect(f.state().stage).toBe('connecting');
  expect(f.request.mock.calls[0][2]).toBeUndefined();
  expect(f.request.mock.calls.slice(1).every(call => JSON.stringify(call[2]) === JSON.stringify(context))).toBe(true);
  expect(f.turn).toHaveBeenCalledWith('mac', 'id1', context);
  expect(f.commands.find(command => command.kind === 'start')).toMatchObject({ control_supported: false, force_relay: false });
  await f.receive({ kind: 'transport_connected' }); await f.receive({ kind: 'bound' });
  expect(f.state().stage).toBe('connecting');
  await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  expect(f.state()).toMatchObject({ stage: 'observing', width: 1280, height: 828 });
  expect(JSON.stringify(f.states)).not.toContain('scoped');
  expect(JSON.stringify(f.states)).not.toContain('gathered offer');
});
it('does not gate the dedicated remote desktop route by general Peer protocol compatibility', async () => {
  const f = fixture(); await f.open();
  expect(f.state().stage).toBe('choose_display');
  expect(f.request.mock.calls.map(call => call[1].op)).toEqual(['capabilities', 'list_displays']);
  expect(f.request).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: 'attach' }));
});
it('reports old/unsupported hosts and never tries to attach without a view grant', async () => {
  for (const response of [{ availability: 'unsupported' }, { availability: 'ready', protocol_versions: [1],
    capabilities: ['read_only_video_v1', 'gathered_sdp_v1'], authorization: 'none' }]) {
    const f = fixture(); f.request.mockResolvedValue({ context, payload: response }); await f.open();
    expect(f.state().stage).toBe('failed'); expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.commands.filter(command => command.kind === 'start')).toEqual([]);
  }
});
it('rejects CLI, offline and malformed targets before native/network work', async () => {
  const f = fixture();
  for (const target of [{ device_id: 'cli', device_kind: 'cli', online: true }, { device_id: 'mac', online: false }, { device_id: '', online: true }]) await f.controller.open(target);
  expect(f.request).not.toHaveBeenCalled();
});
it('rejects duplicate displays and preserves revision strings containing a colon', async () => {
  const f = fixture(); await f.open(); expect(f.state().stage).toBe('choose_display');
  const g = fixture(); g.request.mockImplementation(async (_target, request) => ({ context, payload: request.op === 'list_displays'
    ? { state_revision: 'r:1', displays: [{ display_id: 'same', width: 1, height: 1 }, { display_id: 'same', width: 2, height: 2 }] } : g.payload(request) }));
  await g.open(); expect(g.state()).toMatchObject({ stage: 'failed', error: 'invalid_response' });
});
it('resolves a lost attach ACK from the same authoritative snapshot without replaying the mutation', async () => {
  const f = fixture(); await f.open();
  f.request.mockImplementation(async (_target, request) => {
    if (request.op === 'attach') throw 'delivery_unknown';
    return { context, payload: f.payload(request) };
  });
  await f.controller.attach('display', false);
  expect(f.request.mock.calls.filter(call => call[1].op === 'attach')).toHaveLength(1);
  expect(f.state().stage).toBe('connecting');
  expect(f.request.mock.calls.at(-1)).toEqual(['mac', { version: 1, op: 'get_state' }, context, 'id1']);
});
it('closes synchronously and detaches only after an in-flight attach settles', async () => {
  const f = fixture(); await f.open(); const pending = deferred<Awaited<ReturnType<DesktopControllerPorts['request']>>>();
  f.request.mockImplementation(async (_target, request) => request.op === 'attach' ? pending.promise : { context, payload: f.payload(request) });
  const attach = f.controller.attach('display', false); f.controller.close();
  expect(f.state().stage).toBe('closed'); expect(f.commands.at(-1)).toEqual({ kind: 'stop' });
  expect(f.request.mock.calls.some(call => call[1].op === 'detach')).toBe(false);
  pending.resolve({ context, payload: f.snapshot() }); await attach; await Promise.resolve();
  expect(f.request.mock.calls.at(-1)).toEqual(['mac', { version: 1, op: 'detach', body: { attach_id: 'id1' } }, context, 'id1']);
  await vi.advanceTimersByTimeAsync(5000); expect(f.state().stage).toBe('closed'); expect(f.turn).not.toHaveBeenCalled();
});
it('fences a late TURN result and closes immediately on a native account-change event', async () => {
  const f = fixture(); const pending = deferred<Awaited<ReturnType<DesktopControllerPorts['turn']>>>();
  f.turn.mockReturnValue(pending.promise); await f.connect(); f.invalidate();
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'controller_context_changed' });
  pending.resolve({ target_device_id: 'mac', attach_id: 'id1', expires_at: 2000000000, ice_servers: [] });
  await Promise.resolve(); await Promise.resolve();
  expect(f.commands.some(command => command.kind === 'start')).toBe(false); expect(f.stopInvalidation).toHaveBeenCalledTimes(1);
});
it('discards old renderer events and rejects a changed native socket context', async () => {
  const f = fixture(); await f.connect();
  await f.receive({ kind: 'first_frame_presented', renderer_id: 'old', width: 1280, height: 828 });
  expect(f.state().stage).toBe('connecting');
  f.request.mockResolvedValue({ context: { ...context, socket_generation: '4' }, payload: f.snapshot() });
  await vi.advanceTimersByTimeAsync(350);
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'controller_context_changed' });
});
it('requires both known candidates for P2P and treats either relay candidate as TURN', async () => {
  const f = fixture(); await f.connect();
  await f.receive({ kind: 'health', candidate_type: 'host' }); expect(f.state().path).toBe('unknown');
  await f.receive({ kind: 'health', candidate_type: 'prflx', remote_candidate_type: 'relay' }); expect(f.state().path).toBe('relay');
  await f.receive({ kind: 'health', candidate_type: 'host', remote_candidate_type: 'srflx' }); expect(f.state().path).toBe('direct');
});
it('does not accept wrong-target TURN credentials or expose arbitrary errors', async () => {
  const f = fixture(); f.turn.mockResolvedValue({ target_device_id: 'other', attach_id: 'id1', expires_at: 2000000000,
    ice_servers: [{ urls: ['turn:approved.example'], username: 'short', credential: 'scoped' }] });
  await f.connect(); expect(f.state()).toMatchObject({ stage: 'failed', error: 'turn_unavailable' });
  const g = fixture(); g.request.mockRejectedValue(new Error('private server body with credentials')); await g.open();
  expect(g.state().error).toBe('media_unreachable');
});
it('closes on a renderer reload and never retries signal mutations', async () => {
  const f = fixture(); await f.connect();
  f.request.mockRejectedValue('delivery_unknown'); await f.receive({ kind: 'answer', answer_sdp: 'gathered answer' });
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'delivery_unknown' });
  expect(f.request.mock.calls.filter(call => call[1].op === 'signal')).toHaveLength(1);
  const g = fixture(); await g.connect(); await g.controller.receive({ kind: 'bridge_ready' });
  expect(g.state()).toMatchObject({ stage: 'failed', error: 'renderer_reloaded' });
});

it('negotiates control separately and requires a current CAS plus explicit acquisition', async () => {
  const f = fixture(true); await f.connect();
  expect(f.commands.find(command => command.kind === 'start')).toMatchObject({ control_supported: true, parent_focus: true });
  expect(f.state().controlState).toBe('viewing');
  await f.controller.acquireControl(); expect(f.state().controlState).toBe('viewing');
  await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  await f.controller.acquireControl();
  expect(f.state().controlState).toBe('acquiring');
  expect(f.commands.at(-1)).toMatchObject({ kind: 'control', body: { kind: 'acquire_control', expected_state_revision: 'revision:2' } });
  await f.receive({ kind: 'control_state', control_generation: '6', code: 'ok' });
  expect(f.state()).toMatchObject({ controlState: 'controlling', controlGeneration: '6' });
});
it('preserves input renderer/lease identity and cannot relabel an old intent after release', async () => {
  const f = fixture(true); await f.connect(); await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  await f.controller.acquireControl(); await f.receive({ kind: 'control_state', control_generation: '6', code: 'ok' });
  const key = { kind: 'key' as const, renderer_id: 'id2', control_generation: '6', body: { usage: 80, down: true } };
  const before = f.commands.length;
  f.controller.input({ ...key, renderer_id: 'old' }); f.controller.input({ ...key, control_generation: '5' });
  expect(f.commands).toHaveLength(before);
  f.controller.input(key); expect(f.commands.at(-1)).toMatchObject({ kind: 'control', body: { kind: 'key', control_generation: '6' } });
  expect(JSON.stringify(f.commands.at(-1))).not.toContain('"body":{"renderer_id"');
  f.controller.releaseControl(); await f.receive({ kind: 'control_state', control_generation: '6', code: 'ok' });
  expect(f.state().controlGeneration).toBe(''); expect(f.state().controlState).toBe('viewing');
  const released = f.commands.length; f.controller.input(key); expect(f.commands).toHaveLength(released);
  await f.controller.acquireControl(); await f.receive({ kind: 'control_state', control_generation: '7', code: 'ok' });
  f.controller.releaseControl({ renderer: 'id2', generation: '6' });
  expect(f.state().controlGeneration).toBe('7');
  const acquired = f.commands.length; f.controller.input(key); expect(f.commands).toHaveLength(acquired);
  f.controller.inputUnsupported({ renderer: 'id2', generation: '6' }); expect(f.state().controlGeneration).toBe('7');
  f.controller.inputUnsupported({ renderer: 'id2', generation: '7' });
  expect(f.state()).toMatchObject({ controlState: 'viewing', controlError: 'unsupported_input' });
});
it('invalidates an acquisition awaiting CAS when the user releases or focus is lost', async () => {
  const f = fixture(true); await f.connect(); await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  const pending = deferred<Awaited<ReturnType<DesktopControllerPorts['request']>>>(); f.request.mockReturnValueOnce(pending.promise);
  const acquire = f.controller.acquireControl(); f.controller.releaseControl();
  pending.resolve({ context, payload: f.snapshot() }); await acquire;
  expect(f.commands.some(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toBe(false);
  await f.controller.acquireControl(); await f.receive({ kind: 'control_state', control_generation: '7', code: 'ok' });
  f.ports.focused = () => false;
  f.controller.input({ renderer_id: 'id2', control_generation: '7', kind: 'key', body: { usage: 80, down: true } });
  expect(f.state().controlState).toBe('viewing');
  expect(f.commands.at(-1)).toMatchObject({ kind: 'control', body: { kind: 'release_control' } });
});
it('answers the current renderer focus challenge and refuses unsolicited control authority', async () => {
  const f = fixture(true); await f.connect(); f.ports.focused = () => false;
  await f.receive({ kind: 'focus_probe', echo: '42' });
  expect(f.commands.at(-1)).toMatchObject({ kind: 'focus_reply', echo: '42', focused: false, renderer_id: 'id2' });
  const before = f.commands.length; await f.receive({ kind: 'focus_probe', renderer_id: 'old', echo: '43' });
  expect(f.commands).toHaveLength(before);
  await f.receive({ kind: 'control_state', control_generation: '7', code: 'ok' });
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'control_delivery_unknown' });
});
it('applies current presented-size changes as local geometry and retires the old input lease', async () => {
  const f = fixture(true); await f.connect();
  await f.receive({ kind: 'frame_resized', width: 640, height: 414 }); expect(f.state().stage).toBe('connecting');
  await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  await f.controller.acquireControl(); await f.receive({ kind: 'control_state', control_generation: '3', code: 'ok' });
  await f.receive({ kind: 'frame_resized', renderer_id: 'old', width: 320, height: 207 }); expect(f.state().width).toBe(1280);
  await f.receive({ kind: 'frame_resized', width: 640, height: 414 });
  expect(f.state()).toMatchObject({ stage: 'observing', width: 640, height: 414, controlState: 'viewing', controlGeneration: '' });
  expect(f.commands.at(-1)).toMatchObject({ kind: 'control', body: { kind: 'release_control' } });
  expect(f.commands.filter(command => command.kind === 'start')).toHaveLength(1);
  expect(f.request.mock.calls.filter(call => call[1].op === 'attach')).toHaveLength(1);
  await f.receive({ kind: 'frame_resized', width: 32769, height: 414 });
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'invalid_response' });
});

it('keeps video on a transient read failure, retires input and requires a same-source snapshot to resume viewing', async () => {
  const f = fixture(true); await f.connect(); await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  await f.controller.acquireControl(); await f.receive({ kind: 'control_state', control_generation: '3' });
  f.request.mockRejectedValue('delivery_unknown'); await vi.advanceTimersByTimeAsync(1000);
  expect(f.state()).toMatchObject({ stage: 'observing', signalingInterrupted: true, controlState: 'viewing', controlGeneration: '' });
  const calls = f.request.mock.calls.length, commands = f.commands.length;
  await f.controller.acquireControl(); await f.controller.pauseSource();
  f.controller.input({ renderer_id: 'id2', control_generation: '3', kind: 'key', body: { usage: 40, down: true } });
  expect(f.request).toHaveBeenCalledTimes(calls); expect(f.commands).toHaveLength(commands);
  await f.receive({ kind: 'control_state', control_generation: '3' }); expect(f.state().controlGeneration).toBe('');
  f.request.mockResolvedValue({ context, payload: { state: { state_revision: 'revision:3', attachment: { attach_id: 'id1', connection_id: 'pc', display_id: 'display', phase: 'streaming' } } } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.state()).toMatchObject({ stage: 'observing', signalingInterrupted: false, controlState: 'viewing' });
  expect(f.commands.filter(command => command.kind === 'start')).toHaveLength(1);
  expect(f.commands.filter(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(31000); expect(f.state().stage).toBe('observing');
  f.controller.close();
});
it('expires the first failed read after 30 seconds even with repeated errors and an in-flight recovery', async () => {
  const f = fixture(); await f.connect(); await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  f.request.mockRejectedValue('target_unavailable'); await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(15000); expect(f.state().signalingInterrupted).toBe(true);
  const pending = deferred<Awaited<ReturnType<DesktopControllerPorts['request']>>>(); f.request.mockReturnValue(pending.promise);
  await vi.advanceTimersByTimeAsync(15000); expect(f.state().stage).toBe('failed');
  pending.resolve({ context, payload: f.payload({ version: 1, op: 'get_state' }) }); await Promise.resolve(); await Promise.resolve();
  expect(f.state().stage).toBe('failed'); expect(f.state().signalingInterrupted).toBe(false); f.controller.close();
});
for (const error of ['authorization_expired', 'controller_context_changed', 'invalid_response']) {
  it(`does not retain video on ${error}`, async () => {
    const f = fixture(); await f.connect(); await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
    f.request.mockRejectedValue(error); await vi.advanceTimersByTimeAsync(1000);
    expect(f.state()).toMatchObject({ stage: 'failed', signalingInterrupted: false }); expect(f.commands.at(-1)).toEqual({ kind: 'stop' });
  });
}
it('closes a hidden viewer during signaling interruption instead of retaining it in the background', async () => {
  const f = fixture(); await f.connect(); await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  f.request.mockRejectedValue('relay_unavailable'); await vi.advanceTimersByTimeAsync(1000); expect(f.state().signalingInterrupted).toBe(true);
  f.controller.setVisible(false); expect(f.state().stage).toBe('closed');
  await vi.advanceTimersByTimeAsync(30000); expect(f.state().stage).toBe('closed');
});

it('does not turn an authenticated media failure into another transient wait', async () => {
  const f = fixture(); await f.connect(); await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  f.request.mockRejectedValue('delivery_unknown'); await vi.advanceTimersByTimeAsync(1000); expect(f.state().signalingInterrupted).toBe(true);
  f.request.mockResolvedValue({ context, payload: { ...f.snapshot(), media_error: 'authorization_expired' } });
  await vi.advanceTimersByTimeAsync(1000); expect(f.state()).toMatchObject({ stage: 'failed', signalingInterrupted: false, error: 'authorization_expired' });
});

it('does not restore an older lease report after two later control intents', async () => {
  const f = fixture(true); await f.connect();
  await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  await f.controller.acquireControl(); await f.receive({ kind: 'control_state', control_epoch: '1', control_generation: '6', code: 'ok' });
  f.controller.releaseControl(); await f.receive({ kind: 'control_state', control_epoch: '2', code: 'ok' });
  await f.controller.acquireControl(); await f.receive({ kind: 'control_state', control_epoch: '3', control_generation: '7', code: 'ok' });
  f.controller.releaseControl(); await f.receive({ kind: 'control_state', control_epoch: '4', code: 'ok' });
  await f.controller.acquireControl();
  await f.receive({ kind: 'control_state', control_epoch: '1', control_generation: '6', code: 'ok' });
  expect(f.state()).toMatchObject({ stage: 'observing', controlState: 'acquiring', controlGeneration: '' });
  await f.receive({ kind: 'control_state', control_epoch: '5', control_generation: '8', code: 'ok' });
  await f.receive({ kind: 'control_state', control_epoch: '2', pending: 'release_control', code: 'ok' });
  expect(f.state()).toMatchObject({ stage: 'observing', controlState: 'controlling', controlGeneration: '8' });
});

it('keeps an older local media bridge view-only even when the host supports control', async () => {
  const f = fixture(true); await f.connect(false);
  await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  expect(f.state()).toMatchObject({ stage: 'observing', controlSupported: false, textSupported: false, controlState: 'viewing' });
  expect(f.commands.find(command => command.kind === 'start')).toMatchObject({ control_supported: false, parent_focus: false });
  await f.controller.acquireControl();
  expect(f.commands.some(command => command.kind === 'control')).toBe(false);
});
it('rejects malformed, missing and unissued future control report epochs', async () => {
  for (const epoch of [undefined, null, 1, '', '01', '-1', '18446744073709551616', '2']) {
    const f = fixture(true); await f.connect();
    await f.receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
    await f.controller.acquireControl();
    await f.receive({ kind: 'control_state', control_epoch: epoch, control_generation: '6', code: 'ok' });
    expect(f.state()).toMatchObject({ stage: 'failed', error: 'invalid_response' });
  }
});
