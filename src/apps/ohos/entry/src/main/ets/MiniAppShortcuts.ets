import { productViewManager } from '@kit.AppGalleryKit';
import { common, Want } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';

export class MiniAppShortcuts {
  static requireSupport(): void {
    if (Number(deviceInfo.sdkApiVersion) < 24) {
      throw new Error('MiniApp desktop shortcuts require HarmonyOS API 24 or later');
    }
  }
  static id(launchId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(launchId)) {
      throw new Error('Invalid MiniApp launch identity');
    }
    return 'openbitfun.miniapp.' + launchId;
  }
  static async installed(launchIds: string[]): Promise<string[]> {
    MiniAppShortcuts.requireSupport();
    const shortcuts = await productViewManager.getPinShortcutInfos();
    return launchIds.filter(id => shortcuts.some(shortcut => shortcut.shortcutId === MiniAppShortcuts.id(id)));
  }
  static async pin(context: common.UIAbilityContext, launchId: string, title: string, icon: string): Promise<void> {
    MiniAppShortcuts.requireSupport();
    const id = MiniAppShortcuts.id(launchId);
    if ((await MiniAppShortcuts.installed([launchId])).length) {
      // HarmonyOS has no in-place update API; each OS mutation remains consented.
      await productViewManager.removePinShortcut(context, id);
    }
    const want: Want = { bundleName: context.abilityInfo.bundleName, moduleName: context.abilityInfo.moduleName,
      abilityName: 'EntryAbility', parameters: { 'openbitfun.miniappLaunchId': launchId } };
    const checked = await productViewManager.checkPinShortcutPermitted(context, id, want, title.slice(0, 255), icon, '');
    if (checked.code !== 0 || !checked.tid) throw new Error('MiniApp shortcut check failed: ' + checked.code);
    await productViewManager.requestNewPinShortcut(context, checked.tid);
  }
  static async remove(context: common.UIAbilityContext, launchIds: string[]): Promise<void> {
    for (const id of await MiniAppShortcuts.installed(launchIds)) {
      await productViewManager.removePinShortcut(context, MiniAppShortcuts.id(id));
    }
  }
}
