import { common } from '@kit.AbilityKit';

@Entry
@Component
struct TrayPanel {
  build() {
    Row() {
      Button('OpenBitFun').onClick(async () => {
        const context = this.getUIContext().getHostContext() as common.UIExtensionContext;
        await context.startAbility({ bundleName: 'com.openbitfun.desktop', abilityName: 'EntryAbility' });
      })
    }.width('100%').height('100%').justifyContent(FlexAlign.Center)
  }
}
