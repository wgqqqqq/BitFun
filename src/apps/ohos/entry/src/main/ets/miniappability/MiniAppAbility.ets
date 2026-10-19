import { UIAbility, Want, AbilityConstant } from '@kit.AbilityKit';
import window from '@ohos.window';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { MiniAppWindow, MiniAppWindows } from '../MiniAppWindows';
import { MiniAppShortcuts } from '../MiniAppShortcuts';
import { miniAppWindowClosed } from 'libopenbitfun_desktop_lib.so';

// Only EntryAbility initializes NativeAbility/Rust. Each MiniApp owns a system
// task/window in the same process and delegates execution to that existing host.
interface MiniAppPageState { miniAppLabel: string; }
export default class MiniAppAbility extends UIAbility {
  private label: string = '';
  private title: string = '';
  private icon: string = '';
  private redirected: boolean = false;
  async onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): Promise<void> {
    const id = want.parameters?.['openbitfun.miniappLaunchId'];
    if (typeof id !== 'string') throw new Error('Missing MiniApp launch identity');
    MiniAppShortcuts.id(id);
    this.label = 'miniapp-shell-' + id;
    if (!MiniAppWindows.expects(this.label)) {
      // OS task restoration must bootstrap the one host before rendering.
      this.redirected = true;
      await this.context.startAbility({ bundleName: this.context.abilityInfo.bundleName, moduleName: this.context.abilityInfo.moduleName,
        abilityName: 'EntryAbility', parameters: { 'openbitfun.miniappLaunchId': id } });
      await this.context.terminateSelf();
      return;
    }
    this.title = String(want.parameters?.['openbitfun.miniappTitle'] ?? 'MiniApp');
    this.icon = String(want.parameters?.['openbitfun.miniappIcon'] ?? '');
  }
  async onWindowStageCreate(stage: window.WindowStage): Promise<void> {
    if (this.redirected) return;
    const native = await stage.getMainWindow();
    const host = new MiniAppWindow(this.context, native);
    MiniAppWindows.add(this.label, host);
    const state: MiniAppPageState = { miniAppLabel: this.label };
    await stage.loadContent('pages/MiniApp', new LocalStorage(state));
    // Window decoration APIs require UIContent to have been loaded first.
    native.setWindowDecorVisible(true);
    await native.setWindowTitle(this.title);
    await this.context.setMissionLabel(this.title);
    try { await MiniAppWindows.setIcon(host, this.icon); }
    catch (error) { hilog.warn(0, 'MiniAppDesktop', 'Mission icon update failed: %{public}s', String(error)); }
    hilog.info(0, 'MiniAppDesktop', 'MiniApp window created: %{public}s', this.label);
  }
  async onNewWant(_want: Want, _launchParam: AbilityConstant.LaunchParam): Promise<void> {
    await MiniAppWindows.get(this.label)?.window.showWindow();
  }
  onDestroy(): void {
    if (this.redirected) return;
    MiniAppWindows.remove(this.label);
    miniAppWindowClosed(this.label);
  }
}
