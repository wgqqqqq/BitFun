import { webview } from '@kit.ArkWeb';
import { RemoteDesktopProbeViewModel } from '../viewmodel/RemoteDesktopProbeViewModel';
import { INK, PAGE_BG } from '../components/Theme';

class ProbeBridge {
  private receive: (raw: string) => void;
  constructor(receive: (raw: string) => void) { this.receive = receive; }
  postMessage(raw: string): void { this.receive(raw); }
}

/** Explicit developer launch only; bundled ArkWeb receiver, no account/runtime. */
@Entry
@ComponentV2
struct RemoteDesktopProbe {
  @Local model: RemoteDesktopProbeViewModel = new RemoteDesktopProbeViewModel();
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: ProbeBridge = new ProbeBridge((raw: string): void => this.model.receive(raw));
  aboutToDisappear(): void { this.model.close(); }
  build() {
    Column({ space: 8 }) {
      Text($r('app.string.remoteDesktopProbe_title')).fontColor(INK)
      Web({ src: $rawfile('remote-desktop-probe/index.html'), controller: this.controller })
        .javaScriptAccess(true).domStorageAccess(false).fileAccess(false).mediaPlayGestureAccess(false)
        .javaScriptProxy({ object: this.bridge, name: 'OpenBitFunProbeHost', methodList: ['postMessage'], controller: this.controller })
        .onPageEnd(() => {
          const key = AppStorage.get<string>('remoteDesktopProbeKey') || '';
          this.model.start(key,
            (config: string): Promise<void> => this.controller.runJavaScript(`window.OpenBitFunProbe.accept(${config})`).then(() => {}),
            (): void => { void this.controller.runJavaScript('window.OpenBitFunProbe.stop()').catch(() => {}); });
          void this.controller.runJavaScript('window.OpenBitFunProbe.reportCapabilities()').catch(() => {});
        })
        .onOverrideUrlLoading((request: WebResourceRequest): boolean => !request.getRequestUrl().startsWith('resource://rawfile/remote-desktop-probe/'))
        .layoutWeight(1).width('100%')
      Text(this.model.diagnostics).fontSize(12).fontColor(INK).maxLines(8).width('100%')
    }.padding({ top: 40, bottom: 30 }).width('100%').height('100%').backgroundColor(PAGE_BG)
  }
}
