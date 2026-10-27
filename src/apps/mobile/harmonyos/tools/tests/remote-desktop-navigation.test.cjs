const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/runtime/AppRootRuntime.ets'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports_ = {};
class Composition {
  constructor() {
    this.calls = [];
    this.remoteDesktopViewModel = { state: { visible: true }, close: () => { this.calls.push('desktop-close'); this.remoteDesktopViewModel.state.visible = false; } };
    this.appShellState = { showConnectSheet: false, setConnectSheetVisible: value => { this.calls.push('sheet'); this.appShellState.showConnectSheet = value; } };
    this.filePreviewState = { visible: false };
    this.filePreviewController = { close: () => this.calls.push('preview-close') };
    this.appShellViewModel = { backAction: () => 'none' };
  }
}
new Function('require', 'exports', compiled)(name => name === './AppRootRuntimeComposition'
  ? { AppRootRuntimeComposition: Composition } : name === '../navigation/AppRouteContract'
    ? { AppNavigationBackAction: { CloseSidebar: 'sidebar', CloseActiveChat: 'chat', PopRemoteHome: 'home' } } : {}, exports_);
for (const method of ['handleRootBack', 'handleNavigationBack']) {
  test(`${method} closes full-page remote desktop before touching the underlying chat or sheet`, () => {
    const runtime = new exports_.AppRootRuntime({});
    assert.equal(runtime[method]('remote-chat'), true);
    assert.deepEqual(runtime.calls, ['desktop-close']);
    assert.equal(runtime.remoteDesktopViewModel.state.visible, false);
    assert.equal(runtime[method]('remote-chat'), false);
    assert.deepEqual(runtime.calls, ['desktop-close']);
    runtime.appShellState.showConnectSheet = true;
    assert.equal(runtime[method]('remote-chat'), true);
    assert.deepEqual(runtime.calls, ['desktop-close', 'sheet']);
  });
}
