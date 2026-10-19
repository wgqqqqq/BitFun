import { common } from '@kit.AbilityKit';
import window from '@ohos.window';
import { image } from '@kit.ImageKit';
import { fileIo } from '@kit.CoreFileKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { RustWebviewNodeController, WebviewInitData, JsHelper } from '@ohos-rs/ability';
import { MiniAppShortcuts } from './MiniAppShortcuts';

interface Operation { action: string; label?: string; launchId?: string; launchIds?: string[]; title?: string; icon?: string; }

export class MiniAppWindow {
  context: common.UIAbilityContext;
  window: window.Window;
  node: RustWebviewNodeController | null = null;
  webview: JsHelper | null = null;
  constructor(context: common.UIAbilityContext, nativeWindow: window.Window) { this.context = context; this.window = nativeWindow; }
}

// The map binds native containers to host-generated labels. Never use a global
// "current app": independent windows can initialize concurrently.
export class MiniAppWindows {
  private static windows: Map<string, MiniAppWindow> = new Map();
  private static pending: Map<string, () => void> = new Map();
  static expects(label: string): boolean { return MiniAppWindows.pending.has(label) || MiniAppWindows.windows.has(label); }
  static hasWindows(): boolean { return MiniAppWindows.windows.size > 0; }
  static get(label: string): MiniAppWindow | undefined { return MiniAppWindows.windows.get(label); }
  static add(label: string, host: MiniAppWindow): void { MiniAppWindows.windows.set(label, host); }
  static remove(label: string): void { MiniAppWindows.windows.delete(label); }
  static contentReady(label: string, node: RustWebviewNodeController): void {
    const host = MiniAppWindows.windows.get(label);
    if (!host) {
      hilog.error(0, 'MiniAppDesktop', 'MiniApp page has no matching native container: %{public}s', label);
      return;
    }
    host.node = node;
    MiniAppWindows.pending.get(label)?.();
  }
  static attach(data: WebviewInitData): JsHelper | undefined {
    if (!data.webTag?.startsWith('miniapp-shell-')) return undefined;
    const host = MiniAppWindows.windows.get(data.webTag);
    if (!host?.node) throw new Error('MiniApp native container is not ready');
    const node = host.node;
    const result = node.addWebview(data);
    host.webview = result.controller;
    result.controller.dispose = () => { node.removeWebview(result.webTag); host.webview = null; };
    return result.controller;
  }
  private static async waitReady(label: string, start: () => Promise<void>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { MiniAppWindows.pending.delete(label); reject(new Error('MiniApp window did not initialize')); }, 10000);
      MiniAppWindows.pending.set(label, () => { clearTimeout(timer); MiniAppWindows.pending.delete(label); resolve(); });
      start().catch((error: Error) => { clearTimeout(timer); MiniAppWindows.pending.delete(label); reject(error); });
    });
  }
  static async setIcon(host: MiniAppWindow, icon: string): Promise<void> {
    if (Number(deviceInfo.sdkApiVersion) < 22) return;
    const file = fileIo.openSync(icon, fileIo.OpenMode.READ_ONLY);
    const source = image.createImageSource(file.fd);
    try {
      const pixels = await source.createPixelMap();
      try { await host.context.setMissionWindowIcon(pixels); }
      finally { pixels.release(); }
    } finally { source.release(); fileIo.closeSync(file); }
  }
  static async perform(context: common.UIAbilityContext, raw: string): Promise<string> {
    const request = JSON.parse(raw) as Operation;
    const ids = request.launchIds ?? [];
    if (request.action === 'shortcuts') return JSON.stringify({ paths: await MiniAppShortcuts.installed(ids) });
    if (request.action === 'unpin') {
      await MiniAppShortcuts.remove(context, ids);
      return JSON.stringify({ paths: await MiniAppShortcuts.installed(ids) });
    }
    if (request.action === 'pin') {
      if (!request.launchId || !request.title || !request.icon) throw new Error('Incomplete MiniApp shortcut request');
      await MiniAppShortcuts.pin(context, request.launchId, request.title, request.icon);
      return JSON.stringify({ path: request.title });
    }
    const label = request.label ?? '';
    if (!/^miniapp-shell-[0-9a-f-]{36}$/i.test(label)) throw new Error('Invalid MiniApp window identity');
    if (request.action === 'prepare') {
      if (!request.launchId || label !== 'miniapp-shell-' + request.launchId || !request.title || !request.icon) {
        throw new Error('Incomplete MiniApp window request');
      }
      MiniAppShortcuts.id(request.launchId);
      if (!MiniAppWindows.windows.has(label)) {
        await MiniAppWindows.waitReady(label, async () => {
          await context.startAbility({ bundleName: context.abilityInfo.bundleName, moduleName: context.abilityInfo.moduleName,
            abilityName: 'MiniAppAbility', parameters: { 'openbitfun.miniappLaunchId': request.launchId,
              'openbitfun.miniappTitle': request.title, 'openbitfun.miniappIcon': request.icon } });
        });
      }
      return '{}';
    }
    const host = MiniAppWindows.windows.get(label);
    if (!host) {
      if (request.action === 'destroy') return '{}';
      throw new Error('MiniApp window is not open');
    }
    const native = host.window;
    switch (request.action) {
      case 'show':
      case 'focus':
        if (native.getWindowStatus() === window.WindowStatusType.MINIMIZE) await native.restore();
        await native.showWindow();
        host.webview?.requestFocus();
        break;
      case 'destroy': await host.context.terminateSelf(); break;
      case 'windowState': break;
      case 'minimize': await native.minimize(); break;
      case 'fullscreen': throw new Error('Fullscreen is not supported by the HarmonyOS MiniApp window adapter');
      case 'maximize':
        if (native.getWindowStatus() === window.WindowStatusType.MAXIMIZE) await native.recover();
        else await native.maximize();
        break;
      case 'drag': await native.startMoving(); break;
      default: throw new Error('Unsupported MiniApp native window operation');
    }
    return JSON.stringify({ maximized: native.getWindowStatus() === window.WindowStatusType.MAXIMIZE, fullscreen: false });
  }
}
