import { webview } from '@kit.ArkWeb';
import { RemoteDesktopRendererStart, RemoteDesktopRendererEvent } from '../../model/RemoteDesktopModels';
import { RemoteDesktopState } from '../state/RemoteDesktopState';
import { MEDIA_BACKGROUND } from './Theme';
import { RemoteDesktopScreenshotService } from '../../services/RemoteDesktopScreenshotService';

class DesktopNativeBridge {
  private readonly receive: (raw: string) => void;
  constructor(receive: (raw: string) => void) { this.receive = receive; }
  postMessage(raw: string): void { this.receive(raw); }
}
/** Platform leaf: owns only the fixed bundled WebView and its narrow bridge. */
@ComponentV2
export struct RemoteDesktopMediaView {
  @Param state: RemoteDesktopState = new RemoteDesktopState();
  @Event onMessage: (raw: string) => void = (_raw: string) => {};
  @Param screenshotRequest: number = 0;
  @Event onScreenshot: (path: string) => void = (_path: string): void => {};
  private controller: webview.WebviewController = new webview.WebviewController();
  private active: boolean = true;
  private bridgeReady: boolean = false;
  private flushing: boolean = false;
  private binding?: RemoteDesktopRendererStart;
  private bridge: DesktopNativeBridge = new DesktopNativeBridge((raw: string): void => {
    if (!this.active) return;
    // Additive capabilities must not turn a valid bundled ready into a stalled
    // queue. The service owns capability negotiation; this leaf only flushes.
    if (raw.length <= 96 * 1024) {
      try {
        const event: RemoteDesktopRendererEvent = JSON.parse(raw) as RemoteDesktopRendererEvent;
        if (event?.kind === 'bridge_ready') { this.bridgeReady = true; void this.flush(); }
      } catch (_error) { /* The service rejects malformed reports. */ }
    }
    this.onMessage(raw);
  });
  @Monitor('state.rendererVersion')
  private changed(): void { void this.flush(); }
  @Monitor('screenshotRequest')
  private async capture(): Promise<void> {
    if (this.screenshotRequest <= 0) return;
    const renderer = this.binding?.renderer_id, request = this.screenshotRequest;
    const current = (): boolean => this.active && request === this.screenshotRequest && !!renderer &&
      this.binding?.renderer_id === renderer && this.state.rendererId === renderer &&
      this.state.stage === 'observing' && !this.state.signalingInterrupted;
    try {
      const context = this.getUIContext().getHostContext();
      if (!context || !current()) throw new Error('capture_unavailable');
      const path = await RemoteDesktopScreenshotService.capture(context,
        (): Promise<string> => this.controller.runJavaScript(`window.OpenBitFunDesktopReceiver.capture(${JSON.stringify(renderer)})`), current);
      if (current()) this.onScreenshot(path);
      else await RemoteDesktopScreenshotService.discard(path);
    } catch (_error) { if (this.active) this.onScreenshot(''); }
  }
  private async flush(): Promise<void> {
    if (!this.active || !this.bridgeReady || this.flushing) return;
    this.flushing = true;
    try {
      let command = this.state.rendererQueue.take();
      while (this.active && command !== undefined) {
        const binding: RemoteDesktopRendererStart = JSON.parse(command) as RemoteDesktopRendererStart;
        if (binding.kind === 'start') this.binding = binding;
        try {
          await this.controller.runJavaScript(`window.OpenBitFunDesktopReceiver.accept(${command}); void 0`);
        } catch (_error) {
          this.state.rendererQueue.clear();
          this.onMessage(JSON.stringify({ kind: 'bridge_failed', renderer_id: this.binding?.renderer_id,
            attach_id: this.binding?.attach_id, connection_id: this.binding?.connection_id }));
          return;
        }
        command = this.state.rendererQueue.take();
      }
    } finally { this.flushing = false; }
  }
  aboutToDisappear(): void {
    this.active = false;
    this.state.rendererQueue.clear();
    this.onMessage(JSON.stringify({ kind: 'bridge_closed', renderer_id: this.binding?.renderer_id,
      attach_id: this.binding?.attach_id, connection_id: this.binding?.connection_id }));
    void this.controller.runJavaScript('window.OpenBitFunDesktopReceiver.stop()').catch(() => {});
  }
  build() {
    Web({ src: $rawfile('remote-desktop/index.html'), controller: this.controller })
      .backgroundColor(MEDIA_BACKGROUND)
      .javaScriptAccess(true).domStorageAccess(false).fileAccess(false).mediaPlayGestureAccess(false)
      .javaScriptProxy({ object: this.bridge, name: 'OpenBitFunDesktopHost', methodList: ['postMessage'], controller: this.controller })
      .onOverrideUrlLoading((request: WebResourceRequest): boolean => {
        const url = request.getRequestUrl();
        return url !== 'resource://rawfile/remote-desktop/index.html' && url !== 'resource:/RAWFILE/remote-desktop/index.html';
      })
      .opacity(this.state.stage === 'connecting' || this.state.stage === 'observing' ? 1 : 0)
      .width('100%').height('100%')
  }
}
