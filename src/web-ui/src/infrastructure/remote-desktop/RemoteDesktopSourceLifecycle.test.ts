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
type Reply = Awaited<ReturnType<DesktopControllerPorts['request']>>;
function fixture(lifecycle = true, renewal = false) {
  let sequence = 0, invalidated = () => {};
  const clock = { uptime: 0 };
  const model = { revision: 1, connection: 'pc1', display: 'screen:a', phase: 'streaming', cleanup: false,
    quality: undefined as string | undefined,
    attached: true, firstFrame: true, remaining: 300000, lostAck: '', denied: '', catalogRevision: 'catalog:1',
    displays: [{ display_id: 'screen:a', width: 1512, height: 982 }, { display_id: 'screen:b', width: 1920, height: 1080 }] };
  const commands: DesktopRendererCommand[] = [], states: DesktopViewState[] = [];
  const snapshot = () => ({ context: { ...context }, payload: { state: { state_revision: `host:${model.revision}`, cleanup_pending: model.cleanup,
    attachment: model.attached ? { attach_id: 'id1', connection_id: model.connection, display_id: model.display, phase: model.phase,
      ...(model.quality === undefined ? {} : { quality: model.quality }) } : null },
    media: model.phase === 'streaming' ? { offer_sdp: 'offer', force_relay: false, source_first_frame: model.firstFrame, ...(renewal ? { credentials_remaining_ms: model.remaining } : {}) } : undefined } });
  const handle: DesktopControllerPorts['request'] = async (_target, value, _context, attachment) => {
    if (['capabilities', 'list_displays'].includes(value.op) && attachment !== undefined) throw new Error('invalid_request');
    if (['suspend', 'resume', 'select_display', 'set_quality'].includes(value.op) && attachment !== 'id1') throw new Error('invalid_request');
    if (value.op === 'capabilities') return { context, payload: { availability: 'ready', authorization: 'view', protocol_versions: [1],
      capabilities: ['read_only_video_v1', 'gathered_sdp_v1', 'ordered_control_v1', 'text_commit_v1', ...(lifecycle ? ['source_lifecycle_v1'] : []), ...(renewal ? ['credential_rebuild_v1'] : []), ...(model.quality === undefined ? [] : ['quality_presets_v1'])] } };
    if (value.op === 'get_state' && attachment === undefined) return { context, payload: { state: { state_revision: `host:${model.revision}`, busy: false, cleanup_pending: false, attachment: null } } };
    if (value.op === 'list_displays') return { context, payload: { state_revision: model.catalogRevision, displays: model.displays } };
    if (value.op === model.denied) throw new Error('stale_revision');
    if (value.op === 'suspend') { model.phase = 'suspended'; ++model.revision; }
    if (value.op === 'select_display') { model.display = value.body.display_id; ++model.revision; }
    if (value.op === 'set_quality') { model.quality = value.body.quality; ++model.revision; }
    if (value.op === 'resume') { ++model.revision; model.connection = `pc${model.revision}`; model.phase = 'streaming'; }
    if (value.op === model.lostAck) throw new Error('delivery_unknown');
    return snapshot();
  };
  const request = vi.fn(handle), turn = vi.fn<DesktopControllerPorts['turn']>(async () => ({ target_device_id: 'mac', attach_id: 'id1',
    expires_at: Math.floor(Date.now() / 1000) + (renewal ? 600 : 300), ice_servers: [{ urls: ['turn:example.invalid'], username: 'short', credential: 'scoped' }] }));
  const ports: DesktopControllerPorts = { request, turn, renderer: command => commands.push(command), update: state => states.push(state),
    onInvalidated: close => { invalidated = close; return vi.fn(); }, identifier: () => `id${++sequence}`, now: () => Date.now(), monotonicNow: () => clock.uptime, focused: () => true };
  const controller = new RemoteDesktopController(ports);
  const state = () => states.at(-1)!;
  const receive = (event: Record<string, unknown>, binding = { renderer_id: state().rendererId, attach_id: 'id1', connection_id: model.connection }) =>
    controller.receive({ ...(event.kind === 'control_state' ? { control_epoch: [...commands].reverse().find(command => command.kind === 'control')?.control_epoch ?? '0' } : {}), ...binding, ...event });
  const presented = () => receive({ kind: 'first_frame_presented', width: 1280, height: 828 });
  const connect = async () => {
    await controller.receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] });
    await controller.open({ device_id: 'mac', device_kind: 'desktop', online: true });
    await controller.attach('screen:a', false); await vi.advanceTimersByTimeAsync(350); await presented();
  };
  const control = async () => { await controller.acquireControl(); await receive({ kind: 'control_state', control_generation: '6', code: 'ok' }); };
  const operations = () => request.mock.calls.map(call => call[1].op);
  return { controller, state, commands, clock, model, request, turn, handle, snapshot, connect, control, receive, presented, operations, invalidate: () => invalidated() };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T10:00:00Z')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('changes quality only after manual pause and drain, keeps the original attachment and awaits explicit resume', async () => {
  const f = fixture(); f.model.quality = 'data_saver'; await f.connect(); await f.control();
  await f.controller.setQuality('clear'); expect(f.operations()).not.toContain('set_quality');
  f.model.cleanup = true; await f.controller.pauseSource();
  await f.controller.setQuality('clear'); expect(f.operations()).not.toContain('set_quality');
  f.model.cleanup = false; await vi.advanceTimersByTimeAsync(350);
  f.model.revision = 40;
  await f.controller.setQuality('clear');
  expect(f.request.mock.calls.find(call => call[1].op === 'set_quality')).toEqual(['mac', { version: 1, op: 'set_quality',
    body: { attach_id: 'id1', expected_state_revision: 'host:40', quality: 'clear' } }, context, 'id1']);
  expect(f.state()).toMatchObject({ stage: 'paused', qualitySupported: true, quality: 'clear', controlState: 'viewing', controlGeneration: '' });
  expect(f.operations()).not.toContain('resume');
  const requests = f.request.mock.calls.length;
  await f.controller.setQuality('clear'); expect(f.request).toHaveBeenCalledTimes(requests);
  await f.controller.resumeSource(); expect(f.state().stage).toBe('connecting');
  await vi.advanceTimersByTimeAsync(350); await f.presented();
  expect(f.state()).toMatchObject({ stage: 'observing', quality: 'clear', controlState: 'viewing' });
  expect(f.operations().filter(op => op === 'attach')).toHaveLength(1);
  expect(f.commands.filter(c => c.kind === 'start')).toHaveLength(2);
  expect(f.commands.filter(c => c.kind === 'control' && c.body.kind === 'acquire_control')).toHaveLength(1);
});

it('requires both source lifecycle and presets, leaving legacy viewing intact', async () => {
  const f = fixture(false); f.model.quality = 'data_saver'; await f.connect();
  expect(f.state().qualitySupported).toBe(false);
  await f.controller.setQuality('clear'); expect(f.operations()).not.toContain('set_quality');
  expect(f.state().stage).toBe('observing');
});

for (const applied of [true, false]) {
  it(`reads one snapshot for an uncertain quality ACK without replay or resume (applied=${applied})`, async () => {
    const f = fixture(); f.model.quality = 'data_saver'; await f.connect(); await f.controller.pauseSource();
    const before = f.request.mock.calls.length;
    if (applied) f.model.lostAck = 'set_quality';
    else f.request.mockImplementation((...args) => args[1].op === 'set_quality' ? Promise.reject(new Error('delivery_unknown')) : f.handle(...args));
    await f.controller.setQuality('balanced');
    const operations = f.request.mock.calls.slice(before).map(call => call[1].op);
    expect(operations.filter(op => op === 'set_quality')).toHaveLength(1);
    expect(operations.filter(op => op === 'get_state')).toHaveLength(2);
    expect(operations).not.toContain('resume');
    expect(f.state()).toMatchObject({ stage: applied ? 'paused' : 'failed', quality: applied ? 'balanced' : 'data_saver' });
  });
}

it('preserves a quality CAS refusal without reporting success or restoring media', async () => {
  const f = fixture(); f.model.quality = 'data_saver'; await f.connect(); await f.controller.pauseSource();
  f.model.denied = 'set_quality'; await f.controller.setQuality('clear');
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'stale_revision', quality: 'data_saver' });
  expect(f.operations().filter(op => op === 'set_quality')).toHaveLength(1);
  expect(f.operations()).not.toContain('resume');
});

for (const action of ['close', 'hide', 'invalidate'] as const) {
  it(`retires an in-flight quality change on ${action}, cleans the original attachment and fences its successor`, async () => {
    const f = fixture(); f.model.quality = 'data_saver'; await f.connect(); await f.controller.pauseSource();
    const pending = deferred<Reply>();
    f.request.mockImplementation((...args) => args[1].op === 'set_quality' ? pending.promise : f.handle(...args));
    const changing = f.controller.setQuality('clear'); await Promise.resolve(); await Promise.resolve();
    expect(f.state().stage).toBe('setting_quality');
    await f.controller.setQuality('balanced'); await f.controller.resumeSource();
    expect(f.operations().filter(op => op === 'set_quality')).toHaveLength(1);
    if (action === 'hide') f.controller.setVisible(false);
    else if (action === 'invalidate') f.invalidate(); else f.controller.close();
    expect(f.operations()).not.toContain('detach');
    if (action === 'hide') f.controller.setVisible(true);
    await f.controller.open({ device_id: 'mac', device_kind: 'desktop', online: true });
    pending.resolve(f.snapshot()); await changing; await Promise.resolve();
    expect(f.state()).toMatchObject({ stage: 'choose_display', quality: 'data_saver', controlState: 'viewing' });
    expect(f.request.mock.calls.filter(call => call[1].op === 'detach').map(call => [call[0], call[3]])).toEqual([['mac', 'id1']]);
    expect(f.operations()).not.toContain('resume');
  });
}

for (const quality of [undefined, 'ultra', 12]) {
  it(`rejects invalid negotiated snapshot quality ${quality} before sending media`, async () => {
    const f = fixture(); f.model.quality = 'data_saver';
    f.request.mockImplementation(async (...args) => {
      const reply = await f.handle(...args);
      if (args[1].op === 'attach') (reply.payload.state as { attachment: Record<string, unknown> }).attachment.quality = quality;
      return reply;
    });
    await f.controller.receive({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] });
    await f.controller.open({ device_id: 'mac', device_kind: 'desktop', online: true }); await f.controller.attach('screen:a', false);
    expect(f.state()).toMatchObject({ stage: 'failed', error: 'invalid_response' });
    expect(f.commands.some(c => c.kind === 'start')).toBe(false);
  });
}

it('leaves a legacy host on the existing viewing/control path without source mutations', async () => {
  const f = fixture(false); await f.connect(); await f.controller.pauseSource(); await f.controller.resumeSource();
  await f.controller.chooseSource(); await f.controller.selectSource('screen:b');
  expect(f.state()).toMatchObject({ stage: 'observing', sourceLifecycleSupported: false, selectedDisplayId: 'screen:a' });
  expect(f.operations().filter(op => ['suspend', 'resume', 'select_display'].includes(op))).toEqual([]);
});
it('retires input immediately, keeps the old PC until suspend is confirmed, and waits for actual cleanup', async () => {
  const f = fixture(); await f.connect(); await f.control();
  const oldBinding = { renderer_id: f.state().rendererId, attach_id: 'id1', connection_id: 'pc1' };
  const pending = deferred<Reply>();
  f.request.mockImplementation((...args) => args[1].op === 'suspend' ? pending.promise : f.handle(...args));
  const stops = f.commands.filter(command => command.kind === 'stop').length;
  const pause = f.controller.pauseSource(); await Promise.resolve(); await Promise.resolve();
  expect(f.state()).toMatchObject({ stage: 'pausing', controlState: 'viewing', controlGeneration: '', rendererId: '' });
  expect(f.commands.at(-1)).toMatchObject({ kind: 'control', body: { kind: 'release_control' } });
  expect(f.commands.filter(command => command.kind === 'stop')).toHaveLength(stops);
  const before = f.commands.length;
  f.controller.input({ ...oldBinding, control_generation: '6', kind: 'key', body: { usage: 80, down: true } });
  await f.receive({ kind: 'first_frame_presented', width: 1, height: 1 }, oldBinding);
  await f.receive({ kind: 'control_state', control_generation: '6', code: 'ok' }, oldBinding);
  expect(f.commands).toHaveLength(before); expect(f.state().stage).toBe('pausing');
  f.model.phase = 'suspended'; f.model.cleanup = true; pending.resolve(f.snapshot()); await pause;
  expect(f.commands.at(-1)).toEqual({ kind: 'stop' }); expect(f.state().stage).toBe('pausing');
  await f.controller.resumeSource(); await f.controller.chooseSource(); expect(f.operations()).not.toContain('resume');
  await vi.advanceTimersByTimeAsync(350); expect(f.state().stage).toBe('pausing');
  f.model.cleanup = false; await vi.advanceTimersByTimeAsync(350); expect(f.state().stage).toBe('paused');
});
it('resumes with fresh CAS/PC/renderer and needs a newly presented frame before explicit control', async () => {
  const f = fixture(); await f.connect(); await f.control(); await f.controller.pauseSource();
  f.model.revision = 40;
  await f.controller.resumeSource();
  expect(f.request.mock.calls.find(call => call[1].op === 'resume')).toEqual(['mac', { version: 1, op: 'resume',
    body: { attach_id: 'id1', expected_state_revision: 'host:40' } }, context, 'id1']);
  expect(f.state()).toMatchObject({ stage: 'connecting', rendererId: 'id3', controlState: 'viewing', controlGeneration: '' });
  await f.receive({ kind: 'first_frame_presented', width: 10, height: 10 }, { renderer_id: 'id2', attach_id: 'id1', connection_id: 'pc1' });
  await f.controller.acquireControl(); expect(f.state().stage).toBe('connecting');
  await vi.advanceTimersByTimeAsync(350); await f.presented();
  expect(f.state()).toMatchObject({ stage: 'observing', controlState: 'viewing' });
  expect(f.commands.filter(command => command.kind === 'start')).toHaveLength(2);
  expect(f.commands.filter(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toHaveLength(1);
  await f.controller.acquireControl(); expect(f.state().controlState).toBe('acquiring');
});
it('ignores a retired channel closing during suspension but stops on the current channel failing', async () => {
  const f = fixture(); await f.connect();
  const old = { renderer_id: f.state().rendererId, attach_id: 'id1', connection_id: f.model.connection };
  const pending = deferred<Reply>();
  f.request.mockImplementation((...args) => args[1].op === 'suspend' ? pending.promise : f.handle(...args));
  const pause = f.controller.pauseSource(); await Promise.resolve(); await Promise.resolve();
  await f.receive({ kind: 'failed', code: 'media_unreachable', stage: 'channel' }, old);
  expect(f.state().stage).toBe('pausing'); expect(f.operations()).not.toContain('detach');
  f.model.phase = 'suspended'; pending.resolve(f.snapshot()); await pause;
  await f.controller.resumeSource(); await vi.advanceTimersByTimeAsync(350); await f.presented();
  await f.receive({ kind: 'failed', code: 'media_unreachable', stage: 'channel' }, old);
  expect(f.state()).toMatchObject({ stage: 'observing', controlState: 'viewing' });
  expect(f.operations().filter(op => op === 'attach')).toHaveLength(1);
  await f.receive({ kind: 'failed', code: 'media_unreachable', stage: 'channel' });
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'media_unreachable' });
  expect(f.commands.at(-1)).toEqual({ kind: 'stop' });
});
it('discovers without an outer attachment, uses a fresh CAS for selection, and automatically resumes only the confirmed target', async () => {
  const f = fixture(); await f.connect(); await f.controller.pauseSource();
  f.model.catalogRevision = 'stale:catalog'; await f.controller.chooseSource();
  expect(f.request.mock.calls.at(-1)).toEqual(['mac', { version: 1, op: 'list_displays' }, context, undefined]);
  expect(f.state().stage).toBe('choose_source');
  await vi.advanceTimersByTimeAsync(350); expect(f.state().stage).toBe('choose_source');
  f.model.revision = 50; await f.controller.selectSource('screen:b');
  expect(f.request.mock.calls.find(call => call[1].op === 'select_display')).toEqual(['mac', { version: 1, op: 'select_display',
    body: { attach_id: 'id1', display_id: 'screen:b', expected_state_revision: 'host:50' } }, context, 'id1']);
  expect(f.state()).toMatchObject({ stage: 'connecting', selectedDisplayId: 'screen:b', controlState: 'viewing' });
  await vi.advanceTimersByTimeAsync(350); await f.presented(); expect(f.state().stage).toBe('observing');
  expect(f.operations().filter(op => op === 'attach')).toHaveLength(1);
  expect(f.operations().filter(op => op === 'select_display')).toHaveLength(1);
  expect(f.operations().filter(op => op === 'resume')).toHaveLength(1);
  expect(f.commands.some(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toBe(false);
});
it('cancels a pending directory without resuming, and fences its late result across a new choice', async () => {
  const f = fixture(); await f.connect(); await f.controller.pauseSource();
  const pending = deferred<Reply>(); f.request.mockReturnValueOnce(pending.promise);
  const choose = f.controller.chooseSource(); f.controller.cancelSourceChoice();
  expect(f.state().stage).toBe('paused');
  f.model.displays = [{ display_id: 'screen:b', width: 1920, height: 1080 }];
  await f.controller.chooseSource();
  pending.resolve({ context, payload: { state_revision: 'old', displays: [{ display_id: 'old', width: 1, height: 1 }] } }); await choose;
  expect(f.state().displays.map(display => display.display_id)).toEqual(['screen:b']);
  await f.controller.selectSource('screen:a'); expect(f.operations()).not.toContain('select_display');
  f.controller.cancelSourceChoice(); expect(f.state().stage).toBe('paused'); expect(f.operations()).not.toContain('resume');
});
for (const operation of ['suspend', 'resume', 'select_display'] as const) {
  it(`resolves one lost ${operation} ACK by snapshot without replaying`, async () => {
    const f = fixture(); await f.connect();
    if (operation !== 'suspend') await f.controller.pauseSource();
    if (operation === 'select_display') await f.controller.chooseSource();
    f.model.lostAck = operation;
    if (operation === 'suspend') await f.controller.pauseSource();
    else if (operation === 'resume') await f.controller.resumeSource();
    else await f.controller.selectSource('screen:b');
    expect(f.operations().filter(op => op === operation)).toHaveLength(1);
    expect(f.state().stage).toBe(operation === 'suspend' ? 'paused' : 'connecting');
  });
  it(`waits for in-flight ${operation} before detach and discards its late outcome`, async () => {
    const f = fixture(); await f.connect();
    if (operation !== 'suspend') await f.controller.pauseSource();
    if (operation === 'select_display') await f.controller.chooseSource();
    const pending = deferred<Reply>();
    f.request.mockImplementation((...args) => args[1].op === operation ? pending.promise : f.handle(...args));
    const work = operation === 'suspend' ? f.controller.pauseSource() : operation === 'resume' ? f.controller.resumeSource() : f.controller.selectSource('screen:b');
    await Promise.resolve(); await Promise.resolve(); f.controller.close();
    expect(f.state().stage).toBe('closed'); expect(f.commands.at(-1)).toEqual({ kind: 'stop' });
    expect(f.operations()).not.toContain('detach');
    pending.resolve(f.snapshot()); await work; await Promise.resolve();
    expect(f.operations().filter(op => op === 'detach')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000); expect(f.state().stage).toBe('closed');
  });
}
it('does not replay a rejected CAS or resume an unconfirmed selected display', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture(); await f.connect(); await f.controller.pauseSource(); await f.controller.chooseSource();
    if (uncertain) f.request.mockImplementation((...args) => args[1].op === 'select_display' ? Promise.reject(new Error('delivery_unknown')) : f.handle(...args));
    else f.model.denied = 'select_display';
    await f.controller.selectSource('screen:b');
    expect(f.state()).toMatchObject({ stage: 'failed', error: uncertain ? 'delivery_unknown' : 'stale_revision' });
    expect(f.operations().filter(op => op === 'select_display')).toHaveLength(1); expect(f.operations()).not.toContain('resume');
  }
});
it('fences an asynchronous TURN result after close and an old poll rejection across pause/resume', async () => {
  const f = fixture(); const pending = deferred<Awaited<ReturnType<DesktopControllerPorts['turn']>>>();
  f.turn.mockReturnValueOnce(pending.promise); await f.connect();
  // A presented frame cannot precede a started renderer; establish a normal
  // connection, then hold an already in-flight observing-state read instead.
  f.controller.close();
  pending.resolve({ target_device_id: 'mac', attach_id: 'id1', expires_at: 2000000000, ice_servers: [] });
  await Promise.resolve(); expect(f.commands.some(command => command.kind === 'start')).toBe(false);
  const g = fixture(); await g.connect();
  const oldPoll = deferred<Reply>(); g.request.mockReturnValueOnce(oldPoll.promise);
  await vi.advanceTimersByTimeAsync(350);
  await g.controller.pauseSource(); await g.controller.resumeSource();
  oldPoll.reject(new Error('media_unreachable')); await Promise.resolve(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(350); await g.presented(); expect(g.state().stage).toBe('observing');
});
it('ignores an old signal rejection after the source has resumed on a new connection', async () => {
  const f = fixture(); await f.connect();
  const pending = deferred<Reply>();
  f.request.mockImplementation((...args) => args[1].op === 'signal' ? pending.promise : f.handle(...args));
  const signal = f.receive({ kind: 'answer', answer_sdp: 'old answer' });
  await f.controller.pauseSource(); await f.controller.resumeSource();
  pending.reject(new Error('delivery_unknown')); await signal;
  await vi.advanceTimersByTimeAsync(350); await f.presented();
  expect(f.state()).toMatchObject({ stage: 'observing', controlState: 'viewing' });
  expect(f.operations().filter(op => op === 'signal')).toHaveLength(1);
});
it('rejects a source ACK for a different target or unchanged connection without starting or falling back', async () => {
  for (const operation of ['select_display', 'resume'] as const) {
    const f = fixture(); await f.connect(); await f.controller.pauseSource();
    if (operation === 'select_display') await f.controller.chooseSource();
    f.request.mockImplementation((...args) => args[1].op === operation ? Promise.resolve(f.snapshot()) : f.handle(...args));
    if (operation === 'select_display') await f.controller.selectSource('screen:b');
    else await f.controller.resumeSource();
    expect(f.state()).toMatchObject({ stage: 'failed', error: 'delivery_unknown' });
    expect(f.commands.filter(command => command.kind === 'start')).toHaveLength(1);
    expect(f.operations().filter(op => op === operation)).toHaveLength(1);
    if (operation === 'select_display') expect(f.operations()).not.toContain('resume');
  }
});
it('refuses a changed native context during source mutation instead of adopting its authority', async () => {
  const f = fixture(); await f.connect(); await f.controller.pauseSource();
  f.request.mockImplementation(async (...args) => {
    const reply = await f.handle(...args);
    return args[1].op === 'resume' ? { ...reply, context: { ...context, socket_generation: '4' } } : reply;
  });
  await f.controller.resumeSource();
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'controller_context_changed' });
  expect(f.request.mock.calls.at(-1)?.[2]).toEqual(context);
  expect(f.commands.filter(command => command.kind === 'start')).toHaveLength(1);
});
it('ends on host retention expiry even with a directory read pending, and ignores its late result', async () => {
  const f = fixture(); await f.connect(); await f.controller.pauseSource();
  const pending = deferred<Reply>(); f.request.mockReturnValueOnce(pending.promise);
  const choice = f.controller.chooseSource(); f.model.attached = false;
  await vi.advanceTimersByTimeAsync(350); expect(f.state()).toMatchObject({ stage: 'failed', error: 'sharing_ended' });
  pending.resolve({ context, payload: { state_revision: 'late', displays: f.model.displays } }); await choice;
  expect(f.state().stage).toBe('failed'); expect(f.operations()).not.toContain('select_display');
});
it('fences source discovery on account invalidation and rejects duplicate catalog entries', async () => {
  const f = fixture(); await f.connect(); await f.controller.pauseSource();
  const pending = deferred<Reply>(); f.request.mockReturnValueOnce(pending.promise);
  const choice = f.controller.chooseSource(); f.invalidate();
  pending.resolve({ context, payload: { state_revision: 'late', displays: f.model.displays } }); await choice;
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'controller_context_changed' });
  const g = fixture(); await g.connect(); await g.controller.pauseSource(); g.model.displays.push(g.model.displays[0]);
  await g.controller.chooseSource(); expect(g.state()).toMatchObject({ stage: 'failed', error: 'invalid_response' });
});
it('bounds a pending cleanup and never lets its paused resume button become available', async () => {
  const f = fixture(); await f.connect(); f.model.cleanup = true; await f.controller.pauseSource();
  await vi.advanceTimersByTimeAsync(60500);
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'cleanup_pending' }); expect(f.operations()).not.toContain('resume');
});
it('pauses a hidden live scene and resumes only viewing with a new PC when it becomes visible', async () => {
  const f = fixture(); await f.connect(); await f.control();
  f.controller.setVisible(false); await vi.waitFor(() => expect(f.state().stage).toBe('paused'));
  expect(f.state().controlGeneration).toBe(''); expect(f.operations().filter(op => op === 'suspend')).toHaveLength(1);
  await f.controller.acquireControl(); expect(f.state().controlState).toBe('viewing');
  f.controller.setVisible(true); f.controller.setVisible(true);
  await vi.waitFor(() => expect(f.state().stage).toBe('connecting'));
  await vi.advanceTimersByTimeAsync(350); await f.presented();
  expect(f.state()).toMatchObject({ stage: 'observing', rendererId: 'id3', controlState: 'viewing' });
  expect(f.operations().filter(op => op === 'resume')).toHaveLength(1);
  expect(f.commands.filter(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toHaveLength(1);
});
it('defers a quick return until the pending pause ACK and real cleanup, then resumes once', async () => {
  const f = fixture(); await f.connect();
  const pending = deferred<Reply>();
  f.request.mockImplementation((...args) => args[1].op === 'suspend' ? pending.promise : f.handle(...args));
  f.controller.setVisible(false); await Promise.resolve(); await Promise.resolve(); f.controller.setVisible(true);
  expect(f.operations()).not.toContain('resume');
  f.model.phase = 'suspended'; f.model.cleanup = true; pending.resolve(f.snapshot());
  await vi.waitFor(() => expect(f.state().stage).toBe('pausing'));
  await vi.advanceTimersByTimeAsync(350); expect(f.operations()).not.toContain('resume');
  f.model.cleanup = false; await vi.advanceTimersByTimeAsync(350);
  expect(f.state().stage).toBe('connecting'); expect(f.operations().filter(op => op === 'resume')).toHaveLength(1);
});
it('preserves a manual pause or canceled display choice across hiding without auto-resuming', async () => {
  const f = fixture(); await f.connect(); await f.controller.pauseSource(); await f.controller.chooseSource();
  f.controller.setVisible(false); expect(f.state().stage).toBe('paused'); f.controller.setVisible(true);
  await vi.advanceTimersByTimeAsync(350);
  expect(f.state().stage).toBe('paused'); expect(f.operations()).not.toContain('resume');
});
it('requires explicit reconnection after hidden retention expires or a legacy view closes', async () => {
  for (const lifecycle of [false, true]) {
    const f = fixture(lifecycle); await f.connect(); f.controller.setVisible(false);
    if (lifecycle) {
      await vi.waitFor(() => expect(f.state().stage).toBe('paused'));
      f.model.attached = false; await vi.advanceTimersByTimeAsync(350); expect(f.state().stage).toBe('failed');
    } else expect(f.state().stage).toBe('closed');
    const before = f.request.mock.calls.length;
    f.controller.setVisible(true); await vi.advanceTimersByTimeAsync(700);
    expect(f.request.mock.calls.length).toBe(before); expect(f.operations()).not.toContain('resume');
    expect(f.operations().filter(op => op === 'attach')).toHaveLength(1);
  }
});
it('retires an in-flight automatic resume if hidden again and never revives its late ACK', async () => {
  const f = fixture(); await f.connect(); f.controller.setVisible(false);
  await vi.waitFor(() => expect(f.state().stage).toBe('paused'));
  const pending = deferred<Reply>();
  f.request.mockImplementation((...args) => args[1].op === 'resume' ? pending.promise : f.handle(...args));
  f.controller.setVisible(true); await Promise.resolve(); await Promise.resolve();
  expect(f.state().stage).toBe('resuming'); f.controller.setVisible(false);
  expect(f.state().stage).toBe('closed'); expect(f.operations()).not.toContain('detach');
  pending.resolve(f.snapshot()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(350); f.controller.setVisible(true);
  expect(f.state().stage).toBe('closed'); expect(f.operations().filter(op => op === 'resume')).toHaveLength(1);
  expect(f.operations().filter(op => op === 'detach')).toHaveLength(1);
});

it('rebuilds expiring credentials only after drainage and requires a new view-only first frame', async () => {
  const f = fixture(true, true); await f.connect(); await f.control();
  const old = { renderer_id: f.state().rendererId, attach_id: 'id1', connection_id: f.model.connection };
  f.model.cleanup = true; f.clock.uptime = 240001;
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.state()).toMatchObject({ stage: 'pausing', controlState: 'viewing', controlGeneration: '', rendererId: '' });
  expect(f.operations().filter(op => op === 'suspend')).toHaveLength(1);
  expect(f.operations()).not.toContain('resume');
  await f.receive({ kind: 'first_frame_presented', width: 1, height: 1 }, old);
  expect(f.state().stage).toBe('pausing');
  f.model.cleanup = false; await vi.advanceTimersByTimeAsync(350);
  expect(f.operations().filter(op => op === 'resume')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(350);
  expect(f.turn).toHaveBeenCalledTimes(2);
  expect(f.state().stage).toBe('connecting');
  expect(f.model.connection).not.toBe(old.connection_id);
  expect(f.state().rendererId).not.toBe(old.renderer_id);
  await f.presented(); expect(f.state()).toMatchObject({ stage: 'observing', controlState: 'viewing', controlGeneration: '' });
  expect(f.commands.filter(command => command.kind === 'control' && command.body.kind === 'acquire_control')).toHaveLength(1);
  expect(f.operations().filter(op => op === 'attach')).toHaveLength(1);
  f.controller.close();
});
it('keeps an explicit manual pause across expiry', async () => {
  const f = fixture(true, true); await f.connect(); await f.controller.pauseSource();
  f.clock.uptime = 400000; await vi.advanceTimersByTimeAsync(1000);
  expect(f.state().stage).toBe('paused'); expect(f.operations()).not.toContain('resume'); f.controller.close();
});
for (const reason of ['hide', 'close', 'account']) it(`does not auto-resume credential drainage after ${reason}`, async () => {
  const f = fixture(true, true); await f.connect(); f.model.cleanup = true; f.clock.uptime = 240001;
  await vi.advanceTimersByTimeAsync(1000); expect(f.state().stage).toBe('pausing');
  if (reason === 'hide') f.controller.setVisible(false);
  else if (reason === 'account') f.invalidate(); else f.controller.close();
  f.model.cleanup = false; await vi.advanceTimersByTimeAsync(350);
  expect(f.operations()).not.toContain('resume'); f.controller.close();
});
for (const remaining of [undefined, null, -1, 660001, NaN, 1.5]) it(`rejects an invalid advertised credential budget: ${String(remaining)}`, async () => {
  const f = fixture(true, true); f.model.remaining = remaining as number; await f.connect();
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'invalid_response' });
  expect(f.commands.some(command => command.kind === 'start')).toBe(false); f.controller.close();
});
it('does not loop when controller credentials cannot outlive the rebuild margin', async () => {
  const f = fixture(true, true);
  f.turn.mockImplementation(async () => ({ target_device_id: 'mac', attach_id: 'id1', expires_at: Math.floor(Date.now() / 1000) + 30,
    ice_servers: [{ urls: ['turn:example.invalid'], username: 'short', credential: 'scoped' }] }));
  await f.connect(); expect(f.state()).toMatchObject({ stage: 'failed', error: 'turn_credentials_expired' });
  expect(f.operations()).not.toContain('resume'); f.controller.close();
});
it('does not extend the credential budget after a calendar rollback', async () => {
  const f = fixture(true, true); await f.connect();
  vi.setSystemTime(Date.now() - 3600000); f.clock.uptime = 240001;
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.operations().filter(op => op === 'suspend')).toHaveLength(1);
  expect(f.operations().filter(op => op === 'resume')).toHaveLength(1); f.controller.close();
});
it('uses the shorter host lifetime despite later controller TURN credentials', async () => {
  const f = fixture(true, true); f.model.remaining = 61000; await f.connect();
  f.model.remaining = 300000; f.clock.uptime = 1001;
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.operations().filter(op => op === 'resume')).toHaveLength(1); f.controller.close();
});
it('charges a delayed state response to the credential budget', async () => {
  const f = fixture(true, true); await f.connect(); const pending = deferred<Reply>();
  f.request.mockImplementation((...args) => args[1].op === 'get_state' ? pending.promise : f.handle(...args));
  await vi.advanceTimersByTimeAsync(1000); f.clock.uptime = 300001;
  pending.resolve(f.snapshot()); await vi.advanceTimersByTimeAsync(0);
  expect(f.state()).toMatchObject({ stage: 'failed', error: 'turn_credentials_expired' });
  expect(f.operations()).not.toContain('resume'); f.controller.close();
});
it('requires both lifecycle and credential capabilities before using the new path', async () => {
  const f = fixture(false, true); f.model.remaining = 1; await f.connect();
  f.clock.uptime = 400000; await vi.advanceTimersByTimeAsync(1000);
  expect(f.state().stage).toBe('observing'); expect(f.operations()).not.toContain('suspend'); f.controller.close();
});
