import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { RemoteDesktopServiceState } from '../state/RemoteDesktopServiceState';
import { TemplateIcon } from './TemplateIcon';
import { SidebarDeviceIcon } from './SidebarNavigationIcons';
import { CARD, INK, MUTED, SOFT, STATUS_DANGER, STATUS_SUCCESS } from './Theme';

/** Device selection only; device trust, capability probing and media belong to the remote desktop owner. */
@ComponentV2
export struct RemoteDesktopDevicePicker {
  @Param deviceId: string = '';
  @Param serviceState: RemoteDesktopServiceState = new RemoteDesktopServiceState();
  @Event onConnect: (address: string, key: string) => Promise<void> = async (): Promise<void> => {};
  @Event onDisconnect: () => void = (): void => {};
  @Event onClose: () => void = () => {};
  @Event listDevices: () => Promise<CloudAccountDevice[]> = async (): Promise<CloudAccountDevice[]> => [];
  @Event onSelect: (device: CloudAccountDevice) => void = (_device: CloudAccountDevice): void => {};
  @Local devices: CloudAccountDevice[] = [];
  @Local busy: boolean = false;
  @Local error: string = '';
  @Local serviceUrl: string = '';
  @Local pairingKey: string = '';
  private active: boolean = false;
  private requestVersion: number = 0;

  aboutToAppear(): void {
    this.active = true;
    this.serviceUrl = this.serviceState.serviceUrl;
    if (this.serviceState.connected) void this.refresh();
  }

  aboutToDisappear(): void {
    this.active = false;
    this.requestVersion += 1;
    this.busy = false;
    this.pairingKey = '';
  }

  build() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Text(RemoteI18n.t('remoteDesktop.navigation'))
          .fontSize(MobileDesignTypography.titleMedium.size).fontWeight(FontWeight.Medium).fontColor(INK).layoutWeight(1)
        Button() {
          SymbolGlyph($r('sys.symbol.arrow_clockwise')).fontSize(17).fontColor([MUTED])
        }.width(36).height(36).padding(0).backgroundColor(SOFT).borderRadius(18)
          .accessibilityText(this.busy ? RemoteI18n.t('common.loading') : RemoteI18n.t('common.refresh'))
          .enabled(!this.busy && this.serviceState.connected)
          .onClick((): void => { void this.refresh(); })
        Button() {
          TemplateIcon({ src: $r('app.media.settings_close_x'), iconWidth: 14, iconHeight: 14, tint: MUTED })
        }.width(36).height(36).padding(0).backgroundColor(SOFT).borderRadius(18)
          .accessibilityText(RemoteI18n.t('common.close')).onClick((): void => this.onClose())
      }.width('100%').height(40)
      Text(RemoteI18n.t('remoteDesktop.serviceDescription'))
        .fontSize(MobileDesignTypography.bodySmall.size).fontColor(MUTED).width('100%')
      Scroll() {
        Column({ space: 8 }) {
          if (!this.serviceState.connected) {
            TextInput({ text: this.serviceUrl, placeholder: RemoteI18n.t('remoteDesktop.serviceAddress') })
              .onChange((value: string): void => { this.serviceUrl = value; })
              .enabled(!this.busy && !this.serviceState.busy)
            TextInput({ text: this.pairingKey, placeholder: RemoteI18n.t('remoteDesktop.servicePairingKey') })
              .type(InputType.Password).onChange((value: string): void => { this.pairingKey = value; })
              .enabled(!this.busy && !this.serviceState.busy)
            Text(RemoteI18n.t('remoteDesktop.servicePairingHint')).fontColor(MUTED)
              .fontSize(MobileDesignTypography.bodySmall.size)
            Button(RemoteI18n.t('remoteDesktop.serviceConnect'))
              .enabled(!this.busy && !this.serviceState.busy && this.serviceUrl.trim().length > 0)
              .onClick((): void => { void this.connectService(); })
          } else {
            Text(this.serviceState.serviceUrl).fontColor(MUTED).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            Button(RemoteI18n.t('remoteDesktop.serviceDisconnect')).onClick((): void => {
              ++this.requestVersion; this.devices = []; this.onDisconnect();
            })
          }
          if (this.serviceState.failed) {
            Text(RemoteI18n.t('remoteDesktop.serviceFailed')).fontColor(STATUS_DANGER).width('100%')
          } else if (this.error.length > 0) {
            Text(this.error).fontColor(STATUS_DANGER).width('100%')
          } else if (!this.busy && this.desktopDevices().length === 0) {
            Text(RemoteI18n.t('remote.settings.deviceEmpty')).fontColor(MUTED).width('100%')
          }
          ForEach(this.desktopDevices(), (device: CloudAccountDevice) => {
            Button({ type: ButtonType.Normal }) {
              Row({ space: 12 }) {
                SidebarDeviceIcon({ deviceName: device.deviceName })
                Column({ space: 4 }) {
                  Text(device.deviceName || device.deviceId)
                    .fontSize(MobileDesignTypography.bodyMedium.size).fontWeight(FontWeight.Medium).fontColor(INK)
                    .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(device.online ? RemoteI18n.t('sidebar.deviceOnline') : RemoteI18n.t('sidebar.deviceOffline'))
                    .fontSize(MobileDesignTypography.bodySmall.size)
                    .fontColor(device.online ? STATUS_SUCCESS : MUTED)
                }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(14).fontColor([MUTED])
              }.width('100%')
            }
            .width('100%').height(64)
            .padding(12).backgroundColor(SOFT).borderRadius(12)
            .enabled(device.online).opacity(device.online ? 1 : 0.48)
            .onClick((): void => this.onSelect(device))
          }, (device: CloudAccountDevice): string => device.deviceId)
        }.width('100%')
      }.width('100%').height(Math.min(400, Math.max(280, this.desktopDevices().length * 72 + 80)))
    }.width('100%').padding(20).backgroundColor(CARD)
  }

  private desktopDevices(): CloudAccountDevice[] {
    return this.devices.filter((device: CloudAccountDevice): boolean =>
      device.deviceId !== this.deviceId && (!device.deviceKind || device.deviceKind === 'desktop'));
  }

  private async refresh(): Promise<void> {
    if (this.busy || !this.active) return;
    const version = ++this.requestVersion;
    const serviceUrl = this.serviceState.serviceUrl;
    this.busy = true;
    this.error = '';
    try {
      const devices = await this.listDevices();
      if (this.active && version === this.requestVersion && serviceUrl === this.serviceState.serviceUrl && this.serviceState.connected) this.devices = devices;
    } catch (_) {
      if (this.active && version === this.requestVersion) this.error = RemoteI18n.t('remote.settings.deviceLoadFailed');
    } finally {
      if (this.active && version === this.requestVersion) this.busy = false;
    }
  }

  private async connectService(): Promise<void> {
    const version = ++this.requestVersion;
    this.busy = true;
    try {
      await this.onConnect(this.serviceUrl, this.pairingKey);
      if (this.active && version === this.requestVersion && this.serviceState.connected) {
        this.pairingKey = ''; this.busy = false; await this.refresh();
      }
    } finally { if (this.active && version === this.requestVersion) this.busy = false; }
  }
}
