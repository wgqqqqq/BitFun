#!/usr/bin/env node
// Keep DevEco's local signing secrets out of the checked-in build profile.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
const host = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/apps/ohos');
const profilePath = path.join(host, 'build-profile.json5');
const profile = JSON5.parse(readFileSync(profilePath, 'utf8'));
const signingConfigs = profile.app?.signingConfigs;
if (!Array.isArray(signingConfigs) || !signingConfigs.some(config => config.name === 'default')) {
  throw new Error('First generate the default signing configuration for this project in DevEco Studio');
}
const localPath = path.join(host, 'signing.local.json');
writeFileSync(localPath, JSON.stringify({ signingConfigs }, null, 2) + '\n', { mode: 0o600 });
chmodSync(localPath, 0o600);
profile.app.signingConfigs = [];
for (const product of profile.app.products) delete product.signingConfig;
writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n');
console.log('Saved local signing configuration. Use scripts/ohos/hvigor.mjs to build signed packages.');
