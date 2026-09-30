#!/usr/bin/env node
// Stage build outputs only. This does not build, sign, install, or migrate data.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import guard from '../../src/apps/ohos/tools/verify-runtime.cjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--native-library')) {
  throw new Error('Usage: node scripts/ohos/stage-runtime.mjs [--native-library /absolute/path/libopenbitfun_desktop_lib.so]');
}
const library = args.length ? args[1] : path.join(root, 'target/aarch64-unknown-linux-ohos/debug/libopenbitfun_desktop_lib.so');
if (!path.isAbsolute(library) || path.basename(library) !== 'libopenbitfun_desktop_lib.so') {
  throw new Error('Expected the current Desktop library with an absolute path');
}
const assets = [
  ['dist', 'frontend/dist', 'index.html'],
  ['src/apps/extension-host/dist', 'resources/ext-host', 'extension-host.js'],
  ['src/mobile-web/dist', 'mobile-web/dist', 'index.html'],
];
for (const [source, , required] of assets) {
  if (!existsSync(path.join(root, source, required))) throw new Error(`Build output is missing: ${source}/${required}`);
}
// Validate before creating or replacing any package files.
const bytes = readFileSync(library);
if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
    bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== 183) {
  throw new Error('Expected an ELF64 little-endian AArch64 shared library');
}
const host = path.join(root, 'src/apps/ohos');
const libraries = path.join(host, 'entry/libs/arm64-v8a');
const resources = path.join(host, 'entry/src/main/resources/resfile');
mkdirSync(libraries, { recursive: true });
mkdirSync(resources, { recursive: true });
cpSync(library, path.join(libraries, path.basename(library)));
for (const [source, destination] of assets) {
  cpSync(path.join(root, source), path.join(resources, destination), { recursive: true });
}
cpSync(path.join(root, 'src/apps/desktop/resources/worker_host.js'), path.join(resources, 'resources/worker_host.js'));
cpSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(resources, 'THIRD_PARTY_NOTICES.md'));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (revision.status !== 0) throw new Error('Could not identify the source revision');
writeFileSync(path.join(resources, 'ohos-build.json'), JSON.stringify({
  baseRevision: revision.stdout.trim(),
  nativeSha256: createHash('sha256').update(bytes).digest('hex'),
  experimental: true,
  deviceValidated: false,
}, null, 2) + '\n');
guard.verifyRuntime(path.join(host, 'entry'));
console.log(`Staged current Desktop outputs in ${host}. Signing and device validation are still required.`);
