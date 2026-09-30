import { statusBarManager } from '@kit.DesktopExtensionKit';
import { common } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';

export class TrayManager {
  private initialized: boolean = false;
  private pending: Promise<void> | null = null;
  private context: common.UIAbilityContext;
  constructor(context: common.UIAbilityContext) { this.context = context; }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.pending) return this.pending;
    this.pending = this.add();
    try { await this.pending; this.initialized = true; }
    finally { this.pending = null; }
  }

  private async add(): Promise<void> {
    const bytes = await this.context.resourceManager.getMediaContent($r('app.media.app_icon').id);
    const source = image.createImageSource(bytes.buffer);
    const icon = await source.createPixelMap({ desiredSize: { width: 24, height: 24 } });
    try {
      await new Promise<void>((resolve, reject) => {
        statusBarManager.addToStatusBar(this.context, {
          icons: { white: icon, black: icon },
          quickOperation: { title: 'OpenBitFun', height: 96, abilityName: 'TrayAbility' },
          statusBarGroupMenu: [[{ title: 'OpenBitFun', menuAction: { abilityName: 'EntryAbility' } }]]
        }, (error) => { if (error) reject(error); else resolve(); });
      });
    } finally { await icon.release(); await source.release(); }
  }

  async perform(action: string): Promise<boolean> {
    await this.initialize();
    if (action.startsWith('unread:')) {
      const count = Number(action.substring(7));
      if (!Number.isInteger(count) || count < 0) throw new Error('Invalid unread count');
      await statusBarManager.updateStatusBarHoverTips(this.context,
        count > 0 ? 'OpenBitFun (' + count.toString() + ')' : 'OpenBitFun');
    } else if (action !== 'initialize') throw new Error('Unsupported tray action');
    return true;
  }
}
