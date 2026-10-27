const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function fixture() {
  const instances = [], inputs = [], unavailable = [], hidden = [];
  const scheduled = new Map();
  let id = 0;
  class State {
    constructor() {
      Object.assign(this, { stage: 'observing', controlState: 'controlling', rendererId: 'renderer',
        controlGeneration: '1', textSupported: true, signalingInterrupted: false });
    }
  }
  class Keyboard {
    constructor(renderer, generation, hooks, onHidden) {
      Object.assign(this, { renderer, generation, hooks, onHidden, opened: false, closed: false });
      instances.push(this);
    }
    open() { this.opened = true; }
    close() { this.closed = true; }
  }
  const file = path.join(__dirname, '../../entry/src/main/ets/pages/components/RemoteDesktopKeyboard.ets');
  let source = fs.readFileSync(file, 'utf8');
  const cut = source.indexOf('\n  @Builder private Key');
  assert.ok(cut > 0);
  source = (source.slice(0, cut) + '\n}').replace('export struct ', 'export class ')
    .replace(/@ComponentV2\s*/g, '').replace(/@(Param|Event)\s+/g, '');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText;
  const exports = {};
  new Function('require', 'exports', 'setTimeout', 'clearTimeout', code)(name => {
    if (name.endsWith('/RemoteDesktopState')) return { RemoteDesktopState: State, emptyRemoteDesktopActions: () => ({}) };
    if (name.endsWith('/RemoteDesktopKeyboardService')) return { RemoteDesktopKeyboardService: Keyboard };
    return {};
  }, exports, fn => { scheduled.set(++id, fn); return id; }, () => {});
  const view = new exports.RemoteDesktopKeyboard();
  view.isRequested = () => true;
  view.actions = { input: value => inputs.push(value) };
  view.onUnavailable = () => unavailable.push(true);
  view.onHidden = () => hidden.push(true);
  view.aboutToAppear();
  return { view, instances, inputs, unavailable, hidden,
    open() { view.open(); return id; }, run(key) { scheduled.get(key)(); } };
}

test('delayed keyboard open cannot inherit a successor binding or interrupted authority', () => {
  for (const change of [state => state.controlGeneration = '3', state => state.rendererId = 'replacement',
    state => state.signalingInterrupted = true, state => state.stage = 'terminal']) {
    const f = fixture(); const timer = f.open(); change(f.view.state); f.run(timer);
    assert.equal(f.instances.length, 0);
  }
});

test('retired keyboard callbacks cannot affect a successor before component unmount', () => {
  const f = fixture(); f.run(f.open()); const old = f.instances[0];
  f.view.state.controlGeneration = '3';
  old.hooks.input({ kind: 'text_commit' }); old.hooks.unavailable(); old.onHidden();
  assert.deepEqual([f.inputs.length, f.unavailable.length, f.hidden.length], [0, 0, 0]);
});

test('hiding the keyboard fences callbacks before ArkUI removes the component', () => {
  const f = fixture(); let requested = true; f.view.isRequested = () => requested;
  f.run(f.open()); const old = f.instances[0]; requested = false;
  old.hooks.input({ kind: 'text_commit' }); old.hooks.unavailable(); old.onHidden();
  assert.deepEqual([f.inputs.length, f.unavailable.length, f.hidden.length], [0, 0, 0]);
});

test('hide then reopen in one UI flush cannot revive the previous open request', () => {
  const f = fixture(); let request = 1;
  f.view.isRequested = () => request === 1;
  const timer = f.open(); request = 3; f.run(timer);
  assert.equal(f.instances.length, 0);
});

test('queued canceled open cannot replace the newest request for the same binding', () => {
  const f = fixture(); const old = f.open(); const current = f.open();
  f.run(old); assert.equal(f.instances.length, 0);
  f.run(current); assert.equal(f.instances.length, 1); assert.equal(f.instances[0].opened, true);
});

test('current callbacks work while reopen and disappearance retire old instances immediately', () => {
  const f = fixture(); f.run(f.open()); const first = f.instances[0];
  first.hooks.input({ kind: 'text_commit' }); first.hooks.unavailable(); first.onHidden();
  assert.deepEqual([f.inputs.length, f.unavailable.length, f.hidden.length], [1, 1, 1]);
  const timer = f.open(); assert.equal(first.closed, true);
  first.hooks.input({ kind: 'text_commit' }); first.hooks.unavailable(); first.onHidden();
  assert.deepEqual([f.inputs.length, f.unavailable.length, f.hidden.length], [1, 1, 1]);
  f.view.aboutToDisappear(); f.run(timer);
  assert.equal(f.instances.length, 1);
});
