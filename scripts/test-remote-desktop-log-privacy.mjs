// Real native PeerConnections; no screen, account, TURN or OS input provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'Native media log privacy probe currently requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const filter = 'native_datachannel_payloads_stay_out_of_sdk_logs';
const markers = ['rd-private-client-payload', 'rd-private-host-payload'];
const run = (command, args, budget = 60_000) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, windowsHide: true,
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', size = 0, overflow = false;
  let kill;
  const terminate = () => {
    child.kill('SIGTERM');
    kill ??= setTimeout(() => child.kill('SIGKILL'), 3000);
  };
  const deadline = setTimeout(terminate, budget);
  const collect = name => chunk => {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) { overflow = true; terminate(); return; }
    if (name === 'stdout') stdout += String(chunk); else stderr += String(chunk);
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));
  child.once('error', error => { clearTimeout(deadline); clearTimeout(kill); reject(error); });
  child.once('close', (code, signal) => {
    clearTimeout(deadline); clearTimeout(kill);
    // Never print a failed SDK transcript: it may contain wire payloads.
    if (overflow) { reject(new Error('Native SDK output exceeded the bounded capture')); return; }
    resolve({ code, signal, stdout, stderr });
  });
});
let harness = process.env.OPENBITFUN_TEST_BINARY;
if (!harness) {
  const build = await run('cargo', ['test', '--locked', '-p', 'openbitfun-desktop',
    '--features', 'remote-desktop-media', '--lib', filter, '--no-run', '--message-format=json'], 15 * 60_000);
  assert.equal(build.code, 0, 'Native privacy fixture build failed; run the focused Cargo command for compiler diagnostics');
  const artifacts = build.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(message => message.reason === 'compiler-artifact' && message.profile.test && message.executable);
  assert.equal(artifacts.length, 1, 'Expected one current Desktop test executable');
  harness = artifacts[0].executable;
}
const result = await run(harness, [filter, '--ignored', '--test-threads=1', '--nocapture']);
assert.equal(result.code, 0, 'Native transport fixture failed; no transcript was printed');
assert.equal(/test result: ok\. 1 passed;/.test(result.stdout), true, 'Native transport fixture did not run');
assert.equal(result.stdout.includes('RD_LOG_PRIVACY_PAYLOADS_DELIVERED'), true,
  'Both fixed payloads must reach their in-memory recipients');
for (const output of [result.stdout, result.stderr]) {
  assert.equal(output.includes('SCTP_PACKET'), false, 'SDK emitted a plaintext SCTP packet dump');
  const compact = output.toLowerCase().replace(/\s/g, '');
  for (const marker of markers) {
    assert.equal(output.includes(marker), false, 'SDK emitted a private payload as text');
    assert.equal(compact.includes(Buffer.from(marker).toString('hex')), false,
      'SDK emitted a private payload as hexadecimal bytes');
  }
}
console.log('PASS: bidirectional native DataChannel payloads delivered without stdout/stderr payload dumps; no OS input');
