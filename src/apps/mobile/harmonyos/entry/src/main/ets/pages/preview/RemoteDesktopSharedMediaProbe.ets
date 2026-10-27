import { RemoteDesktopMediaView } from '../components/RemoteDesktopMediaView';
import { INK, PAGE_BG } from '../components/Theme';
import { RemoteDesktopState } from '../state/RemoteDesktopState';
import { RemoteDesktopProbeViewModel } from '../viewmodel/RemoteDesktopProbeViewModel';
import { RemoteDesktopRendererStart } from '../../model/RemoteDesktopModels';

/** DEBUG launch only. Reuses the product renderer without account or input. */
@Entry
@ComponentV2
struct RemoteDesktopSharedMediaProbe {
  @Local model: RemoteDesktopProbeViewModel = new RemoteDesktopProbeViewModel();
  @Local media: RemoteDesktopState = new RemoteDesktopState();
  private lastCommand: string = '';
  aboutToAppear(): void {
    this.media.stage = 'connecting';
    this.model.start(AppStorage.get<string>('remoteDesktopProbeKey') || '',
      (raw: string): Promise<void> => {
        const command = JSON.parse(raw) as RemoteDesktopRendererStart;
        if ((command.kind === 'start' || command.kind === 'source_ready' || command.kind === 'stop')
          && raw !== this.lastCommand) {
          this.lastCommand = raw;
          if (!this.media.queueRenderer(raw, command.kind === 'stop')) this.model.close();
        }
        return Promise.resolve();
      },
      (): void => {
        this.media.queueRenderer('{"kind":"stop"}', true);
      });
  }
  aboutToDisappear(): void { this.model.close(); }
  build() {
    Column({ space: 8 }) {
      Text($r('app.string.remoteDesktopProbe_title')).fontColor(INK)
      RemoteDesktopMediaView({ state: this.media, onMessage: (raw: string): void => this.model.receive(raw) })
        .layoutWeight(1).width('100%')
      Text(this.model.diagnostics).fontSize(12).fontColor(INK).maxLines(8).width('100%')
    }.padding({ top: 40, bottom: 30 }).width('100%').height('100%').backgroundColor(PAGE_BG)
  }
}
