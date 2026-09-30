import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../src/web-ui/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../src/apps/ohos/entry/src/main/ets/CompanionFoldTransfer.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { companionFoldTarget: target } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const screen = { left: 0, top: 0, width: 2472, height: 3296 };
const crease = { left: 0, top: 1608, width: 2472, height: 82 };
const pet = { left: 800, top: 1200, width: 200, height: 200 };
test('transfers downward before the pet reaches the crease, leaving landing space', () => {
  assert.deepEqual(target(pet, 800, 1325, crease, screen, 86, 43), { x: 800, y: 1733 });
  assert.equal(target(pet, 800, 1310, crease, screen, 86, 43), null);
});
test('transfers upward and clamps horizontal landing inside the screen', () => {
  assert.deepEqual(target({ ...pet, top: 1900 }, 2460, 1770, crease, screen, 86, 43), { x: 2229, y: 1365 });
});
test('does not transfer sideways or when moving away from the crease', () => {
  assert.equal(target({ ...pet, top: 1380 }, 900, 1380, crease, screen, 86, 43), null);
  assert.equal(target({ ...pet, top: 1380 }, 900, 1370, crease, screen, 86, 43), null);
});
test('rejects a vertical crease or a pet too tall for either destination', () => {
  assert.equal(target(pet, 800, 1500, { left: 1608, top: 0, width: 82, height: 2472 }, screen, 86, 43), null);
  assert.equal(target({ ...pet, height: 1600 }, 800, 1500, crease, screen, 86, 43), null);
});
