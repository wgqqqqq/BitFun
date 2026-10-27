@ObservedV2
export class RemoteDesktopServiceState {
  @Trace connected: boolean = false;
  @Trace serviceUrl: string = '';
  @Trace deviceId: string = '';
  @Trace busy: boolean = false;
  @Trace failed: boolean = false;
}
