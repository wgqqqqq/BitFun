const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const loaded = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '../../../../../shared/remote-desktop-media/control.js'), 'utf8'))(loaded);
const { createController } = loaded.exports;
function fixture(context, timers = true) {
  if (timers) context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const sent = [], states = [], failures = [];
  const flags = { current: true, healthy: true, send: true };
  const control = createController({ current: () => flags.current, healthy: () => flags.healthy,
    send: message => { if (!flags.send) return false; sent.push(message); return true; },
    state: value => states.push(value), fail: code => failures.push(code) });
  function result(generation = '1', code = 'ok') {
    control.receive({ version: 1, kind: 'control_result', request_id: sent.at(-1).request_id, control_generation: generation, code });
  }
  return { control, flags, sent, states, failures, result };
}
test('control intent retains its generation and old results cannot reacquire after release', context => {
  const f = fixture(context);
  assert.equal(f.control.acquire('boot:1'), true); f.result('1');
  const old = { control_generation: '1', kind: 'pointer_move', body: { x: 0.2, y: 0.3 } };
  assert.equal(f.control.input(old), true);
  assert.equal(f.control.release(), true); f.result('1');
  assert.equal(f.control.acquire('boot:3'), true); f.result('3');
  assert.equal(f.control.input(old), false);
  f.control.receive({ version: 1, kind: 'control_revoked', control_generation: '1' });
  assert.equal(f.control.input({ ...old, control_generation: '3' }), true);
  f.control.stop(); assert.equal(f.control.input({ ...old, control_generation: '3' }), false);
});
test('renewal and visibility loss stop local input without automatic reacquisition', context => {
  const f = fixture(context); f.control.acquire('boot:1'); f.result();
  context.mock.timers.tick(2000);
  assert.equal(f.sent.at(-1).kind, 'renew_control'); f.result();
  f.flags.healthy = false; context.mock.timers.tick(2000);
  assert.equal(f.sent.at(-1).kind, 'release_control');
  assert.equal(f.states.at(-1).control_generation, undefined);
  assert.equal(f.control.input({ control_generation: '1', kind: 'key', body: { usage: 4, down: true } }), false);
  f.flags.healthy = true; f.result(); context.mock.timers.tick(2000);
  assert.equal(f.sent.filter(x => x.kind === 'acquire_control').length, 1);
  f.control.stop();
});
test('unknown acquisition and send pressure close the connection rather than replay input', context => {
  const f = fixture(context); f.control.acquire('boot:1');
  context.mock.timers.tick(4000);
  assert.deepEqual(f.failures, ['control_delivery_unknown']);
  f.result('1'); assert.equal(f.states.at(-1).control_generation, undefined);
  assert.equal(f.control.acquire('boot:1'), false);
  const other = fixture(context, false); other.control.acquire('boot:1'); other.result(); other.flags.send = false;
  assert.equal(other.control.input({ control_generation: '1', kind: 'key', body: { usage: 4, down: false } }), false);
  assert.deepEqual(other.failures, ['input_backpressure']);
  assert.equal(other.states.at(-1).control_generation, undefined);
  other.control.stop(); f.control.stop();
});

test('repeated release preserves the single pending ACK and its timeout', context => {
  const f = fixture(context);
  f.control.acquire('boot:1'); f.result();
  f.control.release();
  const release = f.sent.at(-1);
  context.mock.timers.tick(2000);
  f.control.release();
  assert.equal(f.sent.filter(message => message.kind === 'release_control').length, 1);
  assert.equal(f.states.at(-1).pending, 'release_control');
  assert.equal(f.control.acquire('boot:3'), false, 'Unknown release must remain serialized');
  context.mock.timers.tick(2000);
  assert.deepEqual(f.failures, ['control_delivery_unknown']);
  f.control.receive({ version: 1, kind: 'control_result', request_id: release.request_id, code: 'ok', control_generation: '1' });
  assert.equal(f.states.at(-1).control_generation, undefined);
  assert.equal(f.control.acquire('boot:3'), false);
});

test('duplicate release while renewal is in flight still accepts only the release ACK', context => {
  const f = fixture(context);
  f.control.acquire('boot:1'); f.result();
  context.mock.timers.tick(2000);
  const renew = f.sent.at(-1);
  f.control.release(); f.control.release();
  f.control.receive({ version: 1, kind: 'control_result', request_id: renew.request_id, code: 'ok', control_generation: '1' });
  assert.equal(f.states.at(-1).control_generation, undefined);
  assert.equal(f.control.acquire('boot:3'), false);
  f.result();
  assert.equal(f.control.acquire('boot:3'), true); f.result('3');
  assert.equal(f.states.at(-1).control_generation, '3');
  assert.deepEqual(f.failures, []); f.control.stop();
});

test('a matching post-drain revocation settles release when the host discarded its queued request', context => {
  const f = fixture(context);
  f.control.acquire('boot:1'); f.result('1');
  f.control.release();
  f.control.receive({ version: 1, kind: 'control_revoked', control_generation: '1' });
  context.mock.timers.tick(4000);
  assert.deepEqual(f.failures, [], 'A definitive host revocation was mistaken for an unknown release');
  assert.equal(f.states.at(-1).pending, undefined);
  assert.equal(f.control.input({ control_generation: '1', kind: 'key', body: { usage: 40, down: true } }), false);
  assert.equal(f.sent.filter(m => m.kind === 'acquire_control').length, 1, 'Revocation must not automatically reacquire');
  assert.equal(f.control.acquire('boot:3'), true); f.result('3');
  f.control.receive({ version: 1, kind: 'control_revoked', control_generation: '1' });
  assert.equal(f.control.input({ control_generation: '3', kind: 'key', body: { usage: 40, down: false } }), true);
  f.control.stop();
});

test('malformed revocations cannot cancel an acquisition with an unknown outcome', context => {
  const f = fixture(context);
  f.control.acquire('boot:1');
  for (const generation of [undefined, null, '', 0, 1, '01', '18446744073709551616']) {
    f.control.receive({ version: 1, kind: 'control_revoked', control_generation: generation });
  }
  assert.equal(f.states.at(-1).pending, 'acquire_control');
  context.mock.timers.tick(4000);
  assert.deepEqual(f.failures, ['control_delivery_unknown']);
  assert.equal(f.control.acquire('boot:2'), false);
});

test('a retired generation cannot settle another lease release or clear a successor acquisition', context => {
  const f = fixture(context);
  f.control.acquire('boot:1'); f.result('1');
  f.control.release(); f.result('1');
  f.control.acquire('boot:3');
  f.control.receive({ version: 1, kind: 'control_revoked', control_generation: '1' });
  assert.equal(f.states.at(-1).pending, 'acquire_control');
  f.result('3'); f.control.release();
  f.control.receive({ version: 1, kind: 'control_revoked', control_generation: '1' });
  assert.equal(f.states.at(-1).pending, 'release_control');
  assert.equal(f.control.acquire('boot:5'), false);
  context.mock.timers.tick(4000);
  assert.deepEqual(f.failures, ['control_delivery_unknown']);
});
