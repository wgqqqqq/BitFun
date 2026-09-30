#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import JSON5 from 'json5';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = path.join(root, 'src/apps/ohos');
const studio = process.env.OPENBITFUN_DEVECO_CONTENTS || '/Applications/DevEco-Studio.app/Contents';
const profilePath = path.join(host, 'build-profile.json5');
const localSigning = path.join(host, 'signing.local.json');
const originalProfile = readFileSync(profilePath, 'utf8');
let injectedProfile;
if (existsSync(localSigning)) {
  const profile = JSON5.parse(originalProfile);
  const local = JSON.parse(readFileSync(localSigning, 'utf8'));
  if (!Array.isArray(local.signingConfigs) || !local.signingConfigs.some(config => config.name === 'default')) {
    throw new Error('Local signing must contain the DevEco-generated default signing configuration');
  }
  profile.app.signingConfigs = local.signingConfigs;
  for (const product of profile.app.products) {
    if (product.name === 'default') product.signingConfig = 'default';
  }
  injectedProfile = JSON.stringify(profile, null, 2) + '\n';
  writeFileSync(profilePath, injectedProfile);
}
try {
  const result = spawnSync(path.join(studio, 'tools/node/bin/node'), [path.join(studio, 'tools/hvigor/bin/hvigorw.js'), ...process.argv.slice(2)], {
    cwd: host,
    env: { ...process.env, DEVECO_SDK_HOME: path.join(studio, 'sdk'), OHOS_BASE_SDK_HOME: path.join(studio, 'sdk/default/openharmony'), JAVA_HOME: path.join(studio, 'jbr/Contents/Home') },
    stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (injectedProfile) {
    if (readFileSync(profilePath, 'utf8') !== injectedProfile) {
      throw new Error('Build profile changed during Hvigor execution; preserve the local signing data and restore the public profile before committing');
    }
    writeFileSync(profilePath, originalProfile);
  }
}
