const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,
  '../../entry/src/main/ets/pages/viewmodel/RemoteDesktopViewModel.ets'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  let hooks, service;
  const projection = { stage: 'choose_display', controlSupported: true, controlState: 'viewing',
    controlError: '', rendererId: '', candidateType: '', controlReady: false, signalingInterrupted: false };
  class State { constructor() { this.visible = false; this.panMode = false; } }
  class Service {
    constructor(value) { hooks = value; service = this; this.acquires = 0; }
    open() { hooks.update({ ...projection }); }
    close() { hooks.update({ ...projection, stage: 'closed' }); }
    acquireControl() { this.acquires++; projection.controlState = 'acquiring'; hooks.update({ ...projection }); }
    releaseControl() { projection.controlState = 'viewing'; hooks.update({ ...projection }); }
  }
  const module = {};
  new Function('require', 'exports', code)(name => name === '../../services/RemoteDesktopService'
    ? { RemoteDesktopService: Service } : name === '../state/RemoteDesktopState' ? { RemoteDesktopState: State } : {}, module);
  const vm = new module.RemoteDesktopViewModel(() => undefined);
  vm.open({ deviceId: 'desktop' });
  return { vm, service, emit(value) { Object.assign(projection, value); hooks.update({ ...projection }); } };
}

test('default input waits for presented media and transport, then makes one normal acquisition', async () => {
  const f = fixture();
  f.emit({ stage: 'observing', rendererId: 'first' }); await settle();
  assert.equal(f.service.acquires, 0);
  f.emit({ candidateType: 'relay' }); await settle();
  assert.equal(f.service.acquires, 0, 'ICE selection alone does not prove input readiness');
  f.emit({ controlReady: true }); await settle();
  assert.equal(f.service.acquires, 1);
  f.emit({}); f.emit({}); await settle();
  assert.equal(f.service.acquires, 1);
});

test('a healthy media rebuild restores requested control through a fresh acquisition', async () => {
  const f = fixture();
  f.emit({ stage: 'observing', rendererId: 'first', candidateType: 'relay', controlReady: true }); await settle();
  f.emit({ controlState: 'controlling', controlGeneration: '1' });
  f.emit({ stage: 'resuming', rendererId: '', candidateType: '', controlState: 'viewing', controlGeneration: '' });
  f.emit({ stage: 'observing', rendererId: 'second', candidateType: 'relay', controlReady: true }); await settle();
  assert.equal(f.service.acquires, 2);
});

for (const code of ['control_busy', 'control_approval_required', 'control_revoked', 'input_suspended']) {
  test(`${code} prevents retries and automatic control after a later media rebuild`, async () => {
    const f = fixture();
    f.emit({ stage: 'observing', rendererId: 'first', candidateType: 'relay', controlReady: true }); await settle();
    f.emit({ controlState: 'viewing', controlError: code });
    f.emit({}); await settle();
    f.emit({ stage: 'resuming', rendererId: '', controlError: '' });
    f.emit({ stage: 'observing', rendererId: 'second' }); await settle();
    assert.equal(f.service.acquires, 1);
    f.vm.actions.acquireControl(); await settle();
    assert.equal(f.service.acquires, 2, 'an explicit user recovery still uses the normal acquisition');
  });
}

test('explicit stop remains stopped across media changes', async () => {
  const f = fixture();
  f.emit({ stage: 'observing', rendererId: 'first', candidateType: 'relay', controlReady: true }); await settle();
  f.vm.actions.releaseControl();
  f.emit({ rendererId: 'second' }); await settle();
  assert.equal(f.service.acquires, 1);
});

test('leaving the page cancels an acquisition queued by its last update', async () => {
  const f = fixture();
  f.emit({ stage: 'observing', rendererId: 'first', candidateType: 'relay', controlReady: true });
  f.vm.close(); await settle();
  assert.equal(f.service.acquires, 0);
});

test('read-only hosts and interrupted signaling cannot acquire automatically', async () => {
  const f = fixture();
  f.emit({ stage: 'observing', rendererId: 'first', candidateType: 'relay', controlReady: true, controlSupported: false }); await settle();
  assert.equal(f.service.acquires, 0);
  f.emit({ controlSupported: true, signalingInterrupted: true }); await settle();
  f.emit({ signalingInterrupted: false }); await settle();
  assert.equal(f.service.acquires, 0);
});


test('canvas movement preserves current control and explicit stop remains stopped', async () => {
  const f = fixture();
  f.emit({ stage: 'observing', rendererId: 'first', candidateType: 'relay', controlReady: true }); await settle();
  f.emit({ controlState: 'controlling', controlGeneration: '1' });
  f.vm.actions.togglePan(); assert.equal(f.vm.state.panMode,true); assert.equal(f.vm.state.controlState,'controlling');
  f.vm.actions.togglePan(); assert.equal(f.vm.state.panMode,false); assert.equal(f.service.acquires,1);
  f.vm.actions.releaseControl(); f.vm.actions.togglePan(); f.vm.actions.togglePan(); await settle();
  assert.equal(f.vm.state.controlState,'viewing'); assert.equal(f.service.acquires,1);
});
