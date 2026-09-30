#!/usr/bin/env node
// Development cross-compilation only; this does not package or install a PC app.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const target = 'aarch64-unknown-linux-ohos';
const targetKey = target.replaceAll('-', '_');
const defaultNdk = '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function toolchainCacheKey(ndk) {
  const compiler = statSync(path.join(ndk, 'llvm/bin/clang'));
  const metadata = path.join(ndk, 'oh-uni-package.json');
  return createHash('sha256').update(JSON.stringify([
    ndk, compiler.size, compiler.mtimeMs,
    existsSync(metadata) ? readFileSync(metadata, 'utf8') : '',
  ])).digest('hex').slice(0, 20);
}

export function resolveNdk(env = process.env) {
  const candidate = env.OPENBITFUN_OHOS_NDK || env.OHOS_NDK_HOME || defaultNdk;
  for (const relative of ['llvm/bin/clang', 'llvm/bin/clang++', 'llvm/bin/llvm-ar', 'sysroot']) {
    if (!existsSync(path.join(candidate, relative))) {
      throw new Error(`Missing OHOS SDK component: ${path.join(candidate, relative)}. Set OPENBITFUN_OHOS_NDK to the SDK native directory.`);
    }
  }
  return realpathSync(candidate);
}

export function createToolchain(ndk, directory, inherited = process.env) {
  const env = { ...inherited, OPENBITFUN_OHOS_NDK: ndk, OHOS_NDK_HOME: ndk };
  // Literal shell source: SDK paths are passed through an environment variable,
  // never interpolated into executable shell text. Handles spaces in SDK paths.
  for (const [variable, compiler] of [['CC', 'clang'], ['CXX', 'clang++']]) {
    const wrapper = path.join(directory, compiler);
    const source = `#!/bin/sh\nexec "$OPENBITFUN_OHOS_NDK/llvm/bin/${compiler}" --target=aarch64-linux-ohos "--sysroot=$OPENBITFUN_OHOS_NDK/sysroot" -D__MUSL__ "$@"\n`;
    if (!existsSync(wrapper) || readFileSync(wrapper, 'utf8') !== source) {
      const temporary = `${wrapper}.${process.pid}.tmp`;
      writeFileSync(temporary, source, { mode: 0o700 });
      renameSync(temporary, wrapper);
    }
    env[`${variable}_${targetKey}`] = wrapper;
  }
  env[`AR_${targetKey}`] = path.join(ndk, 'llvm/bin/llvm-ar');
  env.CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER = env[`CC_${targetKey}`];
  // bindgen parses this value using shlex; quote paths without executing them.
  const sysroot = `--sysroot=${path.join(ndk, 'sysroot')}`;
  env[`BINDGEN_EXTRA_CLANG_ARGS_${targetKey}`] = [
    `'${sysroot.replaceAll("'", "'\"'\"'")}'`, '-D__MUSL__',
    inherited[`BINDGEN_EXTRA_CLANG_ARGS_${targetKey}`] || '',
  ].join(' ');
  env.LIBCLANG_PATH ||= path.join(ndk, 'llvm/lib');
  return env;
}

export function cargoArguments(args) {
  if (!['check', 'build', 'test', 'tree', 'metadata'].includes(args[0])) {
    throw new Error('Expected a Cargo check, build, test, tree, or metadata command.');
  }
  if (args.includes('--') || args.some((arg) => arg === '--target' || arg.startsWith('--target='))) {
    throw new Error('This launcher owns --target; test execution arguments are not supported. Use test --no-run for cross-compilation.');
  }
  if (args[0] === 'test' && !args.includes('--no-run')) {
    throw new Error('Cross-compiled tests cannot run on the build host. Add --no-run.');
  }
  // cargo metadata uses --filter-platform rather than --target.
  return [...args, args[0] === 'metadata' ? '--filter-platform' : '--target', target];
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 0 || args[0] === '--help') {
    console.log(`Usage: node scripts/ohos-cargo.mjs <check|build|test|tree|metadata> [Cargo arguments]

Uses ${target}. Set OPENBITFUN_OHOS_NDK to the SDK native directory.
macOS defaults to the bundled DevEco Studio SDK; Linux/WSL must set the path.
Install the Rust target first: rustup target add ${target}
Example: node scripts/ohos-cargo.mjs check --locked -p terminal-core
This command does not prove device support or produce a signed HAP.`);
    return 0;
  }
  if (process.platform === 'win32') {
    throw new Error('This launcher requires macOS or Linux/WSL and a matching host SDK.');
  }
  const commandArgs = cargoArguments(args);
  const ndk = resolveNdk();
  // A random linker path changes every Rust fingerprint and defeats Cargo's
  // incremental cache. Keep SDK-specific wrappers stable across invocations.
  const directory = path.join(repoRoot, 'target/ohos-toolchains', toolchainCacheKey(ndk));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env = createToolchain(ndk, directory);
  const result = spawnSync('cargo', commandArgs, { env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[ohos-cargo] ${error.message}`);
    process.exitCode = 1;
  }
}
