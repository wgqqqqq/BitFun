import { CompanionWindow } from '../CompanionWindow';
import { WindowChrome } from '../WindowChrome';
import { registerCompanionOperation } from 'libopenbitfun_desktop_lib.so';
import { TrayManager } from '../TrayManager';
import { NativeAbility } from '@ohos-rs/ability';
import { AbilityConstant, Want } from '@kit.AbilityKit';
import window from '@ohos.window';
import resourceManager from '@ohos.resourceManager';
import { deviceInfo, settings } from '@kit.BasicServicesKit';
import { WorkspaceAccess } from '../WorkspaceAccess';
import { registerTrayOperation, registerExternalUrlOpener, configureDataDirectory, configureDeviceDisplayName, configureSystemDarkMode, configureResourceDirectory, configureTerminalDiagnostics, configureWorkspaceAccessDiagnostics, registerWorkspaceAccess, registerWindowOperation } from 'libopenbitfun_desktop_lib.so';

// The library is built from this repository's src/apps/desktop.
export default class EntryAbility extends NativeAbility {
  public moduleName: string = 'openbitfun_desktop_lib';
  public defaultPage: boolean = false;
  private mainWindow: window.Window | null = null;
  private companion: CompanionWindow | null = null;

  async onDestroy(): Promise<void> {
    WindowChrome.dispose();
    try { await this.companion?.perform(JSON.stringify({ action: 'destroy' })); }
    finally { await super.onDestroy(); }
  }

  async onWindowStageCreate(stage: window.WindowStage): Promise<void> {
    this.mainWindow = await stage.getMainWindow();
    await super.onWindowStageCreate(stage);
    await stage.loadContent('pages/Index');
    WindowChrome.configure(this.mainWindow);
  }

  onNewWant(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.mainWindow?.showWindow().catch(() => console.error('Could not restore main window'));
  }

  async onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): Promise<void> {
    configureDataDirectory(this.context.filesDir);
    let deviceName: string = '';
    try {
      deviceName = settings.getValueSync(this.context, settings.general.DEVICE_NAME, '').trim();
    } catch (_) {
      // Some PC images do not expose a user-configured Settings device name.
    }
    if (deviceName.toLowerCase() === 'localhost') deviceName = '';
    configureDeviceDisplayName(deviceName || deviceInfo.marketName || deviceInfo.productModel || 'HarmonyOS PC');
    const companion = new CompanionWindow(this.context);
    this.companion = companion;
    registerCompanionOperation(async (error: Error | null, request: string): Promise<string> => {
      if (error) throw new Error('Companion bridge failed');
      return companion.perform(request);
    });
    const tray = new TrayManager(this.context);
    registerTrayOperation(async (error: Error | null, action: string): Promise<boolean> => {
      if (error) throw new Error('Tray bridge failed');
      return tray.perform(action);
    });
    registerExternalUrlOpener(async (error: Error | null, url: string): Promise<boolean> => {
      if (error) throw new Error('System browser bridge failed');
      await this.context.openLink(url, { appLinkingOnly: false });
      return true;
    });
    configureTerminalDiagnostics(want.parameters?.['openbitfun.terminalDiagnostic'] === true);
    const workspaceAccess = new WorkspaceAccess(this.context);
    registerWorkspaceAccess(async (error: Error | null, request: string): Promise<string> => {
      if (error) throw new Error('Workspace access bridge failed');
      return workspaceAccess.perform(request);
    });
    configureWorkspaceAccessDiagnostics(want.parameters?.['openbitfun.workspaceAccessDiagnostic'] === true);
    // Before the product runtime starts: child processes inherit only the grants
    // this process already holds, so authorized workspaces must be live by now.
    await workspaceAccess.activateRemembered();
    configureResourceDirectory(this.context.resourceDir);
    const resourceConfiguration = await this.context.resourceManager.getConfiguration();
    configureSystemDarkMode(resourceConfiguration.colorMode === resourceManager.ColorMode.DARK);
    registerWindowOperation(async (error: Error | null, action: string): Promise<boolean> => {
      if (error) throw error;
      const mainWindow = this.mainWindow;
      if (!mainWindow) throw new Error('Native main window is not ready');
      const status = mainWindow.getWindowStatus();
      if (status === window.WindowStatusType.UNDEFINED) {
        throw new Error('Native window status is unavailable');
      }
      switch (action) {
        case 'get_state': break;
        case 'toggle_maximize':
          if (status === window.WindowStatusType.MAXIMIZE) {
            await mainWindow.recover();
          } else {
            await mainWindow.maximize();
          }
          break;
        case 'minimize': await mainWindow.minimize(); break;
        case 'maximize': await mainWindow.maximize(); break;
        case 'show':
          if (status === window.WindowStatusType.MINIMIZE) await mainWindow.restore();
          else await mainWindow.showWindow();
          break;
        default: throw new Error('Unsupported native window operation: ' + action);
      }
      return mainWindow.getWindowStatus() === window.WindowStatusType.MAXIMIZE;
    });
    await super.onCreate(want, launchParam);
  }
}
