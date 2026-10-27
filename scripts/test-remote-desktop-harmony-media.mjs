// DEBUG HarmonyOS product renderer + production macOS sender. No account/input.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin');
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--display'
  && /^macos:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(args[1]),
  'Use --display macos:<uuid> within the authorized local capture scope');
const display = args[1];
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-rd-harmony-media-'));
console.log(`Harmony native media evidence: ${directory}`);
const run = (command, parameters) => new Promise((resolve, reject) => {
  const child = spawn(command, parameters, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}`)));
});
const hdc = process.env.HDC || '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc';
const targets = (await run(hdc, ['list', 'targets'])).trim().split(/\s+/).filter(value => value && value !== '[Empty]');
assert.equal(targets.length, 1, 'Connect exactly one authorized test phone');
const device = (...parameters) => run(hdc, ['-t', targets[0], ...parameters]);
const manifest = await readFile(join(root, 'src/apps/mobile/harmonyos/AppScope/app.json5'), 'utf8');
const bundle = manifest.match(/"bundleName"\s*:\s*"([^"]+)"/)?.[1];
assert.ok(bundle);
let harness = process.env.OPENBITFUN_TEST_BINARY;
if (!harness) {
  const messages = await run('cargo', ['test', '--locked', '-p', 'openbitfun-desktop',
    '--features', 'remote-desktop-media', '--lib', 'remote_desktop::media', '--no-run', '--message-format=json']);
  const artifacts = messages.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(message => message.reason === 'compiler-artifact' && message.profile.test && message.executable);
  assert.equal(artifacts.length, 1); harness = artifacts[0].executable;
}
const privateConfig = process.env.OPENBITFUN_RD_NATIVE_MEDIA_CONFIG
  ? JSON.parse(await readFile(process.env.OPENBITFUN_RD_NATIVE_MEDIA_CONFIG, 'utf8')) : {};
privateConfig.phone = true;
const configuration = join(directory, 'configuration.json');
await writeFile(configuration, JSON.stringify(privateConfig), { mode: 0o600, flag: 'wx' });
const writeReceipt = async (name, value) => {
  const temporary = join(directory, `.${name}.node`);
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, name));
};
const key = randomBytes(24).toString('hex');
let command = {}, binding, answerWritten = false;
const events = [];
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json');
  if (request.headers.host !== '127.0.0.1:18765' || request.headers.authorization !== `Bearer ${key}`) {
    response.writeHead(401); response.end('{}'); return;
  }
  try {
    if (request.method === 'GET' && request.url === '/api/receiver') {
      response.end(JSON.stringify(command)); return;
    }
    if (request.method !== 'POST' || request.url !== '/api/event') { response.writeHead(404); response.end('{}'); return; }
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; assert.ok(size <= 128 * 1024); chunks.push(chunk); }
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (event.kind === 'bridge_ready') { response.end('{}'); return; }
    assert.ok(binding && event.renderer_id === binding.renderer_id && event.attach_id === binding.attach_id
      && event.connection_id === binding.connection_id, 'Current fixture binding required');
    if (event.kind === 'answer') {
      if (!answerWritten) {
        assert.equal(typeof event.answer_sdp, 'string'); assert.ok(event.answer_sdp.length <= 90 * 1024);
        answerWritten = true; await writeReceipt('answer.json', { answer_sdp: event.answer_sdp });
      }
    } else {
      // Evidence contains diagnostics only. Never persist arbitrary bridge
      // bodies, SDP, ICE credentials or HTTP Authorization in event history.
      events.push({ at_ms: performance.now(), kind: event.kind, code: event.code,
        width: event.width, height: event.height, frames_decoded: event.frames_decoded,
        candidate_type: event.candidate_type, remote_candidate_type: event.remote_candidate_type,
        protocol: event.protocol, relay_protocol: event.relay_protocol });
      if (events.length > 256) events.shift();
    }
    response.end('{}');
  } catch { response.writeHead(400); response.end('{}'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(18765, '127.0.0.1', resolve); });
let native, completion, finished, watchdog, reversed = false, launched = false;
let transcript = '', nativeErrors = '';
try {
  await device('rport', 'tcp:18765', 'tcp:18765'); reversed = true;
  await device('shell', 'aa', 'force-stop', bundle);
  await device('shell', 'aa', 'start', '-a', 'EntryAbility', '-b', bundle,
    '--ps', 'openbitfunRemoteDesktopProbe', 'true', '--ps', 'remoteDesktopSharedReceiver', 'true',
    '--ps', 'remoteDesktopProbeKey', key); launched = true;
  native = spawn(harness, ['native_remote_desktop_capture_to_shared_receiver_and_source_stop',
    '--ignored', '--test-threads=1', '--nocapture'], { cwd: root, windowsHide: true,
    env: { ...process.env, OPENBITFUN_RD_CAPTURE_AUTHORIZED: '1', OPENBITFUN_RD_CAPTURE_DISPLAY: display,
      OPENBITFUN_RD_MEDIA_PROBE_DIRECTORY: directory, OPENBITFUN_RD_NATIVE_MEDIA_CONFIG: configuration },
    stdio: ['ignore', 'pipe', 'pipe'] });
  native.stdout.on('data', chunk => { transcript += String(chunk); });
  native.stderr.on('data', chunk => { nativeErrors += String(chunk); });
  completion = new Promise((resolve, reject) => {
    native.once('error', reject);
    native.once('close', (code, signal) => { finished = { code, signal }; resolve(finished); });
  });
  watchdog = setTimeout(() => native.kill('SIGTERM'), 75_000);
  const waitReceipt = async (name, predicate = () => true, budget = 30_000) => {
    const deadline = performance.now() + budget;
    while (performance.now() < deadline) {
      try {
        const value = JSON.parse(await readFile(join(directory, name), 'utf8'));
        if (predicate(value)) return value;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.equal(finished, undefined, `Native probe exited before ${name}: ${JSON.stringify(finished)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Phone/native receipt deadline expired: ${name}`);
  };
  binding = await waitReceipt('offer.json'); command = binding;
  await waitReceipt('state.json', state => state.phase === 'awaiting_source');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.ok(!events.some(event => event.kind === 'first_frame_presented' || event.frames_decoded > 0));
  await writeReceipt('capture.json', { start: true });
  await waitReceipt('state.json', state => state.phase === 'capture' && state.submitted > 0);
  command = { kind: 'source_ready', renderer_id: binding.renderer_id, connection_id: binding.connection_id };
  const result = await waitReceipt('result.json');
  assert.equal((await completion).code, 0);
  assert.match(transcript, /test result: ok\. 1 passed;/);
  const first = events.find(event => event.kind === 'first_frame_presented');
  assert.ok(first?.width > 0 && first?.height > 0, 'Real phone presentation missing');
  assert.ok(events.some(event => event.frames_decoded > 1), 'No phone decoder progression');
  if (privateConfig.force_relay) assert.ok(events.some(event => event.frames_decoded > 1
    && event.candidate_type === 'relay' && event.remote_candidate_type === 'relay'), 'Selected relay/relay media pair missing');
  const requestedTransport = privateConfig.receiver_ice_servers?.[0]?.urls?.[0]?.match(/transport=(udp|tcp)/)?.[1];
  if (privateConfig.force_relay && requestedTransport) assert.ok(events.some(event => event.frames_decoded > 1
    && event.relay_protocol === requestedTransport), 'Actual receiver-to-TURN transport is unproven');
  if (privateConfig.force_relay && requestedTransport) assert.equal(result.selected_pair.relay_protocol, requestedTransport,
    'Actual sender-to-TURN transport is unproven');
  assert.equal(result.expired_health.candidate, false); assert.equal(result.drained, true);
  console.log(JSON.stringify({ first_frame: [first.width, first.height], submitted: result.submitted,
    force_relay: result.force_relay, selected_pair: result.selected_pair,
    expired_health: result.expired_health, drained: result.drained }, null, 2));
  console.log('PASS: actual HarmonyOS shared receiver, native display media and source-stop expiry; fixture signaling only');
} finally {
  clearTimeout(watchdog); command = { kind: 'stop' };
  await writeFile(join(directory, 'cancel'), '', { mode: 0o600 });
  if (native && !finished) {
    const terminate = setTimeout(() => native.kill('SIGTERM'), 5_000);
    const kill = setTimeout(() => native.kill('SIGKILL'), 7_000);
    try { await completion; } finally { clearTimeout(terminate); clearTimeout(kill); }
  }
  await writeFile(join(directory, 'native-test.log'), transcript + nativeErrors, { mode: 0o600 });
  await writeFile(join(directory, 'receiver.json'), JSON.stringify(events, null, 2), { mode: 0o600 });
  if (launched) { await device('shell', 'aa', 'force-stop', bundle); await device('shell', 'aa', 'start', '-a', 'EntryAbility', '-b', bundle); }
  if (reversed) await device('fport', 'rm', 'tcp:18765', 'tcp:18765');
  await new Promise(resolve => server.close(resolve));
}
