// Production macOS sender + bundled shared renderer, local host ICE only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/mobile-web/tests/helpers/browser-account-harness.mjs';

assert.equal(process.platform, 'darwin', 'Native media probe requires macOS');
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--display'
  && /^macos:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(args[1]),
  'Use --display macos:<uuid> within the explicitly authorized capture scope');
const display = args[1];
const root = fileURLToPath(new URL('../', import.meta.url));
const assets = join(root, 'src/shared/remote-desktop-media');
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-rd-native-media-'));
console.log(`Native media evidence: ${directory}`);
const run = (command, parameters) => new Promise((resolve, reject) => {
  const child = spawn(command, parameters, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}`)));
});
let harness = process.env.OPENBITFUN_TEST_BINARY;
if (!harness) {
  const messages = await run('cargo', ['test', '--locked', '-p', 'openbitfun-desktop',
    '--features', 'remote-desktop-media', '--lib', 'remote_desktop::media', '--no-run', '--message-format=json']);
  const artifacts = messages.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(message => message.reason === 'compiler-artifact' && message.profile.test && message.executable);
  assert.equal(artifacts.length, 1);
  harness = artifacts[0].executable;
}
const writeReceipt = async (name, value) => {
  const temporary = join(directory, `.${name}.node`);
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, name));
};
const server = createServer(async (request, response) => {
  const file = request.url === '/' ? 'index.html' : ['/receiver.js', '/control.js'].includes(request.url) ? request.url.slice(1) : undefined;
  if (request.method !== 'GET' || !file) { response.writeHead(404); response.end(); return; }
  response.setHeader('content-type', file.endsWith('.html') ? 'text/html' : 'text/javascript');
  response.end(await readFile(join(assets, file)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, native, finished, completion, watchdog;
let transcript = '';
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 600 });
  await page.evaluateOnNewDocument(() => {
    window.events = [];
    window.rawPresentations = 0;
    window.OpenBitFunDesktopHost = { postMessage: raw => window.events.push(JSON.parse(raw)) };
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return original.call(this, (now, metadata) => { window.rawPresentations++; callback(now, metadata); });
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.bringToFront();
  await page.waitForFunction(() => window.events.some(event => event.kind === 'bridge_ready'));
  native = spawn(harness, ['native_remote_desktop_capture_to_shared_receiver_and_source_stop',
    '--ignored', '--test-threads=1', '--nocapture'], { cwd: root, windowsHide: true,
    env: { ...process.env, OPENBITFUN_RD_CAPTURE_AUTHORIZED: '1', OPENBITFUN_RD_CAPTURE_DISPLAY: display,
      OPENBITFUN_RD_MEDIA_PROBE_DIRECTORY: directory }, stdio: ['ignore', 'pipe', 'inherit'] });
  native.stdout.on('data', chunk => { transcript += String(chunk); });
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
    throw new Error(`Native receipt deadline expired: ${name}`);
  };
  const offer = await waitReceipt('offer.json');
  await page.evaluate(config => window.OpenBitFunDesktopReceiver.accept(config), offer);
  await page.waitForFunction(() => window.events.some(event => event.kind === 'answer'), { timeout: 20_000 });
  const answer = await page.evaluate(() => window.events.find(event => event.kind === 'answer'));
  await writeReceipt('answer.json', { answer_sdp: answer.answer_sdp });
  await waitReceipt('state.json', state => state.phase === 'awaiting_source');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.equal(await page.evaluate(() => window.rawPresentations), 0,
    'Sender presented placeholder video before native capture');
  assert.equal(await page.evaluate(() => window.events.some(event => event.kind === 'first_frame_presented')), false);
  await writeReceipt('capture.json', { start: true });
  await waitReceipt('state.json', state => state.phase === 'capture' && state.submitted > 0);
  await page.evaluate(() => window.OpenBitFunDesktopReceiver.accept({ kind: 'source_ready',
    renderer_id: 'native-probe-renderer', connection_id: 'native-probe-connection' }));
  await page.waitForFunction(() => window.events.some(event => event.kind === 'first_frame_presented'), { timeout: 10_000 });
  const first = await page.evaluate(() => window.events.find(event => event.kind === 'first_frame_presented'));
  assert.ok(first.width > 0 && first.height > 0);
  await waitReceipt('state.json', state => state.phase === 'source_stopped');
  const result = await waitReceipt('result.json');
  assert.equal(result.display_id, display);
  assert.equal(result.drained, true);
  assert.equal(result.expired_health.source_activity, 'unknown');
  assert.equal(result.expired_health.candidate, false);
  const exit = await completion;
  assert.equal(exit.code, 0, `Native probe failed: ${JSON.stringify(exit)}`);
  assert.match(transcript, /test result: ok\. 1 passed;/);
  const health = await page.evaluate(() => window.events.filter(event => event.kind === 'health'));
  assert.ok(health.some(event => event.frames_decoded > 1));
  await writeReceipt('receiver.json', { scope: result.scope, first,
    raw_presentations: await page.evaluate(() => window.rawPresentations), health });
  await page.evaluate(() => window.OpenBitFunDesktopReceiver.stop());
  assert.equal(await page.$eval('video', video => video.srcObject), null);
  console.log(JSON.stringify({ submitted: result.submitted, first_frame: [first.width, first.height],
    drained: result.drained, expired_health: result.expired_health }, null, 2));
  console.log('PASS: real native media, no startup placeholder, source-only stop expires despite live receiver replies');
} finally {
  clearTimeout(watchdog);
  await writeFile(join(directory, 'cancel'), '', { mode: 0o600 });
  if (native && !finished) {
    const terminate = setTimeout(() => native.kill('SIGTERM'), 5_000);
    const kill = setTimeout(() => native.kill('SIGKILL'), 7_000);
    try { await completion; } finally { clearTimeout(terminate); clearTimeout(kill); }
  }
  await writeFile(join(directory, 'native-test.log'), transcript, { mode: 0o600 });
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
