import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const shortcut = 'openbitfun.miniapp.' + id;
const context = { abilityInfo: { bundleName: 'com.bitfun.app', moduleName: 'entry' } };
function fixture(overrides = {}, api = 24) {
  const calls = [];
  const manager = {
    getPinShortcutInfos: async () => [],
    checkPinShortcutPermitted: async (...args) => { calls.push(['check', ...args]); return { code: 0, tid: 'verified' }; },
    requestNewPinShortcut: async (...args) => { calls.push(['pin', ...args]); },
    removePinShortcut: async (...args) => { calls.push(['remove', ...args]); },
    ...overrides,
  };
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/apps/ohos/entry/src/main/ets/MiniAppShortcuts.ets', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (name === '@kit.AppGalleryKit') return { productViewManager: manager };
    if (name === '@kit.BasicServicesKit') return { deviceInfo: { sdkApiVersion: api } };
    throw new Error('Unexpected platform dependency: ' + name);
  }});
  return { adapter: exports.MiniAppShortcuts, calls };
}

test('shortcut targets the host with only a stable identity and uses the bounded dynamic-icon API', async () => {
  const { adapter, calls } = fixture();
  await adapter.pin(context, id, 'Notes', '/private/icon.png');
  const [, ctx, key, want, label, icon, background] = calls[0];
  assert.equal(ctx, context); assert.equal(key, shortcut);
  assert.equal(want.abilityName, 'EntryAbility');
  assert.deepEqual(JSON.parse(JSON.stringify(want.parameters)), { 'openbitfun.miniappLaunchId': id });
  assert.equal(label, 'Notes'); assert.equal(icon, '/private/icon.png'); assert.equal(background, '');
  assert.deepEqual(calls[1], ['pin', context, 'verified']);
});

test('pin waits for OS confirmation and propagates cancellation', async () => {
  let rejectConfirmation, enterConfirmation;
  const entered = new Promise(resolve => { enterConfirmation = resolve; });
  const { adapter } = fixture({ requestNewPinShortcut: () => new Promise((_, reject) => { rejectConfirmation = reject; enterConfirmation(); }) });
  let settled = false;
  const pending = adapter.pin(context, id, 'Notes', '/private/icon.png');
  pending.finally(() => { settled = true; }).catch(() => {});
  await entered;
  assert.equal(settled, false);
  rejectConfirmation(new Error('1006620007: User refused'));
  await assert.rejects(pending, /User refused/);
});

test('refusing removal during update leaves the existing shortcut untouched', async () => {
  const { adapter, calls } = fixture({ getPinShortcutInfos: async () => [{ shortcutId: shortcut }], removePinShortcut: async () => { throw new Error('1006620013: User refused'); } });
  await assert.rejects(adapter.pin(context, id, 'New name', '/private/icon.png'), /User refused/);
  assert.equal(calls.length, 0);
});

test('quota or verification failure never reports an installed entry', async () => {
  const { adapter, calls } = fixture({ checkPinShortcutPermitted: async () => ({ code: 1006620004 }) });
  await assert.rejects(adapter.pin(context, id, 'Notes', '/private/icon.png'), /1006620004/);
  assert.equal(calls.length, 0);
});

test('status and removal use actual OS entries and only the requested launch identities', async () => {
  let installed = true;
  const { adapter, calls } = fixture({ getPinShortcutInfos: async () => installed ? [{ shortcutId: shortcut }, { shortcutId: 'unrelated' }] : [] });
  assert.deepEqual(Array.from(await adapter.installed([id])), [id]);
  await adapter.remove(context, [id]);
  assert.deepEqual(calls, [['remove', context, shortcut]]);
  installed = false;
  assert.deepEqual(Array.from(await adapter.installed([id])), []);
  await adapter.remove(context, [id]);
  assert.equal(calls.length, 1);
});

test('invalid identities and older devices fail explicitly before an OS mutation', async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.pin(context, '../other', 'Notes', '/private/icon.png'), /Invalid MiniApp launch identity/);
  assert.equal(calls.length, 0);
  await assert.rejects(fixture({}, 21).adapter.installed([id]), /API 24/);
});

test('the MiniApp Ability shares the default process and has no public launch surface', () => {
  const module = JSON.parse(readFileSync(new URL('../src/apps/ohos/entry/src/main/module.json5', import.meta.url))).module;
  const ability = module.abilities.find(item => item.name === 'MiniAppAbility');
  assert.equal(ability.exported, false);
  assert.equal(ability.launchType, 'specified');
  assert.equal(ability.process, undefined);
  assert.equal(ability.skills, undefined);
  const capability = JSON.parse(readFileSync(new URL('../src/apps/desktop/ohos-capabilities/main.json', import.meta.url)));
  assert.deepEqual(capability.webviews, ['main']);
  assert.equal(capability.windows, undefined);
});

function entryFixture() {
  const calls = [];
  const subscriptions = new Map();
  const nativeWindow = {
    minimize: async () => { calls.push('minimize'); },
    showWindow: async () => { calls.push('show'); },
    on: (event, callback) => subscriptions.set(event, callback),
  };
  class NativeAbility {
    context = {};
    async onWindowStageCreate() {}
  }
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/apps/ohos/entry/src/main/ets/entryability/EntryAbility.ets', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, console, require: name => {
    if (name === '@ohos-rs/ability') return { NativeAbility };
    if (name === '../WindowChrome') return { WindowChrome: { configure() {} } };
    if (name === '@kit.PerformanceAnalysisKit') return { hilog: { info() {} } };
    if (name === 'libopenbitfun_desktop_lib.so') return { launchMiniApp: (launchId, complete) => { calls.push(['launch', launchId]); complete(null); } };
    if (name === '@kit.ArkUI') return { promptAction: { showToast: () => calls.push('error') } };
    return {};
  }});
  const stage = { getMainWindow: async () => nativeWindow, loadContent: async () => {}, on: (event, callback) => subscriptions.set(event, callback) };
  return { entry: new exports.default(), stage, calls, subscriptions };
}

test('closing the workbench cancels destruction synchronously and preserves the shared host even without an open MiniApp', async () => {
  const { entry, stage, calls, subscriptions } = entryFixture();
  await entry.onWindowStageCreate(stage);
  assert.equal(subscriptions.get('windowStageClose')(), true);
  assert.equal(await subscriptions.get('windowWillClose')(), true);
  assert.deepEqual(calls, ['minimize', 'minimize']);
});

test('a desktop Want opens its MiniApp and hides the workbench without restarting the native runtime', async () => {
  const { entry, stage, calls } = entryFixture();
  await entry.onWindowStageCreate(stage);
  entry.onNewWant({ parameters: { 'openbitfun.miniappLaunchId': id } }, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['launch', id], 'minimize']);
});
