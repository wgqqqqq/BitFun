import { Context } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

/** One view's window preference; serialized across retiring/replacement views. */
export class RemoteDesktopOrientationService {
  private static tail: Promise<void> = Promise.resolve();
  private closed: boolean = false;
  private appWindow?: window.Window;
  private original?: window.Orientation;

  rotate(context: Context): Promise<boolean> {
    const work = RemoteDesktopOrientationService.tail.then(async (): Promise<boolean> => {
      if (this.closed) return false;
      try {
        const current = this.appWindow || await window.getLastWindow(context);
        if (this.closed) return false;
        if (!this.appWindow) {
          this.original = current.getPreferredOrientation(); this.appWindow = current;
        }
        const rect = current.getWindowProperties().windowRect;
        if (rect.width <= 0 || rect.height <= 0) return false;
        await current.setPreferredOrientation(rect.width > rect.height ? window.Orientation.PORTRAIT : window.Orientation.LANDSCAPE);
        return !this.closed;
      } catch (_error) { console.warn('Remote desktop window rotation failed'); return false; }
    });
    RemoteDesktopOrientationService.tail = work.then((): void => {});
    return work;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    RemoteDesktopOrientationService.tail = RemoteDesktopOrientationService.tail.then(async (): Promise<void> => {
      const current = this.appWindow, original = this.original;
      this.appWindow = undefined; this.original = undefined;
      if (!current || original === undefined) return;
      try { await current.setPreferredOrientation(original); }
      catch (_error) { console.warn('Remote desktop window orientation restoration failed'); }
    });
  }
}
