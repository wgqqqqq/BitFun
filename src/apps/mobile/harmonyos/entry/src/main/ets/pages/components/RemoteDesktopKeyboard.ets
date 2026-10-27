import { RemoteDesktopActions, RemoteDesktopState, emptyRemoteDesktopActions } from '../state/RemoteDesktopState';
import { RemoteDesktopKeyboardService } from '../../services/RemoteDesktopKeyboardService';
import { RemoteDesktopInput } from '../../model/RemoteDesktopModels';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { CONTENT_ON_ACTION, MEDIA_SCRIM, MUTED, TRANSPARENT } from './Theme';

/** Virtual remote keyboard: confirmed IME input goes to the remote focus. */
@ComponentV2
export struct RemoteDesktopKeyboard {
  @Param state: RemoteDesktopState = new RemoteDesktopState();
  @Param actions: RemoteDesktopActions = emptyRemoteDesktopActions();
  @Param shortViewport: boolean = false;
  @Param isRequested: () => boolean = (): boolean => false;
  @Event onUnavailable: () => void = (): void => {};
  @Event onHidden: () => void = (): void => {};
  private keyboard: RemoteDesktopKeyboardService | undefined = undefined;
  private timer: number = -1;
  private active: boolean = false;
  aboutToAppear(): void { this.active = true; }
  aboutToDisappear(): void {
    this.active = false; this.retire();
  }
  private retire(): void {
    clearTimeout(this.timer); this.timer = -1;
    const keyboard = this.keyboard; this.keyboard = undefined; keyboard?.close();
  }
  private open(): void {
    this.retire();
    // Capture the initiating authority before yielding to the UI queue.
    const renderer = this.state.rendererId; const generation = this.state.controlGeneration;
    const textSupported = this.state.textSupported;
    const current = (): boolean => this.active && this.isRequested() && this.state.stage === 'observing' &&
      this.state.controlState === 'controlling' && !this.state.signalingInterrupted &&
      renderer.length > 0 && generation.length > 0 &&
      this.state.rendererId === renderer && this.state.controlGeneration === generation;
    const timer = setTimeout((): void => {
      if (this.timer !== timer || !current()) return;
      try {
        const keyboard: RemoteDesktopKeyboardService = new RemoteDesktopKeyboardService(renderer, generation, {
          input: (input: RemoteDesktopInput): void => {
            if (current() && this.keyboard === keyboard) this.actions.input(input);
          },
          unavailable: (): void => {
            if (current() && this.keyboard === keyboard) this.onUnavailable();
          }
        }, (): void => { if (current() && this.keyboard === keyboard) this.onHidden(); });
        this.keyboard = keyboard; keyboard.open(textSupported);
      } catch (_error) {
        console.warn('Remote desktop keyboard initialization failed');
        if (this.timer === timer && current()) { this.retire(); this.onUnavailable(); }
      }
    }, 80);
    this.timer = timer;
  }
  @Builder private Key(label: string, usage: number) {
    Button(label).backgroundColor(TRANSPARENT).fontColor(CONTENT_ON_ACTION).height(44).width(usage === 40 ? 56 : 44).padding(0)
      .fontSize(MobileDesignTypography.bodySmall.size).borderRadius(22)
      .focusOnTouch(false)
      .onClick((): void => this.keyboard?.key(usage))
  }
  build() {
    Column({ space: 4 }) {
      Scroll() {
        Row({ space: 4 }) {
          this.Key('⌫', 42); this.Key('Enter', 40); this.Key('Esc', 41); this.Key('Tab', 43)
          this.Key('←', 80); this.Key('↑', 82); this.Key('↓', 81); this.Key('→', 79)
        }
      }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).width('100%').height(44)
        .backgroundColor(MEDIA_SCRIM).border({ width: 0.5, color: MUTED }).borderRadius(22).clip(true).id('rd-special-keys')
    }.width('100%').id('rd-virtual-keyboard')
      .enabled(this.state.controlState === 'controlling').onAppear((): void => this.open())
  }
}
