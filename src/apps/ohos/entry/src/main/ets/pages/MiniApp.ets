import { RustWebviewNodeController } from '@ohos-rs/ability';
import { MiniAppWindows } from '../MiniAppWindows';
@Entry({ useSharedStorage: true })
@Component
struct MiniApp {
  @LocalStorageProp('miniAppLabel') label: string = '';
  private controller: RustWebviewNodeController = new RustWebviewNodeController(this.getUIContext());
  aboutToAppear(): void { MiniAppWindows.contentReady(this.label, this.controller); }
  build() {
    Stack() { NodeContainer(this.controller).width('100%').height('100%') }.width('100%').height('100%')
  }
}
