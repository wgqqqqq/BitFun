import { RemoteDesktopPanel } from '../components/RemoteDesktopPanel';
import { RemoteDesktopActions, RemoteDesktopState } from '../state/RemoteDesktopState';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { INK, PAGE_BG, SOFT } from '../components/Theme';
import { REMOTE_DESKTOP_QUALITIES, RemoteDesktopInput, RemoteDesktopRendererEvent, RemoteDesktopDisplay } from '../../model/RemoteDesktopModels';
import { RemoteDesktopKeyboardService } from '../../services/RemoteDesktopKeyboardService';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';

/** Native layout/bridge fixture only. No account, TURN credential or remote pixels. */
@ComponentV2
export struct RemoteDesktopPreview {
  @Local state: RemoteDesktopState = this.makeState();
  @Local compact: boolean = false;
  @Local paneWidth: number = 0;
  @Local paneHeight: number = 0;
  @Local bridgeCount: number = 0;
  @Local closedCount: number = 0;
  @Local selected: string = '';
  @Local inputCount: number = 0;
  @Local textCount: number = 0;
  @Local textUnits: number = 0;
  @Local keyDowns: number = 0;
  @Local keyUps: number = 0;
  @Local lastUsage: number = 0;
  @Local leftDowns: number = 0;
  @Local leftUps: number = 0;
  @Local pointerMoves: number = 0;
  @Local pointerX: number = 0;
  @Local pointerY: number = 0;
  @Local shortViewport: boolean = false;
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();
  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext();
    if (context) this.insets.bind(this.getUIContext(), context);
  }
  aboutToDisappear(): void { this.insets.unbind(); }
  private readonly actions: RemoteDesktopActions = {
    reconnect: (): void => { this.state.canReconnect = false; this.state.stage = 'choose_display'; },
    pauseSource: (): void => { this.actions.releaseControl(); this.state.stage = 'paused'; this.state.queueRenderer('{"kind":"stop"}', true); },
    resumeSource: (): void => { this.state.rendererId += '-resumed'; this.state.stage = 'observing'; },
    chooseSource: (): void => { this.state.stage = 'choose_source'; },
    cancelSourceChoice: (): void => { this.state.stage = 'paused'; },
    setQuality: (quality: string): void => {
      if (this.state.stage === 'paused' && REMOTE_DESKTOP_QUALITIES.includes(quality)) this.state.quality = quality;
    },
    selectSource: (displayId: string): void => {
      const display = this.state.displays.find((item: RemoteDesktopDisplay): boolean => item.display_id === displayId);
      if (!display) return;
      this.state.selectedDisplayId = displayId; this.selected = `${displayId}:${this.state.forceRelay}`;
      this.state.videoWidth = display.width; this.state.videoHeight = display.height;
      this.actions.resumeSource();
    },
    toggleDirectTouch: (): void => { this.actions.releaseControl(); this.state.directTouch = !this.state.directTouch; },
    togglePan: (): void => { this.actions.releaseControl(); this.state.panMode = !this.state.panMode; },
    acquireControl: (): void => { this.state.controlError = ''; this.state.controlState = 'controlling'; this.state.controlGeneration = '1'; },
    releaseControl: (reason?: 'input_suspended'): void => {
      this.state.controlState = 'viewing'; this.state.controlGeneration = '';
      if (reason) this.state.controlError = reason;
    },
    input: (message: RemoteDesktopInput): void => {
      RemoteDesktopKeyboardService.beforePointer(message);
      this.inputCount++;
      if (message.kind === 'text_commit') { this.textCount++; this.textUnits += message.body.text?.length || 0; }
      if (message.kind === 'key') {
        if (message.body.down) this.keyDowns++; else this.keyUps++;
        this.lastUsage = message.body.usage || 0;
      }
      if (message.kind === 'pointer_move') this.pointerMoves++;
      if (message.kind === 'pointer_button' && message.body.button === 'left') {
        if (message.body.x !== undefined && message.body.y !== undefined) {
          this.pointerX = Math.round(message.body.x * 1000); this.pointerY = Math.round(message.body.y * 1000);
        }
        if (message.body.down === true) this.leftDowns++;
        if (message.body.down === false) this.leftUps++;
      }
    },
    close: (): void => {
      this.state.queueRenderer('{"kind":"stop"}', true);
      this.state.visible = false;
    },
    attach: (displayId: string, forceRelay: boolean): void => { this.selected = `${displayId}:${forceRelay}`; },
    receive: (raw: string): void => {
      const event = JSON.parse(raw) as RemoteDesktopRendererEvent;
      if (event.kind === 'bridge_ready') this.bridgeCount++;
      if (event.kind === 'bridge_closed') this.closedCount++;
    }
  };
  private makeState(): RemoteDesktopState {
    const state = new RemoteDesktopState();
    state.rendererId = 'preview'; state.videoWidth = 1280; state.videoHeight = 830;
    state.selectedDisplayId = 'display-a';
    state.visible = true; state.stage = 'choose_display'; state.deviceName = 'Preview computer';
    state.displays = [{ display_id: 'display-a', width: 1280, height: 830 }, { display_id: 'display-b', width: 1920, height: 1080 }];
    return state;
  }
  build() {
    Column() {
      Row({ space: 8 }) {
        Button('Resize').fontSize(12).height(28).padding({ left: 8, right: 8 })
          .id('rd-preview-resize').onClick((): void => { this.compact = !this.compact; })
        Button('Control').fontSize(12).height(28).padding({ left: 8, right: 8 }).id('rd-preview-control').onClick((): void => {
          this.state.stage = 'observing'; this.state.controlSupported = true; this.state.textSupported = true;
          this.state.sourceLifecycleSupported = true;
          this.state.qualitySupported = true;
        })
        Button('Permission').fontSize(12).height(28).padding({ left: 8, right: 8 }).id('rd-preview-permission').onClick((): void => {
          this.state.stage = 'failed'; this.state.errorCode = 'device_approval_required'; this.state.canReconnect = true;
        })
      }.visibility(this.shortViewport ? Visibility.None : Visibility.Visible)
      Text(`bridge=${this.bridgeCount} closed=${this.closedCount} selected=${this.selected} width=${this.paneWidth} height=${this.paneHeight} inputs=${this.inputCount} control=${this.state.controlState} left=${this.leftDowns}:${this.leftUps} moves=${this.pointerMoves} point=${this.pointerX}:${this.pointerY} text=${this.textCount}:${this.textUnits} keys=${this.keyDowns}:${this.keyUps} usage=${this.lastUsage}`)
        .fontColor(INK).fontSize(MobileDesignTypography.bodySmall.size).id('rd-preview-diagnostics')
        .visibility(this.shortViewport ? Visibility.None : Visibility.Visible)
      if (this.state.visible) {
        RemoteDesktopPanel({ state: this.state, actions: this.actions })
          .width(this.compact ? 320 : '100%').layoutWeight(1).id('rd-preview-pane')
          .onAreaChange((_old: Area, area: Area): void => {
            this.paneWidth = Math.round(Number(area.width)); this.paneHeight = Math.round(Number(area.height));
          })
      } else {
        Text('Stopped').fontColor(INK).id('rd-preview-stopped')
      }
    }.padding({ top: this.insets.top + 8, bottom: 8 }).width('100%').height('100%').backgroundColor(PAGE_BG)
      .onAreaChange((_old: Area, area: Area): void => { this.shortViewport = Number(area.height) > 0 && Number(area.height) < 240; })
  }
}
