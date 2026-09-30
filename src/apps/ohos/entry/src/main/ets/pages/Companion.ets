import { RustWebviewNodeController } from '@ohos-rs/ability';
import { CompanionContent, CompanionWindow } from '../CompanionWindow';

@Entry
@Component
struct Companion {
  private controller: RustWebviewNodeController = new RustWebviewNodeController(this.getUIContext());
  aboutToAppear(): void { CompanionContent.controller = this.controller; CompanionContent.onReady?.(); }
  aboutToDisappear(): void {
    if (CompanionContent.controller === this.controller) CompanionContent.controller = null;
  }
  build() {
    Stack() {
      NodeContainer(this.controller).width('100%').height('100%')
    }.width('100%').height('100%').backgroundColor(Color.Transparent)
    .onTouch((event: TouchEvent) => CompanionWindow.observeTouch(event))
  }
}
