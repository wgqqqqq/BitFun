import { WindowChrome } from '../WindowChrome';
import { DefaultXComponent } from '@ohos-rs/ability';

@Entry
@Component
struct Index {
  build() {
    Column() {
      DefaultXComponent({ moduleName: 'openbitfun_desktop_lib', dedicatedWebview: WindowChrome.attach })
        .width('100%')
        .height('100%')
    }.width('100%').height('100%')
    .onTouch((event: TouchEvent) => WindowChrome.onTouch(event))
  }
}
