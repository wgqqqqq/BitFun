// Bundled WKWebView + generated video/ordered DC. Dedicated simulator, no account or OS input.
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

const args = process.argv.slice(2);
assert.equal(args.length, 6); assert.equal(args[0], '--simulator'); assert.equal(args[2], '--ice-config'); assert.equal(args[4], '--products');
const simulator = args[1]; assert.match(simulator, /^[A-F0-9-]{36}$/);
assert.ok(process.env.DEVELOPER_DIR, 'Select the compatible Xcode locally');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'openbitfun-rd-ios-media-'));
console.log(`iOS media evidence: ${directory}`);
function run(command, parameters, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, parameters, { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
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
const key = randomBytes(32).toString('hex');
const configured = join(directory, 'private.xctestrun');
let browser, page, port;
const lifecycle = [];
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json');
  if (request.headers.host !== `127.0.0.1:${port}` || request.headers.authorization !== `Bearer ${key}`) {
    response.writeHead(401); response.end('{}'); return;
  }
  if (request.method === 'GET' && request.url === '/') {
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Generated media fixture</title>'); return;
  }
  if (request.method !== 'POST' || request.url !== '/operation') { response.writeHead(404); response.end('{}'); return; }
  try {
    const chunks = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; assert.ok(length <= 128 * 1024); chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(['start', 'answer', 'probe', 'status', 'stats', 'stop'].includes(value.operation));
    if (value.operation === 'start') { assert.equal(value.id, 'first'); value.configuration = ice.profiles?.first || ice; }
    const tracked = ['start', 'answer', 'stop'].includes(value.operation);
    if (tracked) lifecycle.push({ operation: value.operation, state: 'begin', at: new Date().toISOString() });
    const result = await page.evaluate(value => window.androidMediaSource(value), value);
    if (tracked) lifecycle.push({ operation: value.operation, state: 'complete', at: new Date().toISOString() });
    if (value.operation === 'stats') lifecycle.push({ operation: 'media_stats', at: new Date().toISOString(), ...result });
    response.end(JSON.stringify(result));
  } catch { response.writeHead(400); response.end('{}'); }
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); port = server.address().port;
  browser = await launchBrowser(); page = await browser.newPage();
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${key}` }); await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(generatedDesktopSource);
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
    '-parallel-testing-enabled', 'NO', '-only-testing:OpenBitFunUITests/RemoteDesktopMediaUITests', '-resultBundlePath', bundle]);
  await writeFile(join(directory, 'xcodebuild.log'), result.output.replaceAll(key, '<redacted>'), { mode: 0o600 });
  await writeFile(join(directory, 'source-lifecycle.json'), JSON.stringify(lifecycle, null, 2), { mode: 0o600 });
  const summary = await run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundle]);
  await writeFile(join(directory, 'summary.json'), summary.output, { mode: 0o600 });
  assert.equal(result.code, 0, `iOS media failed; inspect ${directory}`); assert.equal(summary.code, 0);
  const verdict = JSON.parse(summary.output);
  assert.equal(verdict.totalTestCount, 2); assert.equal(verdict.passedTests, 2); assert.equal(verdict.failedTests, 0); assert.equal(verdict.skippedTests, 0);
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, tests: 2, native_wkwebview: true, native_pixels: true,
    forced_turn: true, ordered_channel: true, permission_denied: true, navigation_refused: true,
    account_routing: false, native_desktop_capture: false, physical_phone: false, os_input: false }, null, 2), { mode: 0o600 });
  console.log('Native iOS WKWebView media checks passed against the isolated generated source.');
} finally {
  if (page) await page.evaluate(() => window.androidMediaSource?.({ operation: 'stop' })).catch(() => {});
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(configured, { force: true });
}
