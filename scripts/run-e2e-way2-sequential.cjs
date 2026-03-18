const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = __dirname.endsWith('/scripts') ? path.dirname(__dirname) : __dirname;
const e2eRoot = path.join(repoRoot, 'tests', 'e2e');
const specsRoot = path.join(e2eRoot, 'specs');

function collectSpecs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const specs = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      specs.push(...collectSpecs(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      specs.push(fullPath);
    }
  }

  return specs;
}

const specs = collectSpecs(specsRoot)
  .sort((a, b) => a.localeCompare(b))
  .map(specPath => `./${path.relative(e2eRoot, specPath).split(path.sep).join('/')}`);

if (specs.length === 0) {
  console.error('No E2E spec files found for way2 run.');
  process.exit(1);
}

for (const [index, spec] of specs.entries()) {
  const label = `[way2 ${index + 1}/${specs.length}]`;
  console.log(`${label} Running ${spec}`);

  const result = spawnSync(
    'pnpm',
    ['--dir', 'tests/e2e', 'exec', 'wdio', 'run', './config/wdio.conf.ts', '--spec', spec],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) {
    console.error(`${label} Failed: ${spec}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`[way2] Completed ${specs.length} spec files sequentially.`);
