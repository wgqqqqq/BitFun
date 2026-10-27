const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/viewmodel/RemoteDesktopProbeViewModel.ets'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(context) {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const transports = [], sent = []; let stopped = 0;
  class Transport {
    constructor() { this.closed = false; this.posts = []; this.pending = new Promise(resolve => { this.resolve = resolve; }); transports.push(this); }
    request(endpoint, body) { if (endpoint === 'event') { this.posts.push(body); return Promise.resolve('{}'); } return this.pending; }
    close() { this.closed = true; }
  }
  const exports = {};
  new Function('require', 'exports', 'ObservedV2', 'Trace', js)(() => ({ RemoteDesktopProbeService: Transport }),
    exports, value => value, () => {});
  const model = new exports.RemoteDesktopProbeViewModel();
  const start = () => model.start('private-fixture-key', async raw => { sent.push(raw); }, () => { stopped++; });
  return { model, Transport, transports, sent, start, stopped: () => stopped };
}
test('legacy and shared-renderer answers remain transport-only', async context => {
  const f = fixture(context); f.start();
  f.model.receive('{"kind":"health","frames_decoded":4}');
  const diagnostics = f.model.diagnostics;
  const answers = [{ type: 'answer', answer: { sdp: 'private-sdp' } }, { kind: 'answer', answer_sdp: 'private-sdp' }];
  for (const answer of answers) f.model.receive(JSON.stringify(answer));
  await settle();
  assert.equal(f.model.diagnostics, diagnostics);
  assert.equal(f.transports[0].posts.length, 3);
  assert.ok(f.transports[0].posts.slice(1).every(raw => raw.includes('private-sdp')));
  f.model.close();
});
test('closing before poll completes cannot deliver a renderer command', async context => {
  const f = fixture(context); f.start(); f.model.close();
  f.transports[0].resolve('{"kind":"start"}'); await settle();
  assert.deepEqual(f.sent, []); assert.equal(f.transports[0].closed, true);
});
test('background stops media and replacement ignores the old poll', async context => {
  const f = fixture(context); f.start(); const old = f.transports[0];
  const before = f.stopped(); f.Transport.onLifecycle(false);
  assert.equal(f.stopped(), before + 1);
  f.start(); old.resolve('{"kind":"start","renderer_id":"old"}');
  f.transports[1].resolve('{"kind":"start","renderer_id":"new"}'); await settle();
  assert.deepEqual(f.sent, ['{"kind":"start","renderer_id":"new"}']);
  f.model.close();
});
