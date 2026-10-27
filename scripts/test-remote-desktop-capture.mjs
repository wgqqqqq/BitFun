// Production capture adapter, opt-in selected display, metadata-only evidence.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'Native display capture requires macOS');
const args = process.argv.slice(2);
const listOnly = args.length === 1 && args[0] === '--list';
const pattern = args.length === 3 && args[2] === '--pattern';
const display = (args.length === 2 || pattern) && args[0] === '--display' ? args[1] : undefined;
assert.ok(listOnly || /^macos:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(display ?? ''),
  'Use --list (no capture), or --display macos:<uuid> [--pattern] for an explicitly authorized display');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'openbitfun-rd-native-capture-'));
console.log(`Native capture evidence: ${output}`);
const run = (command, parameters, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, parameters, { cwd: root, env, windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}`)));
});
let harness = process.env.OPENBITFUN_TEST_BINARY;
if (!harness) {
  const messages = await run('cargo', ['test', '--locked', '-p', 'openbitfun-desktop',
    '--features', 'remote-desktop-media', '--lib', 'remote_desktop::macos_capture',
    '--no-run', '--message-format=json']);
  const artifacts = messages.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(message => message.reason === 'compiler-artifact' && message.profile.test && message.executable);
  assert.equal(artifacts.length, 1, 'Expected one current Desktop library test executable');
  harness = artifacts[0].executable;
}
const flags = ['--ignored', '--test-threads=1', '--nocapture'];
const metadata = await run(harness, ['native_remote_desktop_capture_list_displays', ...flags]);
const displays = JSON.parse(metadata.match(/\bRD_CAPTURE_DISPLAYS (\[[^\n]*\])/)?.[1] ?? 'null');
assert.ok(Array.isArray(displays), 'Native metadata receipt missing');
const availability = metadata.match(/\bRD_CAPTURE_AVAILABILITY (\w+)/)?.[1];
await writeFile(join(output, 'metadata.json'), JSON.stringify({ availability, displays }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ availability, displays }, null, 2));
if (!listOnly) {
  assert.ok(displays.some(item => item.display_id === display), 'Selected display is not currently active');
  assert.equal(availability, 'ready', 'Capture unavailable; no permission request or unlock performed');
  const observations = join(output, 'observations.json');
  console.log(`Capturing the explicitly selected display for 10 seconds: ${display}`);
  let fixture, patternReadyAt, patternStaticAt;
  const started = performance.now();
  let transcript;
  try {
    if (pattern) {
      const binary = join(output, 'pattern');
      await run('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Werror', '-mmacosx-version-min=14.0',
        'scripts/fixtures/remote-desktop-capture.m', '-framework', 'AppKit', '-framework', 'CoreGraphics', '-o', binary]);
      fixture = spawn(binary, [display.slice('macos:'.length)], { cwd: root, windowsHide: true,
        stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Pattern fixture not ready')), 5_000);
        let stdout = '';
        fixture.once('error', error => { clearTimeout(timer); reject(error); });
        fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Pattern exited ${code}`)); });
        fixture.stdout.on('data', chunk => {
          stdout += String(chunk);
          if (stdout.includes('PATTERN_READY') && patternReadyAt === undefined) {
            patternReadyAt = performance.now() - started;
            clearTimeout(timer); resolve();
          }
          if (stdout.includes('PATTERN_STATIC') && patternStaticAt === undefined) patternStaticAt = performance.now() - started;
        });
      });
    }
    const captureStartedAt = performance.now() - started;
    transcript = await run(harness, ['native_remote_desktop_capture_observations_and_drain', ...flags], {
      ...process.env, OPENBITFUN_RD_CAPTURE_AUTHORIZED: '1',
      OPENBITFUN_RD_CAPTURE_DISPLAY: display, OPENBITFUN_RD_CAPTURE_OBSERVATIONS: observations,
    });
    if (pattern) {
      assert.ok(patternStaticAt !== undefined, 'Pattern never reached its unchanged phase');
      assert.equal(fixture.exitCode, null, 'Pattern exited before capture finished');
      await writeFile(join(output, 'pattern.json'), JSON.stringify({ patternReadyAt, patternStaticAt, captureStartedAt,
        scope: 'generated content stops changing; no claim that cursor or other OS pixels are static' }, null, 2), { mode: 0o600 });
    }
  } finally {
    if (fixture && fixture.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => fixture.kill('SIGKILL'), 1_000);
      fixture.once('exit', () => { clearTimeout(timer); resolve(); });
      fixture.kill('SIGTERM');
    });
  }
  assert.match(transcript, /test result: ok\. 1 passed;/, 'Native capture test did not execute');
  const result = JSON.parse(await readFile(observations, 'utf8'));
  assert.equal(result.display_id, display);
  assert.ok(result.frames > 0);
  assert.equal(result.drained, true);
  assert.equal(result.callbacks_after_close, false);
  assert.equal(result.failures, 0);
  assert.equal(result.timestamp_regressions, 0);
  console.log(JSON.stringify({ frames: result.frames, idle: result.idle,
    unobservable: result.unobservable, drained: result.drained }, null, 2));
  console.log('PASS: selected native source delivered advancing samples and drained; no media/input/freeze verdict');
}
