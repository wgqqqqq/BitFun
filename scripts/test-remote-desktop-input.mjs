// Native delivery test. Build first; preflight never requests TCC permission.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

assert.equal(process.platform, 'darwin', 'Native remote input fixture requires macOS');
const textOnly = process.argv.length === 3 && process.argv[2] === '--text';
assert.ok(process.argv.length === 2 || textOnly, 'Use no argument or --text');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'openbitfun-rd-native-input-'));
console.log(`Native fixture evidence: ${output}`);
const run = (command, args, env = process.env, capture = false) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, windowsHide: true, env,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  let text = '';
  child.stdout?.on('data', chunk => { text += String(chunk); });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(text) : reject(new Error(`${command} exited ${code}`)));
});
let fixture;
try {
  let harness = process.env.OPENBITFUN_TEST_BINARY;
  if (!harness) {
    const messages = await run('cargo', ['test', '--locked', '-p', 'openbitfun-desktop',
      '--features', 'remote-desktop-media', '--lib', 'native_remote_desktop_input', '--no-run', '--message-format=json'], process.env, true);
    const artifacts = messages.split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(message => message.reason === 'compiler-artifact' && message.profile.test && message.executable);
    assert.equal(artifacts.length, 1, 'Expected one Desktop library test executable');
    harness = artifacts[0].executable;
  }
  const flags = ['--ignored', '--test-threads=1', '--nocapture'];
  const preflight = await run(harness, ['native_remote_desktop_input_permission_probe', ...flags], process.env, true);
  const probe = preflight.match(/\bRD_INPUT_PROBE (ready|permission_required|session_unavailable)\b/)?.[1];
  await writeFile(join(output, 'preflight.json'), JSON.stringify({ status: probe ?? 'unknown' }, null, 2), { mode: 0o600 });
  assert.equal(probe, 'ready', `Native precondition ${probe ?? 'unknown'}; no permission requested and no input posted`);
  const contents = join(output, 'OpenBitFun Remote Input Fixture.app', 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.openbitfun.remote-input-fixture</string><key>CFBundleName</key><string>OpenBitFun Remote Input Fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const binary = join(contents, 'MacOS', 'fixture');
  const receipt = join(output, 'receipt.json');
  await run('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Werror', '-mmacosx-version-min=14.0',
    'scripts/fixtures/remote-desktop-input.m', '-framework', 'AppKit', '-framework', 'CoreGraphics', '-o', binary]);
  fixture = spawn(binary, textOnly ? [receipt, '--text'] : [receipt], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const pid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native fixture failed to become ready')), 10_000);
    let text = '';
    fixture.once('error', error => { clearTimeout(timer); reject(error); });
    fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Native fixture exited ${code}`)); });
    fixture.stdout.on('data', chunk => {
      text += String(chunk);
      const ready = text.match(/^READY (\d+)$/m);
      if (ready) { clearTimeout(timer); resolve(ready[1]); }
    });
  });
  assert.equal(Number(pid), fixture.pid, 'Receipt must belong to the child we created');
  await run(harness, [textOnly ? 'native_remote_desktop_input_text_delivery_and_partial_cancel' : 'native_remote_desktop_input_fixture_delivery_and_revoke', ...flags], {
    ...process.env, OPENBITFUN_RD_INPUT_RECEIPT: receipt, OPENBITFUN_RD_INPUT_PID: pid, OPENBITFUN_RD_INPUT_TIMING: '1',
  });
  const received = JSON.parse(await readFile(receipt, 'utf8'));
  if (textOnly) {
    assert.equal(received.text_followup_prefix_matches, true);
    assert.equal(received.text_downs, received.text_ups);
    assert.ok(received.text_downs > 2);
    assert.equal(received.unexpected_keys, 0);
    console.log('PASS: native Cocoa Unicode delivery and cancellation without replay or stuck text key');
  } else {
  assert.equal(received.downs, 3); assert.equal(received.ups, 3);
  assert.deepEqual(received.clicks.slice(0, 2), [1, 2]);
  assert.ok(received.drags > 0);
  assert.equal(received.key_downs, 2); assert.equal(received.key_ups, 2);
  assert.equal(received.shifted_keys, 1); assert.equal(received.shift_held, false);
  assert.equal(received.unexpected_keys, 0);
  assert.equal(received.point_errors, 0, 'Native coordinates and cleanup cursor position must match the fixture target');
  assert.equal(received.left_held, false, 'Combined session still reports a held left button');
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'passed',
    scope: 'local macOS native fixture; no account, WebRTC, mobile or AI concurrency verification' }, null, 2), { mode: 0o600 });
  if (!textOnly) console.log('PASS: native click/double-click, drag, physical key, modifier release and revoked-input rejection');
} finally {
  if (fixture && fixture.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => fixture.kill('SIGKILL'), 1_000);
      fixture.once('exit', () => { clearTimeout(timer); resolve(); });
      fixture.kill('SIGTERM');
    });
  }
}
