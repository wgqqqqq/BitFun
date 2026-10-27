const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.join(__dirname, '../../entry/src/main/ets');
function load(file, imports) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`);
    return imports[name];
  }, exports);
  return exports;
}
const official = 'https://remote.openbitfun.com/v/1.0.2';
const endpoint = load('services/RemoteDesktopServiceEndpoint.ets', {
  '@kit.ArkTS': { url: { URL: { parseURL: value => new URL(value) } } },
  './AccountDeviceLink': { OFFICIAL_RELAY_URL: official }
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function fixture(saved) {
  const store = { saved: copy(saved), writes: [], readFailure: false,
    async init() {}, async loadDesktopProfile() { if (this.loading) await this.loading.promise; if (this.readFailure) throw new Error('unreadable'); return copy(this.saved); },
    async saveDesktopProfile(value) { this.writes.push(copy(value)); if (this.pause) await this.pause.promise; this.saved = copy(value); }
  };
  const client = { pairs: [], closes: 0,
    closeAccount() { this.closes++; },
    async pairDesktopService(...args) { this.pairs.push(args); if (this.pairing) await this.pairing.promise; return { token: 'paired-token' }; },
    async listDevices() { return this.directory ? this.directory.promise : [{ deviceId: 'computer' }]; }
  };
  let uuid = 0;
  const { RemoteDesktopServiceViewModel: ViewModel } = load('pages/viewmodel/RemoteDesktopServiceViewModel.ets', {
    '@kit.ArkTS': { util: { generateRandomUUID: () => `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000` } },
    '../../services/CloudAccountClient': { CloudAccountClient: class { constructor(independent) { assert.equal(independent, true); return client; } } },
    '../../services/CloudAccountSessionStore': { CloudAccountSessionStore: class { constructor(independent) { assert.equal(independent, true); return store; } } },
    '../../services/RemoteDesktopServiceEndpoint': endpoint,
    '../../services/Encoding': { Encoding: {
      base64ToBytes: value => new Uint8Array(Buffer.from(value, 'base64')),
      bytesToBase64: value => Buffer.from(value).toString('base64'), randomBytes: length => new Uint8Array(length).fill(7)
    } },
    '../state/RemoteDesktopServiceState': { RemoteDesktopServiceState: class { connected = false; busy = false; failed = false; serviceUrl = ''; deviceId = ''; } }
  });
  return { vm: new ViewModel(), store, client, ViewModel };
}
function profile(extra = {}) {
  return { version: 1, serviceUrl: 'https://desktop.example', deviceId: 'a'.repeat(32), deviceName: 'Phone',
    requestId: '00000001-0000-4000-8000-000000000000', privateKey: Buffer.alloc(32, 7).toString('base64'),
    token: 'saved-token', principal: 'remote-desktop-self-hosted', ...extra };
}

test('self-hosted endpoints refuse login Relay, public HTTP, embedded credentials and secret query strings', () => {
  for (const value of [official, 'https://REMOTE.OPENBITFUN.COM:8443', 'http://desktop.example',
    'https://u:key@desktop.example', 'https://desktop.example?key=secret', 'https://desktop.example#secret']) {
    assert.equal(endpoint.normalizeRemoteDesktopServiceUrl(value), '', value);
  }
  assert.equal(endpoint.normalizeRemoteDesktopServiceUrl(' https://desktop.example/service/ '), 'https://desktop.example/service');
  assert.equal(endpoint.normalizeRemoteDesktopServiceUrl('http://127.0.0.1:9701/'), 'http://127.0.0.1:9701');
});

test('pending enrollment survives response loss with the same identity and never persists deployment key', async () => {
  const f = fixture(); f.client.pairing = deferred();
  const first = f.vm.connect({}, 'https://desktop.example', 'private-deployment-key'); await settle();
  assert.equal(f.store.saved.token, ''); assert.equal(f.store.saved.connectOnStartup, false);
  const retained = copy(f.store.saved);
  f.vm.disconnect(); f.client.pairing.resolve(); await first; await settle();
  assert.equal(f.vm.binding(), undefined); assert.equal(f.store.saved.connectOnStartup, false);
  const restarted = fixture(f.store.saved);
  await restarted.vm.connect({}, 'https://desktop.example', 'private-deployment-key');
  assert.equal(restarted.client.pairs[0][2], retained.deviceId);
  assert.equal(restarted.client.pairs[0][4], retained.requestId);
  assert.equal(restarted.store.saved.privateKey, retained.privateKey);
  assert.equal(restarted.vm.state.connected, true);
  assert.ok(!JSON.stringify(restarted.store.writes).includes('private-deployment-key'));
});

test('explicit disconnect wins over delayed credential writes and remains disconnected after restart', async () => {
  const f = fixture(profile({ futureField: { retained: true } })); await f.vm.init({});
  const oldKey = f.vm.binding().session.masterKey;
  f.store.pause = deferred(); const connecting = f.vm.connect({}, 'https://desktop.example', ''); await settle();
  f.vm.disconnect(); f.store.pause.resolve(); await connecting; await settle();
  assert.equal(f.vm.binding(), undefined); assert.equal(f.store.saved.connectOnStartup, false);
  assert.deepEqual(f.store.saved.futureField, { retained: true });
  const restarted = fixture(f.store.saved); await restarted.vm.init({});
  assert.equal(restarted.vm.state.connected, false); assert.equal(restarted.vm.state.serviceUrl, 'https://desktop.example');
  // An explicitly disconnected live binding erases its decoded key copy.
  await restarted.vm.connect({}, 'https://desktop.example', '');
  const key = restarted.vm.binding().session.masterKey; restarted.vm.disconnect(); await settle();
  assert.ok(key.every(value => value === 0)); assert.ok(oldKey.every(value => value === 0));
});

test('legacy additive profiles restore without reenrollment; expired credentials can reenroll the same device', async () => {
  const f = fixture(profile()); await f.vm.init({}); assert.equal(f.vm.state.connected, true);
  assert.equal(f.client.pairs.length, 0);
  await f.vm.connect({}, 'https://desktop.example', 'renewal-key');
  assert.equal(f.client.pairs.length, 1); assert.equal(f.store.saved.deviceId, 'a'.repeat(32));
  assert.equal(f.store.saved.token, 'paired-token');
});

test('disconnect during secure-store restoration cancels automatic and pending explicit connection', async () => {
  const f = fixture(profile()); f.store.loading = deferred();
  const initializing = f.vm.init({});
  const connecting = f.vm.connect({}, 'https://desktop.example', 'key');
  f.vm.disconnect(); f.store.loading.resolve();
  await initializing; await connecting; await settle();
  assert.equal(f.vm.binding(), undefined); assert.equal(f.vm.state.connected, false);
  assert.equal(f.client.pairs.length, 0); assert.equal(f.store.saved.connectOnStartup, false);
});

test('unreadable, future or wrong-principal profiles remain retained and cannot be overwritten', async () => {
  for (const [value, unreadable] of [[profile({ version: 2 }), false], [profile({ principal: 'login-account' }), false],
    [profile({ serviceUrl: official }), false], [profile({ token: 123 }), false],
    [profile({ requestId: '' }), false], [profile({ connectOnStartup: 'unexpected' }), false], [profile(), true]]) {
    const f = fixture(value); f.store.readFailure = unreadable;
    await f.vm.init({}); await f.vm.connect({}, 'https://desktop.example', 'key');
    assert.equal(f.vm.state.failed, true); assert.equal(f.vm.binding(), undefined);
    assert.equal(f.client.pairs.length, 0); assert.equal(f.store.writes.length, 0); assert.deepEqual(f.store.saved, value);
  }
});

test('changing service retains old credentials and late directory replies cannot reach a disconnected controller', async () => {
  const f = fixture(profile()); await f.vm.init({});
  await f.vm.connect({}, 'https://other.example', 'key');
  assert.equal(f.vm.state.failed, true); assert.equal(f.store.saved.serviceUrl, 'https://desktop.example'); assert.equal(f.store.writes.length, 0);
  f.client.directory = deferred(); const listing = f.vm.listDevices(); f.vm.disconnect();
  f.client.directory.resolve([{ deviceId: 'retired' }]);
  await assert.rejects(listing, /remote_desktop_connection_changed/);
});
