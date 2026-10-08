import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = path.join(root, 'src/apps/ohos');
const read = relative => readFileSync(path.join(root, relative), 'utf8');

test('PC package identity matches the HarmonyOS controller and native library matches the Desktop host', () => {
  const app = JSON.parse(read('src/apps/ohos/AppScope/app.json5')).app;
  const mobile = read('src/apps/mobile/harmonyos/AppScope/app.json5');
  assert.equal(app.bundleName, mobile.match(/"bundleName"\s*:\s*"([^"]+)"/)[1]);
  const cargo = read('src/apps/desktop/Cargo.toml');
  const library = cargo.match(/\[lib\]\s*name\s*=\s*"([^"]+)"/)[1];
  const entry = read('src/apps/ohos/entry/src/main/ets/entryability/EntryAbility.ets');
  assert.equal(entry.match(/moduleName:\s*string\s*=\s*'([^']+)'/)[1], library);
  const deps = JSON.parse(read('src/apps/ohos/entry/oh-package.json5')).dependencies;
  assert.ok(deps[`lib${library}.so`]);
  for (const dependency of Object.values(deps)) {
    assert.ok(dependency.startsWith('file:'));
    assert.ok(existsSync(path.resolve(host, 'entry', dependency.slice(5), 'oh-package.json5')));
  }
});

test('ArkWeb registers the workbench scheme before the native host starts', () => {
  const scheme = read('src/apps/desktop/src/frontend_workbench.rs').match(/FRONTEND_PROTOCOL_SCHEME: &str = "([^"]+)"/)[1];
  const entry = read('src/apps/desktop/src/ohos.rs');
  assert.ok(entry.match(/protocol\s*=\s*"([^"]+)"/)[1].split(',').includes(scheme));
  const ark = read('src/apps/ohos/ability/src/main/ets/ability/NativeAbility.ets');
  assert.ok(ark.indexOf('module.registerCustomProtocol()') < ark.indexOf('WebviewController.initializeWebEngine()'));
  assert.ok(ark.includes('module.init(this.createInitContext(moduleName))'));
});

test('PC entry is scoped to 2in1 and signing material is not present in its manifest', () => {
  const module = JSON.parse(read('src/apps/ohos/entry/src/main/module.json5')).module;
  assert.deepEqual(module.deviceTypes, ['2in1']);
  for (const ability of module.abilities) {
    assert.ok(existsSync(path.resolve(host, 'entry/src/main', ability.srcEntry)));
  }
  const profile = JSON.parse(read('src/apps/ohos/build-profile.json5'));
  assert.deepEqual(profile.app.signingConfigs, []);
});

test('packaging rejects a missing native product instead of accepting an ArkTS-only shell', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { default: guard } = await import('../src/apps/ohos/tools/verify-runtime.cjs');
  const temporary = mkdtempSync(path.join(tmpdir(), 'openbitfun-ohos-host-'));
  try { assert.throws(() => guard.verifyRuntime(temporary), /Desktop OHOS library is missing/); }
  finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('the native render page is declared in the packaged route profile', () => {
  const module = JSON.parse(read('src/apps/ohos/entry/src/main/module.json5')).module;
  assert.equal(module.pages, '$profile:main_pages');
  const routes = JSON.parse(read('src/apps/ohos/entry/src/main/resources/base/profile/main_pages.json')).src;
  for (const route of routes) assert.ok(existsSync(path.join(host, 'entry/src/main/ets', `${route}.ets`)));
  const entry = read('src/apps/ohos/entry/src/main/ets/entryability/EntryAbility.ets');
  const route = entry.match(/stage\.loadContent\('([^']+)'\)/)[1];
  assert.ok(routes.includes(route));
  assert.ok(read(`src/apps/ohos/entry/src/main/ets/${route}.ets`).includes("DefaultXComponent({ moduleName: 'openbitfun_desktop_lib',"));
});

test('packaging requires mobile-web HTML and assets alongside Desktop resources', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { default: guard } = await import('../src/apps/ohos/tools/verify-runtime.cjs');
  const temporary = mkdtempSync(path.join(tmpdir(), 'openbitfun-ohos-resources-'));
  try {
    const libraries = path.join(temporary, 'libs/arm64-v8a');
    mkdirSync(libraries, { recursive: true });
    const elf = Buffer.alloc(64);
    Buffer.from('7f454c46', 'hex').copy(elf);
    elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(3, 16); elf.writeUInt16LE(183, 18);
    writeFileSync(path.join(libraries, 'libopenbitfun_desktop_lib.so'), elf);
    const resources = path.join(temporary, 'src/main/resources/resfile');
    for (const file of ['frontend/dist/index.html', 'resources/ext-host/extension-host.js', 'resources/worker_host.js']) {
      mkdirSync(path.dirname(path.join(resources, file)), { recursive: true });
      writeFileSync(path.join(resources, file), 'fixture');
    }
    assert.throws(() => guard.verifyRuntime(temporary), /mobile-web\/dist\/index.html/);
    mkdirSync(path.join(resources, 'mobile-web/dist'), { recursive: true });
    writeFileSync(path.join(resources, 'mobile-web/dist/index.html'), 'fixture');
    assert.throws(() => guard.verifyRuntime(temporary), /mobile-web\/dist\/assets/);
    mkdirSync(path.join(resources, 'mobile-web/dist/assets'));
    assert.doesNotThrow(() => guard.verifyRuntime(temporary));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('the product companion replaces the exported diagnostic surface', () => {
  const module = JSON.parse(read('src/apps/ohos/entry/src/main/module.json5')).module;
  assert.deepEqual(module.abilities.map(ability => ability.name), ['EntryAbility']);
  const routes = JSON.parse(read('src/apps/ohos/entry/src/main/resources/base/profile/main_pages.json')).src;
  assert.ok(routes.includes('pages/Companion'));
  assert.ok(!routes.includes('pages/PetProbe'));
  assert.ok(!existsSync(path.join(host, 'entry/src/main/ets/petprobe/PetProbeAbility.ets')));
});
