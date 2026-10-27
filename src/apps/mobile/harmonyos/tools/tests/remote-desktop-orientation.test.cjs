const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/RemoteDesktopOrientationService.ets'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const calls = [], exports_ = {};
  const orientation = { PORTRAIT: 1, LANDSCAPE: 2 };
  const appWindow = {
    preference: 13, rect: { width: 400, height: 800 },
    getPreferredOrientation() { calls.push(['read', this.preference]); return this.preference; },
    getWindowProperties() { return { windowRect: this.rect }; },
    async setPreferredOrientation(value) {
      calls.push(['set', value]);
      this.preference = value;
      if (value === 1) this.rect = { width: 400, height: 800 };
      if (value === 2) this.rect = { width: 800, height: 400 };
    }
  };
  const adapter = { Orientation: orientation, getLastWindow: async () => appWindow };
  new Function('require', 'exports', compiled)(() => ({ window: adapter }), exports_);
  return { Service: exports_.RemoteDesktopOrientationService, appWindow, adapter, calls };
}
test('rotation reads the current geometry each time and restores the original system preference once', async () => {
  const f = fixture(), view = new f.Service();
  assert.equal(await view.rotate({}), true);
  assert.equal(await view.rotate({}), true);
  assert.deepEqual(f.calls, [['read', 13], ['set', 2], ['set', 1]]);
  view.close(); view.close(); await tick();
  assert.deepEqual(f.calls.at(-1), ['set', 13]);
  assert.equal(f.calls.filter(c => c[1] === 13 && c[0] === 'set').length, 1);
  assert.equal(await view.rotate({}), false);
});
test('closing while the platform window lookup is pending never rotates that late window', async () => {
  const f = fixture(), wait = deferred(), view = new f.Service();
  f.adapter.getLastWindow = () => wait.promise;
  const rotation = view.rotate({}); await tick(); view.close();
  wait.resolve(f.appWindow);
  assert.equal(await rotation, false); await tick();
  assert.deepEqual(f.calls, []);
});
test('a retired pending rotation restores before a replacement captures its own preference', async () => {
  const f = fixture(), wait = deferred(), old = new f.Service();
  const apply = f.appWindow.setPreferredOrientation.bind(f.appWindow);
  let first = true;
  f.appWindow.setPreferredOrientation = async value => {
    if (first) { first = false; await wait.promise; }
    return apply(value);
  };
  const rotation = old.rotate({}); await tick(); old.close();
  const replacement = new f.Service(), next = replacement.rotate({});
  wait.resolve();
  assert.equal(await rotation, false); assert.equal(await next, true);
  assert.deepEqual(f.calls, [['read', 13], ['set', 2], ['set', 13], ['read', 13], ['set', 1]]);
  replacement.close(); await tick();
  assert.deepEqual(f.calls.at(-1), ['set', 13]);
});
test('a rejected platform rotation reports failure and does not poison the next view', async () => {
  const f = fixture(), view = new f.Service();
  const apply = f.appWindow.setPreferredOrientation.bind(f.appWindow);
  f.appWindow.setPreferredOrientation = async () => { throw new Error('platform unavailable'); };
  assert.equal(await view.rotate({}), false);
  view.close(); await tick();
  f.appWindow.setPreferredOrientation = apply;
  const next = new f.Service();
  assert.equal(await next.rotate({}), true);
  next.close(); await tick();
});
test('unknown zero-sized window geometry cannot report successful rotation', async () => {
  const f = fixture(), view = new f.Service();
  f.appWindow.rect = { width: 0, height: 0 };
  assert.equal(await view.rotate({}), false);
  assert.deepEqual(f.calls, [['read', 13]]);
  view.close(); await tick();
});
