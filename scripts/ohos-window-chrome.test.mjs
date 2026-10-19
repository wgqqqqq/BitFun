import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../src/web-ui/package.json', import.meta.url));
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const TouchType = { Down: 0, Up: 1, Move: 2, Cancel: 3 };
const HitTestMode = { Default: 0, Block: 1 };

function fixture() {
  const exports = {};
  const source = readFileSync(new URL('../src/apps/ohos/entry/src/main/ets/WindowChrome.ets', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, console, TouchType, HitTestMode, require: name => {
    if (name === './MiniAppWindows') return { MiniAppWindows: { attach() {} } };
    if (name === './CompanionWindow') return { CompanionWindow: { attach() {} } };
    if (name === '@kit.AbilityKit') return { ConfigurationConstant: { ColorMode: {} } };
    throw new Error('Unexpected platform dependency: ' + name);
  }});
  const { WindowChrome: chrome } = exports;
  const offsets = [];
  let moves = 0, proxy;
  const native = { setWindowDecorHeight() {}, setDecorButtonStyle() {}, setWindowDecorVisible() {}, setWindowTitleMoveEnabled() {},
    getTitleButtonRect: () => ({ width: 100, right: 0 }), on() {}, off() {},
    getUIContext: () => ({ vp2px: value => value * 1.8 }), getWindowProperties: () => ({ windowRect: { width: 1620, height: 1200 } }),
    startMoving: async (x, y) => { moves++; offsets.push([x, y]); } };
  chrome.configure(native);
  const data = { url: 'openbitfun-ui://localhost/' };
  chrome.attach(data);
  data.onControllerAttached({ registerJavaScriptProxy: value => { proxy = value; }, runJavaScript: async () => {} });
  const dom = new JSDOM('<header class="openbitfun-scene-top-bar"><button>Action</button></header><aside role="dialog" style="display:none"></aside>', { runScripts: 'outside-only' });
  const { window } = dom;
  const frames = [], mutations = [];
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  window.MutationObserver = class { constructor(callback) { mutations.push(callback); } observe() {} disconnect() {} };
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.openbitfunNativeCaption = proxy;
  const bar = window.document.querySelector('header');
  bar.getBoundingClientRect = () => ({ x: 0, y: 0, width: 900, height: 45 });
  bar.querySelector('button').getBoundingClientRect = () => ({ x: 10, y: 5, width: 70, height: 30 });
  const dialog = window.document.querySelector('[role="dialog"]');
  dialog.getClientRects = () => window.getComputedStyle(dialog).display === 'none' || dialog.hidden ? [] : [{ width: 200, height: 100 }];
  window.eval(data.initializationScripts.at(-1).script);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const flush = () => { while (frames.length) frames.shift()(); };
  flush();
  return { chrome, dom, dialog, offsets, moves: () => moves, update: () => { mutations.forEach(callback => callback()); flush(); } };
}
const point = (x, y, type = TouchType.Down) => ({ type, touches: [{ windowX: x, windowY: y }] });

test('a mounted hidden dialog does not disable caption movement; visible dialogs do', () => {
  const f = fixture();
  try {
    assert.equal(f.chrome.hitTest(point(400, 20)), HitTestMode.Block);
    f.chrome.onTouch(point(400, 20));
    assert.equal(f.moves(), 1);
    f.dialog.style.display = 'block'; f.update();
    assert.equal(f.chrome.hitTest(point(400, 20)), HitTestMode.Default);
    f.chrome.onTouch(point(400, 20));
    assert.equal(f.moves(), 1);
    f.dialog.hidden = true; f.update();
    assert.equal(f.chrome.hitTest(point(400, 20)), HitTestMode.Block);
  } finally { f.dom.window.close(); }
});

test('caption hit testing keeps buttons, content, multiple pointers and non-down events in ArkWeb', () => {
  const f = fixture();
  try {
    for (const event of [point(30, 20), point(400, 100), point(400, 20, TouchType.Move), { type: TouchType.Down, touches: [point(400, 20).touches[0], point(500, 20).touches[0]] }]) {
      assert.equal(f.chrome.hitTest(event), HitTestMode.Default);
      f.chrome.onTouch(event);
    }
    assert.equal(f.moves(), 0);
    f.chrome.onTouch(point(899, 44));
    assert.equal(f.moves(), 1);
  } finally { f.dom.window.close(); }
});

test('hidden menus and visibility-hidden overlays do not block dragging', () => {
  const f = fixture();
  try {
    f.dialog.setAttribute('role', 'menu'); f.dialog.style.display = 'block'; f.dialog.style.visibility = 'hidden'; f.update();
    assert.equal(f.chrome.hitTest(point(400, 20)), HitTestMode.Block);
    f.dialog.style.visibility = 'visible'; f.update();
    assert.equal(f.chrome.hitTest(point(400, 20)), HitTestMode.Default);
  } finally { f.dom.window.close(); }
});


test('native drag keeps the logical grab point in physical pixels on high-density PCs', () => {
  const f = fixture();
  try {
    f.chrome.onTouch(point(400, 20));
    f.chrome.onTouch(point(899.9, 44.9));
    assert.deepEqual(f.offsets, [[720, 36], [1619, 80]]);
  } finally { f.dom.window.close(); }
});
