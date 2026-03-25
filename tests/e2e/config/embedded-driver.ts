import type { Options } from '@wdio/types';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DRIVER_HOST = '127.0.0.1';
const DRIVER_PORT = Number(process.env.BITFUN_E2E_WEBDRIVER_PORT || 4445);

let bitfunApp: ChildProcess | null = null;

function projectRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

type BrowserLogEntry = {
  level: string;
  message: string;
  timestamp: number;
};

function executableCandidates(buildType: 'debug' | 'release'): string[] {
  const root = projectRoot();
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binaryName = `bitfun-desktop${suffix}`;

  if (process.platform === 'darwin') {
    return [
      path.join(root, 'target', buildType, binaryName),
      path.join(root, 'target', buildType, 'BitFun.app', 'Contents', 'MacOS', 'BitFun'),
    ];
  }

  return [path.join(root, 'target', buildType, binaryName)];
}

export function getApplicationPath(): string {
  const forcedPath = process.env.BITFUN_E2E_APP_PATH;
  const forcedMode = process.env.BITFUN_E2E_APP_MODE?.toLowerCase();

  if (forcedPath) {
    return forcedPath;
  }

  if (forcedMode === 'debug') {
    return executableCandidates('debug')[0];
  }

  if (forcedMode === 'release') {
    throw new Error('Release mode is disabled for E2E. Use the debug desktop build instead.');
  }

  const debugMatch = executableCandidates('debug').find(candidate => fs.existsSync(candidate));
  if (debugMatch) {
    return debugMatch;
  }

  throw new Error(
    `Debug desktop build not found. Expected one of: ${executableCandidates('debug').join(', ')}`
  );
}

async function waitForDevServerIfNeeded(appPath: string): Promise<void> {
  if (!appPath.includes(`${path.sep}debug${path.sep}`)) {
    return;
  }

  const hosts = ['127.0.0.1', '::1'];
  const running = await Promise.any(hosts.map(host => {
    return new Promise<boolean>((resolve, reject) => {
      const client = new net.Socket();
      client.setTimeout(2000);
      client.connect(1422, host, () => {
        client.destroy();
        resolve(true);
      });
      client.on('error', error => {
        client.destroy();
        reject(error);
      });
      client.on('timeout', () => {
        client.destroy();
        reject(new Error(`Timeout connecting to ${host}:1422`));
      });
    });
  })).then(() => true).catch(() => false);

  if (running) {
    console.log('Dev server is already running on port 1422');
    return;
  }

  console.warn('Dev server not running on port 1422');
  console.warn('Please start it with: pnpm run dev:web');
}

async function fetchDriverStatus(): Promise<boolean> {
  try {
    const response = await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/status`);
    if (!response.ok) {
      return false;
    }
    const body = await response.json() as { value?: { ready?: boolean } };
    return body.value?.ready === true;
  } catch {
    return false;
  }
}

async function createProbeSession(): Promise<string> {
  const response = await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  if (!response.ok) {
    throw new Error(`Failed to create probe session: ${response.status} ${await response.text()}`);
  }

  const body = await response.json() as { value?: { sessionId?: string } };
  const sessionId = body.value?.sessionId;
  if (!sessionId) {
    throw new Error('Probe session did not return a session id');
  }
  return sessionId;
}

async function deleteProbeSession(sessionId: string): Promise<void> {
  await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/session/${sessionId}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}

async function probeDocumentReady(sessionId: string): Promise<boolean> {
  const response = await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/session/${sessionId}/execute/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      script: '() => Boolean(document?.body)',
      args: [],
    }),
  });

  if (!response.ok) {
    throw new Error(`Document ready probe failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json() as { value?: boolean };
  return body.value === true;
}

async function waitForEmbeddedDriverReady(timeoutMs: number = 30000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await fetchDriverStatus()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`Embedded WebDriver did not become ready within ${timeoutMs}ms`);
}

async function waitForWebviewDocumentReady(timeoutMs: number = 30000): Promise<void> {
  const startedAt = Date.now();
  let lastError = 'document.body is not ready';

  while (Date.now() - startedAt < timeoutMs) {
    let sessionId: string | null = null;

    try {
      sessionId = await createProbeSession();
      const ready = await probeDocumentReady(sessionId);
      if (ready) {
        await deleteProbeSession(sessionId);
        return;
      }
      lastError = 'document.body is not ready';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      if (sessionId) {
        await deleteProbeSession(sessionId);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Webview document did not become ready within ${timeoutMs}ms: ${lastError}`);
}

async function fetchSessionLogs(
  sessionId: string,
  logType: string,
): Promise<BrowserLogEntry[]> {
  const response = await fetch(`http://${DRIVER_HOST}:${DRIVER_PORT}/session/${sessionId}/se/log`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: logType }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch logs: ${response.status} ${body}`);
  }

  const payload = await response.json() as { value?: BrowserLogEntry[] };
  return payload.value ?? [];
}

function stopBitFunApp(): void {
  if (!bitfunApp) {
    return;
  }

  bitfunApp.kill();
  bitfunApp = null;
}

async function startBitFunApp(): Promise<void> {
  const appPath = getApplicationPath();

  if (!fs.existsSync(appPath)) {
    console.error(`Application not found at: ${appPath}`);
    console.error('Please build the debug application first with:');
    console.error('cargo build -p bitfun-desktop');
    throw new Error('Application not built');
  }

  await waitForDevServerIfNeeded(appPath);

  stopBitFunApp();

  console.log(`Starting BitFun with embedded WebDriver on port ${DRIVER_PORT}`);
  console.log(`Application: ${appPath}`);

  bitfunApp = spawn(appPath, [], {
    cwd: projectRoot(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BITFUN_WEBDRIVER_PORT: String(DRIVER_PORT),
      BITFUN_WEBDRIVER_LABEL: 'main',
    },
  });

  bitfunApp.stdout?.on('data', (data: Buffer) => {
    console.log(`[bitfun-app] ${data.toString().trim()}`);
  });

  bitfunApp.stderr?.on('data', (data: Buffer) => {
    console.error(`[bitfun-app] ${data.toString().trim()}`);
  });

  bitfunApp.on('exit', (code, signal) => {
    console.log(`[bitfun-app] exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
  });

  await waitForEmbeddedDriverReady();
  await waitForWebviewDocumentReady();
  console.log(`Embedded WebDriver is ready on http://${DRIVER_HOST}:${DRIVER_PORT}`);
}

function sharedAfterTest(): Options.Testrunner['afterTest'] {
  return async function afterTest(test, _context, { error, passed }) {
    const isRealFailure = !passed && !!error;
    if (!isRealFailure) {
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotName = `failure-${test.title.replace(/\s+/g, '_')}-${timestamp}.png`;

    try {
      const screenshotPath = path.resolve(__dirname, '..', 'reports', 'screenshots', screenshotName);
      await browser.saveScreenshot(screenshotPath);
      console.log(`Screenshot saved: ${screenshotName}`);
    } catch (screenshotError) {
      console.error('Failed to save screenshot:', screenshotError);
    }
  };
}

export function createEmbeddedConfig(specs: string[], label: string): Options.Testrunner {
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
    capabilities: [{
      maxInstances: 1,
      browserName: 'bitfun',
      'bitfun:embedded': true,
    } as any],

    logLevel: 'info',
    bail: 0,
    baseUrl: '',
    waitforTimeout: 10000,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,

    services: [],
    hostname: DRIVER_HOST,
    port: DRIVER_PORT,
    path: '/',

    framework: 'mocha',
    reporters: ['spec'],

    mochaOpts: {
      ui: 'bdd',
      timeout: 120000,
      retries: 0,
    },

    onPrepare: async function onPrepare() {
      console.log(`Preparing ${label} E2E test run...`);
      const appPath = getApplicationPath();

      if (!fs.existsSync(appPath)) {
        console.error(`Application not found at: ${appPath}`);
        console.error('Please build the debug application first with:');
        console.error('cargo build -p bitfun-desktop');
        throw new Error('Application not built');
      }

      console.log(`application: ${appPath}`);
      await waitForDevServerIfNeeded(appPath);
    },

    beforeSession: async function beforeSession() {
      await startBitFunApp();
    },

    before: async function before() {
      const browserWithLogs = browser as WebdriverIO.Browser & {
        getLogs?: (logType: string) => Promise<BrowserLogEntry[]>;
      };

      if (typeof browserWithLogs.getLogs !== 'function') {
        browser.addCommand('getLogs', async function (this: WebdriverIO.Browser, logType: string) {
          return fetchSessionLogs(this.sessionId, logType);
        });
      }
    },

    afterSession: function afterSession() {
      console.log('Stopping BitFun app...');
      stopBitFunApp();
    },

    afterTest: sharedAfterTest(),

    onComplete: function onComplete() {
      console.log(`${label} E2E test run completed`);
      stopBitFunApp();
    },
  };
}
