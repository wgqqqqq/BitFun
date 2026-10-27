// Native drain deadlines only. Never opens a source or touches screen/input permissions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'Native capture drain verification requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'openbitfun-rd-capture-drain-'));
const binary = join(output, 'capture-drain');
function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      process.stdout.write(stdout);
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}`));
    });
  });
}
await run('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Werror', '-mmacosx-version-min=14.0',
  'scripts/fixtures/remote-desktop-capture-drain.m', '-framework', 'ScreenCaptureKit',
  '-framework', 'AppKit', '-framework', 'CoreMedia', '-framework', 'CoreVideo',
  '-framework', 'CoreGraphics', '-o', binary], 30_000);
const rows = (await run(binary, [], 30_000)).trim().split('\n').map(line => JSON.parse(line));
assert.deepEqual(rows.map(row => row.barrier), ['context_detach', 'final_clear']);
assert.ok(rows.every(row => row.passed && row.bounded && row.handle_retained && row.retry_drained));
console.log('PASS: both native queue barriers time out, retain the handle and support a later drain retry');
