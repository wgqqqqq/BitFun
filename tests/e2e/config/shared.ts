import type { Options } from '@wdio/types';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_DRIVER_PORT = Number(process.env.BITFUN_E2E_DRIVER_PORT ?? 4444);
const DEFAULT_DRIVER_HOST = process.env.BITFUN_E2E_DRIVER_HOST ?? 'localhost';
const DEFAULT_WAY2_NATIVE_PORT = Number(process.env.BITFUN_E2E_WAY2_NATIVE_PORT ?? 4445);
const DEFAULT_WAY2_NATIVE_HOST = process.env.BITFUN_E2E_WAY2_NATIVE_HOST ?? '127.0.0.1';
const DRIVER_IMPL = (process.env.BITFUN_E2E_DRIVER_IMPL ?? 'auto').toLowerCase();
const IS_WAY2_AUTOMATION = DRIVER_IMPL === 'way2';
const IS_MAC_AUTOMATION = !IS_WAY2_AUTOMATION && (
  DRIVER_IMPL === 'mac-automation' ||
  (DRIVER_IMPL === 'auto' && process.platform === 'darwin')
);
const USES_LEGACY_DRIVER = !IS_WAY2_AUTOMATION && !IS_MAC_AUTOMATION;

let automationDriver: ChildProcess | null = null;
let automationDriverStartError: Error | null = null;

type ListeningProcess = {
  pid: number,
  command: string,
};

const MSEDGEDRIVER_PATHS = [
  path.join(os.tmpdir(), 'msedgedriver.exe'),
  'C:\\Windows\\System32\\msedgedriver.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'msedgedriver.exe'),
];

function findMsEdgeDriver(): string | null {
  for (const candidate of MSEDGEDRIVER_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findCommandInPath(command: string): string | null {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(locator, [command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0) {
    return null;
  }

  const firstLine = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);

  return firstLine ?? null;
}

function resolveCommandPath(command: string): string | null {
  const looksLikePath = command.includes(path.sep) || command.startsWith('.');
  if (looksLikePath) {
    return fs.existsSync(command) ? command : null;
  }

  return findCommandInPath(command);
}

function getLegacyTauriDriverPath(): string {
  const explicitPath = process.env.BITFUN_E2E_DRIVER_PATH;
  if (explicitPath) {
    return explicitPath;
  }

  const fromPath = findCommandInPath('tauri-driver');
  if (fromPath) {
    return fromPath;
  }

  const driverName = process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver';
  return path.join(os.homedir(), '.cargo', 'bin', driverName);
}

function getMacAutomationDriverPath(): string {
  const explicitPath =
    process.env.BITFUN_E2E_MAC_DRIVER_PATH ??
    process.env.BITFUN_E2E_DRIVER_PATH;
  if (explicitPath) {
    return explicitPath;
  }

  const fromPath = findCommandInPath('tauri-wd');
  if (fromPath) {
    return fromPath;
  }

  return path.join(os.homedir(), '.cargo', 'bin', 'tauri-wd');
}

function getWay2AutomationDriverPath(): string {
  const explicitPath =
    process.env.BITFUN_E2E_WAY2_DRIVER_PATH ??
    process.env.BITFUN_E2E_DRIVER_PATH;
  if (explicitPath) {
    return explicitPath;
  }

  const fromPath = findCommandInPath('tauri-webdriver');
  if (fromPath) {
    return fromPath;
  }

  const driverName = process.platform === 'win32' ? 'tauri-webdriver.exe' : 'tauri-webdriver';
  const projectRoot = getProjectRoot();

  const candidates = [
    path.join(projectRoot, 'webdriver_runtime', 'tauri-webdriver', 'target', 'release', driverName),
    path.join(projectRoot, 'webdriver_runtime', 'tauri-webdriver', 'target', 'debug', driverName),
  ];

  const existing = candidates.find(candidate => fs.existsSync(candidate));
  return existing ?? candidates[0];
}

function getAutomationDriverPath(): string {
  if (IS_WAY2_AUTOMATION) {
    return getWay2AutomationDriverPath();
  }

  return IS_MAC_AUTOMATION ? getMacAutomationDriverPath() : getLegacyTauriDriverPath();
}

function getDriverDisplayName(): string {
  if (IS_WAY2_AUTOMATION) {
    return 'tauri-webdriver';
  }

  return IS_MAC_AUTOMATION ? 'tauri-wd' : 'tauri-driver';
}

function getProjectRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

function getMacAppCandidates(buildType: 'debug' | 'release'): string[] {
  const projectRoot = getProjectRoot();
  const appBundleBinary = path.join(
    projectRoot,
    'target',
    buildType,
    'bundle',
    'macos',
    'BitFun.app',
    'Contents',
    'MacOS',
    'BitFun',
  );

  return [
    path.join(projectRoot, 'target', buildType, 'bitfun-desktop'),
    appBundleBinary,
  ];
}

export function getApplicationPath(): string {
  const forcedPath = process.env.BITFUN_E2E_APP_PATH;
  const forcedMode = process.env.BITFUN_E2E_APP_MODE?.toLowerCase();

  if (forcedPath) {
    return forcedPath;
  }

  const projectRoot = getProjectRoot();

  const releaseCandidates = process.platform === 'darwin'
    ? getMacAppCandidates('release')
    : [path.join(projectRoot, 'target', 'release', process.platform === 'win32' ? 'bitfun-desktop.exe' : 'bitfun-desktop')];

  const debugCandidates = process.platform === 'darwin'
    ? getMacAppCandidates('debug')
    : [path.join(projectRoot, 'target', 'debug', process.platform === 'win32' ? 'bitfun-desktop.exe' : 'bitfun-desktop')];

  if (forcedMode === 'debug') {
    return debugCandidates[0];
  }

  if (forcedMode === 'release') {
    return releaseCandidates[0];
  }

  const allCandidates = (IS_MAC_AUTOMATION || IS_WAY2_AUTOMATION)
    ? [...debugCandidates, ...releaseCandidates]
    : [...releaseCandidates, ...debugCandidates];
  const existing = allCandidates.find(candidate => fs.existsSync(candidate));

  return existing ?? debugCandidates[0];
}

function isDebugBuildPath(appPath: string): boolean {
  return appPath.includes(`${path.sep}debug${path.sep}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFileName(input: string): string {
  return input
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(1000);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    const onFailure = () => {
      socket.destroy();
      resolve(false);
    };

    socket.once('error', onFailure);
    socket.once('timeout', onFailure);
    socket.connect(port, host);
  });
}

function getPortListener(port: number): ListeningProcess | null {
  if (process.platform === 'win32') {
    return null;
  }

  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return null;
  }

  let pid: number | null = null;
  let command: string | null = null;

  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('p') && pid === null) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('c') && command === null) {
      command = line.slice(1);
    }

    if (pid !== null && command !== null) {
      break;
    }
  }

  if (!pid || !command) {
    return null;
  }

  return { pid, command };
}

function isKnownAutomationDriver(command: string): boolean {
  return command.includes('tauri-wd') || command.includes('tauri-driver') || command.includes('tauri-webdriver');
}

function isKnownWay2NativeProcess(command: string): boolean {
  return command.includes('bitfun-desktop') || command.includes('BitFun') || command.includes('tauri-webdriver');
}

async function waitForPortState(host: string, port: number, shouldBeOpen: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await isPortOpen(host, port)) === shouldBeOpen) {
      return true;
    }

    await sleep(200);
  }

  return false;
}

async function ensureDriverPortAvailable(host: string, port: number): Promise<void> {
  if (!(await isPortOpen(host, port))) {
    return;
  }

  const listener = getPortListener(port);
  if (listener && isKnownAutomationDriver(listener.command)) {
    console.warn(`Cleaning stale ${listener.command} process on port ${port} (pid ${listener.pid})`);
    try {
      process.kill(listener.pid, 'SIGTERM');
    } catch (error) {
      console.warn(`Failed to terminate stale process ${listener.pid}:`, error);
    }

    if (await waitForPortState(host, port, false, 5000)) {
      return;
    }

    try {
      process.kill(listener.pid, 'SIGKILL');
    } catch (error) {
      console.warn(`Failed to force kill stale process ${listener.pid}:`, error);
    }

    if (await waitForPortState(host, port, false, 3000)) {
      return;
    }
  }

  const activeListener = getPortListener(port);
  const ownerText = activeListener
    ? `${activeListener.command} (pid ${activeListener.pid})`
    : 'an unknown process';

  throw new Error(`WebDriver port ${host}:${port} is already in use by ${ownerText}`);
}

async function ensureWay2NativePortAvailable(host: string, port: number): Promise<void> {
  if (!(await isPortOpen(host, port))) {
    return;
  }

  const listener = getPortListener(port);
  if (listener && isKnownWay2NativeProcess(listener.command)) {
    console.warn(`Cleaning stale ${listener.command} process on native port ${port} (pid ${listener.pid})`);
    try {
      process.kill(listener.pid, 'SIGTERM');
    } catch (error) {
      console.warn(`Failed to terminate stale native process ${listener.pid}:`, error);
    }

    if (await waitForPortState(host, port, false, 5000)) {
      return;
    }

    try {
      process.kill(listener.pid, 'SIGKILL');
    } catch (error) {
      console.warn(`Failed to force kill stale native process ${listener.pid}:`, error);
    }

    if (await waitForPortState(host, port, false, 3000)) {
      return;
    }
  }

  const activeListener = getPortListener(port);
  const ownerText = activeListener
    ? `${activeListener.command} (pid ${activeListener.pid})`
    : 'an unknown process';

  throw new Error(`Way2 native port ${host}:${port} is already in use by ${ownerText}`);
}

async function waitForDriverReady(
  host: string,
  port: number,
  timeoutMs = 15000,
  driverProcess?: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isPortOpen(host, port)) {
      return;
    }

    if (automationDriverStartError) {
      throw automationDriverStartError;
    }

    if (driverProcess && driverProcess.exitCode !== null) {
      throw new Error(`${getDriverDisplayName()} exited before becoming ready (code ${driverProcess.exitCode})`);
    }

    if (driverProcess && driverProcess.signalCode !== null) {
      throw new Error(`${getDriverDisplayName()} exited before becoming ready (signal ${driverProcess.signalCode})`);
    }

    await sleep(250);
  }

  throw new Error(`WebDriver server did not become ready on ${host}:${port} within ${timeoutMs}ms`);
}

async function stopAutomationDriver(): Promise<void> {
  if (!automationDriver) {
    return;
  }

  const driverProcess = automationDriver;
  automationDriver = null;

  driverProcess.kill('SIGTERM');

  const driverStopped = await waitForPortState(DEFAULT_DRIVER_HOST, DEFAULT_DRIVER_PORT, false, 5000);
  const nativeStopped = IS_WAY2_AUTOMATION
    ? await waitForPortState(DEFAULT_WAY2_NATIVE_HOST, DEFAULT_WAY2_NATIVE_PORT, false, 5000)
    : true;

  if (driverStopped && nativeStopped) {
    return;
  }

  driverProcess.kill('SIGKILL');

  await waitForPortState(DEFAULT_DRIVER_HOST, DEFAULT_DRIVER_PORT, false, 3000);
  if (IS_WAY2_AUTOMATION) {
    await waitForPortState(DEFAULT_WAY2_NATIVE_HOST, DEFAULT_WAY2_NATIVE_PORT, false, 3000);
  }
}

async function checkDevServer(): Promise<void> {
  const isRunning = await isPortOpen('localhost', 1422);
  if (isRunning) {
    console.log('Dev server is already running on port 1422');
    return;
  }

  console.warn('Dev server not running on port 1422');
  console.warn('Please start it with: pnpm run dev');
  console.warn('Continuing anyway...');
}

type ConfigOptions = {
  specs: string[],
  label: string,
};

export function createWdioConfig({ specs, label }: ConfigOptions): Options.Testrunner {
  const capabilities = [{
    ...(IS_WAY2_AUTOMATION ? { 'wdio:maxInstances': 1 } : {}),
    'tauri:options': {
      application: getApplicationPath(),
    },
  }] as unknown as Options.Testrunner['capabilities'];

  return {
    runner: 'local',
    autoCompileOpts: {
      autoCompile: true,
      tsNodeOpts: {
        transpileOnly: true,
        project: path.resolve(__dirname, '..', 'tsconfig.json'),
      },
    },

    specs,
    exclude: [],

    maxInstances: 1,
    maxInstancesPerCapability: IS_WAY2_AUTOMATION ? 1 : undefined,
    capabilities,

    logLevel: 'info',
    bail: 0,
    baseUrl: '',
    waitforTimeout: 10000,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,

    services: [],
    hostname: DEFAULT_DRIVER_HOST,
    port: DEFAULT_DRIVER_PORT,
    path: '/',

    framework: 'mocha',
    reporters: ['spec'],

    mochaOpts: {
      ui: 'bdd',
      timeout: 120000,
      retries: 0,
    },

    onPrepare: async function () {
      console.log(`Preparing ${label} E2E test run...`);
      fs.mkdirSync(path.resolve(__dirname, '..', 'reports', 'screenshots'), { recursive: true });

      const driverPath = getAutomationDriverPath();
      const resolvedDriverPath = resolveCommandPath(driverPath);
      if (!resolvedDriverPath) {
        const installCommand = IS_WAY2_AUTOMATION
          ? 'pnpm run e2e:build:way2-driver'
          : IS_MAC_AUTOMATION
            ? 'cargo install tauri-webdriver-automation'
            : 'cargo install tauri-driver --locked';
        console.error(`${getDriverDisplayName()} not found. Please install it with:`);
        console.error(installCommand);
        throw new Error(`${getDriverDisplayName()} not installed`);
      }
      console.log(`${getDriverDisplayName()}: ${resolvedDriverPath}`);

      if (IS_WAY2_AUTOMATION) {
        console.log(`way2 native WebDriver target: ${DEFAULT_WAY2_NATIVE_HOST}:${DEFAULT_WAY2_NATIVE_PORT}`);
      } else if (USES_LEGACY_DRIVER) {
        const msedgeDriverPath = findMsEdgeDriver();
        if (msedgeDriverPath) {
          console.log(`msedgedriver: ${msedgeDriverPath}`);
        } else {
          console.warn('msedgedriver not found. Will try to use PATH.');
        }
      }

      const appPath = getApplicationPath();
      if (!fs.existsSync(appPath)) {
        console.error(`Application not found at: ${appPath}`);
        console.error('Please build the application first with:');
        console.error(
          IS_WAY2_AUTOMATION
            ? 'pnpm run desktop:build:e2e:way2'
            : IS_MAC_AUTOMATION
              ? 'pnpm run desktop:build:e2e:mac'
              : 'pnpm run desktop:build',
        );
        throw new Error('Application not built');
      }
      console.log(`application: ${appPath}`);

      if (IS_WAY2_AUTOMATION && !isDebugBuildPath(appPath)) {
        console.error('way2 automation POC requires a debug desktop build with the webdriver-e2e-way2 feature enabled.');
        console.error('Build it with: pnpm run desktop:build:e2e:way2');
        throw new Error('way2 automation requires debug webdriver build');
      }

      if (IS_MAC_AUTOMATION && !isDebugBuildPath(appPath)) {
        console.error('macOS automation requires a debug desktop build with the webdriver-e2e feature enabled.');
        console.error('Build it with: pnpm run desktop:build:e2e:mac');
        throw new Error('macOS automation requires debug webdriver build');
      }

      if (USES_LEGACY_DRIVER && isDebugBuildPath(appPath)) {
        console.log('Debug build detected, checking dev server...');
        await checkDevServer();
      }
    },

    beforeSession: async function () {
      const driverPath = getAutomationDriverPath();
      const appPath = getApplicationPath();
      const args: string[] = ['--port', String(DEFAULT_DRIVER_PORT)];
      automationDriverStartError = null;

      console.log(`Starting ${getDriverDisplayName()}...`);

      if (automationDriver) {
        await stopAutomationDriver();
      }

      await ensureDriverPortAvailable(DEFAULT_DRIVER_HOST, DEFAULT_DRIVER_PORT);
      if (IS_WAY2_AUTOMATION) {
        await ensureWay2NativePortAvailable(DEFAULT_WAY2_NATIVE_HOST, DEFAULT_WAY2_NATIVE_PORT);
      }

      if (IS_WAY2_AUTOMATION) {
        args.push('--native-port', String(DEFAULT_WAY2_NATIVE_PORT));
        args.push('--native-host', DEFAULT_WAY2_NATIVE_HOST);
      } else if (USES_LEGACY_DRIVER) {
        const msedgeDriverPath = findMsEdgeDriver();
        if (msedgeDriverPath) {
          console.log(`msedgedriver: ${msedgeDriverPath}`);
          args.push('--native-driver', msedgeDriverPath);
        } else {
          console.warn('msedgedriver not found in common paths');
        }
      }

      console.log(`Application: ${appPath}`);
      console.log(`Starting: ${driverPath} ${args.join(' ')}`);

      automationDriver = spawn(driverPath, args, {
        env: IS_WAY2_AUTOMATION
          ? {
            ...process.env,
            TAURI_WEBDRIVER_PORT: String(DEFAULT_WAY2_NATIVE_PORT),
          }
          : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      automationDriver.once('error', error => {
        automationDriverStartError = error;
      });

      automationDriver.stdout?.on('data', (data: Buffer) => {
        console.log(`[${getDriverDisplayName()}] ${data.toString().trim()}`);
      });

      automationDriver.stderr?.on('data', (data: Buffer) => {
        console.error(`[${getDriverDisplayName()}] ${data.toString().trim()}`);
      });

      await waitForDriverReady(DEFAULT_DRIVER_HOST, DEFAULT_DRIVER_PORT, 15000, automationDriver);
      console.log(`${getDriverDisplayName()} started on port ${DEFAULT_DRIVER_PORT}`);
    },

    afterSession: async function () {
      console.log(`Stopping ${getDriverDisplayName()}...`);

      if (automationDriver) {
        await stopAutomationDriver();
        console.log(`${getDriverDisplayName()} stopped`);
      }
    },

    afterTest: async function (test, context, { error, passed }) {
      const isRealFailure = !passed && !!error;
      if (isRealFailure) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const screenshotName = `failure-${sanitizeFileName(test.title)}-${timestamp}.png`;

        try {
          const screenshotPath = path.resolve(__dirname, '..', 'reports', 'screenshots', screenshotName);
          await browser.saveScreenshot(screenshotPath);
          console.log(`Screenshot saved: ${screenshotName}`);
        } catch (screenshotError) {
          console.error('Failed to save screenshot:', screenshotError);
        }
      }
    },

    onComplete: async function () {
      console.log(`${label} E2E test run completed`);
      await stopAutomationDriver();
    },
  };
}
