const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const folder = path.join(__dirname, '../../entry/src/main/ets/services');
function load(name, dependencies = {}) {
  const source = fs.readFileSync(path.join(folder, name + '.ets'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const output = {};
  new Function('exports', 'require', code)(output, name => {
    assert.ok(dependencies[name], 'Unexpected platform dependency: ' + name);
    return dependencies[name];
  });
  return output;
}
const pure = load('RemoteDesktopKeyboardInput');
function fixture() {
  const messages = [], failures = [];
  const input = new pure.RemoteDesktopKeyboardInput('renderer-a', '7', {
    input: message => messages.push(message), unavailable: () => failures.push(true),
  });
  return { input, messages, failures };
}
test('ordinary typing commits immediately, repeated letters remain distinct and context is not mirrored', () => {
  const f = fixture(); f.input.commit('a'); f.input.commit('a'); f.input.commit('你🙂e\u0301');
  assert.deepEqual(f.messages.map(m => m.body.text), ['a', 'a', '你🙂e\u0301']);
  assert.ok(f.messages.every(m => m.kind === 'text_commit' && m.renderer_id === 'renderer-a' && m.control_generation === '7'));
  assert.equal(f.input.leftContext(100), ''); assert.equal(f.input.cursor(), 0);
});
test('Chinese preedit stays local; the confirmed replacement commits once without a send button', () => {
  const f = fixture(); f.input.setPreview('n', -1, -1); f.input.setPreview('ni', -1, -1);
  assert.equal(f.messages.length, 0); assert.equal(f.input.leftContext(10), 'ni');
  f.input.commit('你'); f.input.finishPreview();
  assert.deepEqual(f.messages.map(m => m.body.text), ['你']);
  f.input.setPreview('好', -1, -1); f.input.finishPreview(); f.input.finishPreview();
  assert.deepEqual(f.messages.map(m => m.body.text), ['你', '好']);
});
test('backspace in preedit does not delete remote text, and cancelled preedit never commits', () => {
  const f = fixture(); f.input.setPreview('ni', -1, -1); f.input.delete(true, 1);
  assert.equal(f.input.leftContext(10), 'n'); assert.equal(f.messages.length, 0);
  f.input.setPreview('', -1, -1); f.input.finishPreview();
  assert.equal(f.messages.length, 0);
  f.input.setPreview('discard', -1, -1); f.input.close(); f.input.finishPreview(); f.input.commit('late');
  assert.equal(f.messages.length, 0);
});
test('backspace, forward delete, return and tab are paired physical input, never local edits', () => {
  const f = fixture(); f.input.delete(true, 1); f.input.delete(false, 1); f.input.key(40); f.input.key(43);
  assert.deepEqual(f.messages.map(m => [m.body.usage, m.body.down]), [
    [42, true], [42, false], [76, true], [76, false], [40, true], [40, false], [43, true], [43, false],
  ]);
});
test('multiline commits preserve text/return order, and invalid input never partially types', () => {
  const f = fixture(); f.input.commit('one\r\ntwo\n');
  assert.deepEqual(f.messages.map(m => m.kind === 'text_commit' ? m.body.text : [m.body.usage, m.body.down]),
    ['one', [40, true], [40, false], 'two', [40, true], [40, false]]);
  for (const text of ['\ud800', 'bad\0text', 'a'.repeat(4097)]) {
    const invalid = fixture(); invalid.input.commit(text);
    assert.equal(invalid.messages.length, 0); assert.equal(invalid.failures.length, 1);
  }
});
test('bulk UTF-16 deletion or an unknown composition range stops rather than guessing the remote field', () => {
  const f = fixture(); f.input.delete(true, 2); f.input.key(42);
  assert.equal(f.messages.length, 0); assert.equal(f.failures.length, 1);
  const g = fixture(); g.input.setPreview('n', -1, -1); g.input.setPreview('x', 2, 3); g.input.finishPreview();
  assert.equal(g.messages.length, 0); assert.equal(g.failures.length, 1);
});
test('composition context never returns half a surrogate or accepts an unpaired replacement', () => {
  const f = fixture(); f.input.setPreview('🙂', -1, -1);
  assert.equal(f.input.leftContext(1), ''); assert.equal(f.input.leftContext(2), '🙂');
  f.input.setPreview('\ude01', 1, 2); f.input.finishPreview();
  assert.equal(f.messages.length, 0); assert.equal(f.failures.length, 1);
});

function platform(offFailure) {
  const listeners = new Map(), calls = [], messages = [], failures = [], removals = [];
  let resolveAttach;
  let attached = false;
  const controller = {
    on: (name, fn) => {
      assert.ok(attached || ['setPreviewText', 'finishTextPreview'].includes(name), 'Editing callbacks require an attached platform client');
      if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn);
    },
    off: (name, fn) => {
      removals.push(name);
      if (name === offFailure) throw new Error('Platform callback removal failed');
      listeners.get(name)?.delete(fn);
    },
    attach: async () => { calls.push('attach'); await new Promise(resolve => { resolveAttach = resolve; }); },
    detach: async () => { attached = false; calls.push('detach'); },
  };
  const ime = { getController: () => controller, TextInputType: { TEXT: 0 }, EnterKeyType: { NEWLINE: 0 },
    KeyboardStatus: { HIDE: 0 }, Direction: { CURSOR_LEFT: 0, CURSOR_RIGHT: 1, CURSOR_UP: 2, CURSOR_DOWN: 3 } };
  const { RemoteDesktopKeyboardService } = load('RemoteDesktopKeyboardService', {
    '@kit.IMEKit': { inputMethod: ime }, './RemoteDesktopKeyboardInput': pure,
  });
  const emit = (name, ...args) => [...(listeners.get(name) || [])].forEach(fn => fn(...args));
  const make = (renderer, generation) => new RemoteDesktopKeyboardService(renderer, generation, {
    input: m => messages.push(m), unavailable: () => failures.push(true),
  }, () => calls.push('hidden'));
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { listeners, calls, messages, failures, removals, make, emit, settle, Service: RemoteDesktopKeyboardService,
    resolve: () => { attached = true; resolveAttach(); } };
}
test('one failed IME callback removal cannot skip other removals or detach before a successor', async () => {
  for (const failedEvent of ['setPreviewText', 'insertText', 'sendKeyboardStatus']) {
    const f = platform(failedEvent), a = f.make('a', '1'); a.open(); await f.settle(); f.resolve(); await f.settle();
    let b;
    try {
      const registered = [...f.listeners.keys()];
      const oldInsert = [...f.listeners.get('insertText')][0];
      a.close(); b = f.make('b', '2'); b.open(); await f.settle();
      assert.deepEqual(f.removals, registered, 'Every old callback must get an independent removal attempt');
      assert.deepEqual(f.calls, ['attach', 'detach', 'attach']);
      for (const [name, listeners] of f.listeners) {
        assert.equal(listeners.size, (name === failedEvent ? 1 : 0) + (['setPreviewText', 'finishTextPreview'].includes(name) ? 1 : 0));
      }
      // A callback retained by a failing platform must remain fenced even once
      // the next lease has attached its own input client.
      f.resolve(); await f.settle(); oldInsert('retired input');
      f.emit('insertText', 'fresh');
      assert.equal(f.messages.length, 1); assert.equal(f.messages[0].renderer_id, 'b');
      assert.equal(f.messages[0].control_generation, '2');
    } finally {
      a.close(); b?.close(); await f.settle(); f.resolve(); await f.settle();
    }
  }
});
test('closing during platform attachment drops queued IME input and serializes detach before a new keyboard', async () => {
  const f = platform(), a = f.make('a', '1'); a.open(); await f.settle();
  assert.equal(f.listeners.has('insertText'), false);
  const late = [...f.listeners.get('setPreviewText')][0];
  a.close(); late('late', {start:-1,end:-1}); const b = f.make('b', '2'); b.open(); await f.settle();
  assert.deepEqual(f.calls, ['attach']); assert.equal(f.messages.length, 0);
  f.resolve(); await f.settle(); assert.deepEqual(f.calls, ['attach', 'detach', 'attach']);
  f.resolve(); await f.settle(); late('still late', {start:-1,end:-1}); f.emit('insertText', 'fresh');
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].renderer_id, 'b'); assert.equal(f.messages[0].control_generation, '2');
  b.close(); await f.settle(); assert.ok([...f.listeners.values()].every(set => set.size === 0));
});
test('platform callbacks forward committed text/paired keys and hidden keyboards cannot send late input', async () => {
  const f = platform(), a = f.make('a', '1'); a.open(); await f.settle(); f.resolve(); await f.settle();
  f.emit('setPreviewText', 'ni', { start: -1, end: -1 }); assert.equal(f.messages.length, 0);
  f.emit('insertText', '你'); f.emit('finishTextPreview'); f.emit('deleteLeft', 1); f.emit('sendFunctionKey', {});
  assert.deepEqual(f.messages.map(m => m.kind), ['text_commit', 'key', 'key', 'key', 'key']);
  const late = [...f.listeners.get('insertText')][0];
  f.emit('sendKeyboardStatus', 0); late('late'); await f.settle();
  assert.equal(f.messages.length, 5); assert.deepEqual(f.calls, ['attach', 'hidden', 'detach']);
});
test('selecting another remote target retires preedit before the click; stale pointers cannot close a new keyboard', async () => {
  const f = platform(), a = f.make('a', '1'); a.open(); await f.settle(); f.resolve(); await f.settle();
  f.emit('setPreviewText', 'unconfirmed', {start:-1,end:-1});
  const lateFinish = [...f.listeners.get('finishTextPreview')][0];
  f.Service.beforePointer({renderer_id:'a',control_generation:'old',kind:'pointer_button',body:{down:true}});
  assert.deepEqual(f.calls,['attach']);
  f.Service.beforePointer({renderer_id:'a',control_generation:'1',kind:'pointer_move',body:{x:.2,y:.3}});
  assert.deepEqual(f.calls,['attach']);
  f.Service.beforePointer({renderer_id:'a',control_generation:'1',kind:'pointer_button',body:{down:true}});
  lateFinish(); await f.settle();
  assert.equal(f.messages.length,0); assert.deepEqual(f.calls,['attach','hidden','detach']);
});
test('a host without text support still exposes physical keys without attaching a text input method', async () => {
  const f = platform(), a = f.make('a', '1'); a.open(false); a.key(43); await f.settle();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.messages.map(m=>[m.kind,m.body.usage,m.body.down]),[['key',43,true],['key',43,false]]);
  a.close(); await f.settle(); assert.deepEqual(f.calls, []);
});
test('IME range selection and clipboard-style extended editing explicitly stop without guessing remote content', async () => {
  for (const [event, value] of [['selectByRange',{start:0,end:3}],['selectByMovement',{direction:0}],['handleExtendAction',5]]) {
    const f = platform(), a = f.make('a','1'); a.open(); await f.settle(); f.resolve(); await f.settle();
    f.emit(event,value); await f.settle(); f.emit('insertText','late');
    assert.equal(f.failures.length,1); assert.equal(f.messages.length,0); assert.deepEqual(f.calls,['attach','detach']);
  }
});
