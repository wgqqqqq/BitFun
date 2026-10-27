const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.join(__dirname, '../../entry/src/main/ets');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture() {
  const clock = { wall: 10000, uptime: 1000, fail: false }, inputs = [], releases = [];
  const policy = {}, adapter = {};
  new Function('exports', compile(fs.readFileSync(path.join(root, 'pages/policy/RemoteDesktopTouchPolicy.ets'), 'utf8')))(policy);
  const clockPath = path.join(root, 'services/RemoteDesktopGestureClock.ets');
  if (fs.existsSync(clockPath)) new Function('require', 'exports', compile(fs.readFileSync(clockPath, 'utf8')))(() => ({ systemDateTime: {
    TimeType: { STARTUP: 0 }, getUptime(kind, nanos) { assert.equal(kind, 0); assert.equal(nanos, false); if (clock.fail) throw new Error('Unavailable clock'); return clock.uptime; }
  } }), adapter);
  let source = fs.readFileSync(path.join(root, 'pages/components/RemoteDesktopViewport.ets'), 'utf8');
  const build = source.indexOf('\n  build() {'); assert.ok(build > 0, 'Expected the platform leaf build method');
  // Execute the actual touch/gesture handlers; only declarative ArkUI rendering
  // and decorators are removed from this host-side fixture.
  source = (source.slice(0, build) + '\n}').replace('export struct ', 'export class ')
    .replace(/@ComponentV2\s*/g, '').replace(/@(Param|Local|Event)\s+/g, '').replace(/@Monitor\([^\n]*\)\s*/g, '');
  class State { constructor() { Object.assign(this, { stage: 'observing', rendererId: 'renderer', controlGeneration: '3', controlState: 'controlling',
    videoWidth: 400, videoHeight: 200, directTouch: true, panMode: false }); } }
  const values = {}, types = { Down: 0, Move: 1, Up: 2, Cancel: 3 };
  new Function('require', 'exports', 'TouchType', 'Date', compile(source))(name => {
    if (name.endsWith('/RemoteDesktopState')) return { RemoteDesktopState: State, emptyRemoteDesktopActions: () => ({}) };
    if (name.endsWith('/RemoteDesktopTouchPolicy')) return policy;
    if (name.endsWith('/RemoteDesktopGestureClock')) return adapter;
    return {};
  }, values, types, { now: () => clock.wall });
  const view = new values.RemoteDesktopViewport(); view.viewportWidth = view.viewportHeight = 400;
  view.actions = { input: message => inputs.push(message), releaseControl: reason => releases.push(reason) };
  const point = { id: 1, x: 200, y: 200 };
  return { clock, inputs, releases, view,
    down(at = clock.uptime) { view.touchEvent({ type: types.Down, touches: [point], changedTouches: [point], timestamp: clock.fail ? undefined : at * 1e6 }); },
    up(at = clock.uptime) { view.touchEvent({ type: types.Up, touches: [], changedTouches: [point], timestamp: clock.fail ? undefined : at * 1e6 }); },
    longPress(at = clock.uptime) { view.longPressEvent({ timestamp: clock.fail ? undefined : at * 1e6 }, `${view.state.rendererId}:${view.state.controlGeneration}`); },
    pendingLongPress() { const at = clock.uptime + 500, binding = `${view.state.rendererId}:${view.state.controlGeneration}`; return () => view.longPressEvent({ timestamp: at * 1e6 }, binding); }
  };
}
test('a delayed short-tap Up uses hardware event time rather than dispatch latency', () => {
  const f = fixture(); f.down(1000); f.clock.uptime = 1700; f.up(1060);
  assert.deepEqual(f.inputs.map(x => [x.body.button, x.body.down]), [['left', true], ['left', false]]);
  assert.deepEqual(f.releases, []);
});
test('a wall-clock jump during a short tap cannot turn it into a remote right click', () => {
  const f = fixture(); f.down(); f.clock.uptime += 60; f.clock.wall += 60000; f.up();
  assert.deepEqual(f.inputs.map(x => [x.body.button, x.body.down]), [['left', true], ['left', false]]);
  assert.equal(f.releases.length, 0);
});
test('a wall-clock rollback cannot suppress a genuine long press or duplicate its click at up', () => {
  const f = fixture(); f.down(); f.clock.uptime += 500; f.clock.wall -= 5000; f.longPress();
  f.clock.uptime += 60; f.clock.wall += 60; f.up();
  assert.deepEqual(f.inputs.map(x => [x.body.button, x.body.down]), [['right', true], ['right', false]]);
  assert.equal(f.releases.length, 0);
});
test('double-tap hold uses event time across a wall-clock jump', () => {
  const f = fixture(); f.down(); f.clock.uptime += 60; f.up();
  f.clock.uptime += 100; f.clock.wall += 60000; f.down();
  f.clock.uptime += 500; f.longPress();
  assert.deepEqual(f.inputs.map(x => [x.body.button, x.body.down]), [['left', true], ['left', false], ['left', true]]);
  f.clock.uptime += 50; f.up();
  assert.deepEqual(f.inputs.at(-1).body, { button: 'left', down: false, x: .5, y: .5 });
});
test('unavailable or invalid event time releases control without calendar-time fallback', () => {
  for (const invalid of [NaN, Infinity, -1, 'throw']) {
    const f = fixture(); f.clock.uptime = invalid; f.clock.fail = invalid === 'throw'; f.down();
    assert.deepEqual(f.inputs, []); assert.deepEqual(f.releases, ['input_suspended']);
    f.clock.fail = false; f.clock.uptime = 1200; f.up();
    assert.deepEqual(f.inputs, [], 'An old Up cannot resurrect the failed Down');
  }
});
test('clock loss while a drag is held pairs its old button and retires authority', () => {
  const f = fixture(); f.down(); f.clock.uptime += 60; f.up();
  f.clock.uptime += 100; f.down(); f.clock.uptime += 500; f.longPress();
  assert.equal(f.inputs.at(-1).body.down, true);
  f.clock.fail = true; f.up();
  assert.deepEqual(f.inputs.at(-1), { renderer_id: 'renderer', control_generation: '3', kind: 'pointer_button', body: { button: 'left', down: false, x: .5, y: .5 } });
  assert.deepEqual(f.releases, ['input_suspended']);
});
test('a retired native long press cannot release a successor', () => {
  for (const retire of [f => f.view.aboutToDisappear(), f => f.view.contextChanged(),
    f => { f.view.state.controlGeneration = '5'; }]) {
    const f = fixture(); f.down(); const late = f.pendingLongPress();
    retire(f); f.clock.fail = true; late();
    assert.deepEqual(f.releases, []); assert.deepEqual(f.inputs, []);
  }
});

test('event-time rollback during a held drag pairs its button and retires input', () => {
  const f = fixture(); f.down(1000); f.up(1060); f.down(1160); f.longPress(1660);
  assert.equal(f.inputs.at(-1).body.down, true);
  f.up(1100);
  assert.equal(f.inputs.at(-1).body.down, false);
  assert.deepEqual(f.releases, ['input_suspended']);
});
test('an old long press timestamp cannot act on a later finger in the same lease', () => {
  const f = fixture(); f.down(1000); const late = f.pendingLongPress(); f.up(1060); f.down(1700); late();
  assert.equal(f.inputs.length, 2);
  f.up(1760); assert.equal(f.inputs.length, 4);
  assert.ok(f.inputs.every(x => x.body.button === 'left'));
});
test('dispatch delays do not consume the hardware double-tap interval', () => {
  const f = fixture(); f.down(1000); f.clock.uptime = 1700; f.up(1060);
  f.clock.uptime = 2400; f.down(1160); f.longPress(1660);
  assert.deepEqual(f.inputs.map(x => [x.body.button, x.body.down]), [['left', true], ['left', false], ['left', true]]);
  f.up(1720); assert.equal(f.inputs.at(-1).body.down, false);
  assert.deepEqual(f.releases, []);
});
test('a delayed long-press callback cannot turn the second held tap into a right click at Up', () => {
  const f = fixture(); f.down(1000); f.up(1060); f.down(1160);
  const late = f.pendingLongPress(); f.up(1760); late();
  assert.deepEqual(f.inputs.map(x => [x.body.button, x.body.down]),
    [['left', true], ['left', false], ['left', true], ['left', false]]);
  assert.deepEqual(f.releases, []);
});
test('native long-press recognition can carry its last touch timestamp', () => {
  const f = fixture(); f.down(1000); f.clock.uptime = 1600; f.longPress(1000);
  assert.deepEqual(f.inputs.map(x => [x.body.button, x.body.down]), [['right', true], ['right', false]]);
  f.up(1700); assert.equal(f.inputs.length, 2);
});


test('native touch cancellation releases the held button but leaves the control lease usable', () => {
  const f = fixture(); f.down(1000); f.up(1060); f.down(1160); f.longPress(1660);
  f.view.touchEvent({ type: 3, touches: [], changedTouches: [], timestamp: 1700 * 1e6 });
  assert.equal(f.inputs.at(-1).body.down,false); assert.deepEqual(f.releases,[]);
  const before=f.inputs.length; f.down(2000); f.up(2060);
  assert.equal(f.inputs.length,before+2); assert.equal(f.inputs.at(-1).body.down,false);
});
