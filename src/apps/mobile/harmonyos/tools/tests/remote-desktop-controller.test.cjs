const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/RemoteDesktopService.ets'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const models = {};
new Function('exports', ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/model/RemoteDesktopModels.ets'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText)(models);
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(context) {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls = [], commands = [], projections = [], channels = [], logs = [], clock = { uptime: 0 }; let id = 0, binding;
  const exports = {};
  new Function('require', 'exports', js)(name => name === '../model/RemoteDesktopModels' ? models : name === './Encoding' ? { Encoding: {
    randomBytes: () => Uint8Array.from({ length: 16 }, () => ++id), parseJsonObject: JSON.parse, utf8ToBytes: value => Buffer.from(value)
  } } : name === './RemoteDesktopGestureClock' ? { RemoteDesktopGestureClock: { now: () => clock.uptime } } : name === './RemoteLogger' ? { RemoteLogger: { info: value => logs.push(value), warn: value => logs.push(value) } } : {}, exports);
  const client = { async listDevices() { return client.devices ?? [{ deviceId: 'desktop', deviceKind: 'desktop', deviceName: 'Computer', online: true }]; }, async remoteDesktopChannel() {
    const index = channels.length;
    const channel = { live: true, closed: false, current() { return this.live; }, close() { this.closed = true; this.live = false; },
      async call(request, attachment) {
        if (!this.current()) throw new Error('account_changed');
        calls.push({ request, attachment, channel: index });
        // Match ReadOnlyRequest::matches_route_attachment: discovery is unscoped.
        if (['capabilities', 'list_displays'].includes(request.op) && attachment) throw new Error('invalid_request');
        if (request.op === 'get_state' && !attachment) return { state: client.setupState ? await client.setupState() : { state_revision: 'boot:0', busy: false, cleanup_pending: false, attachment: null } };
        if (client.override) { const result = client.override(request, attachment); if (result !== undefined) return result; }
        if (request.op === 'capabilities') return { protocol_versions: [1], capabilities: ['read_only_video_v1', 'gathered_sdp_v1'], authorization: 'view', availability: 'ready' };
        if (request.op === 'list_displays') return { state_revision: 'boot:0', displays: [{ display_id: 'display', width: 1280, height: 830 }] };
        if (request.op === 'attach' || request.op === 'get_state') return { state: { attachment: { attach_id: attachment, connection_id: `pc-${attachment}` } }, media: { offer_sdp: 'offer', source_first_frame: true } };
        return {};
      }, async turn() { return { ice_servers: [{ urls: ['turn:trial:3478'], username: 'short', credential: 'short' }] }; }
    }; channels.push(channel); return channel;
  } };
  binding = { session: { token: 'account-token', userId: 'user-a' }, relayUrl: 'https://trial', client };
  const service = new exports.RemoteDesktopService({ binding: () => binding, renderer: command => commands.push(JSON.parse(command)), update: state => projections.push({ ...state }) });
  return { service, client, calls, commands, channels, logs, clock, Service: exports.RemoteDesktopService, switchAccount() { binding = { ...binding, session: { token: 'replacement', userId: 'user-b' } }; },
    setBinding(value) { binding = value; }, get binding() { return binding; }, get state() { return projections.at(-1); }, device: { deviceId: 'desktop', deviceKind: 'desktop', online: true, deviceName: 'Computer' } };
}
function epoch(f) { return [...f.commands].reverse().find(command => ['control', 'start'].includes(command.kind))?.control_epoch; }
async function connect(f, context) {
  await f.service.open(f.device); await f.service.receive('{"kind":"bridge_ready","capabilities":["control_epoch_v1"]}'); await f.service.attach('display', true);
  context.mock.timers.tick(350); await settle(); return f.commands.filter(command => command.kind === 'start').at(-1);
}

test('native display IDs remain opaque and unsafe provider errors never enter diagnostics', async context => {
  const f = fixture(context);
  try {
    f.client.override = request => request.op === 'list_displays' ? {
      state_revision: 'boot:1', displays: [{ display_id: 'macos:37d8832a-2d66-02ca-b9f7-8f30a301b230', width: 1512, height: 982 }]
    } : undefined;
    await f.service.open(f.device);
    assert.equal(f.state.stage, 'choose_display');
    f.client.override = request => { if (request.op === 'capabilities') throw new Error('Bearer secret-fixture-content'); };
    await f.service.open(f.device);
    assert.equal(f.state.stage, 'failed');
    assert.ok(f.logs.some(value => value.includes('code=unclassified')));
    assert.ok(f.logs.every(value => !value.includes('secret-fixture-content')));
  } finally { f.service.close(); }
});

for (const stage of ['channel', 'ice_486', 'private-address-or-credential', undefined]) {
  test(`renderer failure diagnostics retain only current fixed stage ${String(stage)}`, async context => {
    const f = fixture(context);
    try {
      const current = await connect(f, context), before = f.logs.length;
      await f.service.receive(JSON.stringify({ ...current, kind: 'failed', connection_id: 'retired', stage, code: 'media_unreachable' }));
      assert.equal(f.logs.length, before);
      await f.service.receive(JSON.stringify({ ...current, kind: 'failed', stage, code: 'media_unreachable' }));
      await settle();
      assert.equal(f.state.stage, 'failed');
      assert.equal(f.state.errorCode, 'media_unreachable');
      assert.equal(f.commands.at(-1).kind, 'stop');
      assert.ok(f.logs.includes(`remote desktop renderer failed stage=${['channel', 'ice_486'].includes(stage) ? stage : 'unknown'}`));
      assert.ok(f.logs.every(value => !value.includes('private-address-or-credential')));
    } finally { f.service.close(); }
  });
}

for (const operation of ['capabilities', 'list_displays', 'attach', 'get_state', 'turn', 'signal', 'attach_snapshot']) {
  test(`invalid_request diagnostics identify ${operation} without replay or wire content`, async context => {
    const f = fixture(context);
    const failedOperation = operation === 'attach_snapshot' ? 'get_state' : operation;
    f.client.override = request => {
      if (operation === 'attach_snapshot' && request.op === 'attach') throw new Error('delivery_unknown');
      if (request.op === failedOperation) throw new Error('invalid_request');
    };
    try {
      await f.service.open(f.device);
      if (f.state.stage === 'choose_display') {
        f.channels[0].turn = async () => {
          if (operation === 'turn') throw new Error('invalid_request');
          return { ice_servers: [] };
        };
        await f.service.receive('{"kind":"bridge_ready","capabilities":["control_epoch_v1"]}');
        await f.service.attach('display', false);
        context.mock.timers.tick(350); await settle();
        if (operation === 'signal') {
          const config = f.commands.find(command => command.kind === 'start');
          await f.service.receive(JSON.stringify({ ...config, kind: 'answer', answer_sdp: 'private-answer-content' }));
        }
      }
      assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'invalid_request');
      const failures = f.logs.filter(value => value.startsWith('remote desktop failed'));
      assert.equal(failures.length, 1);
      assert.ok(failures[0].endsWith(`origin=${failedOperation} code=invalid_request`));
      assert.ok(f.logs.every(value => !/account-token|private-answer-content|pc-/.test(value)));
      assert.ok(f.calls.filter(call => call.request.op === 'attach').length <= 1);
      assert.equal(f.commands.at(-1).kind, 'stop');
    } finally { f.service.close(); await settle(); }
  });
}

for (const availability of ['permission_required','host_locked','media_backend_unavailable']) {
  test(`host availability ${availability} does not become a protocol mismatch`, async context => {
    const f = fixture(context);
    f.client.override = request => request.op === 'capabilities'
      ? {protocol_versions:[1],capabilities:[],authorization:'view',availability} : undefined;
    try { await f.service.open(f.device); assert.equal(f.state.errorCode,availability); }
    finally { f.service.close(); }
  });
}
test('display selection scopes the answer; negotiation is distinct from presentation and forced TURN is checked', async context => {
  const f = fixture(context);
  try {
    const config = await connect(f, context); assert.ok(config); assert.equal(config.force_relay, true); assert.equal(f.state.stage, 'connecting');
    await f.service.receive(JSON.stringify({ ...config, kind: 'answer', answer_sdp: 'answer' }));
    assert.equal(f.calls.filter(call => call.request.op === 'signal').length, 1); assert.equal(f.state.stage, 'connecting');
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 })); assert.equal(f.state.stage, 'observing');
    await f.service.receive(JSON.stringify({ ...config, kind: 'health', candidate_type: 'host', remote_candidate_type: 'relay' }));
    assert.equal(f.state.errorCode, 'relay_not_selected'); assert.equal(f.state.stage, 'failed');
  } finally { f.service.close(); await settle(); }
});
test('background while probe is pending cancels before display lookup', async context => {
  const f = fixture(context), pending = deferred(); f.client.override = request => request.op === 'capabilities' ? pending.promise : undefined;
  const opening = f.service.open(f.device); await settle(); f.Service.onLifecycle(false);
  pending.resolve({ protocol_versions: [1], capabilities: ['read_only_video_v1', 'gathered_sdp_v1'], authorization: 'view', availability: 'ready' }); await opening;
  assert.equal(f.state.stage, 'closed'); assert.equal(f.calls.some(call => call.request.op === 'list_displays'), false); assert.equal(f.channels[0].closed, true);
});
test('account switch closes local media before a late frame can publish observing', async context => {
  const f = fixture(context);
  try {
    const config = await connect(f, context); f.switchAccount(); context.mock.timers.tick(250); await settle();
    assert.equal(f.commands.at(-1).kind, 'stop'); assert.equal(f.state.stage, 'closed');
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 })); assert.equal(f.state.stage, 'closed'); assert.equal(f.channels[0].closed, true);
  } finally { f.service.close(); }
});
test('lost attach ACK reads snapshot without replaying the mutation', async context => {
  const f = fixture(context);
  try {
    f.client.override = request => request.op === 'attach' ? Promise.reject(new Error('delivery_unknown')) : undefined;
    await f.service.open(f.device); await f.service.attach('display', false);
    assert.equal(f.calls.filter(call => call.request.op === 'attach').length, 1); assert.equal(f.calls.filter(call => call.request.op === 'get_state').length, 1); assert.equal(f.state.stage, 'connecting');
  } finally { f.service.close(); await settle(); }
});
for (const code of ['stale_revision', 'attachment_busy', 'cleanup_pending', 'device_approval_required', 'target_unavailable']) {
  test(`explicit attach rejection ${code} is preserved without mutation recovery`, async context => {
    const f = fixture(context);
    try {
      f.client.override = request => request.op === 'attach' ? Promise.reject(new Error(code)) : undefined;
      await f.service.open(f.device); await f.service.attach('display', false);
      assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, code);
      assert.equal(f.calls.filter(call => call.request.op === 'attach').length, 1);
      assert.equal(f.calls.some(call => call.request.op === 'get_state'), false);
      assert.equal(f.commands.some(command => command.kind === 'start'), false);
    } finally { f.service.close(); await settle(); }
  });
}
test('late TURN credentials after close cannot start media', async context => {
  const f = fixture(context), pending = deferred();
  await f.service.open(f.device); f.channels[0].turn = () => pending.promise;
  await f.service.receive('{"kind":"bridge_ready","capabilities":["control_epoch_v1"]}'); await f.service.attach('display', false);
  context.mock.timers.tick(350); await settle(); f.service.close(); pending.resolve({ ice_servers: [] }); await settle();
  assert.equal(f.commands.some(command => command.kind === 'start'), false); assert.equal(f.state.stage, 'closed');
});
test('CLI, mobile and watch fail before dispatch; legacy unknown-kind target is probed', async context => {
  const f = fixture(context);
  try {
    for (const deviceKind of ['cli', 'mobile', 'watch']) { await f.service.open({ ...f.device, deviceKind }); assert.equal(f.state.errorCode, 'unsupported'); }
    assert.equal(f.calls.length, 0); await f.service.open({ ...f.device, deviceKind: undefined }); assert.equal(f.state.stage, 'choose_display');
  } finally { f.service.close(); }
});
test('old renderer close and delayed answer failure cannot end a successor', async context => {
  const f = fixture(context), pending = deferred();
  try {
    const old = await connect(f, context); f.client.override = request => request.op === 'signal' ? pending.promise : undefined;
    const reply = f.service.receive(JSON.stringify({ ...old, kind: 'answer', answer_sdp: 'answer' })); await settle(); f.service.close(); await settle();
    const next = await connect(f, context); assert.notEqual(next.renderer_id, old.renderer_id);
    await f.service.receive(JSON.stringify({ ...old, kind: 'bridge_closed' })); pending.reject(new Error('old-answer-failed')); await reply;
    assert.equal(f.state.stage, 'connecting'); await f.service.receive(JSON.stringify({ ...next, kind: 'first_frame_presented', width: 1280, height: 830 })); assert.equal(f.state.stage, 'observing');
    assert.equal(f.logs.some(value => value.startsWith('remote desktop failed')), false);
  } finally { f.service.close(); await settle(); }
});

test('legacy view-only hosts never receive control or keyboard commands', async context => {
  const f = fixture(context);
  try {
    const config = await connect(f, context);
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.acquireControl();
    f.service.input({ control_generation: '1', kind: 'key', body: { usage: 40, down: true } });
    assert.equal(f.commands.some(command => command.kind === 'control'), false);
    assert.equal(f.state.controlSupported, false);
  } finally { f.service.close(); }
});
function controlHost(f) {
  f.client.override = (request, attachment) => {
    if (request.op === 'capabilities') return { protocol_versions: [1], capabilities: ['read_only_video_v1', 'gathered_sdp_v1', 'ordered_control_v1', 'text_commit_v1'], authorization: 'view', availability: 'ready' };
    if (request.op === 'get_state') return { state: { state_revision: 'boot:42', attachment: { attach_id: attachment, connection_id: `pc-${attachment}` } }, media: { offer_sdp: 'offer', source_first_frame: true } };
  };
}
test('explicit control reads fresh CAS and old native intents cannot cross releases', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const config = await connect(f, context);
    assert.equal(config.control_supported, true);
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    assert.equal(f.commands.some(command => command.kind === 'control'), false);
    await f.service.acquireControl();
    assert.equal(f.state.controlState, 'acquiring');
    assert.equal(f.commands.at(-1).body.expected_state_revision, 'boot:42');
    await f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), pending: 'acquire_control', code: 'ok' }));
    assert.equal(f.state.controlState, 'acquiring');
    await f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), control_generation: '3', code: 'ok' }));
    const old = { renderer_id: config.renderer_id, control_generation: '3', kind: 'key', body: { usage: 40, down: true } };
    f.service.input(old); assert.deepEqual(f.commands.at(-1).body, { control_generation: old.control_generation, kind: old.kind, body: old.body });
    f.service.releaseControl(); assert.equal(f.state.controlGeneration, '');
    const count = f.commands.length; f.service.input(old); assert.equal(f.commands.length, count);
    await f.service.acquireControl();
    await f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), control_generation: '5', code: 'ok' }));
    const before = f.commands.length; f.service.input(old); assert.equal(f.commands.length, before);
    f.service.input({ ...old, control_generation: '5' }); assert.equal(f.commands.length, before + 1);
    f.Service.onLifecycle(false); assert.equal(f.state.controlGeneration, ''); assert.equal(f.commands.at(-1).kind, 'stop');
    await f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), control_generation: '5' }));
    assert.equal(f.state.stage, 'closed');
  } finally { f.service.close(); }
});
test('release while fresh CAS is pending cannot send a late acquire', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const config = await connect(f, context);
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    const pending = deferred(); f.client.override = request => request.op === 'get_state' ? pending.promise : undefined;
    const acquiring = f.service.acquireControl(); await settle(); f.service.releaseControl();
    pending.resolve({ state: { state_revision: 'boot:42', attachment: { attach_id: config.attach_id, connection_id: config.connection_id } } });
    await acquiring;
    assert.equal(f.commands.some(command => command.body?.kind === 'acquire_control'), false);
    assert.equal(f.state.controlState, 'viewing');
  } finally { f.service.close(); }
});
test('a local input failure stays visible through release cleanup until explicit acquisition', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const config = await connect(f, context);
    const deliver = state => f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), ...state }));
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.acquireControl(); await deliver({ control_generation: '3', code: 'ok' });
    f.service.releaseControl('input_suspended');
    assert.equal(f.state.controlError, 'input_suspended'); assert.equal(f.state.controlGeneration, '');
    assert.equal(f.commands.at(-1).body.kind, 'release_control');
    await deliver({ pending: 'release_control', code: 'ok' }); await deliver({ code: 'ok' });
    assert.equal(f.state.controlState, 'viewing'); assert.equal(f.state.controlError, 'input_suspended');
    await f.service.acquireControl(); assert.equal(f.state.controlError, '');
    await deliver({ control_generation: '5', code: 'ok' }); assert.equal(f.state.controlGeneration, '5');
  } finally { f.service.close(); }
});
test('unsolicited control success closes media instead of accepting authority', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const config = await connect(f, context);
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), control_generation: '1', code: 'ok' }));
    assert.equal(f.state.controlGeneration, ''); assert.equal(f.state.stage, 'failed');
    assert.equal(f.state.errorCode, 'control_delivery_unknown');
  } finally { f.service.close(); }
});

test('queued renewal state cannot restore a lease after native release', async context => {
  const f = fixture(context); controlHost(f);
  const loaded = { exports: {} };
  new Function('module', fs.readFileSync(path.join(__dirname, '../../../../../shared/remote-desktop-media/control.js'), 'utf8'))(loaded);
  const { createController } = loaded.exports;
  const states = [], wire = [];
  const control = createController({ current: () => true, healthy: () => true,
    send: message => { wire.push(message); return true; }, state: state => states.push({ ...state, control_epoch: epoch(f) }),
    fail: code => assert.fail(code) });
  try {
    const config = await connect(f, context);
    const deliver = state => f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), ...state }));
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.acquireControl();
    control.acquire(f.commands.at(-1).body.expected_state_revision);
    await deliver(states.shift());
    control.receive({ version: 1, kind: 'control_result', request_id: wire.at(-1).request_id,
      code: 'ok', control_generation: '1' });
    await deliver(states.shift());
    context.mock.timers.tick(2000); await settle();
    assert.equal(states[0].pending, 'renew_control');
    f.service.releaseControl();
    await deliver(states.shift()); // The JS->native bridge was already carrying this renewal.
    assert.equal(f.state.stage, 'observing');
    assert.equal(f.state.controlState, 'viewing');
    assert.equal(f.state.controlGeneration, '');
    const count = f.commands.length;
    f.service.input({ renderer_id: config.renderer_id, control_generation: '1', kind: 'key', body: { usage: 40, down: true } });
    assert.equal(f.commands.length, count);
    control.release();
    while (states.length) await deliver(states.shift());
    control.receive({ version: 1, kind: 'control_result', request_id: wire.at(-1).request_id,
      code: 'ok', control_generation: '1' });
    await deliver(states.shift());
    assert.equal(f.state.stage, 'observing');
    await f.service.acquireControl();
    control.acquire(f.commands.at(-1).body.expected_state_revision);
    await deliver(states.shift());
    control.receive({ version: 1, kind: 'control_result', request_id: wire.at(-1).request_id,
      code: 'ok', control_generation: '3' });
    await deliver(states.shift());
    await deliver({ control_generation: '1', pending: 'renew_control', code: 'ok' });
    assert.equal(f.state.controlGeneration, '3');
    assert.equal(f.state.stage, 'observing');
  } finally { control.stop(); f.service.close(); }
});

test('a late state from a revoked lease is ignored but an unknown grant still closes media', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const config = await connect(f, context);
    const deliver = state => f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), ...state }));
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.acquireControl();
    await deliver({ control_generation: '1', code: 'ok' });
    await deliver({ code: 'control_revoked' });
    await deliver({ control_generation: '1', pending: 'renew_control', code: 'ok' });
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.controlGeneration, '');
    await deliver({ control_generation: '99', code: 'ok' });
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'control_delivery_unknown');
  } finally { f.service.close(); }
});

test('cancelling an unconfirmed acquisition cannot bless a late unknown grant', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const config = await connect(f, context);
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.acquireControl(); f.service.releaseControl();
    await f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), control_generation: '1', code: 'ok' }));
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'control_delivery_unknown');
  } finally { f.service.close(); }
});

test('a new PC reusing the same lease number cannot adopt an old native intent', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const old = await connect(f, context);
    await f.service.receive(JSON.stringify({ ...old, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.acquireControl();
    await f.service.receive(JSON.stringify({ ...old, kind: 'control_state', control_epoch: epoch(f), control_generation: '1', code: 'ok' }));
    const input = { renderer_id: old.renderer_id, control_generation: '1', kind: 'key', body: { usage: 40, down: true } };
    f.service.close(); const next = await connect(f, context);
    await f.service.receive(JSON.stringify({ ...next, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.acquireControl();
    await f.service.receive(JSON.stringify({ ...next, kind: 'control_state', control_epoch: epoch(f), control_generation: '1', code: 'ok' }));
    const count = f.commands.length; f.service.input(input); assert.equal(f.commands.length, count);
    f.service.input({ ...input, renderer_id: next.renderer_id }); assert.equal(f.commands.length, count + 1);
    assert.equal(f.commands.at(-1).body.renderer_id, undefined, 'Local identity must not expand the input wire');
  } finally { f.service.close(); }
});

for (const reason of ['close', 'background']) for (const outcome of ['accepted', 'delivery_unknown']) {
  test(`${reason} waits for an in-flight attach before retiring it after ${outcome}`, async context => {
    const f = fixture(context), pending = deferred(), detached = deferred();
    try {
      await f.service.open(f.device); await f.service.receive('{"kind":"bridge_ready","capabilities":["control_epoch_v1"]}');
      f.client.override = request => request.op === 'attach' ? pending.promise : request.op === 'detach' ? detached.promise : undefined;
      const attaching = f.service.attach('display', true); await settle();
      const request = f.calls.find(call => call.request.op === 'attach');
      if (reason === 'background') f.Service.onLifecycle(false); else f.service.close();
      f.service.close(); // Duplicate lifecycle events cannot duplicate cleanup.
      assert.equal(f.state.stage, 'closed'); assert.equal(f.commands.at(-1).kind, 'stop');
      assert.equal(f.calls.some(call => call.request.op === 'detach'), false, 'Detach overtook the pending attach');
      assert.equal(f.channels[0].closed, false, 'Retain only the old bounded request owner until cleanup');
      if (outcome === 'accepted') pending.resolve({ state: { attachment: {
        attach_id: request.attachment, connection_id: `pc-${request.attachment}` } } });
      else pending.reject(new Error('delivery_unknown'));
      await attaching; await settle();
      assert.deepEqual(f.calls.filter(call => call.request.op === 'detach'), [{
        channel: 0, attachment: request.attachment,
        request: { version: 1, op: 'detach', body: { attach_id: request.attachment } }
      }]);
      assert.equal(f.channels[0].closed, false, 'Do not erase the peer key before detach settles');
      detached.resolve({}); await settle();
      assert.equal(f.channels[0].closed, true);
      context.mock.timers.tick(60000); await settle();
      assert.equal(f.state.stage, 'closed'); assert.equal(f.calls.some(call => call.request.op === 'get_state'), false);
      assert.equal(f.calls.filter(call => call.request.op === 'attach').length, 1);
      assert.equal(f.commands.some(command => command.kind === 'start'), false);
    } finally { pending.resolve({}); detached.resolve({}); f.service.close(); await settle(); }
  });
}
test('a retired attach completion cleans up through its own channel without closing a successor', async context => {
  const f = fixture(context), pending = deferred();
  try {
    await f.service.open(f.device);
    f.client.override = request => request.op === 'attach' ? pending.promise : undefined;
    const attaching = f.service.attach('display', false); await settle();
    const old = f.calls.find(call => call.request.op === 'attach');
    f.client.override = undefined;
    const config = await connect(f, context);
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    assert.equal(f.state.stage, 'observing');
    assert.equal(f.calls.some(call => call.request.op === 'detach'), false);
    pending.resolve({ state: { attachment: { attach_id: old.attachment, connection_id: 'old-pc' } } });
    await attaching; await settle();
    const cleanup = f.calls.filter(call => call.request.op === 'detach');
    assert.equal(cleanup.length, 1); assert.equal(cleanup[0].attachment, old.attachment); assert.equal(cleanup[0].channel, 0);
    assert.equal(f.channels[0].closed, true); assert.equal(f.channels[1].closed, false);
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.rendererId, config.renderer_id);
  } finally { pending.resolve({}); f.service.close(); await settle(); }
});

test('pending attach cleanup cannot borrow a replacement account connection', async context => {
  const f = fixture(context), pending = deferred();
  try {
    await f.service.open(f.device);
    f.client.override = request => request.op === 'attach' ? pending.promise : undefined;
    const attaching = f.service.attach('display', false); await settle();
    f.switchAccount(); f.channels[0].live = false;
    context.mock.timers.tick(250); await settle();
    assert.equal(f.state.stage, 'closed'); assert.equal(f.commands.at(-1).kind, 'stop');
    pending.reject(new Error('account_changed')); await attaching; await settle();
    assert.equal(f.channels[0].closed, true);
    assert.equal(f.calls.filter(call => call.request.op === 'detach').length, 0, 'An invalid old account cannot dispatch cleanup with a new identity');
    assert.equal(f.channels.length, 1, 'Cleanup cannot acquire a replacement channel');
  } finally { pending.resolve({}); f.service.close(); await settle(); }
});


test('explicit reconnect re-probes a fresh directory/channel and waits for a new display choice without restoring control', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const old = await connect(f, context);
    await f.service.receive(JSON.stringify({ ...old, kind:'first_frame_presented', width: 1280, height: 830 }));
    f.Service.onLifecycle(false); await settle();
    assert.equal(f.state.canReconnect, true);
    const before=f.calls.length; context.mock.timers.tick(8000); await settle();
    assert.equal(f.calls.length, before, 'Background must not auto-reconnect');
    f.client.devices=[{...f.device,deviceName:'Fresh directory name'}];
    await f.service.reconnect();
    assert.equal(f.channels.length,2); assert.equal(f.channels[0].closed,true); assert.equal(f.channels[1].closed,false);
    assert.equal(f.state.stage,'choose_display'); assert.equal(f.state.deviceName,'Fresh directory name');
    assert.equal(f.state.canReconnect,false); assert.equal(f.state.controlState,'viewing'); assert.equal(f.state.controlGeneration,'');
    assert.equal(f.calls.filter(c=>c.request.op==='attach').length,1,'Reconnect must wait for a user display choice');
    assert.equal(f.commands.filter(c=>c.kind==='start').length,1);
    await f.service.receive(JSON.stringify({...old,kind:'first_frame_presented', width: 1280, height: 830 }));
    assert.equal(f.state.stage,'choose_display','An old frame cannot restore the retired renderer');
    await f.service.attach('display',false); context.mock.timers.tick(350); await settle();
    const fresh=f.commands.filter(c=>c.kind==='start').at(-1);
    assert.notEqual(fresh.attach_id,old.attach_id); assert.notEqual(fresh.renderer_id,old.renderer_id);
    assert.equal(fresh.force_relay,false); assert.equal(f.state.controlState,'viewing');
  } finally { f.service.close(); await settle(); }
});

test('a failed probe can retry after an explicit action without reusing a stale online flag', async context => {
  const f=fixture(context);
  try {
    await f.service.open({...f.device,online:false});
    assert.equal(f.state.errorCode,'target_unavailable'); assert.equal(f.state.canReconnect,true); assert.equal(f.channels.length,0);
    await f.service.reconnect(); assert.equal(f.state.stage,'choose_display'); assert.equal(f.channels.length,1);
  } finally { f.service.close(); }
});

for (const change of ['account','relay','close','background']) {
  test(`a pending manual reconnect cannot survive ${change} or dispatch through a replacement identity`,async context=>{
    const f=fixture(context), directory=deferred();
    try {
      await f.service.open(f.device); f.Service.onLifecycle(false); await settle();
      let lookups=0; f.client.listDevices=()=>{lookups++;return directory.promise;};
      const retry=f.service.reconnect(); await settle(); await f.service.reconnect();
      assert.equal(lookups,1,'A second click while probing must not create another retry');
      if(change==='account') f.switchAccount();
      if(change==='relay') f.setBinding({...f.binding,relayUrl:'https://other-relay'});
      if(change==='close') f.service.close();
      if(change==='background') f.Service.onLifecycle(false);
      directory.resolve([f.device]); await retry;
      assert.equal(f.channels.length,1); assert.equal(f.state.stage,'closed');
      assert.equal(f.state.canReconnect,change==='background');
    } finally { directory.resolve([]); f.service.close(); await settle(); }
  });
}

test('a retired reconnect directory reply cannot replace a newly selected computer',async context=>{
  const f=fixture(context), directory=deferred();
  try {
    await f.service.open(f.device); f.Service.onLifecycle(false);
    f.client.listDevices=()=>directory.promise;
    const retry=f.service.reconnect(); await settle();
    await f.service.open({...f.device,deviceId:'other',deviceName:'New selection'});
    directory.resolve([f.device]); await retry;
    assert.equal(f.state.deviceName,'New selection'); assert.equal(f.state.stage,'choose_display'); assert.equal(f.channels.length,2);
  } finally { directory.resolve([]); f.service.close(); await settle(); }
});

for(const devices of [[],[{deviceId:'desktop',deviceKind:'desktop',deviceName:'Offline',online:false}]]) {
  test(`a missing or offline reconnect target stays explicit and creates no new channel (${devices.length})`,async context=>{
    const f=fixture(context);
    try {
      await f.service.open(f.device); f.Service.onLifecycle(false); f.client.devices=devices;
      await f.service.reconnect();
      assert.equal(f.state.stage,'failed'); assert.equal(f.state.errorCode,'target_unavailable');
      assert.equal(f.state.canReconnect,true); assert.equal(f.channels.length,1);
    } finally { f.service.close(); }
  });
}

for(const reason of ['account','relay','explicit_exit']) {
  test(`manual reconnect after ${reason} cannot dispatch even a directory request`,async context=>{
    const f=fixture(context);
    try {
      await f.service.open(f.device); f.Service.onLifecycle(false);
      let lookups=0; f.client.listDevices=async()=>{lookups++;return [f.device];};
      if(reason==='account') f.switchAccount();
      if(reason==='relay') f.setBinding({...f.binding,relayUrl:'https://other-relay'});
      if(reason==='explicit_exit') f.service.close();
      await f.service.reconnect();
      assert.equal(lookups,0); assert.equal(f.channels.length,1); assert.equal(f.state.canReconnect,false);
    } finally { f.service.close(); }
  });
}

test('late retired-renderer events cannot cancel an explicit reconnect while its directory lookup is pending',async context=>{
  const f=fixture(context), directory=deferred();
  try {
    const old=await connect(f,context); f.Service.onLifecycle(false); await settle();
    f.client.listDevices=()=>directory.promise;
    const retry=f.service.reconnect(); await settle();
    for(const kind of ['health','first_frame_presented','control_state']) {
      await f.service.receive(JSON.stringify({...old,kind}));
      assert.equal(f.state.stage,'probing','A retired renderer callback cancelled the new user intent');
    }
    directory.resolve([f.device]); await retry;
    assert.equal(f.state.stage,'choose_display'); assert.equal(f.channels.length,2);
    assert.equal(f.state.controlState,'viewing'); assert.equal(f.state.controlGeneration,'');
  } finally { directory.resolve([]); f.service.close(); await settle(); }
});

function sourceFixture(context, renewal = false) {
  const f = fixture(context);
  const model = { phase: 'streaming', revision: 1, cleanup: false, connection: '', attachment: '', display: 'display', remaining: 300000 };
  const snapshot = () => ({ state_revision: `source:${model.revision}`, busy: true, cleanup_pending: model.cleanup,
    attachment: { attach_id: model.attachment, connection_id: model.connection, display_id: model.display, phase: model.phase,
      ...(model.quality === undefined ? {} : { quality: model.quality }) } });
  const normal = (request, attachment) => {
    if (request.op === 'capabilities') return { protocol_versions: [1], capabilities: ['read_only_video_v1', 'gathered_sdp_v1', 'source_lifecycle_v1', 'ordered_control_v1', ...(renewal ? ['credential_rebuild_v1'] : []), ...(model.quality === undefined ? [] : ['quality_presets_v1'])], authorization: 'view', availability: 'ready' };
    if (request.op === 'list_displays') return { state_revision: model.catalogRevision ?? `source:${model.revision}`, displays: model.displays ?? [{ display_id: 'display', width: 1280, height: 830 }, { display_id: 'second-display', width: 1920, height: 1080 }] };
    if (request.op === 'attach') { model.attachment = attachment; model.connection = `pc-${attachment}`; }
    if (request.op === 'attach' || request.op === 'get_state') return { state: snapshot(), media: { offer_sdp: 'offer', source_first_frame: true, ...(renewal ? { credentials_remaining_ms: model.remaining } : {}) } };
    if (request.op === 'suspend') { model.phase = 'suspended'; model.revision++; return { state: snapshot() }; }
    if (request.op === 'select_display') { model.display = request.body.display_id; model.revision++; return { state: snapshot() }; }
    if (request.op === 'set_quality') { model.quality = request.body.quality; model.revision++; return { state: snapshot() }; }
    if (request.op === 'resume') { model.phase = 'binding'; model.revision++; model.connection = `resumed-${attachment}-${model.revision}`; return { state: snapshot() }; }
  };
  f.client.override = normal;
  const fixtureChannel = f.client.remoteDesktopChannel.bind(f.client);
  if (renewal) f.client.remoteDesktopChannel = async (...args) => {
    const channel = await fixtureChannel(...args);
    channel.turn = async () => ({ expires_at: Math.floor(Date.now() / 1000) + 600, ice_servers: [{ urls: ['turn:trial:3478'], username: 'short', credential: 'short' }] });
    return channel;
  };
  return { ...f, model, normal, snapshot, get state() { return f.state; } };
}
async function sourceViewing(f, context) {
  const config = await connect(f, context);
  await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
  return config;
}

test('quality changes require the negotiated lifecycle and a drained manual pause, then an explicit new view', async context => {
  const f = sourceFixture(context); f.model.quality = 'data_saver';
  try {
    const old = await sourceViewing(f, context);
    assert.equal(f.state.qualitySupported, true);
    await f.service.setQuality('clear');
    assert.equal(f.calls.some(c => c.request.op === 'set_quality'), false);
    await f.service.acquireControl();
    await f.service.receive(JSON.stringify({ ...old, kind: 'control_state', control_epoch: epoch(f), control_generation: '10', code: 'ok' }));
    f.model.cleanup = true; await f.service.pauseSource();
    await f.service.setQuality('clear'); assert.equal(f.calls.some(c => c.request.op === 'set_quality'), false);
    f.model.cleanup = false; context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'paused'); assert.equal(f.state.controlGeneration, '');
    const count = f.commands.filter(c => c.kind === 'start').length;
    await f.service.setQuality('clear');
    assert.equal(f.state.stage, 'paused'); assert.equal(f.state.quality, 'clear');
    assert.equal(f.state.controlState, 'viewing');
    const mutations = f.calls.filter(c => c.request.op === 'set_quality');
    assert.deepEqual(mutations.map(c => ({ body: c.request.body, attachment: c.attachment })), [{
      body: { attach_id: old.attach_id, expected_state_revision: 'source:2', quality: 'clear' }, attachment: old.attach_id
    }]);
    assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
    assert.equal(f.commands.filter(c => c.kind === 'start').length, count);
    const before = f.calls.length;
    await f.service.setQuality('clear'); await f.service.setQuality('ultra');
    assert.equal(f.calls.length, before);
    await f.service.resumeSource(); context.mock.timers.tick(350); await settle();
    const next = f.commands.filter(c => c.kind === 'start').at(-1);
    assert.equal(next.attach_id, old.attach_id); assert.notEqual(next.connection_id, old.connection_id);
    assert.notEqual(next.renderer_id, old.renderer_id); assert.equal(next.force_relay, true);
    assert.equal(f.state.stage, 'connecting'); assert.equal(f.state.quality, 'clear');
    await f.service.receive(JSON.stringify({ ...old, kind: 'first_frame_presented', width: 1280, height: 830 }));
    assert.equal(f.state.stage, 'connecting');
    await f.service.receive(JSON.stringify({ ...next, kind: 'first_frame_presented', width: 1920, height: 1240 }));
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.controlState, 'viewing');
    assert.equal(f.calls.filter(c => c.request.op === 'attach').length, 1);
  } finally { f.service.close(); await settle(); }
});

test('legacy hosts and quality without source lifecycle never enable the quality mutation', async context => {
  const f = fixture(context);
  try {
    f.client.override = request => request.op === 'capabilities' ? {
      protocol_versions: [1], capabilities: ['read_only_video_v1', 'gathered_sdp_v1', 'quality_presets_v1'], authorization: 'view', availability: 'ready'
    } : undefined;
    await connect(f, context); await f.service.setQuality('balanced');
    assert.equal(f.state.qualitySupported, false);
    assert.equal(f.calls.some(c => c.request.op === 'set_quality'), false);
  } finally { f.service.close(); }
});

for (const applied of [true, false]) {
  test(`uncertain quality ACK reads one snapshot without replay or automatic resume (applied=${applied})`, async context => {
    const f = sourceFixture(context); f.model.quality = 'data_saver';
    try {
      await sourceViewing(f, context); await f.service.pauseSource();
      const before = f.calls.length;
      f.client.override = (request, attachment) => {
        if (request.op === 'set_quality') { if (applied) f.normal(request, attachment); throw new Error('delivery_unknown'); }
        return f.normal(request, attachment);
      };
      await f.service.setQuality('balanced');
      const calls = f.calls.slice(before);
      assert.equal(calls.filter(c => c.request.op === 'set_quality').length, 1);
      assert.equal(calls.filter(c => c.request.op === 'get_state').length, 2);
      assert.equal(calls.some(c => c.request.op === 'resume'), false);
      assert.equal(f.state.stage, applied ? 'paused' : 'failed');
      assert.equal(f.state.quality, applied ? 'balanced' : 'data_saver');
    } finally { f.service.close(); await settle(); }
  });
}

for (const code of ['stale_revision', 'device_approval_required', 'cleanup_pending']) {
  test(`quality refusal ${code} never claims the requested preset or resumes sharing`, async context => {
    const f = sourceFixture(context); f.model.quality = 'data_saver';
    try {
      await sourceViewing(f, context); await f.service.pauseSource();
      f.client.override = (r,a) => { if (r.op === 'set_quality') throw new Error(code); return f.normal(r,a); };
      await f.service.setQuality('clear');
      assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, code); assert.equal(f.state.quality, 'data_saver');
      assert.equal(f.calls.filter(c => c.request.op === 'set_quality').length, 1);
      assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
    } finally { f.service.close(); await settle(); }
  });
}

test('exit during quality mutation retires input now and finishes old-channel detach without touching a replacement', async context => {
  const f = sourceFixture(context), pending = deferred(); f.model.quality = 'data_saver';
  try {
    const old = await sourceViewing(f, context); await f.service.pauseSource();
    f.client.override = (r,a) => r.op === 'set_quality' ? pending.promise : f.normal(r,a);
    const changing = f.service.setQuality('clear'); await settle();
    assert.equal(f.state.stage, 'setting_quality');
    await f.service.setQuality('balanced'); await f.service.resumeSource();
    assert.equal(f.calls.filter(c => c.request.op === 'set_quality').length, 1);
    f.service.close(); assert.equal(f.commands.at(-1).kind, 'stop');
    assert.equal(f.calls.some(c => c.request.op === 'detach'), false);
    await f.service.open({ ...f.device, deviceId: 'replacement' });
    pending.resolve({ state: { ...f.snapshot(), attachment: { ...f.snapshot().attachment, quality: 'clear' } } });
    await changing; await settle();
    assert.equal(f.state.stage, 'choose_display'); assert.equal(f.state.quality, 'data_saver');
    assert.equal(f.channels[0].closed, true); assert.equal(f.channels[1].closed, false);
    assert.deepEqual(f.calls.filter(c => c.request.op === 'detach').map(c => ({ channel: c.channel, attachment: c.attachment })), [{ channel: 0, attachment: old.attach_id }]);
  } finally { pending.resolve({}); f.service.close(); await settle(); }
});

for (const quality of [undefined, 'ultra', 123]) {
  test(`a negotiated host with invalid snapshot quality ${quality} cannot start media`, async context => {
    const f = sourceFixture(context); f.model.quality = 'data_saver';
    try {
      f.client.override = (r,a) => {
        const reply = f.normal(r,a);
        if (r.op === 'attach') reply.state.attachment.quality = quality;
        return reply;
      };
      await connect(f, context);
      assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'invalid_response');
      assert.equal(f.commands.some(c => c.kind === 'start'), false);
    } finally { f.service.close(); await settle(); }
  });
}

test('source lifecycle is optional; a legacy viewer sends no suspend/resume', async context => {
  const f = fixture(context);
  try {
    const old = await connect(f, context); await f.service.receive(JSON.stringify({ ...old, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.pauseSource(); await f.service.resumeSource(); await f.service.chooseSource(); await f.service.selectSource('second-display');
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.sourceLifecycleSupported, false);
    assert.equal(f.calls.some(c => ['suspend', 'resume'].includes(c.request.op)), false);
  } finally { f.service.close(); }
});

test('pause retires input immediately but closes media only after the host marks suspension', async context => {
  const f = sourceFixture(context), pending = deferred();
  try {
    const old = await sourceViewing(f, context);
    await f.service.acquireControl(); await f.service.receive(JSON.stringify({ ...old, kind: 'control_state', control_epoch: epoch(f), control_generation: '10', code: 'ok' }));
    assert.equal(f.state.controlState, 'controlling');
    f.model.cleanup = true;
    f.client.override = (request, attachment) => request.op === 'suspend' ? pending.promise : f.normal(request, attachment);
    const index = f.commands.length, paused = f.service.pauseSource(); await settle();
    assert.equal(f.state.stage, 'pausing'); assert.equal(f.state.controlGeneration, ''); assert.equal(f.state.rendererId, '');
    await f.service.pauseSource();
    f.service.input({ ...old, kind: 'key', control_generation: '10', body: { usage: 4, down: true } });
    await f.service.receive(JSON.stringify({ ...old, kind: 'failed', code: 'media_unreachable' }));
    assert.equal(f.commands.slice(index).length, 0, 'do not close the PC before expected closure is committed');
    const mutation = f.calls.find(c => c.request.op === 'suspend');
    assert.deepEqual(mutation.request.body, { attach_id: old.attach_id, expected_state_revision: 'source:1' });
    pending.resolve(f.normal({ op: 'suspend' }, old.attach_id)); await paused;
    assert.equal(f.commands.at(-1).kind, 'stop'); assert.equal(f.state.stage, 'pausing');
    await f.service.resumeSource(); assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
    f.model.cleanup = false; context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'paused'); assert.equal(f.channels[0].closed, false);
    assert.equal(f.calls.filter(c => c.request.op === 'suspend').length, 1);
    assert.equal(f.calls.some(c => c.request.op === 'detach'), false);
  } finally { f.service.close(); await settle(); }
});

test('resume retains attachment and TURN policy with a new PC, renderer and first-frame gate', async context => {
  const f = sourceFixture(context);
  try {
    const old = await sourceViewing(f, context); await f.service.pauseSource(); assert.equal(f.state.stage, 'paused');
    await f.service.resumeSource(); assert.equal(f.state.stage, 'connecting');
    context.mock.timers.tick(350); await settle();
    const next = f.commands.filter(c => c.kind === 'start').at(-1);
    assert.equal(next.attach_id, old.attach_id); assert.notEqual(next.connection_id, old.connection_id); assert.notEqual(next.renderer_id, old.renderer_id);
    assert.equal(next.force_relay, true); assert.equal(f.channels.length, 1);
    for (const kind of ['failed', 'first_frame_presented', 'bridge_closed', 'control_state']) {
      await f.service.receive(JSON.stringify({ ...old, kind, code: 'media_unreachable', control_generation: '10' }));
      assert.equal(f.state.stage, 'connecting'); assert.equal(f.state.controlGeneration, '');
    }
    await f.service.receive(JSON.stringify({ ...next, kind: 'first_frame_presented', width: 1280, height: 830 }));
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.controlState, 'viewing');
    assert.equal(f.calls.filter(c => c.request.op === 'attach').length, 1);
    assert.equal(f.commands.filter(c => c.body?.kind === 'acquire_control').length, 0);
  } finally { f.service.close(); await settle(); }
});

for (const op of ['suspend', 'resume']) {
  test(`lost ${op} ACK reads the same attachment without replay`, async context => {
    const f = sourceFixture(context);
    try {
      await sourceViewing(f, context);
      if (op === 'resume') await f.service.pauseSource();
      f.client.override = (request, attachment) => {
        const result = f.normal(request, attachment);
        if (request.op === op) throw new Error('delivery_unknown');
        return result;
      };
      if (op === 'suspend') await f.service.pauseSource(); else await f.service.resumeSource();
      assert.equal(f.state.stage, op === 'suspend' ? 'paused' : 'connecting');
      assert.equal(f.calls.filter(c => c.request.op === op).length, 1);
      assert.equal(f.calls.filter(c => c.request.op === 'attach').length, 1);
    } finally { f.service.close(); await settle(); }
  });
}

test('close during resume waits for its old mutation before detach, without starting late media', async context => {
  const f = sourceFixture(context), pending = deferred();
  const old = await sourceViewing(f, context); await f.service.pauseSource();
  f.client.override = (request, attachment) => request.op === 'resume' ? pending.promise : f.normal(request, attachment);
  const resuming = f.service.resumeSource(); await settle(); f.service.close();
  assert.equal(f.calls.some(c => c.request.op === 'detach'), false); assert.equal(f.channels[0].closed, false);
  pending.resolve(f.normal({ op: 'resume' }, old.attach_id)); await resuming; await settle();
  assert.equal(f.state.stage, 'closed'); assert.equal(f.commands.filter(c => c.kind === 'start').length, 1);
  assert.equal(f.calls.filter(c => c.request.op === 'detach').length, 1); assert.equal(f.channels[0].closed, true);
});

test('the retained native bridge closing while paused ends the attachment', async context => {
  const f = sourceFixture(context);
  try {
    const old = await sourceViewing(f, context); await f.service.pauseSource();
    await f.service.receive(JSON.stringify({ ...old, kind: 'bridge_closed' }));
    await settle(); assert.equal(f.state.stage, 'closed'); assert.equal(f.channels[0].closed, true);
  } finally { f.service.close(); }
});

for (const op of ['suspend', 'resume']) {
  test(`explicit ${op} CAS rejection is never refreshed or replayed`, async context => {
    const f = sourceFixture(context);
    try {
      await sourceViewing(f, context);
      if (op === 'resume') await f.service.pauseSource();
      f.client.override = (request, attachment) => {
        if (request.op === op) throw new Error('stale_revision');
        return f.normal(request, attachment);
      };
      if (op === 'suspend') await f.service.pauseSource(); else await f.service.resumeSource();
      assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'stale_revision');
      assert.equal(f.calls.filter(c => c.request.op === op).length, 1);
      assert.equal(f.commands.filter(c => c.kind === 'start').length, 1);
    } finally { f.service.close(); await settle(); }
  });
}

test('an uncertain resume without a new binding fails instead of replaying or accepting old video', async context => {
  const f = sourceFixture(context);
  try {
    await sourceViewing(f, context); await f.service.pauseSource();
    f.client.override = (request, attachment) => {
      if (request.op === 'resume') throw new Error('delivery_unknown');
      return f.normal(request, attachment);
    };
    await f.service.resumeSource();
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'delivery_unknown');
    assert.equal(f.calls.filter(c => c.request.op === 'resume').length, 1);
    assert.equal(f.commands.filter(c => c.kind === 'start').length, 1);
  } finally { f.service.close(); await settle(); }
});

test('retained attachment expiry becomes an explicit reconnect state without automatic resume', async context => {
  const f = sourceFixture(context);
  try {
    await sourceViewing(f, context); await f.service.pauseSource();
    f.client.override = (request, attachment) => request.op === 'get_state'
      ? { state: { state_revision: 'expired', cleanup_pending: false } } : f.normal(request, attachment);
    context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'sharing_ended'); assert.equal(f.state.canReconnect, true);
    assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
  } finally { f.service.close(); await settle(); }
});

test('identity monitoring survives source phases and cancels a pending resume', async context => {
  const f = sourceFixture(context), pending = deferred();
  const old = await sourceViewing(f, context); await f.service.pauseSource();
  f.client.override = (request, attachment) => request.op === 'resume' ? pending.promise : f.normal(request, attachment);
  const resumed = f.service.resumeSource(); await settle(); f.switchAccount(); context.mock.timers.tick(250); await settle();
  assert.equal(f.state.stage, 'closed');
  pending.resolve(f.normal({ op: 'resume' }, old.attach_id)); await resumed; await settle();
  assert.equal(f.commands.filter(c => c.kind === 'start').length, 1); assert.equal(f.channels[0].closed, true);
});

test('an old poll failure cannot end a resumed source or clear its poll owner', async context => {
  const f = sourceFixture(context), oldPoll = deferred();
  try {
    await sourceViewing(f, context);
    let delay = true;
    f.client.override = (request, attachment) => {
      if (request.op === 'get_state' && delay) { delay = false; return oldPoll.promise; }
      return f.normal(request, attachment);
    };
    context.mock.timers.tick(350); await settle();
    await f.service.pauseSource(); await f.service.resumeSource();
    context.mock.timers.tick(350); await settle();
    const next = f.commands.filter(c => c.kind === 'start').at(-1);
    oldPoll.reject(new Error('old_socket_closed')); await settle();
    assert.equal(f.state.stage, 'connecting');
    await f.service.receive(JSON.stringify({ ...next, kind: 'first_frame_presented', width: 1280, height: 830 }));
    assert.equal(f.state.stage, 'observing');
    context.mock.timers.tick(350); await settle(); assert.equal(f.state.stage, 'observing');
  } finally { f.service.close(); await settle(); }
});

test('a retired native bridge close cannot cancel a replacement before its first renderer start', async context => {
  const f = sourceFixture(context);
  try {
    const old = await sourceViewing(f, context); await f.service.pauseSource(); f.service.close(); await settle();
    await f.service.open(f.device); await f.service.attach('display', true);
    await f.service.receive(JSON.stringify({ ...old, kind: 'bridge_closed' }));
    assert.equal(f.state.stage, 'connecting'); assert.equal(f.channels[1].closed, false);
    context.mock.timers.tick(350); await settle();
    assert.equal(f.commands.filter(c => c.kind === 'start').length, 2);
  } finally { f.service.close(); await settle(); }
});

test('explicit source choice refreshes the catalog, selects with fresh CAS and resumes viewing on a new PC', async context => {
  const f = sourceFixture(context);
  try {
    const old = await sourceViewing(f, context); await f.service.pauseSource(); f.model.catalogRevision = 'catalog:old';
    await f.service.chooseSource(); assert.equal(f.state.stage, 'choose_source'); assert.equal(f.state.displays.length, 2);
    context.mock.timers.tick(350); await settle(); assert.equal(f.state.stage, 'choose_source', 'retained polls must not dismiss selection');
    const selected = f.service.selectSource('second-display'); await f.service.selectSource('second-display'); await selected;
    assert.equal(f.state.stage, 'connecting'); assert.equal(f.state.selectedDisplayId, 'second-display');
    assert.equal(f.state.videoWidth, 1920); assert.equal(f.state.controlGeneration, '');
    const mutation = f.calls.filter(c => c.request.op === 'select_display'); assert.equal(mutation.length, 1);
    assert.deepEqual(mutation[0].request.body, { attach_id: old.attach_id, expected_state_revision: 'source:2', display_id: 'second-display' });
    assert.equal(f.calls.filter(c => c.request.op === 'resume').length, 1); assert.equal(f.calls.filter(c => c.request.op === 'attach').length, 1);
    context.mock.timers.tick(350); await settle(); const next = f.commands.filter(c => c.kind === 'start').at(-1);
    assert.equal(next.attach_id, old.attach_id); assert.notEqual(next.connection_id, old.connection_id); assert.notEqual(next.renderer_id, old.renderer_id); assert.equal(next.force_relay, true);
    await f.service.receive(JSON.stringify({ ...old, kind: 'first_frame_presented', width: 1280, height: 830 })); assert.equal(f.state.stage, 'connecting');
    await f.service.receive(JSON.stringify({ ...next, kind: 'first_frame_presented', width: 1920, height: 1080 }));
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.controlState, 'viewing');
  } finally { f.service.close(); await settle(); }
});

test('canceling a pending display catalog leaves the source paused and fences its late result', async context => {
  const f = sourceFixture(context), pending = deferred();
  try {
    await sourceViewing(f, context); await f.service.pauseSource();
    f.client.override = (r,a) => r.op === 'list_displays' ? pending.promise : f.normal(r,a);
    const reading = f.service.chooseSource(); await settle(); assert.equal(f.state.stage, 'loading_sources');
    f.service.cancelSourceChoice(); assert.equal(f.state.stage, 'paused');
    pending.resolve({ state_revision: 'late', displays: [{ display_id: 'late-display', width: 10, height: 20 }] }); await reading;
    assert.equal(f.state.stage, 'paused'); assert.equal(f.state.selectedDisplayId, 'display');
    assert.equal(f.state.displays.some(d => d.display_id === 'late-display'), false);
    assert.equal(f.calls.some(c => ['select_display','resume'].includes(c.request.op)), false);
  } finally { f.service.close(); await settle(); }
});

test('display selection requires an explicit pause and an entry from the fresh catalog', async context => {
  const f = sourceFixture(context);
  try {
    await sourceViewing(f, context); await f.service.chooseSource(); await f.service.selectSource('second-display');
    assert.equal(f.state.stage, 'observing'); assert.equal(f.calls.filter(c => c.request.op === 'list_displays').length, 1);
    await f.service.pauseSource(); await f.service.chooseSource(); await f.service.selectSource('invented-display');
    assert.equal(f.state.stage, 'choose_source'); assert.equal(f.calls.some(c => c.request.op === 'select_display'), false);
  } finally { f.service.close(); await settle(); }
});

test('a lost select ACK resolves only the requested target, never replaying the selection', async context => {
  const f = sourceFixture(context);
  try {
    await sourceViewing(f, context); await f.service.pauseSource(); await f.service.chooseSource();
    f.client.override = (r,a) => { const reply = f.normal(r,a); if (r.op === 'select_display') throw new Error('delivery_unknown'); return reply; };
    await f.service.selectSource('second-display');
    assert.equal(f.state.stage, 'connecting'); assert.equal(f.state.selectedDisplayId, 'second-display');
    assert.equal(f.calls.filter(c => c.request.op === 'select_display').length, 1);
  } finally { f.service.close(); await settle(); }
});

test('an uncertain select still showing the old target cannot resume or fall back to it', async context => {
  const f = sourceFixture(context);
  try {
    await sourceViewing(f, context); await f.service.pauseSource(); await f.service.chooseSource();
    f.client.override = (r,a) => { if (r.op === 'select_display') throw new Error('delivery_unknown'); return f.normal(r,a); };
    await f.service.selectSource('second-display');
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'delivery_unknown');
    assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
    assert.equal(f.calls.filter(c => c.request.op === 'select_display').length, 1);
  } finally { f.service.close(); await settle(); }
});

for (const code of ['stale_revision','device_approval_required','target_lost']) {
  test(`source selection refusal ${code} is not retried or redirected to another display`, async context => {
    const f = sourceFixture(context);
    try {
      await sourceViewing(f, context); await f.service.pauseSource(); await f.service.chooseSource();
      f.client.override = (r,a) => { if (r.op === 'select_display') throw new Error(code); return f.normal(r,a); };
      await f.service.selectSource('second-display');
      assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, code);
      assert.equal(f.calls.filter(c => c.request.op === 'select_display').length, 1);
      assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
    } finally { f.service.close(); await settle(); }
  });
}

test('exit during selection waits for that mutation, then detaches without a late resume', async context => {
  const f = sourceFixture(context), pending = deferred();
  const old = await sourceViewing(f, context); await f.service.pauseSource(); await f.service.chooseSource();
  f.client.override = (r,a) => r.op === 'select_display' ? pending.promise : f.normal(r,a);
  const selection = f.service.selectSource('second-display'); await settle(); f.service.close();
  assert.equal(f.calls.some(c => c.request.op === 'detach'), false);
  pending.resolve(f.normal({ op: 'select_display', body: { display_id: 'second-display' } }, old.attach_id)); await selection; await settle();
  assert.equal(f.state.stage, 'closed'); assert.equal(f.channels[0].closed, true);
  assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
});

test('a duplicate display ID is rejected instead of exposing ambiguous selection', async context => {
  const f = sourceFixture(context);
  try {
    await sourceViewing(f, context); await f.service.pauseSource();
    f.model.displays = [{ display_id:'display', width:1280, height:830 }, { display_id:'display', width:1920, height:1080 }];
    await f.service.chooseSource(); assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'invalid_response');
  } finally { f.service.close(); await settle(); }
});

test('retained expiry while choosing a display closes the picker and cannot trigger a selection', async context => {
  const f = sourceFixture(context);
  try {
    await sourceViewing(f, context); await f.service.pauseSource(); await f.service.chooseSource();
    f.client.override = (r,a) => r.op === 'get_state' ? { state: { state_revision: 'expired', cleanup_pending: false } } : f.normal(r,a);
    context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.canReconnect, true);
    await f.service.selectSource('second-display'); assert.equal(f.calls.some(c => c.request.op === 'select_display'), false);
  } finally { f.service.close(); await settle(); }
});

test('an account change during display lookup cannot expose its late source list', async context => {
  const f = sourceFixture(context), pending = deferred();
  await sourceViewing(f, context); await f.service.pauseSource();
  f.client.override = (r,a) => r.op === 'list_displays' ? pending.promise : f.normal(r,a);
  const reading = f.service.chooseSource(); await settle(); f.switchAccount(); context.mock.timers.tick(250); await settle();
  pending.resolve({ state_revision:'late', displays:[{display_id:'foreign',width:1920,height:1080}] }); await reading;
  assert.equal(f.state.stage, 'closed'); assert.equal(f.state.displays.some(d=>d.display_id==='foreign'),false);
  assert.equal(f.channels[0].closed, true);
});


test('live display discovery is unscoped while the following selection stays attachment-scoped', async context => {
  const f = sourceFixture(context);
  try {
    const old = await sourceViewing(f, context); await f.service.pauseSource(); await f.service.chooseSource();
    assert.equal(f.state.stage, 'choose_source');
    assert.equal(f.calls.filter(c => c.request.op === 'list_displays').at(-1).attachment, undefined);
    await f.service.selectSource('second-display');
    assert.equal(f.calls.find(c => c.request.op === 'select_display').attachment, old.attach_id);
  } finally { f.service.close(); await settle(); }
});
test('local presented-size changes update phone geometry and retire authority without reconnecting', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const config = await connect(f, context);
    await f.service.receive(JSON.stringify({ ...config, kind: 'frame_resized', width: 640, height: 415 })); assert.equal(f.state.stage, 'connecting');
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.acquireControl(); await f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), control_generation: '3', code: 'ok' }));
    await f.service.receive(JSON.stringify({ ...config, renderer_id: 'old', kind: 'frame_resized', width: 320, height: 208 })); assert.equal(f.state.videoWidth, 1280);
    await f.service.receive(JSON.stringify({ ...config, kind: 'frame_resized', width: 640, height: 415 }));
    assert.equal(f.state.videoWidth, 640); assert.equal(f.state.videoHeight, 415); assert.equal(f.state.controlState, 'viewing');
    assert.equal(f.commands.at(-1).body.kind, 'release_control'); assert.equal(f.commands.filter(c => c.kind === 'start').length, 1);
    assert.equal(f.calls.filter(c => c.request.op === 'attach').length, 1); assert.equal(f.logs.filter(s => s.includes('remote desktop first frame')).length, 1);
  } finally { f.service.close(); }
});

test('missing first-frame dimensions cannot advertise an observed phone view', async context => {
  const f = fixture(context);
  try {
    const config = await connect(f, context); await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented' }));
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'invalid_response');
  } finally { f.service.close(); }
});

test('malformed current resize metadata closes the observed phone view', async context => {
  const f = fixture(context);
  try {
    const config = await connect(f, context); await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.receive(JSON.stringify({ ...config, kind: 'frame_resized', width: 0, height: 415 }));
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'invalid_response');
  } finally { f.service.close(); }
});

async function observeSignalingFixture(f, context) {
  const config = await connect(f, context);
  await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
  return config;
}
test('transient state read failure preserves video, retires input and recovers only the same streaming source', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const config = await observeSignalingFixture(f, context);
    await f.service.acquireControl();
    await f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), control_generation: '3', code: 'ok' }));
    const regular = f.client.override; let interrupted = true;
    f.client.override = (request, attachment) => {
      if (request.op !== 'get_state') return regular(request, attachment);
      if (interrupted) throw new Error('delivery_unknown');
      return { state: { state_revision: 'boot:43', attachment: { attach_id: attachment, connection_id: `pc-${attachment}`, display_id: 'display', phase: 'streaming' } } };
    };
    context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.signalingInterrupted, true);
    assert.equal(f.state.controlState, 'viewing'); assert.equal(f.state.controlGeneration, '');
    const before = f.calls.length, commands = f.commands.length;
    await f.service.acquireControl(); await f.service.pauseSource();
    f.service.input({ renderer_id: config.renderer_id, control_generation: '3', kind: 'key', body: { usage: 40, down: true } });
    assert.equal(f.calls.length, before); assert.equal(f.commands.length, commands);
    await f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: epoch(f), control_generation: '3', code: 'ok' }));
    assert.equal(f.state.controlGeneration, '');
    interrupted = false; context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.signalingInterrupted, false);
    assert.equal(f.state.controlGeneration, ''); assert.equal(f.state.controlState, 'viewing');
    assert.equal(f.commands.filter(command => command.kind === 'start').length, 1);
    assert.equal(f.commands.filter(command => command.body?.kind === 'acquire_control').length, 1);
    context.mock.timers.tick(31000); await settle(); assert.equal(f.state.stage, 'observing');
  } finally { f.service.close(); await settle(); }
});
test('repeated failed reads cannot extend the 30 second wait and a late snapshot cannot revive it', async context => {
  const f = fixture(context), pending = deferred();
  try {
    await observeSignalingFixture(f, context);
    f.client.override = request => { if (request.op === 'get_state') throw new Error('target_unavailable'); };
    context.mock.timers.tick(350); await settle();
    context.mock.timers.tick(15000); await settle();
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.signalingInterrupted, true);
    f.client.override = request => request.op === 'get_state' ? pending.promise : undefined;
    context.mock.timers.tick(350); await settle();
    context.mock.timers.tick(14650); await settle();
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.signalingInterrupted, false);
    pending.resolve({ state: { attachment: { phase: 'streaming' } } }); await settle();
    assert.equal(f.state.stage, 'failed'); assert.equal(f.commands.filter(command => command.kind === 'start').length, 1);
  } finally { f.service.close(); await settle(); }
});
for (const error of ['authorization_expired', 'account_changed', 'signal_decryption_failed', 'invalid_response']) {
  test(`state read failure ${error} stops immediately without video grace`, async context => {
    const f = fixture(context);
    try {
      await observeSignalingFixture(f, context);
      f.client.override = request => { if (request.op === 'get_state') throw new Error(error); };
      context.mock.timers.tick(350); await settle();
      assert.equal(f.state.stage, 'failed'); assert.equal(f.state.signalingInterrupted, false); assert.equal(f.commands.at(-1).kind, 'stop');
    } finally { f.service.close(); await settle(); }
  });
}
test('a transient failure before presentation still closes, and background cancels the video wait', async context => {
  const f = fixture(context);
  try {
    await connect(f, context);
    f.client.override = request => { if (request.op === 'get_state') throw new Error('delivery_unknown'); };
    context.mock.timers.tick(350); await settle(); assert.equal(f.state.stage, 'failed');
    f.client.override = undefined; await observeSignalingFixture(f, context);
    f.client.override = request => { if (request.op === 'get_state') throw new Error('relay_disconnected'); };
    context.mock.timers.tick(350); await settle(); assert.equal(f.state.signalingInterrupted, true);
    f.Service.onLifecycle(false); context.mock.timers.tick(30000); await settle();
    assert.equal(f.state.stage, 'closed'); assert.equal(f.state.signalingInterrupted, false);
  } finally { f.service.close(); await settle(); }
});
for (const recovered of [{ phase: 'suspended', display_id: 'display' }, { phase: 'streaming', display_id: 'other' }]) {
  test(`recovery refuses changed source ${JSON.stringify(recovered)}`, async context => {
    const f = fixture(context);
    try {
      await observeSignalingFixture(f, context);
      f.client.override = request => { if (request.op === 'get_state') throw new Error('delivery_unknown'); };
      context.mock.timers.tick(350); await settle();
      f.client.override = (request, attachment) => request.op === 'get_state' ? { state: { attachment: { attach_id: attachment, connection_id: `pc-${attachment}`, ...recovered } } } : undefined;
      context.mock.timers.tick(350); await settle(); assert.equal(f.state.stage, 'failed');
    } finally { f.service.close(); await settle(); }
  });
}

test('authenticated revocation and account replacement still stop during the bounded video wait', async context => {
  const f = fixture(context);
  try {
    for (const replaceAccount of [false, true]) {
      await observeSignalingFixture(f, context);
      f.client.override = request => { if (request.op === 'get_state') throw new Error('delivery_unknown'); };
      context.mock.timers.tick(350); await settle(); assert.equal(f.state.signalingInterrupted, true);
      if (replaceAccount) { f.switchAccount(); context.mock.timers.tick(250); }
      else {
        f.client.override = (request, attachment) => request.op === 'get_state' ? { state: { attachment: { attach_id: attachment, connection_id: `pc-${attachment}` } }, media_error: 'authorization_expired' } : undefined;
        context.mock.timers.tick(350);
      }
      await settle(); assert.ok(['failed', 'closed'].includes(f.state.stage)); assert.equal(f.state.signalingInterrupted, false);
      assert.equal(f.commands.at(-1).kind, 'stop'); f.client.override = undefined;
    }
  } finally { f.service.close(); await settle(); }
});

test('credential rebuild drains the old PC, obtains fresh TURN and requires a new view-only first frame', async context => {
  const f = sourceFixture(context, true);
  try {
    const old = await sourceViewing(f, context);
    await f.service.acquireControl();
    await f.service.receive(JSON.stringify({ ...old, kind: 'control_state', control_epoch: epoch(f), control_generation: '10', code: 'ok' }));
    f.model.cleanup = true;
    // A stale/increasing sample cannot extend the original 300-second budget,
    // even while the controller's separately issued credentials last longer.
    f.clock.uptime = 240001;
    context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'pausing'); assert.equal(f.state.controlState, 'viewing');
    assert.equal(f.calls.filter(c => c.request.op === 'suspend').length, 1);
    assert.equal(f.calls.filter(c => c.request.op === 'resume').length, 0);
    await f.service.receive(JSON.stringify({ ...old, kind: 'first_frame_presented', width: 1, height: 1 }));
    assert.equal(f.state.stage, 'pausing');
    f.model.cleanup = false; context.mock.timers.tick(350); await settle();
    assert.equal(f.calls.filter(c => c.request.op === 'resume').length, 1);
    assert.equal(f.state.stage, 'connecting');
    context.mock.timers.tick(350); await settle();
    const current = f.commands.filter(c => c.kind === 'start').at(-1);
    assert.notEqual(current.connection_id, old.connection_id); assert.notEqual(current.renderer_id, old.renderer_id);
    assert.equal(current.attach_id, old.attach_id);
    assert.equal(f.state.stage, 'connecting');
    await f.service.receive(JSON.stringify({ ...current, kind: 'first_frame_presented', width: 1280, height: 830 }));
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.controlGeneration, '');
    assert.equal(f.commands.filter(c => c.body?.kind === 'acquire_control').length, 1);
    assert.equal(f.calls.filter(c => c.request.op === 'attach').length, 1);
  } finally { f.service.close(); await settle(); }
});

test('manual pause near credential expiry never automatically resumes', async context => {
  const f = sourceFixture(context, true);
  try {
    await sourceViewing(f, context); await f.service.pauseSource();
    f.clock.uptime = 400000;
    context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'paused'); assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
  } finally { f.service.close(); }
});
for (const reason of ['background', 'account']) test(`credential drainage cannot revive after ${reason}`, async context => {
  const f = sourceFixture(context, true);
  try {
    await sourceViewing(f, context); f.model.cleanup = true; f.clock.uptime = 240001;
    context.mock.timers.tick(350); await settle(); assert.equal(f.state.stage, 'pausing');
    if (reason === 'background') f.Service.onLifecycle(false); else { f.switchAccount(); context.mock.timers.tick(250); }
    f.model.cleanup = false; context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'closed'); assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
  } finally { f.service.close(); }
});
for (const remaining of [undefined, null, -1, 660001, NaN, 1.5]) test(`advertised credential budget rejects invalid value ${String(remaining)}`, async context => {
  const f = sourceFixture(context, true);
  try {
    f.model.remaining = remaining; await connect(f, context);
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'invalid_response');
    assert.equal(f.commands.some(c => c.kind === 'start'), false);
  } finally { f.service.close(); }
});
test('near-expired controller credentials stop without a rebuild loop', async context => {
  const f = sourceFixture(context, true);
  try {
    await f.service.open(f.device);
    f.channels[0].turn = async () => ({ expires_at: Math.floor(Date.now() / 1000) + 30, ice_servers: [{}] });
    await f.service.receive('{"kind":"bridge_ready","capabilities":["control_epoch_v1"]}'); await f.service.attach('display', false);
    context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'turn_credentials_expired');
    assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
  } finally { f.service.close(); }
});
test('calendar rollback cannot postpone the credential rebuild', async context => {
  const f = sourceFixture(context, true), wall = Date.now();
  context.mock.method(Date, 'now', () => wall);
  try {
    await sourceViewing(f, context);
    Date.now.mock.mockImplementation(() => wall - 3600000);
    f.clock.uptime = 240001; context.mock.timers.tick(350); await settle();
    assert.equal(f.calls.filter(c => c.request.op === 'suspend').length, 1);
    assert.equal(f.calls.filter(c => c.request.op === 'resume').length, 1);
  } finally { f.service.close(); }
});
test('the host budget triggers renewal before later controller credentials expire', async context => {
  const f = sourceFixture(context, true);
  try {
    f.model.remaining = 61000; await sourceViewing(f, context);
    f.model.remaining = 300000; f.clock.uptime = 1001;
    context.mock.timers.tick(350); await settle();
    assert.equal(f.calls.filter(c => c.request.op === 'resume').length, 1);
  } finally { f.service.close(); }
});
test('a slow host state reply is charged to the existing credential budget', async context => {
  const f = sourceFixture(context, true), pending = deferred();
  try {
    await sourceViewing(f, context);
    f.client.override = (request, attachment) => request.op === 'get_state' ? pending.promise : f.normal(request, attachment);
    context.mock.timers.tick(350); await settle();
    f.clock.uptime = 300001;
    pending.resolve({ state: f.snapshot(), media: { credentials_remaining_ms: 300000, offer_sdp: 'offer', source_first_frame: true } });
    await settle();
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'turn_credentials_expired');
    assert.equal(f.calls.some(c => c.request.op === 'resume'), false);
  } finally { f.service.close(); }
});
test('a missing monotonic clock closes a negotiated credential rebuild path', async context => {
  const f = sourceFixture(context, true);
  try {
    f.clock.uptime = undefined; await connect(f, context);
    assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'turn_credentials_expired');
  } finally { f.service.close(); }
});

test('a report from two leases ago cannot replace a new acquisition or clear its successor', async context => {
  const f = fixture(context); controlHost(f);
  try {
    const config = await connect(f, context);
    const state = value => ({ ...config, kind: 'control_state', control_epoch: epoch(f), ...value });
    const deliver = value => f.service.receive(JSON.stringify(value));
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    await f.service.acquireControl();
    const oldGrant = state({ control_epoch: f.commands.at(-1).control_epoch, control_generation: '6', code: 'ok' });
    await deliver(oldGrant);
    f.service.releaseControl();
    const oldRelease = state({ control_epoch: f.commands.at(-1).control_epoch, code: 'ok' });
    await deliver(oldRelease);
    await f.service.acquireControl();
    await deliver(state({ control_epoch: f.commands.at(-1).control_epoch, control_generation: '7', code: 'ok' }));
    f.service.releaseControl(); await deliver(state({ control_epoch: f.commands.at(-1).control_epoch, code: 'ok' }));
    await f.service.acquireControl();
    const current = state({ control_epoch: f.commands.at(-1).control_epoch, control_generation: '8', code: 'ok' });
    await deliver(oldGrant);
    assert.equal(f.state.controlState, 'acquiring'); assert.equal(f.state.controlGeneration, '');
    await deliver(current); await deliver(oldRelease);
    assert.equal(f.state.controlState, 'controlling'); assert.equal(f.state.controlGeneration, '8');
    assert.equal(f.state.stage, 'observing');
  } finally { f.service.close(); }
});

test('a legacy local receiver keeps video view-only even when the host offers control', async context => {
  const f = fixture(context); controlHost(f);
  try {
    await f.service.open(f.device); await f.service.receive('{"kind":"bridge_ready"}'); await f.service.attach('display', true);
    context.mock.timers.tick(350); await settle();
    const config = f.commands.find(command => command.kind === 'start');
    assert.equal(config.control_supported, false); assert.equal(config.control_epoch, undefined);
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    assert.equal(f.state.stage, 'observing'); assert.equal(f.state.controlSupported, false); assert.equal(f.state.textSupported, false);
    await f.service.acquireControl(); f.service.releaseControl();
    assert.equal(f.commands.some(command => command.kind === 'control'), false);
  } finally { f.service.close(); }
});
for (const bad of [undefined, null, 1, '', '01', '-1', '9007199254740992', '99']) {
  test(`missing, malformed or unissued report epoch ${String(bad)} cannot authorize input`, async context => {
    const f = fixture(context); controlHost(f);
    try {
      const config = await connect(f, context);
      await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
      await f.service.acquireControl();
      await f.service.receive(JSON.stringify({ ...config, kind: 'control_state', control_epoch: bad, control_generation: '6', code: 'ok' }));
      assert.equal(f.state.stage, 'failed'); assert.equal(f.state.errorCode, 'invalid_response'); assert.equal(f.state.controlGeneration, '');
      assert.equal(f.commands.at(-1).kind, 'stop');
    } finally { f.service.close(); }
  });
}


function setupHostWait(context) {
  const f = fixture(context);
  f.client.override = request => request.op === 'capabilities' ? {
    protocol_versions: [1], capabilities: ['read_only_video_v1', 'gathered_sdp_v1', 'source_lifecycle_v1'], authorization: 'view', availability: 'ready'
  } : undefined;
  return f;
}
const previousAttachment = { attach_id: 'previous', connection_id: 'previous-pc', display_id: 'display', phase: 'streaming' };

test('new setup waits for the prior owned attachment and native drain before offering a fresh display choice', async context => {
  const f = setupHostWait(context);
  let state = { state_revision: 'boot:1', busy: true, cleanup_pending: false, attachment: previousAttachment };
  f.client.setupState = () => state;
  const opened = f.service.open(f.device); await settle();
  try {
    assert.equal(f.state.stage, 'waiting_for_host');
    assert.deepEqual(f.calls.map(c => c.request.op), ['capabilities', 'get_state']);
    state = { state_revision: 'boot:2', busy: false, cleanup_pending: true };
    context.mock.timers.tick(350); await settle();
    assert.equal(f.state.stage, 'waiting_for_host');
    state = { state_revision: 'boot:3', busy: false, cleanup_pending: false };
    context.mock.timers.tick(350); await settle(); await opened;
    assert.equal(f.state.stage, 'choose_display');
    assert.equal(f.calls.at(-1).request.op, 'list_displays');
    assert.deepEqual(f.logs, ['remote desktop waiting for prior source to end', 'remote desktop prior source ended; refreshing display choices']);
    assert.ok(f.calls.every(c => !c.attachment));
    assert.equal(f.commands.some(c => c.kind === 'start' || c.kind === 'control'), false);
    assert.equal(f.calls.some(c => ['attach', 'detach', 'resume'].includes(c.request.op)), false);
  } finally { f.service.close(); await settle(); }
});

test('setup does not wait for or detach a different controller attachment', async context => {
  const f = setupHostWait(context);
  f.client.setupState = () => ({ state_revision: 'boot:1', busy: true, cleanup_pending: false });
  try {
    await f.service.open(f.device);
    assert.equal(f.state.errorCode, 'attachment_busy');
    assert.deepEqual(f.calls.map(c => c.request.op), ['capabilities', 'get_state']);
  } finally { f.service.close(); }
});

for (const reason of ['close', 'account', 'timeout', 'clock_rollback', 'clock_missing']) {
  test(`pending setup ${reason} cannot read a later catalog or create an attachment`, async context => {
    const f = setupHostWait(context);
    f.clock.uptime = 100;
    f.client.setupState = () => ({ state_revision: 'boot:1', busy: false, cleanup_pending: true });
    const opened = f.service.open(f.device); await settle();
    assert.equal(f.state.stage, 'waiting_for_host');
    if (reason === 'close') f.service.close();
    else if (reason === 'account') f.switchAccount();
    else f.clock.uptime = reason === 'timeout' ? 60100 : reason === 'clock_missing' ? undefined : 99;
    context.mock.timers.tick(350); await settle(); await opened;
    assert.equal(f.calls.some(c => ['list_displays', 'attach', 'detach', 'resume'].includes(c.request.op)), false);
    assert.equal(f.state.stage, ['timeout', 'clock_rollback', 'clock_missing'].includes(reason) ? 'failed' : 'closed');
    if (reason === 'timeout') assert.equal(f.state.errorCode, 'cleanup_pending');
    f.service.close(); await settle();
  });
}

test('setup refuses an incomplete occupancy snapshot', async context => {
  const f = setupHostWait(context);
  f.client.setupState = () => ({ state_revision: 'boot:1', busy: false });
  try {
    await f.service.open(f.device);
    assert.equal(f.state.errorCode, 'invalid_response');
    assert.equal(f.calls.some(c => c.request.op === 'list_displays'), false);
  } finally { f.service.close(); }
});

test('automatic input readiness follows current host health; missing legacy observations stay false', async context => {
  const f = fixture(context); let health;
  try {
    const config = await connect(f, context);
    await f.service.receive(JSON.stringify({ ...config, kind: 'first_frame_presented', width: 1280, height: 830 }));
    f.client.override = (request, attachment) => request.op === 'get_state' ? {
      state: { attachment: { attach_id: attachment, connection_id: config.connection_id, phase: 'streaming' } },
      media: { health }
    } : undefined;
    for (const [observation, expected] of [[undefined, false], [{ candidate: false }, false], [{ candidate: true }, true], [undefined, false]]) {
      health = observation;
      context.mock.timers.tick(1000); await settle();
      assert.equal(f.state.controlReady, expected);
    }
  } finally { f.service.close(); }
});
