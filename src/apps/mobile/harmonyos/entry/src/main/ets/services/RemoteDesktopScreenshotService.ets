import { common } from '@kit.AbilityKit';
import fs from '@ohos.file.fs';
import fileUri from '@ohos.file.fileuri';
import photoAccessHelper from '@ohos.file.photoAccessHelper';
import { Encoding } from './Encoding';

/** Phone-local frame files and photo export; no account, input or remote RPC. */
export class RemoteDesktopScreenshotService {
  static async capture(context: common.Context, read: () => Promise<string>, current: () => boolean): Promise<string> {
    const raw = await read();
    const data: string = raw.startsWith('"') ? JSON.parse(raw) as string : raw;
    const prefix = 'data:image/png;base64,';
    if (!current() || data.length > 24 * 1024 * 1024 || !data.startsWith(prefix)) throw new Error('capture_unavailable');
    const bytes = Encoding.base64ToBytes(data.slice(prefix.length));
    if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error('capture_invalid');
    const path = `${context.cacheDir}/${Encoding.randomId('rd-capture')}.png`;
    try {
      const file = await fs.open(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY);
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const count = await fs.write(file.fd, bytes.slice(offset).buffer);
          if (count <= 0) throw new Error('capture_write_failed');
          offset += count;
        }
      } finally { await fs.close(file); }
      if (!current()) throw new Error('capture_retired');
      return path;
    } catch (error) { await RemoteDesktopScreenshotService.discard(path); throw error as Error; }
  }
  static async save(context: common.Context, path: string): Promise<void> {
    const helper = photoAccessHelper.getPhotoAccessHelper(context);
    try {
      const request = photoAccessHelper.MediaAssetChangeRequest.createImageAssetRequest(context, fileUri.getUriFromPath(path));
      await helper.applyChanges(request);
    } finally { await helper.release(); }
  }
  static async discard(path: string): Promise<void> {
    if (!/\/rd-capture-[A-Za-z0-9-]+\.png$/.test(path)) return;
    try { await fs.unlink(path); } catch (_error) { /* The OS may already have evicted this cache file. */ }
  }
}
