import { bundleManager, common } from '@kit.AbilityKit';

@Entry
@Component
struct TrayPanel {
  build() {
    Row() {
      Button('OpenBitFun').onClick(async () => {
        const context = this.getUIContext().getHostContext() as common.UIExtensionContext;
        const bundleName = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT).name;
        await context.startAbility({ bundleName, abilityName: 'EntryAbility' });
      })
    }.width('100%').height('100%').justifyContent(FlexAlign.Center)
  }
}
