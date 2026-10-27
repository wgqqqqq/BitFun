import { RemoteDesktopScreenshotService } from '../../services/RemoteDesktopScreenshotService';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { TemplateIcon } from './TemplateIcon';
import { CARD, INK, SOFT, MUTED, PRIMARY_ACTION, CONTENT_ON_ACTION, STATUS_DANGER, STATUS_SUCCESS } from './Theme';

/** Platform photo-export leaf. Closing retires the temporary preview file. */
@ComponentV2
export struct RemoteDesktopScreenshotPreview {
  @Param path: string = '';
  @Event onClose: () => void = (): void => {};
  @Local saving: boolean = false;
  @Local saved: boolean = false;
  @Local failed: boolean = false;
  private active: boolean = true;
  private filePath: string = '';
  aboutToAppear(): void { this.filePath = this.path; }
  aboutToDisappear(): void {
    this.active = false;
    if (!this.saving) void RemoteDesktopScreenshotService.discard(this.filePath);
  }
  private async save(): Promise<void> {
    if (!this.active || this.saving || this.saved) return;
    const context = this.getUIContext().getHostContext();
    if (!context) { this.failed = true; return; }
    this.saving = true; this.failed = false;
    try { await RemoteDesktopScreenshotService.save(context, this.filePath); if (this.active) this.saved = true; }
    catch (_error) { if (this.active) this.failed = true; }
    finally { this.saving = false; if (!this.active) await RemoteDesktopScreenshotService.discard(this.filePath); }
  }
  build() {
    Column({ space: 16 }) {
      Row() {
        Text(RemoteI18n.t('remoteDesktop.screenshot')).fontColor(INK).fontSize(MobileDesignTypography.titleMedium.size).fontWeight(FontWeight.Medium)
        Blank()
        Button() {
          TemplateIcon({ src: $r('app.media.settings_close_x'), iconWidth: 14, iconHeight: 14, tint: MUTED })
        }.width(36).height(36).padding(0).backgroundColor(SOFT).borderRadius(18)
          .accessibilityText(RemoteI18n.t('common.close')).onClick((): void => this.onClose()).id('rd-screenshot-close')
      }.width('100%').height(40)
      Image(`file://${this.path}`).objectFit(ImageFit.Contain).width('100%').aspectRatio(1.6)
        .constraintSize({ maxHeight: 260 }).backgroundColor(SOFT).borderRadius(12).id('rd-screenshot-image')
      if (this.failed) Text(RemoteI18n.t('remoteDesktop.screenshotFailed')).fontColor(STATUS_DANGER).fontSize(MobileDesignTypography.bodySmall.size)
      Row() {
      if (this.saved) Text(RemoteI18n.t('remoteDesktop.screenshotSaved')).fontColor(STATUS_SUCCESS).fontSize(MobileDesignTypography.bodySmall.size)
      Blank()
      SaveButton({ icon: SaveIconStyle.LINES, text: SaveDescription.SAVE_IMAGE, buttonType: ButtonType.Capsule })
        .height(44).fontSize(MobileDesignTypography.bodyMedium.size).fontColor(CONTENT_ON_ACTION)
        .iconColor(CONTENT_ON_ACTION).backgroundColor(PRIMARY_ACTION).enabled(!this.saving && !this.saved).id('rd-screenshot-save')
        .onClick((_event: ClickEvent, result: SaveButtonOnClickResult): void => {
          if (result === SaveButtonOnClickResult.SUCCESS) void this.save();
          else if (result === SaveButtonOnClickResult.TEMPORARY_AUTHORIZATION_FAILED) this.failed = true;
        })
      }.width('100%').height(48)
    }.padding({ left: 20, right: 20, top: 16, bottom: 24 }).width('100%').backgroundColor(CARD).id('rd-screenshot-preview')
  }
}
