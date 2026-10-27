const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function fixture(relayUrl = 'http://127.0.0.1:9700') {
  const sockets = [], logs = [];
  class Socket {
    handlers = new Map(); sent = [];
    on(name, handler) { this.handlers.set(name, handler); }
    off(name) { this.handlers.delete(name); }
    async connect(url, options) { this.url = url; this.options = options; return true; }
    async send(value) { this.sent.push(value); return true; }
    async close() {}
    deliver(frame) { this.handlers.get('message')?.(undefined, frame); }
    ack(id, value) { this.deliver(`43${id}${JSON.stringify([value])}`); }
  }
  const uploads = [];
  class Payload {
    close() {}
    async uploadIfLarge(value) { uploads.push(value); return value; }
    async resolve(value) { return value; }
  }
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/AccountRealtime.ets'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('require', 'exports', js)(name => ({
    '@kit.NetworkKit': { webSocket: { createWebSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; } } },
    './RpcPayload': { RpcPayload: Payload },
    './AccountDeviceLink': { normalizeAccountRelayUrl: value => value },
    './ClientBuild': { CLIENT_PROTOCOL_VERSION: 1, clientVersion: () => 'test' },
    './RemoteLogger': { RemoteLogger: { warn: value => logs.push(value) } }
  }[name] || {}), exports);
  const client = new exports.AccountRealtime(relayUrl, 'device-token');
  const socket = sockets[0];
  socket.deliver('0{"sid":"test","pingInterval":15000,"pingTimeout":45000}');
  socket.deliver('40{}');
  socket.deliver('42["auth-ok",{"userId":"account","deviceId":"phone"}]');
  return { client, socket, uploads, logs };
}
const encrypted = { encrypted_data: 'Y2lwaGVy', nonce: 'bm9uY2U=' };
const capabilities = ['remote_desktop_route_v1'];
test('native WebSocket retains its SDK origin port across root and versioned mounts', () => {
  for (const relay of ['http://127.0.0.1:9700', 'https://relay.example/v/1.0.2']) {
    const f = fixture(relay);
    try {
      assert.equal(f.socket.options.supportOriginPort, true);
      assert.equal(f.socket.options.header, undefined, 'do not append a second conflicting Origin');
      assert.equal(f.socket.url, relay.replace(/^http/, 'ws') + '/v1/updates/?EIO=4&transport=websocket');
      assert.equal(f.socket.options.skipServerCertVerification, undefined);
    } finally { f.client.close(); }
  }
});
test('namespace refusal closes input routing and logs only known public reason codes', async () => {
  for (const message of ['origin is not allowed', 'private-secret-fixture']) {
    const f = fixture();
    f.socket.deliver(`44${JSON.stringify({ message })}`);
    await assert.rejects(f.client.callRemoteDesktop('desktop', encrypted, 1000, capabilities), /relay_closed/);
    assert.equal(f.logs.length, 1);
    assert.ok(!f.logs[0].includes('private-secret-fixture'));
    assert.ok(f.logs[0].includes(message === 'origin is not allowed' ? 'origin_is_not_allowed' : 'unclassified'));
    f.client.close();
  }
});
function calls(socket, name) {
  return socket.sent.filter(frame => frame.startsWith('42')).map(frame => {
    const start = frame.indexOf('[');
    return { id: Number(frame.slice(2, start)), value: JSON.parse(frame.slice(start)) };
  }).filter(call => call.value[0] === name);
}

test('remote desktop uses negotiated rd-call and the existing ack owner, without bulk or invoke', async () => {
  const f = fixture();
  try {
    const pending = f.client.callRemoteDesktop('desktop', encrypted, 1000, capabilities);
    await Promise.resolve();
    const [call] = calls(f.socket, 'rd-call');
    assert.equal(call.value[1].version, 1);
    assert.equal(call.value[1].targetDeviceId, 'desktop');
    assert.equal(call.value[1].method, undefined);
    f.socket.ack(call.id, { ok: true, result: encrypted });
    assert.deepEqual(await pending, encrypted);
    assert.equal(calls(f.socket, 'rpc-call').length, 0);
    assert.equal(f.uploads.length, 0);
  } finally { f.client.close(); }
});

test('old Relay, wrong target, oversize or plaintext fail before dispatch', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.client.callRemoteDesktop('desktop', encrypted, 1000, []), /relay_upgrade_required/);
    await assert.rejects(f.client.callRemoteDesktop('desktop:invoke', encrypted, 1000, capabilities), /invalid_request/);
    await assert.rejects(f.client.callRemoteDesktop('desktop', encrypted, 30001, capabilities), /invalid_request/);
    await assert.rejects(f.client.callRemoteDesktop('desktop', { op: 'attach' }, 1000, capabilities), /invalid_signal_envelope/);
    await assert.rejects(f.client.callRemoteDesktop('desktop', { encrypted_data: 'A'.repeat(128*1024+1), nonce: 'AAAA' }, 1000, capabilities), /invalid_signal_envelope/);
    assert.equal(calls(f.socket, 'rd-call').length, 0);
  } finally { f.client.close(); }
});

test('plaintext reply and authorization errors never become a successful encrypted response', async () => {
  const f = fixture();
  try {
    const bad = f.client.callRemoteDesktop('desktop', encrypted, 1000, capabilities);
    const rejected = assert.rejects(bad, /invalid_signal_envelope/);
    await Promise.resolve();
    f.socket.ack(calls(f.socket, 'rd-call')[0].id, { ok: true, result: { displayId: 'screen' } });
    await rejected;
    const denied = f.client.callRemoteDesktop('desktop', encrypted, 1000, capabilities);
    const denial = assert.rejects(denied, /authorization_expired/);
    await Promise.resolve();
    f.socket.ack(calls(f.socket, 'rd-call')[1].id, { ok: false, error: 'authorization_expired' });
    await denial;
  } finally { f.client.close(); }
});

test('timeout remains unknown and a late ack cannot resolve a subsequent request', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    const old = f.client.callRemoteDesktop('desktop', encrypted, 100, capabilities);
    const timeout = assert.rejects(old, /delivery_unknown/);
    await Promise.resolve();
    const oldId = calls(f.socket, 'rd-call')[0].id;
    context.mock.timers.tick(100); await timeout;
    const fresh = f.client.callRemoteDesktop('desktop', encrypted, 1000, capabilities);
    await Promise.resolve();
    const freshId = calls(f.socket, 'rd-call')[1].id;
    assert.notEqual(oldId, freshId);
    f.socket.ack(oldId, { ok: true, result: encrypted });
    assert.equal(f.client.pending.size, 1);
    f.socket.ack(freshId, { ok: true, result: encrypted });
    await fresh;
    assert.equal(calls(f.socket, 'rd-call').length, 2, 'no automatic retry');
  } finally { f.client.close(); }
});

test('existing general RPC keeps its original route and bulk handling', async () => {
  const f = fixture();
  try {
    const pending = f.client.call('desktop', encrypted, 1000);
    await Promise.resolve(); await Promise.resolve();
    const [call] = calls(f.socket, 'rpc-call');
    assert.equal(call.value[1].method, 'desktop:invoke');
    f.socket.ack(call.id, { ok: true, result: encrypted });
    await pending;
    assert.equal(f.uploads.length, 1);
    assert.equal(calls(f.socket, 'rd-call').length, 0);
  } finally { f.client.close(); }
});

test('attachment calls carry only the existing attachment ID as route metadata', async () => {
  const { client, socket, uploads } = fixture();
  const pending = client.callRemoteDesktop('desktop', encrypted, 1000, capabilities, 'attachment-a');
  await new Promise(resolve => setImmediate(resolve));
  const call = calls(socket, 'rd-call')[0];
  assert.equal(call.value[1].attachId, 'attachment-a');
  assert.deepEqual(call.value[1].params, encrypted);
  socket.ack(call.id, { ok: true, result: encrypted }); await pending;
  await assert.rejects(client.callRemoteDesktop('desktop', encrypted, 1000, capabilities, 'a/b'), /invalid_request/);
  assert.equal(calls(socket, 'rd-call').length, 1); assert.equal(uploads.length, 0);
  client.close();
});

for (const fatal of [false, true]) {
  test(`remote desktop reports ${fatal ? 'authentication end' : 'socket loss'} as a stable code without changing generic RPC`, async () => {
    const f = fixture();
    try {
      const rd = f.client.callRemoteDesktop('desktop', encrypted, 1000, capabilities);
      const generic = f.client.call('desktop', encrypted, 1000);
      const rdRejected = assert.rejects(rd, new RegExp(fatal ? '^Error: relay_authentication_ended$' : '^Error: relay_disconnected$'));
      const genericRejected = assert.rejects(generic, /Relay connection lost; delivery outcome is unknown/);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      assert.equal(calls(f.socket, 'rd-call').length, 1); assert.equal(calls(f.socket, 'rpc-call').length, 1);
      if (fatal) f.socket.deliver('44{"message":"authentication failed"}');
      else f.socket.handlers.get('close')();
      await Promise.all([rdRejected, genericRejected]);
    } finally { f.client.close(); }
  });
}

function channelFixture() {
  const logs = [], requests = [];
  let current = true, transportError, hostError;
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/RemoteDesktopAccountChannel.ets'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  class Cipher {
    async encrypt(bytes) { return bytes; }
    async decrypt() { return Buffer.from(JSON.stringify(hostError ? { error: { code: hostError, detail: 'private-host-detail' } } : {})); }
  }
  new Function('require', 'exports', js)(name => ({
    './Encoding': { Encoding: { utf8ToBytes: value => Buffer.from(value), randomBytes: () => new Uint8Array(12), bytesToBase64: value => Buffer.from(value).toString('base64'), base64ToBytes: value => Buffer.from(value, 'base64'), bytesToUtf8: value => Buffer.from(value).toString(), parseJsonObject: JSON.parse } },
    './RemoteCrypto': { HarmonyRemoteCryptoCipher: Cipher },
    './RemoteLogger': { RemoteLogger: { warn: message => logs.push(message) } }
  }[name] || {}), exports);
  const channel = new exports.RemoteDesktopAccountChannel({
    socket: { callRemoteDesktop: async (...args) => { requests.push(args); await Promise.resolve(); if (transportError) throw transportError; return encrypted; } },
    target: 'private-device', key: new Uint8Array(32), capabilities, current: () => current
  });
  return { channel, logs, requests, setCurrent: value => { current = value; }, setTransportError: value => { transportError = value; }, setHostError: value => { hostError = value; } };
}

test('encrypted channel distinguishes target refusal provenance without logging request or error detail or replaying', async () => {
  for (const origin of ['relay_response', 'host_response']) {
    const f = channelFixture();
    if (origin === 'relay_response') f.setTransportError(new Error('target_unavailable'));
    else f.setHostError('target_unavailable');
    await assert.rejects(f.channel.call({ version: 1, op: 'attach', body: { private: 'private-request' } }, 'private-attachment'), /target_unavailable/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.logs, ['remote desktop target unavailable origin=' + origin]);
  }
  for (const origin of ['relay', 'host']) {
    const f = channelFixture();
    if (origin === 'relay') f.setTransportError(new Error('private-transport-detail'));
    else f.setHostError('private-host-error');
    await assert.rejects(f.channel.call({ version: 1, op: 'capabilities' }));
    assert.deepEqual(f.logs, []);
  }
});

test('retired encrypted channels keep late refusal diagnostics silent', async () => {
  for (const origin of ['relay', 'host']) {
    const f = channelFixture();
    if (origin === 'relay') f.setTransportError(new Error('target_unavailable'));
    else f.setHostError('target_unavailable');
    const pending = f.channel.call({ version: 1, op: 'capabilities' });
    for (let step = 0; f.requests.length === 0 && step < 10; step++) await Promise.resolve();
    assert.equal(f.requests.length, 1, 'retire after dispatch, before its reply');
    f.setCurrent(false);
    await assert.rejects(pending);
    assert.deepEqual(f.logs, []);
    assert.equal(f.requests.length, 1);
  }
});
