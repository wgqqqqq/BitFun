const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript'), vm = require('node:vm');
const base = path.join(__dirname, '../../entry/src/main/ets');
function fixture() {
  const commands = ['{"kind":"stop"}'], executed = [], received = [];
  class Controller { async runJavaScript(script) { executed.push(script); } }
  class State { constructor() { this.rendererQueue = { take: () => commands.shift(), clear: () => { commands.length = 0; } }; } }
  let source = fs.readFileSync(path.join(base, 'pages/components/RemoteDesktopMediaView.ets'), 'utf8');
  source = (source.slice(0, source.indexOf('\n  build()')) + '\n}').replace('export struct ', 'export class ')
    .replace(/@ComponentV2\s*/g, '').replace(/@(Param|Event)\s+/g, '').replace(/@Monitor\([^\n]*\)\s*/g, '');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => name === '@kit.ArkWeb' ? { webview: { WebviewController: Controller } }
    : name.endsWith('/RemoteDesktopState') ? { RemoteDesktopState: State } : {}, exports);
  const view = new exports.RemoteDesktopMediaView(); view.onMessage = raw => received.push(raw);
  return { view, commands, executed, received };
}
function bundledReady() {
  const events = [];
  const window = { document: { querySelector: () => ({}) }, addEventListener() {},
    OpenBitFunDesktopHost: { postMessage: raw => events.push(raw) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../../../shared/remote-desktop-media/receiver.js'), 'utf8'), { window });
  return events.find(raw => JSON.parse(raw).kind === 'bridge_ready');
}
test('the actual bundled capability-bearing ready event flushes the native media queue', async () => {
  const f = fixture(), ready = bundledReady(); assert.ok(ready);
  await f.view.flush(); assert.equal(f.executed.length, 0);
  f.view.bridge.postMessage(ready); await f.view.flush();
  assert.deepEqual(f.executed, ['window.OpenBitFunDesktopReceiver.accept({"kind":"stop"}); void 0']);
  assert.deepEqual(f.received, [ready]);
});
test('legacy ready works, other events cannot flush, and retired native bridges remain inactive', async () => {
  for (const raw of ['{"kind":"answer"}', '{', 'null']) {
    const f = fixture(); f.view.bridge.postMessage(raw); await f.view.flush(); assert.equal(f.executed.length, 0);
  }
  const f = fixture(); f.view.bridge.postMessage('{"kind":"bridge_ready"}'); await f.view.flush();
  assert.equal(f.executed.length, 1);
  f.view.aboutToDisappear(); const count = f.received.length, executed = f.executed.length;
  f.commands.push('{"kind":"start"}'); f.view.bridge.postMessage(bundledReady()); await f.view.flush();
  assert.equal(f.received.length, count); assert.equal(f.executed.length, executed);
});
