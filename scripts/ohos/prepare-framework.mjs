#!/usr/bin/env node
// Isolated experimental framework dependencies; never changes the root Cargo patch table.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const sources = {
  'plugin-log': ['https://github.com/tauri-apps/plugins-workspace.git', 'cad301fcc1f3ebad1eaef552c886b0bc8580c3fe'],
  'plugin-fs': ['https://github.com/tauri-apps/plugins-workspace.git', '5c7668b6bb7c9a509f394d584568b3a922161e50'],
  'plugin-opener': ['https://github.com/tauri-apps/plugins-workspace.git', '5c7668b6bb7c9a509f394d584568b3a922161e50'],
  tauri: ['https://github.com/tauri-apps/tauri.git', '7cc68e74ff6981f5c50a52a67d56c5eb2d227188'],
  tao: ['https://github.com/tauri-apps/tao.git', 'e2885f78b5003bbe46e88f01eadb817b8bc5644f'],
  wry: ['https://github.com/tauri-apps/wry.git', '5c9b89920f3c6abf90b9c539fad2e352d24d179a'],
};
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}
// Dependency workspaces must live outside the product workspace so Cargo does
// not try to inherit their package metadata from OpenBitFun's Cargo.toml.
const sourceCache = process.env.OPENBITFUN_OHOS_FRAMEWORK_DIR || path.join(os.homedir(), '.cache/openbitfun/ohos-framework');
const selected = {};
for (const [name, [url, revision]] of Object.entries(sources)) {
  const patch = path.join(here, 'patches', `${name}.patch`);
  const digest = createHash('sha256').update(readFileSync(patch)).digest('hex');
  const directory = path.join(sourceCache, `${name}-${digest.slice(0, 16)}`);
  const marker = path.join(directory, '.openbitfun-prepared');
  if (!existsSync(marker)) {
    if (existsSync(directory)) throw new Error(`Incomplete checkout: ${directory}. Preserve or move it before retrying.`);
    mkdirSync(directory, { recursive: true });
    git(directory, 'init', '-q');
    git(directory, 'fetch', '--depth=1', url, revision);
    git(directory, 'checkout', '--detach', 'FETCH_HEAD');
    if (git(directory, 'rev-parse', 'HEAD') !== revision) throw new Error(`Unexpected ${name} revision`);
    git(directory, 'apply', '--check', patch);
    git(directory, 'apply', patch);
    writeFileSync(marker, `${revision}\n${digest}\n`);
  }
  if (readFileSync(marker, 'utf8') !== `${revision}\n${digest}\n` || git(directory, 'rev-parse', 'HEAD') !== revision) {
    throw new Error(`Unexpected prepared source state: ${directory}`);
  }
  selected[name] = directory;
}
const crates = ['tauri', 'tauri-build', 'tauri-codegen', 'tauri-macros', 'tauri-plugin', 'tauri-runtime', 'tauri-runtime-wry', 'tauri-utils'];
const lines = ['[patch.crates-io]', ...crates.map(name => `${name} = { path = ${JSON.stringify(path.join(selected.tauri, 'crates', name))} }`)];
for (const name of ['tao', 'wry']) lines.push(`${name} = { path = ${JSON.stringify(selected[name])} }`);
for (const name of ['log', 'fs', 'opener']) {
  lines.push(`tauri-plugin-${name} = { path = ${JSON.stringify(path.join(selected[`plugin-${name}`], 'plugins', name))} }`);
}
const config = path.join(root, 'target/ohos-framework/cargo.toml');
mkdirSync(path.dirname(config), { recursive: true });
writeFileSync(config, `${lines.join('\n')}\n`);
console.log(config);
console.log('Experimental framework prepared. Full Desktop plugin and platform adapters are still required.');
