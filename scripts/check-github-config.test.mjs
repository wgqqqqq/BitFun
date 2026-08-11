import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts/check-github-config.mjs');
const requireFromWebUi = createRequire(
  path.join(repoRoot, 'src/web-ui/package.json'),
);
const yaml = requireFromWebUi('yaml');

function createRepo({ workflow, nodeVersionFile }) {
  const root = mkdtempSync(path.join(tmpdir(), 'bitfun-github-config-'));
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ engines: { node: '>=22.12.0' } }, null, 2)}\n`,
  );
  writeFileSync(path.join(root, '.github/workflows/ci.yml'), workflow);

  if (nodeVersionFile) {
    writeFileSync(path.join(root, nodeVersionFile.path), `${nodeVersionFile.value}\n`);
  }

  return root;
}

function runCheck(root) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BITFUN_GITHUB_CONFIG_TEST_ROOT: root,
    },
    encoding: 'utf8',
  });
}

test('rejects setup-node node-version-file below the project baseline', (t) => {
  const root = createRepo({
    nodeVersionFile: { path: '.node-version', value: '20' },
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version-file: .node-version
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node-version-file \.node-version resolves to 20/);
  assert.match(result.stderr, /Node\.js 22\.12\.0 or newer/);
});

test('rejects explicit setup-node node-version below the project baseline when node-version-file is valid', (t) => {
  const root = createRepo({
    nodeVersionFile: { path: '.node-version', value: '22' },
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: 20
          node-version-file: .node-version
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node-version resolves to 20/);
});

test('accepts package.json node-version-file from engines.node', (t) => {
  const root = createRepo({
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version-file: package.json
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.equal(result.status, 0, result.stderr);
});

test('accepts tool-versions node-version-file syntax', (t) => {
  const root = createRepo({
    nodeVersionFile: { path: '.tool-versions', value: 'nodejs 22.12.0' },
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version-file: .tool-versions
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.equal(result.status, 0, result.stderr);
});

test('rejects floating setup-node minor below the project baseline', (t) => {
  const root = createRepo({
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: "22.11.x"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node-version resolves to 22.11.x/);
});

test('accepts floating setup-node minor at the project baseline', (t) => {
  const root = createRepo({
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: "22.12.x"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.equal(result.status, 0, result.stderr);
});

test('accepts explicit setup-node semver range at the project baseline', (t) => {
  const root = createRepo({
    workflow: `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: ">=22.12.0"
`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runCheck(root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub YAML config check passed/);
});

test('keeps Rust CI independent, restore-only on PRs, and target-focused', () => {
  const workflow = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8'),
  );
  const rustJob = workflow.jobs['rust-build-check'];
  const frontendJob = workflow.jobs['frontend-build'];
  const trustedMain =
    "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}";

  assert.equal(
    rustJob.needs,
    undefined,
    'Rust validation must not wait for the frontend build',
  );
  assert.equal(
    rustJob.steps.some((step) => step.uses?.startsWith('actions/download-artifact@')),
    false,
    'Rust validation must not download frontend artifacts',
  );
  assert.match(
    rustJob.steps.find((step) => step.name === 'Create Tauri resource directories')
      ?.run ?? '',
    /mkdir -p dist src\/mobile-web\/dist/,
  );
  assert.equal(
    frontendJob.steps.some(
      (step) =>
        step.uses?.startsWith('actions/upload-artifact@') &&
        step.with?.name === 'frontend-dist',
    ),
    false,
    'The frontend build must not upload an artifact with no consumer',
  );

  for (const jobName of ['cli-test', 'rust-build-check']) {
    const job = workflow.jobs[jobName];
    const cache = job.steps.find((step) =>
      step.uses?.startsWith('swatinem/rust-cache@'),
    );
    assert.equal(
      job.steps.some((step) => step.run?.includes('cargo generate-lockfile')),
      false,
      `${jobName} must consume the committed Cargo.lock`,
    );
    assert.equal(cache?.with?.['save-if'], trustedMain);
    assert.equal(cache?.with?.['cache-on-failure'], trustedMain);
  }

  const rustCache = rustJob.steps.find((step) =>
    step.uses?.startsWith('swatinem/rust-cache@'),
  );
  assert.equal(
    rustCache?.with?.['cache-directories'],
    'target/sherpa-onnx-prebuilt\n',
    'Rust CI must restore sherpa native libraries with the Cargo fingerprints that reference them',
  );

  const commandByStep = new Map(
    rustJob.steps.map((step) => [step.name, step.run]),
  );
  assert.equal(
    commandByStep.get('Run subscription authentication tests'),
    'cargo test --locked -p bitfun-ai-adapters --features subscription-auth --lib subscription_auth',
  );
  const installerCheck = rustJob.steps.find(
    (step) => step.name === 'Check installer compilation',
  );
  assert.equal(installerCheck?.if, "runner.os == 'Windows'");
  assert.equal(
    installerCheck?.run,
    'cargo check --manifest-path BitFun-Installer/src-tauri/Cargo.toml',
  );
  assert.equal(
    commandByStep.get('Run file watch contract tests'),
    'cargo test --locked -p bitfun-services-integrations --no-default-features --features file-watch --test file_watch_contracts',
  );
  assert.equal(
    commandByStep.get('Run search tool tests'),
    'cargo test --locked -p tool-runtime --lib search::',
  );
});

test('generates web API bindings before nightly web type-check', () => {
  const workflow = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/nightly.yml'), 'utf8'),
  );
  const packageJob = workflow.jobs.package;
  const steps = packageJob.steps;
  const generationIndex = steps.findIndex(
    (step) => step.name === 'Generate web API bindings',
  );
  const typeCheckIndex = steps.findIndex(
    (step) => step.name === 'Type-check web UI',
  );

  assert.notEqual(generationIndex, -1);
  assert.notEqual(typeCheckIndex, -1);
  assert.equal(
    steps[generationIndex].run,
    'pnpm --dir src/web-ui run gen:types',
  );
  assert.ok(
    generationIndex < typeCheckIndex,
    'nightly must generate web API bindings before type-checking the web UI',
  );
});

test('passes the verification key when signing the versioned Windows installer', () => {
  const workflow = yaml.parse(
    readFileSync(
      path.join(repoRoot, '.github/workflows/desktop-package.yml'),
      'utf8',
    ),
  );
  const signingStep = workflow.jobs['upload-release-assets'].steps.find(
    (step) => step.name === 'Sign versioned Windows installer',
  );

  assert.equal(
    signingStep?.env?.BITFUN_SIGNING_PUBKEY,
    '${{ secrets.TAURI_UPDATER_PUBKEY }}',
    'release signatures must be self-verified with the configured public key',
  );
});

test('stages unique release asset names before publishing', () => {
  const workflow = yaml.parse(
    readFileSync(
      path.join(repoRoot, '.github/workflows/desktop-package.yml'),
      'utf8',
    ),
  );
  const steps = workflow.jobs['upload-release-assets'].steps;
  const stagingIndex = steps.findIndex(
    (step) => step.name === 'Stage uniquely named release assets',
  );
  const uploadIndex = steps.findIndex((step) => step.name === 'Upload to release');

  assert.notEqual(stagingIndex, -1);
  assert.notEqual(uploadIndex, -1);
  assert.ok(stagingIndex < uploadIndex);
  assert.match(
    steps[stagingIndex].run,
    /node scripts\/stage-github-release-assets\.mjs/,
  );
  assert.doesNotMatch(
    steps[stagingIndex].run,
    /release-assets\/\*\*\/\*\.sig(?:\s|\\)/,
    'raw updater signatures have colliding names across macOS architectures',
  );
  assert.equal(steps[uploadIndex].with.files, 'release-upload-assets/*');
});

test('Desktop packaging keeps beta identity explicit and stable-safe', () => {
  const workflow = yaml.parse(
    readFileSync(
      path.join(repoRoot, '.github/workflows/desktop-package.yml'),
      'utf8',
    ),
  );
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.release_channel.options, ['stable', 'beta']);
  assert.equal(inputs.release_channel.default, 'stable');

  const prepareStep = workflow.jobs.prepare.steps.find(
    (step) => step.name === 'Resolve version metadata',
  );
  assert.match(prepareStep.run, /GITHUB_REPOSITORY.*GCWing\/BitFun/);
  assert.match(prepareStep.run, /merge-base --is-ancestor/);
  assert.match(prepareStep.run, /rev-parse --verify --quiet/);

  const packageJob = workflow.jobs.package;
  assert.equal(
    packageJob.env.BITFUN_RELEASE_CHANNEL,
    '${{ needs.prepare.outputs.release_channel }}',
  );
  assert.equal(packageJob.env.TAURI_UPDATER_ENDPOINT, undefined);
  const patchIndex = packageJob.steps.findIndex(
    (step) => step.name === 'Project beta build version',
  );
  const verifyIndex = packageJob.steps.findIndex(
    (step) => step.name === 'Verify release version metadata',
  );
  assert.ok(patchIndex >= 0 && patchIndex < verifyIndex);
  assert.equal(
    packageJob.steps[patchIndex].if,
    "needs.prepare.outputs.release_channel == 'beta'",
  );

  const uploadSteps = workflow.jobs['upload-release-assets'].steps;
  const release = uploadSteps.find((step) => step.name === 'Upload to release');
  assert.equal(
    release.with.prerelease,
    "${{ needs.prepare.outputs.release_channel == 'beta' }}",
  );
  const verifyIndexPublished = uploadSteps.findIndex(
    (step) => step.name === 'Verify published updater manifest',
  );
  const promoteIndex = uploadSteps.findIndex(
    (step) => step.name === 'Publish beta channel manifest',
  );
  assert.ok(verifyIndexPublished >= 0 && verifyIndexPublished < promoteIndex);
});

test('beta publishing cannot advance the Relay latest image tag', () => {
  const workflow = yaml.parse(
    readFileSync(
      path.join(repoRoot, '.github/workflows/desktop-package.yml'),
      'utf8',
    ),
  );
  const imageTags = workflow.jobs['publish-relay-image'].steps.find(
    (step) => step.name === 'Resolve image tags',
  );
  assert.equal(
    imageTags.env.RELEASE_CHANNEL,
    '${{ needs.prepare.outputs.release_channel }}',
  );
  assert.match(imageTags.run, /RELEASE_CHANNEL.*stable/);
  assert.doesNotMatch(imageTags.run, /RELEASE_PRERELEASE/);
});

test('nightly and beta use the shared build-version projection', () => {
  const nightly = yaml.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/nightly.yml'), 'utf8'),
  );
  const patch = nightly.jobs.package.steps.find(
    (step) => step.name === 'Patch nightly version',
  );
  assert.match(patch.run, /node scripts\/set-build-version\.mjs/);
  assert.equal(nightly.jobs.package.env.BITFUN_RELEASE_CHANNEL, 'nightly');
});
