const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/policy/RemoteDesktopRendererQueue.ets'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports_ = {}; new Function('exports', compiled)(exports_);
const { RemoteDesktopRendererQueue } = exports_;
const control = (body, extra = {}) => JSON.stringify({ kind: 'control', renderer_id: 'renderer', attach_id: 'attachment', connection_id: 'connection', body, ...extra });
const move = (x, extra = {}) => control({ kind: 'pointer_move', control_generation: '1', body: { x, y: .5 } }, extra);
test('stalled native bridge retains the latest adjacent move without losing button edges', () => {
  const queue = new RemoteDesktopRendererQueue();
  const down = control({ kind: 'pointer_button', control_generation: '1', body: { button: 'left', down: true, x: .2, y: .5 } });
  const up = control({ kind: 'pointer_button', control_generation: '1', body: { button: 'left', down: false, x: .9, y: .5 } });
  assert.equal(queue.enqueue(down), true);
  for (let i = 0; i < 512; i++) assert.equal(queue.enqueue(move(i / 512)), true);
  assert.equal(queue.enqueue(up), true);
  assert.deepEqual([queue.take(), queue.take(), queue.take()], [down, move(511 / 512), up]);
  assert.equal(queue.take(), undefined);
});
test('coalescing cannot cross media identities, lease generations or control/input barriers', () => {
  for (const changed of [{ renderer_id: 'other' }, { attach_id: 'other' }, { connection_id: 'other' }, { control_epoch: '2' },
    { body: { kind: 'pointer_move', control_generation: '2', body: { x: .7, y: .5 } } }]) {
    const queue = new RemoteDesktopRendererQueue(), a = move(.2), b = move(.7, changed);
    queue.enqueue(a); queue.enqueue(b); assert.deepEqual([queue.take(), queue.take()], [a, b]);
  }
  for (const intent of [
    { kind: 'pointer_button', control_generation: '1', body: { button: 'left', down: false, x: .3, y: .5 } },
    { kind: 'key', control_generation: '1', body: { usage: 4, down: true } },
    { kind: 'text_commit', control_generation: '1', body: { text: 'fixed' } },
    { kind: 'wheel', control_generation: '1', body: { x: .3, y: .5, dx: 0, dy: 1 } },
    { kind: 'acquire_control', expected_state_revision: 'boot:1' },
    { kind: 'renew_control', control_generation: '1' }, { kind: 'release_control', control_generation: '1' }
  ]) {
    const queue = new RemoteDesktopRendererQueue(), barrier = control(intent);
    for (const value of [move(.2), barrier, move(.3), move(.8)]) assert.equal(queue.enqueue(value), true);
    assert.deepEqual([queue.take(), queue.take(), queue.take()], [move(.2), barrier, move(.8)]);
    assert.equal(queue.take(), undefined);
  }
  for (const kind of ['start', 'stop', 'source_ready']) {
    const queue = new RemoteDesktopRendererQueue(), barrier = JSON.stringify({ kind });
    [move(.2), barrier, move(.8)].forEach(value => queue.enqueue(value));
    assert.deepEqual([queue.take(), queue.take(), queue.take()], [move(.2), barrier, move(.8)]);
  }
});
test('invalid and opaque commands stay ordered instead of being hidden by coalescing', () => {
  for (const value of ['not json', 'null', '42', move(.1, { renderer_id: '' }),
    ...['01', '-1', 1, '9007199254740992'].map(control_epoch => move(.1, { control_epoch })),
    move(-.1), move(1.1), move(null), move(.1, { body: { kind: 'pointer_move', control_generation: '01', body: { x: .1, y: .5 } } }),
    move(.1, { body: { kind: 'pointer_move', control_generation: '18446744073709551616', body: { x: .1, y: .5 } } })]) {
    const queue = new RemoteDesktopRendererQueue();
    [value, value].forEach(value => assert.equal(queue.enqueue(value), true));
    assert.deepEqual([queue.take(), queue.take()], [value, value]);
  }
});
test('replacing a tail at capacity preserves edge pressure and accounts for changed byte length', () => {
  const queue = new RemoteDesktopRendererQueue();
  for (let i = 0; i < 127; i++) assert.equal(queue.enqueue('edge'), true);
  assert.equal(queue.enqueue(move(.2)), true); assert.equal(queue.enqueue(move(.8)), true);
  assert.equal(queue.enqueue('up'), false);
  for (let i = 0; i < 127; i++) assert.equal(queue.take(), 'edge');
  assert.equal(queue.take(), move(.8)); assert.equal(queue.take(), undefined);
  const first = move(.2), larger = move(.123456789);
  const filler = 'x'.repeat(128 * 1024 - first.length);
  assert.equal(queue.enqueue(filler), true); assert.equal(queue.enqueue(first), true);
  assert.equal(queue.enqueue(larger), false, 'replacement still obeys the byte budget');
  assert.equal(queue.take(), filler); assert.equal(queue.take(), first);
  assert.equal(queue.enqueue(larger), true); assert.equal(queue.take(), larger);
  assert.equal(queue.enqueue(first), true); assert.equal(queue.enqueue('release', true), true);
  assert.equal(queue.take(), 'release'); assert.equal(queue.take(), undefined);
});
test('bridge preserves a burst of press/move/release instead of only the latest revision', () => {
  const queue = new RemoteDesktopRendererQueue();
  for (const message of ['down', 'move', 'up']) assert.equal(queue.enqueue(message), true);
  assert.deepEqual([queue.take(), queue.take(), queue.take()], ['down', 'move', 'up']);
  assert.equal(queue.take(), undefined);
});
test('stop/release can discard pending input, while overflow is explicit and bounded', () => {
  const queue = new RemoteDesktopRendererQueue();
  for (let i = 0; i < 128; i++) assert.equal(queue.enqueue('pending'), true);
  assert.equal(queue.enqueue('lost'), false);
  assert.equal(queue.enqueue('release', true), true);
  assert.equal(queue.take(), 'release'); assert.equal(queue.take(), undefined);
  assert.equal(queue.enqueue('x'.repeat(131073)), false);
  assert.equal(queue.enqueue('stop', true), true); assert.equal(queue.take(), 'stop');
});

test('source pause discards queued old input once and preserves the later confirmed media stop', () => {
  const vmSource = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/viewmodel/RemoteDesktopViewModel.ets'), 'utf8');
  const vmJs = ts.transpileModule(vmSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  let hooks;
  class State {
    constructor() { this.stage = 'observing'; this.rendererQueue = new RemoteDesktopRendererQueue(); this.rendererVersion = 0; }
    queueRenderer(value, discard) { const result = this.rendererQueue.enqueue(value, discard); if (result) this.rendererVersion++; return result; }
  }
  class Service { constructor(value) { hooks = value; } }
  const module_ = {};
  new Function('require', 'exports', vmJs)(name => name === '../../services/RemoteDesktopService' ? { RemoteDesktopService: Service }
    : name === '../state/RemoteDesktopState' ? { RemoteDesktopState: State } : {}, module_);
  const vm = new module_.RemoteDesktopViewModel(() => undefined);
  vm.state.queueRenderer('{"kind":"control","body":{"kind":"key","down":true}}');
  hooks.update({ stage: 'pausing' });
  assert.equal(vm.state.rendererQueue.take(), undefined, 'retired queued input must not reach the old PC');
  hooks.renderer('{"kind":"stop"}');
  hooks.update({ stage: 'pausing' });
  hooks.update({ stage: 'paused' }); hooks.update({ stage: 'resuming' });
  assert.equal(vm.state.rendererQueue.take(), '{"kind":"stop"}', 'confirmed stop must survive subsequent progress projections');
  assert.equal(vm.state.rendererQueue.take(), undefined);
});
