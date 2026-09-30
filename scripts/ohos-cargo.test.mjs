import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { cargoArguments, createToolchain, resolveNdk, target, toolchainCacheKey } from './ohos-cargo.mjs';

test('target is explicit and cross-compiled tests cannot run on the build host', () => {
  assert.deepEqual(cargoArguments(['check', '--locked', '-p', 'terminal-core']),
    ['check', '--locked', '-p', 'terminal-core', '--target', target]);
  assert.deepEqual(cargoArguments(['metadata', '--format-version', '1']),
    ['metadata', '--format-version', '1', '--filter-platform', target]);
  assert.throws(() => cargoArguments(['test']), /cannot run/);
  assert.throws(() => cargoArguments(['build', '--target=x86_64-unknown-linux-gnu']), /owns --target/);
  assert.throws(() => cargoArguments(['run']), /Expected/);
  assert.throws(() => cargoArguments(['test', '--no-run', '--', 'ignored']), /not supported/);
});

test('SDK resolution fails before starting a compiler when components are missing', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ohos-sdk-test-'));
  try {
    assert.throws(() => resolveNdk({ OPENBITFUN_OHOS_NDK: directory }), /Missing OHOS SDK component/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('wrappers preserve SDK paths and compiler arguments without changing host compiler settings',
  { skip: process.platform === 'win32' }, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ohos-sdk-test-'));
    try {
      const ndk = path.join(directory, 'SDK space $literal');
      mkdirSync(path.join(ndk, 'llvm/bin'), { recursive: true });
      mkdirSync(path.join(ndk, 'sysroot'));
      const output = path.join(directory, 'arguments');
      for (const compiler of ['clang', 'clang++', 'llvm-ar']) {
        writeFileSync(path.join(ndk, 'llvm/bin', compiler), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGUMENT_OUTPUT"\n', { mode: 0o700 });
      }
      const inherited = { ...process.env, CC: 'host-cc', ARGUMENT_OUTPUT: output };
      const env = createToolchain(resolveNdk({ OPENBITFUN_OHOS_NDK: ndk }), directory, inherited);
      assert.equal(env.CC, 'host-cc');
      assert.equal(env.OHOS_NDK_HOME, resolveNdk({ OPENBITFUN_OHOS_NDK: ndk }));
      assert.equal(inherited.CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER, process.env.CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER);
      const linker = env.CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER;
      const modifiedAt = statSync(linker).mtimeMs;
      createToolchain(resolveNdk({ OPENBITFUN_OHOS_NDK: ndk }), directory, inherited);
      assert.equal(statSync(linker).mtimeMs, modifiedAt);
      const cacheKey = toolchainCacheKey(ndk);
      assert.equal(toolchainCacheKey(ndk), cacheKey);
      writeFileSync(path.join(ndk, 'oh-uni-package.json'), '{"version":"next"}');
      assert.notEqual(toolchainCacheKey(ndk), cacheKey);
      for (const key of ['CC_aarch64_unknown_linux_ohos', 'CXX_aarch64_unknown_linux_ohos']) {
        const result = spawnSync(env[key], ['input with spaces.c', '-o', 'out.o'], { env, windowsHide: true });
        assert.equal(result.status, 0);
        assert.deepEqual(readFileSync(output, 'utf8').trimEnd().split('\n'), [
          '--target=aarch64-linux-ohos', `--sysroot=${resolveNdk({ OPENBITFUN_OHOS_NDK: ndk })}/sysroot`,
          '-D__MUSL__', 'input with spaces.c', '-o', 'out.o',
        ]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
