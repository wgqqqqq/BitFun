// Separate generated-video sender -> actual Android WebView. No account or OS input.
import assert from 'node:assert/strict';
import { generatedDesktopSource } from './remote-desktop/generated-desktop-source.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/mobile-web/tests/helpers/browser-account-harness.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 2 || args.length === 4);
assert.equal(args[0], '--serial');
const serial = args[1]; assert.match(serial, /^emulator-[0-9]+$/);
if (args.length === 4) assert.equal(args[2], '--ice-config');
const ice = args.length === 4 ? JSON.parse(await readFile(args[3], 'utf8')) : {};
if (Number.isFinite(ice.expires_at)) assert.ok(ice.expires_at * 1000 - Date.now() > 150000, 'Provide fresh probe ICE credentials');
const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
assert.ok(sdk, 'Set ANDROID_HOME or ANDROID_SDK_ROOT');
const adb = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-rd-android-media-'));
console.log(`Android media evidence: ${directory}`);
function run(binary, parameters, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 180000, ...spawnOptions } = options;
    if (process.platform === 'win32' && binary.endsWith('.bat')) {
      parameters = ['/d', '/s', '/c', binary, ...parameters]; binary = process.env.ComSpec || 'cmd.exe';
    }
    const child = spawn(binary, parameters, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    let output = '', errors = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output, errors }); });
  });
}
const device = (...parameters) => run(adb, ['-s', serial, ...parameters]);
const owner = await device('emu', 'avd', 'name');
assert.equal(owner.code, 0); assert.equal(owner.output.trim().split(/\r?\n/)[0], 'BitFun_RemoteDesktop_Probe', 'Use a dedicated test AVD, never an authenticated manual-test device');
const key = randomBytes(32).toString('hex');
let browser, page, reversed = false, port;
const lifecycle = [];
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json');
  if (request.headers.host !== `127.0.0.1:${port}` || request.headers.authorization !== `Bearer ${key}`) {
    response.writeHead(401); response.end('{}'); return;
  }
  if (request.method === 'GET' && request.url === '/') {
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Generated media probe</title>'); return;
  }
  if (request.method !== 'POST' || request.url !== '/operation') { response.writeHead(404); response.end('{}'); return; }
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; assert.ok(size <= 128 * 1024); chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(['start', 'answer', 'status', 'probe', 'stats', 'stop'].includes(value.operation));
    if (value.operation === 'start') {
      assert.ok(['first', 'old', 'new', 'navigation'].includes(value.id));
      value.configuration = ice.profiles?.[value.id] ?? ice;
    }
    const tracked = ['start', 'answer', 'stop'].includes(value.operation);
    const mark = state => {
      if (tracked && lifecycle.length < 128) lifecycle.push({ at: new Date().toISOString(), operation: value.operation,
        state, ...(value.operation === 'start' ? { source: value.id } : {}) });
    };
    mark('begin');
    const result = await page.evaluate(value => window.androidMediaSource(value), value);
    mark('complete');
    if (value.operation === 'start' && typeof result.offer_sdp === 'string' && lifecycle.length < 128) {
      const media = result.offer_sdp.split(/\r?\nm=/).slice(1);
      lifecycle.push({ at: new Date().toISOString(), operation: 'gathered_offer', source: value.id,
        media_sections: media.length, candidate_sections: media.filter(section => /^a=candidate:/m.test(section)).length });
    }
    response.end(JSON.stringify(result));
  } catch { response.writeHead(400); response.end('{}'); }
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  browser = await launchBrowser(); page = await browser.newPage();
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${key}` }); await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(generatedDesktopSource);
  assert.equal((await device('reverse', `tcp:${port}`, `tcp:${port}`)).code, 0); reversed = true;
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  const result = await run(wrapper, [':app:connectedDebugAndroidTest',
    '-Pandroid.testInstrumentationRunnerArguments.class=com.openbitfun.mobile.app.RemoteDesktopMediaProbeTest',
    `-Pandroid.testInstrumentationRunnerArguments.remoteDesktopProbePort=${port}`,
    `-Pandroid.testInstrumentationRunnerArguments.remoteDesktopProbeKey=${key}`, '--console=plain'],
  { cwd: join(root, 'src/apps/mobile/android'), env: { ...process.env, ANDROID_SERIAL: serial } });
  await writeFile(join(directory, 'gradle.log'), result.output + result.errors, { mode: 0o600 });
  const reports = join(root, 'src/apps/mobile/android/app/build/outputs/androidTest-results/connected/debug');
  const names = (await readdir(reports)).filter(name => /^TEST-.*\.xml$/.test(name)); assert.equal(names.length, 1);
  const xml = await readFile(join(reports, names[0]), 'utf8');
  const suite = xml.match(/<(?:\w+:)?testsuite\b[^>]*>/)?.[0]; assert.ok(suite);
  await writeFile(join(directory, 'instrumentation.xml'), xml, { mode: 0o600 });
  let metadata = '';
  for (const folder of await readdir(reports, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const name of await readdir(join(reports, folder.name))) {
      if (!name.startsWith('logcat-') || !name.includes('.RemoteDesktopMediaProbeTest-')) continue;
      const log = await readFile(join(reports, folder.name, name), 'utf8');
      metadata += log.split('\n').filter(line => /\b[IEW]\s+OpenBitFunRd(?:Probe|Media):/.test(line)).join('\n') + '\n';
    }
  }
  await writeFile(join(directory, 'device-metadata.log'), metadata, { mode: 0o600 });
  // Preserve XML and sanitized device observations on failure as well as success.
  assert.equal(result.code, 0, `Android probe failed; inspect ${directory}`);
  for (const [attribute, expected] of Object.entries({ tests: 4, failures: 0, errors: 0, skipped: 0 })) {
    assert.equal(Number(suite.match(new RegExp(`\\b${attribute}="([0-9]+)"`))?.[1]), expected);
  }
  assert.ok(metadata.includes('native_pixels=true') && metadata.includes('new_source_required=true')
    && metadata.includes('stale_callbacks_ignored=true') && metadata.includes('permission_denied=true')
    && metadata.includes('Same-origin reload probe passed'));
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, executed: 4, production_adapter: true, generated_source: true, separate_sender: true,
    forced_turn: ice.force_relay === true || (Object.keys(ice.profiles || {}).length > 0 && Object.values(ice.profiles).every(config => config.force_relay === true)),
    real_account: false, native_desktop_capture: false, physical_phone: false, os_input: false }, null, 2), { mode: 0o600 });
  console.log('Android receiver probe passed with a separate generated-video sender.');
} finally {
  if (reversed) await device('reverse', '--remove', `tcp:${port}`);
  if (page) await page.evaluate(() => window.androidMediaSource?.({ operation: 'stop' })).catch(() => {});
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(directory, 'source-lifecycle.json'), JSON.stringify(lifecycle, null, 2), { mode: 0o600 });
}
