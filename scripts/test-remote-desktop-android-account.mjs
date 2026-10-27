// Actual KMP account/store + Android page/receiver; synthetic Relay/desktop only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/mobile-web/tests/helpers/browser-account-harness.mjs';
import { generatedDesktopSource } from './remote-desktop/generated-desktop-source.mjs';
import { AccountDesktopFixture } from './remote-desktop/account-desktop-fixture.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 4 || args.length === 5); assert.equal(args[0], '--serial'); assert.equal(args[2], '--ice-config');
if (args.length === 5) assert.ok(['--keyboard-only', '--actual-ime-only', '--gestures-only'].includes(args[4]));
const focused = args.length === 5, keyboardOnly = args[4] === '--keyboard-only', actualImeOnly = args[4] === '--actual-ime-only', gesturesOnly = args[4] === '--gestures-only';
const expectedTests = focused ? 1 : 9;
const method = gesturesOnly ? 'nativeGesturesReachTheCurrentLeaseAndPinchStaysLocal' : keyboardOnly ? 'nativeKeyboardCommitsAndPairedKeysReachOnlyTheCurrentLease' : 'actualGboardTouchesReachTheCurrentLease';
const serial = args[1]; assert.match(serial, /^emulator-[0-9]+$/);
const ice = JSON.parse(await readFile(args[3], 'utf8'));
assert.ok(ice.expires_at * 1000 - Date.now() > 150000, 'Provide fresh short-lived probe ICE credentials');
assert.equal((ice.profiles?.first || ice).force_relay, true);
const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT; assert.ok(sdk);
const adb = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-rd-android-account-'));
console.log(`Android account/media evidence: ${directory}`);
function run(binary, parameters, cwd = root) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32' && binary.endsWith('.bat')) { parameters = ['/d', '/s', '/c', binary, ...parameters]; binary = process.env.ComSpec || 'cmd.exe'; }
    const child = spawn(binary, parameters, { cwd, env: { ...process.env, ANDROID_SERIAL: serial }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timeout = setTimeout(() => child.kill('SIGTERM'), 180000);
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}
const device = (...args) => run(adb, ['-s', serial, ...args]);
const owner = await device('emu', 'avd', 'name'); assert.equal(owner.code, 0);
assert.equal(owner.output.trim().split(/\r?\n/)[0], 'BitFun_RemoteDesktop_Probe', 'Use only the dedicated synthetic emulator');
const key = randomBytes(32).toString('hex');
let browser, page, fixture, port, reversed = false;
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(403); response.end('{}'); return; }
  try {
    const chunks = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; assert.ok(length <= 128 * 1024); chunks.push(chunk); }
    const body = length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (request.url === '/' && request.method === 'GET' && request.headers.authorization === `Bearer ${key}`) {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><link rel="icon" href="data:,"><title>Isolated generated desktop</title>'); return;
    }
    if (request.url === '/operation' && request.method === 'POST') {
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      const result = await fixture.control(body); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); return;
    }
    await fixture.api(request, response, body);
  } catch {
    if (fixture) fixture.errors.push('Unexpected fixture HTTP request');
    if (!response.headersSent) response.writeHead(400); response.end('{}');
  }
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); port = server.address().port;
  browser = await launchBrowser(); page = await browser.newPage();
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${key}` }); await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(generatedDesktopSource);
  fixture = new AccountDesktopFixture(page, ice, port); fixture.attach(server);
  assert.equal((await device('reverse', `tcp:${port}`, `tcp:${port}`)).code, 0); reversed = true;
  const result = await run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', [':app:connectedDebugAndroidTest',
    `-Pandroid.testInstrumentationRunnerArguments.class=com.openbitfun.mobile.app.RemoteDesktopAccountMediaTest${focused ? `#${method}` : ''}`,
    `-Pandroid.testInstrumentationRunnerArguments.remoteDesktopFixturePort=${port}`,
    `-Pandroid.testInstrumentationRunnerArguments.remoteDesktopFixtureKey=${key}`, '--console=plain'], join(root, 'src/apps/mobile/android'));
  await writeFile(join(directory, 'gradle.log'), result.output, { mode: 0o600 });
  await writeFile(join(directory, 'fixture-diagnostics.json'), JSON.stringify({ stages: fixture.stages, counts: fixture.counts,
    errors: fixture.errors, last_attach_policy: fixture.lastAttachPolicy, source_observations: fixture.sourceObservations }, null, 2), { mode: 0o600 });
  const reports = join(root, 'src/apps/mobile/android/app/build/outputs/androidTest-results/connected/debug');
  const names = (await readdir(reports)).filter(value => /^TEST-.*\.xml$/.test(value)); assert.equal(names.length, 1);
  let nativeMetadata = '';
  for (const folder of await readdir(reports, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const name of await readdir(join(reports, folder.name))) {
      if (!name.startsWith('logcat-') || !name.includes('.RemoteDesktopAccountMediaTest-')) continue;
      const log = await readFile(join(reports, folder.name, name), 'utf8');
      nativeMetadata += log.split('\n').filter(line => /\b[IEW]\s+OpenBitFunRd(?:Account|Media):/.test(line)).join('\n') + '\n';
    }
  }
  await writeFile(join(directory, 'device-metadata.log'), nativeMetadata, { mode: 0o600 });
  for (const name of names) {
    const xml = await readFile(join(reports, name), 'utf8'); await writeFile(join(directory, 'instrumentation.xml'), xml, { mode: 0o600 });
    const suite = xml.match(/<(?:\w+:)?testsuite\b[^>]*>/)?.[0]; assert.ok(suite);
    for (const [attribute, expected] of Object.entries({ tests: expectedTests, failures: 0, errors: 0, skipped: 0 })) {
      assert.equal(Number(suite.match(new RegExp(`\\b${attribute}="([0-9]+)"`))?.[1]), expected);
    }
  }
  assert.equal(result.code, 0, `Account/media fixture failed; inspect ${directory}`);
  assert.equal(fixture.errors.length, 0);
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, tests: expectedTests, keyboard_only: keyboardOnly, actual_ime_only: actualImeOnly, gestures_only: gesturesOnly, native_account_factory: true,
    native_page: true, actual_crypto_and_socket: true, synthetic_auth_and_host: true, generated_source: true,
    forced_turn: true, paused_synthetic_display_selection: !focused, automatic_rebuild_with_shortened_synthetic_host_budget: !focused,
    native_tap_and_focus_retirement: !focused, denied_synthetic_control_grant: !focused, native_keyboard_commits_and_paired_keys: !focused || keyboardOnly,
    actual_gboard_touch_input: !focused || actualImeOnly, native_direct_touch_gestures: !focused || gesturesOnly,
    actual_turn_expiry: false, real_account_service: false, native_desktop_capture: false, physical_phone: false, os_input: false }, null, 2), { mode: 0o600 });
  console.log('KMP account/store and native receiver integration passed against the isolated generated desktop.');
} finally {
  if (reversed) await device('reverse', '--remove', `tcp:${port}`);
  if (fixture) await fixture.close();
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
