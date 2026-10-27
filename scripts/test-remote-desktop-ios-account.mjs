// Public iOS account factory + product page/WKWebView. Synthetic auth/host, no OS input.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/mobile-web/tests/helpers/browser-account-harness.mjs';
import { generatedDesktopSource } from './remote-desktop/generated-desktop-source.mjs';
import { AccountDesktopFixture } from './remote-desktop/account-desktop-fixture.mjs';

const args = process.argv.slice(2);
const controlCases = ['testExplicitControlTapPairsAndStop', 'testDeniedControlKeepsViewing', 'testQueuedTapRejectedAfterNativeWindowFocusLoss', 'testNativeAdmissionRejectsStaleDuplicateAndExpiredRequests'];
const keyboardCases = ['testKeyboardPreeditAndRetirement', 'testNativeKeyboardCommitsDirectlyAndHidesOnStop', 'testNativePinyinCandidateCommitAndDiscard'];
const allCases = ['testAccountMediaAndCleanup', 'testPauseDisplaySelectionAndExplicitFreshReconnect', 'testDeniedViewDoesNotEnumerateOrAllocateMedia', 'testBackgroundClosesAndForegroundRequiresExplicitReconnect', ...controlCases, ...keyboardCases];
assert.ok([6, 7, 8].includes(args.length));
if (args.length === 7) assert.ok(['--smoke-only', '--control-only', '--keyboard-only'].includes(args[6]));
if (args.length === 8) { assert.equal(args[6], '--only-test'); assert.ok(allCases.includes(args[7])); }
const focused = args[6] === '--smoke-only', controlOnly = args[6] === '--control-only';
const cases = args[6] === '--keyboard-only' ? keyboardCases : args.length === 8 ? [args[7]] : focused ? [allCases[0]] : controlOnly ? controlCases : allCases;
const expectedTests = cases.length;
const usesHost = cases.some(name => name !== controlCases[3] && name !== keyboardCases[0]);
const usesMedia = cases.some(name => name !== controlCases[3] && name !== keyboardCases[0] && name !== allCases[2]);
assert.equal(args[0], '--simulator'); assert.equal(args[2], '--ice-config'); assert.equal(args[4], '--products');
const simulator = args[1]; assert.match(simulator, /^[A-F0-9-]{36}$/);
assert.ok(process.env.DEVELOPER_DIR, 'Select the compatible Xcode locally');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-rd-ios-account-'));
console.log(`iOS account/media evidence: ${directory}`);
function run(command, parameters, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, parameters, { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => child.kill('SIGTERM'), Math.max(240000, expectedTests * 35000));
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
const devices = await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']); assert.equal(devices.code, 0);
const device = Object.values(JSON.parse(devices.output).devices).flat().find(value => value.udid === simulator);
assert.equal(device?.name, 'OpenBitFun Remote Desktop Probe'); assert.equal(device.state, 'Booted');
const products = args[5];
const configurations = (await readdir(products)).filter(name => name.endsWith('.xctestrun')); assert.equal(configurations.length, 1);
const original = join(products, configurations[0]);
const ice = JSON.parse(await readFile(args[3], 'utf8'));
assert.ok(ice.expires_at * 1000 - Date.now() > 150000, 'Provide fresh short-lived TURN credentials after building');
assert.equal((ice.profiles?.first || ice).force_relay, true);
if (ice.test_sessions !== undefined) {
  assert.ok(Array.isArray(ice.test_sessions) && ice.test_sessions.length >= expectedTests);
  const users = new Set();
  for (const session of ice.test_sessions) {
    assert.equal(session.expires_at, ice.expires_at);
    for (const name of ['first', 'old', 'new', 'navigation']) {
      const profile = session.profiles?.[name]; assert.equal(profile?.force_relay, true);
      assert.ok(Array.isArray(profile.ice_servers) && profile.ice_servers.length > 0);
      const user = profile.ice_servers[0].username;
      assert.equal(typeof user, 'string'); assert.ok(user && !users.has(user), 'Test credentials must be independent'); users.add(user);
    }
  }
}
const key = randomBytes(32).toString('hex');
const configured = join(directory, 'private.xctestrun');
let browser, page, port, fixture;
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
      const value = await fixture.control(body); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); return;
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
  const script = `import os,plistlib,pathlib
src=pathlib.Path(os.environ['RD_ORIGINAL']);data=plistlib.loads(src.read_bytes())
def visit(o):
 if isinstance(o,dict):
  if 'TestBundlePath' in o:
   o['EnvironmentVariables'].update({'OPENBITFUN_RD_PROBE_PORT':os.environ['RD_PORT'],'OPENBITFUN_RD_PROBE_KEY':os.environ['RD_KEY']})
  return {k:visit(v) for k,v in o.items()}
 if isinstance(o,list):return [visit(v) for v in o]
 if isinstance(o,str):return o.replace('__TESTROOT__',str(src.parent))
 return o
path=pathlib.Path(os.environ['RD_CONFIGURED']);path.write_bytes(plistlib.dumps(visit(data)));path.chmod(0o600)
`;
  const prepare = await run('python3', ['-c', script], { RD_ORIGINAL: original, RD_CONFIGURED: configured, RD_PORT: String(port), RD_KEY: key });
  assert.equal(prepare.code, 0);
  const bundle = join(directory, 'results.xcresult');
  const result = await run('xcodebuild', ['test-without-building', '-xctestrun', configured, '-destination', `platform=iOS Simulator,id=${simulator}`,
    '-parallel-testing-enabled', 'NO', ...cases.map(name => `-only-testing:OpenBitFunUITests/RemoteDesktopAccountUITests/${name}`), '-resultBundlePath', bundle]);
  await writeFile(join(directory, 'xcodebuild.log'), result.output.replaceAll(key, '<redacted>'), { mode: 0o600 });
  await writeFile(join(directory, 'fixture-diagnostics.json'), JSON.stringify({ stages: fixture.stages, counts: fixture.counts, errors: fixture.errors, last_attach_policy: fixture.lastAttachPolicy, source_observations: fixture.sourceObservations }, null, 2), { mode: 0o600 });
  const summary = await run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundle]);
  await writeFile(join(directory, 'summary.json'), summary.output, { mode: 0o600 });
  assert.equal(result.code, 0, `iOS account/media failed; inspect ${directory}`); assert.equal(summary.code, 0);
  const verdict = JSON.parse(summary.output);
  assert.equal(verdict.totalTestCount, expectedTests); assert.equal(verdict.passedTests, expectedTests); assert.equal(verdict.failedTests, 0); assert.equal(verdict.skippedTests, 0);
  assert.equal(fixture.errors.length, 0);
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, tests: expectedTests, smoke_only: focused, control_only: controlOnly, keyboard_only: args[6] === '--keyboard-only', executed_cases: cases, independent_case_credentials: ice.test_sessions !== undefined,
    native_account_factory: true, native_page: usesHost, actual_crypto_and_socket: usesHost, synthetic_auth_and_host: usesHost, synthetic_auth: true,
    forced_turn: usesMedia, paused_display_selection_and_fresh_reconnect: cases.includes(allCases[1]), background_close: cases.includes(allCases[3]),
    denied_view_without_media_allocation: cases.includes(allCases[2]), explicit_control_tap_and_stop: cases.includes(controlCases[0]),
    denied_control_preserves_view: cases.includes(controlCases[1]), native_queued_input_focus_fence: cases.includes(controlCases[2]), native_admission_replay_and_timeout: cases.includes(controlCases[3]), native_keyboard: cases.some(name => name === keyboardCases[1] || name === keyboardCases[2]), native_preedit_lifecycle: cases.includes(keyboardCases[0]), native_pinyin_candidate: cases.includes(keyboardCases[2]), real_account_service: false, native_desktop_capture: false,
    physical_phone: false, os_input: false }, null, 2), { mode: 0o600 });
  console.log(`Native iOS selected account/desktop checks passed: ${expectedTests} executed, no skips.`);
} finally {
  if (fixture) await fixture.close();
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(configured, { force: true });
}
