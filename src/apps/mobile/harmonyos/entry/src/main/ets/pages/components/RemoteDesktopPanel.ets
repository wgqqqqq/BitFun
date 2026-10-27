import { KeyboardAvoidMode } from '@kit.ArkUI';
import { WindowInsetsBinding, WindowSystemBarService } from '../../services/WindowSystemBarService';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteDesktopActions, RemoteDesktopState, emptyRemoteDesktopActions } from '../state/RemoteDesktopState';
import { REMOTE_DESKTOP_QUALITIES, RemoteDesktopDisplay } from '../../model/RemoteDesktopModels';
import { RemoteDesktopKeyboard } from './RemoteDesktopKeyboard';
import { RemoteDesktopScreenshotPreview } from './RemoteDesktopScreenshotPreview';
import { RemoteDesktopViewport } from './RemoteDesktopViewport';
import { RemoteDesktopOrientationService } from '../../services/RemoteDesktopOrientationService';
import { TemplateIcon } from './TemplateIcon';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CARD, CONTENT_ON_ACTION, INK, MEDIA_BACKGROUND, MEDIA_SCRIM, MUTED, SOFT, STATUS_DANGER, STATUS_SUCCESS, TRANSPARENT } from './Theme';

@ComponentV2
export struct RemoteDesktopPanel {
  @Param state: RemoteDesktopState = new RemoteDesktopState();
  @Param actions: RemoteDesktopActions = emptyRemoteDesktopActions();
  @Local shortViewport: boolean = false;
  @Local forceRelay: boolean = false;
  @Local keyboardOpen: boolean = false;
  @Local keyboardRequest: number = 0;
  @Local screenshotRequest: number = 0;
  @Local screenshotBusy: boolean = false;
  @Local screenshotPath: string = '';
  @Local screenshotFailed: boolean = false;
  @Local optionsOpen: boolean = false;
  @Local keyboardUnavailable: boolean = false;
  @Local rotating: boolean = false;
  @Local rotationUnavailable: boolean = false;
  @Local viewportHeight: number = 0;
  @Local viewportTop: number = 0;
  @Local moreTop: number = 0;
  @Local moreBottom: number = 0;
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();
  private releaseMediaAppearance: () => void = (): void => {};
  private previousKeyboardAvoidMode: KeyboardAvoidMode = KeyboardAvoidMode.OFFSET;
  private orientation: RemoteDesktopOrientationService = new RemoteDesktopOrientationService();
  private active: boolean = false;
  aboutToAppear(): void {
    this.active = true;
    this.orientation = new RemoteDesktopOrientationService();
    this.rotating = false; this.rotationUnavailable = false;
    this.releaseMediaAppearance = WindowSystemBarService.retainMediaAppearance();
    this.previousKeyboardAvoidMode = this.getUIContext().getKeyboardAvoidMode();
    this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE);
    const context = this.getUIContext().getHostContext();
    if (context) this.insets.bind(this.getUIContext(), context);
  }
  aboutToDisappear(): void {
    this.active = false; this.orientation.close();
    this.releaseMediaAppearance(); this.insets.unbind(); this.getUIContext().setKeyboardAvoidMode(this.previousKeyboardAvoidMode);
  }
  @Monitor('state.controlState', 'state.controlGeneration', 'state.rendererId', 'state.stage', 'state.signalingInterrupted')
  private authorityChanged(): void {
    this.keyboardOpen = false; this.optionsOpen = false;
  }
  private async rotateScreen(): Promise<void> {
    if (this.rotating) return;
    this.optionsOpen = false; this.keyboardOpen = false; this.rotationUnavailable = false;
    this.actions.releaseControl();
    const context = this.getUIContext().getHostContext();
    if (!context) { this.rotationUnavailable = true; return; }
    this.rotating = true;
    const owner = this.orientation;
    const rotated = await owner.rotate(context);
    if (!this.active || owner !== this.orientation) return;
    this.rotating = false; this.rotationUnavailable = !rotated;
  }

  @Builder private MoreOptions() {
    Scroll() {
      Column({ space: 8 }) {
      if (this.state.stage === 'observing') {
        if (this.state.controlSupported && this.state.controlState !== 'acquiring') {
          Button(RemoteI18n.t(this.state.controlState === 'controlling' ? 'remoteDesktop.stopControl' : 'remoteDesktop.resumeControl'))
            .backgroundColor(SOFT).fontColor(INK).width('100%').enabled(!this.state.signalingInterrupted)
            .onClick((): void => {
              this.optionsOpen = false;
              if (this.state.controlState === 'controlling') this.actions.releaseControl();
              else this.actions.acquireControl();
            })
        }
        Text(RemoteI18n.t(this.state.controlSupported ? 'remoteDesktop.tapHint' : 'remoteDesktop.controlUnsupported')).fontColor(MUTED)
          .fontSize(MobileDesignTypography.bodySmall.size).width('100%')
        if (this.state.controlSupported && !this.state.textSupported) {
          Text(RemoteI18n.t('remoteDesktop.textUnsupported')).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size)
        }
        Button(RemoteI18n.t(this.state.directTouch ? 'remoteDesktop.mouseMode' : 'remoteDesktop.directTouch'))
          .backgroundColor(SOFT).fontColor(INK).width('100%').onClick((): void => {
            this.optionsOpen = false; this.actions.toggleDirectTouch();
          })
        Button(RemoteI18n.t(this.state.panMode ? 'remoteDesktop.stopPanning' : 'remoteDesktop.panCanvas'))
          .backgroundColor(SOFT).fontColor(INK).width('100%').onClick((): void => {
            this.optionsOpen = false; this.actions.togglePan();
          })
        Button(RemoteI18n.t('remoteDesktop.rotateScreen')).backgroundColor(SOFT).fontColor(INK).width('100%')
            .id('rd-rotate-screen').enabled(!this.rotating).onClick((): void => { void this.rotateScreen(); })
        if (this.state.sourceLifecycleSupported) {
          Button(RemoteI18n.t('remoteDesktop.pauseSource')).backgroundColor(SOFT).fontColor(INK).width('100%')
            .id('rd-pause-source').enabled(!this.state.signalingInterrupted).onClick((): void => {
              this.optionsOpen = false; this.keyboardOpen = false; this.actions.pauseSource();
            })
        }
      }
      Button(RemoteI18n.t('remoteDesktop.disconnect')).backgroundColor(SOFT).fontColor(INK).width('100%')
        .onClick((): void => { this.optionsOpen = false; this.actions.close(); })
      }.padding(12).width('100%')
    }.width(240).constraintSize({ maxHeight: Math.max(44, this.shortViewport
      ? this.moreTop - this.viewportTop - this.insets.top - 24
      : this.viewportHeight - (this.moreBottom - this.viewportTop) - this.insets.bottom - 24) })
      .scrollBar(BarState.Auto).backgroundColor(CARD).borderRadius(16).clip(true).id('rd-more-scroll')
  }

  @Builder private MoreButton() {
    Button() {
      TemplateIcon({ src: $r('app.media.remote_ref_more'), iconWidth: 20, iconHeight: 6, tint: CONTENT_ON_ACTION })
    }.width(44).height(44).padding(0).backgroundColor(MEDIA_SCRIM).borderRadius(22)
      .border({ width: 0.5, color: MUTED })
      .accessibilityText(RemoteI18n.t('sidebar.more')).id('rd-more-options')
      .onAreaChange((_old: Area, area: Area): void => {
        this.moreTop = Number(area.globalPosition.y); this.moreBottom = this.moreTop + Number(area.height);
      })
      .bindPopup(this.optionsOpen, {
        builder: (): void => this.MoreOptions(), placement: this.shortViewport ? Placement.TopRight : Placement.BottomRight,
        popupColor: TRANSPARENT, enableArrow: false, autoCancel: true, mask: false, targetSpace: 8,
        onStateChange: (event) => { this.optionsOpen = event.isVisible; }
      })
      .onClick((): void => { this.optionsOpen = !this.optionsOpen; })
  }
  @Builder private Header() {
    Stack({ alignContent: Alignment.Center }) {
      Row() {
        Button() {
          TemplateIcon({ src: $r('app.media.settings_close_x'), iconWidth: 16, iconHeight: 16, tint: CONTENT_ON_ACTION })
        }.width(44).height(44).padding(0).backgroundColor(MEDIA_SCRIM).borderRadius(22)
          .border({ width: 0.5, color: MUTED }).accessibilityText(RemoteI18n.t('remoteDesktop.disconnect'))
          .onClick((): void => this.actions.close())
        Blank()
        this.MoreButton()
      }.width('100%')
      Row({ space: 7 }) {
        TemplateIcon({ src: $r('app.media.sidebar_device_desktop'), iconWidth: 17, iconHeight: 17, tint: CONTENT_ON_ACTION })
        Text(this.state.deviceName).fontColor(CONTENT_ON_ACTION).fontSize(MobileDesignTypography.bodySmall.size)
          .fontWeight(FontWeight.Medium).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
        Circle().width(5).height(5).fill(this.state.stage !== 'observing' ? MUTED : this.state.controlState === 'controlling' ? STATUS_SUCCESS : CONTENT_ON_ACTION)
      }.padding({ left: 12, right: 12 }).height(36).width('60%').constraintSize({ maxWidth: 320 })
        .backgroundColor(MEDIA_SCRIM).border({ width: 0.5, color: MUTED }).borderRadius(18)
        .accessibilityText(this.state.stage === 'observing'
          ? this.state.controlState === 'controlling' ? `${this.state.deviceName}, ${RemoteI18n.t('remoteDesktop.controlling')}` : this.state.deviceName
          : `${this.state.deviceName}, ${RemoteI18n.t(`remoteDesktop.stage.${this.state.stage}`)}`)
    }.padding({ left: 16, right: 16, top: 6, bottom: 6 }).height(56).width('100%').flexShrink(0).id('rd-header')
  }
  @Builder private ControlDock() {
    Row({ space: 12 }) {
      if (this.state.controlState === 'controlling') {
        Text(RemoteI18n.t('remoteDesktop.controlling'))
          .fontColor(CONTENT_ON_ACTION).opacity(0.7).fontSize(MobileDesignTypography.bodySmall.size)
      }
      Blank()
      Row({ space: 8 }) {
      Button() {
        TemplateIcon({ src: $r('app.media.remote_desktop_screenshot'), iconWidth: 22, iconHeight: 22, tint: CONTENT_ON_ACTION })
      }.width(52).height(44).padding(0).backgroundColor(MEDIA_SCRIM).borderRadius(22)
        .border({ width: 0.5, color: MUTED }).id('rd-screenshot-button')
        .accessibilityText(RemoteI18n.t('remoteDesktop.screenshot'))
        .enabled(!this.screenshotBusy && !this.state.signalingInterrupted)
        .onClick((): void => {
          this.keyboardOpen = false; this.optionsOpen = false;
          this.screenshotFailed = false; this.screenshotBusy = true; this.screenshotRequest++;
        })
      Button() {
        SymbolGlyph(this.keyboardOpen ? $r('sys.symbol.chevron_down') : $r('sys.symbol.keyboard'))
          .fontSize(22).fontColor([CONTENT_ON_ACTION])
      }.width(52).height(44).padding(0).backgroundColor(MEDIA_SCRIM).borderRadius(22)
        .border({ width: 0.5, color: MUTED }).id('rd-keyboard-toggle')
        .accessibilityText(RemoteI18n.t(this.keyboardOpen ? 'remoteDesktop.hideKeyboard' : 'remoteDesktop.keyboard'))
        .enabled(this.state.controlState === 'controlling').opacity(this.state.controlState === 'controlling' ? 1 : 0.4)
        .onClick((): void => {
          this.optionsOpen = false; this.keyboardUnavailable = false;
          this.keyboardRequest++; this.keyboardOpen = !this.keyboardOpen;
        })
      }.height(44).flexShrink(0)
      if (this.shortViewport) this.MoreButton()
    }.padding({ left: 16, right: 16, top: 4, bottom: 4 })
      .width(this.keyboardOpen ? this.shortViewport ? 300 : 232 : '100%').height(52).flexShrink(0).id('rd-control-dock')
  }
  @Builder private ScreenshotPreview() {
    RemoteDesktopScreenshotPreview({ path: this.screenshotPath, onClose: (): void => { this.screenshotPath = ''; } })
  }

  private qualityLabel(quality: string): string {
    return RemoteI18n.t(quality === 'data_saver' ? 'remoteDesktop.qualityDataSaver'
      : quality === 'balanced' ? 'remoteDesktop.qualityBalanced' : 'remoteDesktop.qualityClear');
  }
  @Builder private QualityOptions() {
    Column({ space: 8 }) {
      Text(RemoteI18n.f('remoteDesktop.currentQuality', this.qualityLabel(this.state.quality)))
        .fontColor(CONTENT_ON_ACTION).fontSize(MobileDesignTypography.bodySmall.size).id('rd-quality-current')
      ForEach(REMOTE_DESKTOP_QUALITIES, (quality: string) => {
        Button(this.qualityLabel(quality)).backgroundColor(MEDIA_SCRIM).fontColor(CONTENT_ON_ACTION)
          .fontSize(MobileDesignTypography.bodySmall.size).height(44).width('100%').borderRadius(22)
          .border({ width: 0.5, color: MUTED }).enabled(quality !== this.state.quality)
          .id(`rd-quality-${quality}`).onClick((): void => this.actions.setQuality(quality))
      }, (quality: string): string => quality)
    }.width('100%').constraintSize({ maxWidth: 320 }).id('rd-quality-options')
  }
  @Builder private Toolbar() {
    Scroll() {
      Column({ space: 12 }) {
        Text(RemoteI18n.t(`remoteDesktop.stage.${this.state.stage}`)).fontColor(CONTENT_ON_ACTION).fontSize(MobileDesignTypography.bodyMedium.size)
        if (this.state.stage === 'failed') {
          Text(this.errorText()).fontColor(STATUS_DANGER).fontSize(MobileDesignTypography.bodySmall.size)
        }
        if (this.state.stage === 'paused') {
          ForEach(this.state.displays.filter((display: RemoteDesktopDisplay): boolean => display.display_id === this.state.selectedDisplayId), (display: RemoteDesktopDisplay) => {
            Text(RemoteI18n.f('remoteDesktop.currentDisplay', this.displayLabel(display))).fontColor(CONTENT_ON_ACTION).opacity(0.7)
              .fontSize(MobileDesignTypography.bodySmall.size).id('rd-current-source')
          }, (display: RemoteDesktopDisplay): string => display.display_id)
          Text(RemoteI18n.t('remoteDesktop.pauseHint')).fontColor(CONTENT_ON_ACTION).opacity(0.7)
            .fontSize(MobileDesignTypography.bodySmall.size)
          if (this.state.qualitySupported) this.QualityOptions()
          Button(RemoteI18n.t('remoteDesktop.resumeSource')).backgroundColor(MEDIA_SCRIM).fontColor(CONTENT_ON_ACTION)
            .height(44).padding({ left: 18, right: 18 }).borderRadius(22).border({ width: 0.5, color: MUTED })
            .id('rd-resume-source').onClick((): void => this.actions.resumeSource())
          if (this.state.sourceLifecycleSupported) {
            Button(RemoteI18n.t('remoteDesktop.chooseSource')).backgroundColor(MEDIA_SCRIM).fontColor(CONTENT_ON_ACTION)
              .height(44).fontSize(MobileDesignTypography.bodySmall.size).id('rd-choose-source')
              .onClick((): void => this.actions.chooseSource())
          }
        }
        if (this.state.stage === 'choose_source') {
          ForEach(this.state.displays, (display: RemoteDesktopDisplay) => {
            Button(display.display_id === this.state.selectedDisplayId
              ? RemoteI18n.f('remoteDesktop.currentDisplay', this.displayLabel(display)) : this.displayLabel(display))
              .backgroundColor(MEDIA_SCRIM).fontColor(CONTENT_ON_ACTION).height(44)
              .border({ width: 0.5, color: MUTED }).borderRadius(22)
              .id(`rd-source-display-${this.state.displays.findIndex((item: RemoteDesktopDisplay): boolean => item.display_id === display.display_id)}`)
              .onClick((): void => this.actions.selectSource(display.display_id))
          }, (display: RemoteDesktopDisplay): string => display.display_id)
        }
        if (this.state.stage === 'loading_sources' || this.state.stage === 'choose_source') {
          Button(RemoteI18n.t('remoteDesktop.cancelSource')).backgroundColor(MEDIA_SCRIM).fontColor(CONTENT_ON_ACTION)
            .fontSize(MobileDesignTypography.bodySmall.size).height(44).id('rd-cancel-source')
            .onClick((): void => this.actions.cancelSourceChoice())
        }
        if (this.state.stage === 'choose_display') {
          Toggle({ type: ToggleType.Switch, isOn: this.forceRelay })
            .onChange((value: boolean): void => { this.forceRelay = value; })
          Text(RemoteI18n.t('remoteDesktop.forceRelay')).fontColor(CONTENT_ON_ACTION).opacity(0.7).fontSize(MobileDesignTypography.labelSmall.size)
          ForEach(this.state.displays, (display: RemoteDesktopDisplay) => {
            Button(`${display.width} × ${display.height}`).backgroundColor(MEDIA_SCRIM).fontColor(CONTENT_ON_ACTION)
              .onClick((): void => this.actions.attach(display.display_id, this.forceRelay))
          }, (display: RemoteDesktopDisplay): string => display.display_id)
        }
        if (this.state.canReconnect) {
          Button(RemoteI18n.t('home.reconnect')).backgroundColor(MEDIA_SCRIM).fontColor(CONTENT_ON_ACTION)
            .border({ width: 0.5, color: MUTED }).height(44).fontSize(MobileDesignTypography.bodyMedium.size).id('rd-reconnect')
            .onClick((): void => this.actions.reconnect())
        }
        Button(RemoteI18n.t(this.state.stage === 'closed' || this.state.stage === 'failed' ? 'common.back' : 'remoteDesktop.disconnect'))
          .backgroundColor(MEDIA_SCRIM).fontColor(CONTENT_ON_ACTION).fontSize(MobileDesignTypography.bodySmall.size)
          .onClick((): void => this.actions.close())
      }.padding(16).width('100%')
    }.width('100%').height('100%').layoutWeight(1).scrollBar(BarState.Auto).id('rd-toolbar')
  }
  private controlErrorText(): string {
    if (this.state.controlError === 'control_busy') return RemoteI18n.t('remoteDesktop.controlBusy');
    if (this.state.controlError === 'device_approval_required' || this.state.controlError === 'control_authorization_required') return RemoteI18n.t('remoteDesktop.controlApprovalRequired');
    if (this.state.controlError === 'input_permission_required') return RemoteI18n.t('remoteDesktop.inputPermissionRequired');
    return RemoteI18n.t('remoteDesktop.controlPaused');
  }
  private displayLabel(display: RemoteDesktopDisplay): string {
    return RemoteI18n.f2('remoteDesktop.displayLabel', String(this.state.displays.findIndex((item: RemoteDesktopDisplay): boolean => item.display_id === display.display_id) + 1), `${display.width} × ${display.height}`);
  }
  private errorText(): string {
    const code = this.state.errorCode;
    if (code === 'attachment_busy') return RemoteI18n.t('remoteDesktop.attachmentBusy');
    if (code === 'cleanup_pending') return RemoteI18n.t('remoteDesktop.cleanupPending');
    if (code === 'device_approval_required') return RemoteI18n.t('remoteDesktop.approvalRequired');
    if (code === 'permission_required') return RemoteI18n.t('remoteDesktop.permissionRequired');
    if (code === 'host_locked') return RemoteI18n.t('remoteDesktop.hostLocked');
    if (code === 'target_lost') return RemoteI18n.t('remoteDesktop.displayUnavailable');
    if (code === 'turn_unavailable' || code === 'relay_upgrade_required') return RemoteI18n.t('remoteDesktop.updateRequired');
    if (code === 'unsupported' || code === 'media_backend_unavailable') return RemoteI18n.t('remoteDesktop.unsupported');
    return RemoteI18n.t('remoteDesktop.connectionFailed');
  }
  build() {
    Column() {
      if (!this.shortViewport) this.Header()
      if (this.state.signalingInterrupted) {
        Text(RemoteI18n.t('remoteDesktop.signalingInterrupted')).fontColor(CONTENT_ON_ACTION)
          .fontSize(MobileDesignTypography.bodySmall.size).padding({ left: 12, right: 12 }).id('rd-signaling-interrupted')
      }
      if (this.state.stage === 'observing' && this.state.controlError.length > 0) {
        Text(this.controlErrorText()).fontColor(STATUS_DANGER).fontSize(MobileDesignTypography.bodySmall.size).padding({ left: 12, right: 12 })
      }
      if (this.state.stage === 'observing' && this.state.controlState === 'acquiring') {
        Text(RemoteI18n.t('remoteDesktop.acquiringControl')).fontColor(CONTENT_ON_ACTION)
      }
      if (this.keyboardUnavailable) {
        Text(RemoteI18n.t('remoteDesktop.keyboardUnavailable')).fontColor(STATUS_DANGER)
          .fontSize(MobileDesignTypography.bodySmall.size).padding({ left: 12, right: 12 })
      }
      if (this.screenshotFailed) {
        Text(RemoteI18n.t('remoteDesktop.screenshotFailed')).fontColor(STATUS_DANGER)
          .fontSize(MobileDesignTypography.bodySmall.size).padding({ left: 12, right: 12 })
      }
      if (this.rotationUnavailable) {
        Text(RemoteI18n.t('remoteDesktop.rotationUnavailable')).fontColor(STATUS_DANGER)
          .fontSize(MobileDesignTypography.bodySmall.size).padding({ left: 12, right: 12 })
      }
      Flex({ direction: FlexDirection.Column }) {
        Column() {
          RemoteDesktopViewport({ state: this.state, actions: this.actions, screenshotRequest: this.screenshotRequest,
            onScreenshot: (path: string): void => {
              this.screenshotBusy = false; this.screenshotFailed = path.length === 0; this.screenshotPath = path;
            }
          }).layoutWeight(1).height('100%')
        }.layoutWeight(this.state.stage === 'connecting' || this.state.stage === 'observing' ? 1 : 0)
          // Keep the fixed receiver mounted before selection; it remains hidden
          // until connecting and cannot create a second bridge during layout.
          .width('100%').height(this.state.stage === 'connecting' || this.state.stage === 'observing' ? '100%' : 1)
        if (this.state.stage !== 'observing') this.Toolbar()
        if (this.state.stage === 'observing') {
          Flex({ direction: this.keyboardOpen || this.shortViewport ? FlexDirection.Row : FlexDirection.Column }) {
            this.ControlDock()
            if (this.keyboardOpen && this.state.controlState === 'controlling') {
              ForEach([`${this.state.rendererId}:${this.state.controlGeneration}:${this.keyboardRequest}`], (binding: string) => {
                RemoteDesktopKeyboard({ state: this.state, actions: this.actions, shortViewport: this.shortViewport,
                  // Read the owner's intent synchronously, before ArkUI has
                  // propagated parameters or removed a hidden keyboard.
                  isRequested: (): boolean => this.active && this.keyboardOpen &&
                    binding === `${this.state.rendererId}:${this.state.controlGeneration}:${this.keyboardRequest}`,
                  onHidden: (): void => { this.keyboardOpen = false; },
                  onUnavailable: (): void => {
                    this.keyboardUnavailable = true; this.keyboardOpen = false; this.actions.releaseControl();
                  }
                }).padding({ top: 4, right: 12 }).width('100%').height(52)
                  .layoutWeight(1).flexShrink(0)
              }, (binding: string): string => binding)
            }
          }.width('100%').height(this.keyboardOpen || this.shortViewport ? 56 : 60).flexShrink(0)

        }
      }.layoutWeight(1).width('100%')
    }.width('100%').height('100%').backgroundColor(MEDIA_BACKGROUND)
      .bindSheet(this.screenshotPath.length > 0, this.ScreenshotPreview(), {
        height: SheetSize.FIT_CONTENT, showClose: false, dragBar: false, backgroundColor: CARD,
        onDisappear: (): void => { this.screenshotPath = ''; }
      })
      .padding({ top: this.insets.top, bottom: this.insets.bottom,
        left: this.insets.leftPadding(0), right: this.insets.rightPadding(0) })
      .onAreaChange((old: Area, area: Area): void => {
        this.viewportHeight = Number(area.height);
        this.viewportTop = Number(area.globalPosition.y);
        if (Number(old.width) > 0 && Number(old.width) !== Number(area.width)
          && this.state.controlState !== 'viewing') this.actions.releaseControl();
        // The keyboard keeps one compact row; very short windows also
        // move the more menu here so stop and exit stay reachable.
        this.shortViewport = Number(area.height) > 0 && Number(area.height) < 240;
      })
  }
}
