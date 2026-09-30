import display from '@ohos.display';
import { companionFoldTarget, FoldRect } from './CompanionFoldTransfer';
import window from '@ohos.window';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { RustWebviewNodeController, WebviewInitData, JsHelper } from '@ohos-rs/ability';

export class CompanionContent {
  static controller: RustWebviewNodeController | null = null;
  static onReady: (() => void) | null = null;
  static async waitUntilReady(): Promise<void> {
    if (CompanionContent.controller) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        CompanionContent.onReady = null;
        reject(new Error('Companion content did not initialize'));
      }, 5000);
      CompanionContent.onReady = () => {
        clearTimeout(timer);
        CompanionContent.onReady = null;
        resolve();
      };
    });
  }
}

interface NativeDragTouch {
  dragId?: number; id: number; grabX: number; grabY: number; x: number; y: number; origin: window.Rect; valid: boolean;
}

interface NativeDragReply { pointer?: display.Position; grabX?: number; transferred?: boolean }

interface FoldDisplayInfo { id: number; width: number; height: number; alive: boolean; origin: display.Position }

interface Operation {
  action: string;
  dragId?: number;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export class CompanionWindow {
  private static instance: CompanionWindow | null = null;
  private floating: window.Window | null = null;
  private webTag: string | null = null;
  private webview: JsHelper | null = null;
  private position: window.Rect | null = null;
  private chain: Promise<string> = Promise.resolve('{}');

  private nativeTouch: NativeDragTouch | null = null;
  private correctionLogs: number = 0;

  static observeTouch(event: TouchEvent): void {
    const host = CompanionWindow.instance;
    if (!host?.floating) return;
    const point = event.changedTouches[0];
    if (!point) return;
    if (event.type === TouchType.Down) {
      if (event.touches.length !== 1) {
        if (host.nativeTouch) host.nativeTouch.valid = false;
        return;
      }
      host.nativeTouch = { id: point.id, grabX: point.displayX, grabY: point.displayY,
        x: point.displayX, y: point.displayY, origin: host.floating.getWindowProperties().windowRect, valid: true };
      hilog.info(0, 'CompanionHost', 'Native drag touch down: %{public}s', JSON.stringify(host.nativeTouch));
    } else if (host.nativeTouch?.id === point.id) {
      host.nativeTouch.x = point.displayX;
      host.nativeTouch.y = point.displayY;
      if (event.type === TouchType.Cancel) host.nativeTouch.valid = false;
      if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        hilog.info(0, 'CompanionHost', 'Native drag touch ended: %{public}s', JSON.stringify(host.nativeTouch));
      }
    }
  }

  private dragId: number = 0;
  private dragTransferred: boolean = false;
  private foldCrease: FoldRect | null = null;
  private foldScreen: FoldRect | null = null;
  private foldUpperId: number = 0;
  private foldLowerId: number = 0;

  private async beginDrag(id: number): Promise<void> {
    if (this.nativeTouch) {
      if (this.nativeTouch.dragId !== undefined && this.nativeTouch.dragId !== id) this.nativeTouch = null;
      else this.nativeTouch.dragId = id;
    }
    this.dragId = id;
    this.correctionLogs = 0;
    this.dragTransferred = false;
    this.foldCrease = null;
    this.foldScreen = null;
    try {
      if (display.getFoldStatus() !== display.FoldStatus.FOLD_STATUS_HALF_FOLDED) return;
      const region = display.getCurrentFoldCreaseRegion();
      const screens = await display.getAllDisplays();
      // In folded PC mode the lower display must exist; no transfer into a keyboard-only screen.
      if (screens.length < 2 || region.creaseRects.length !== 1) return;
      const source = display.getDisplayByIdSync(region.displayId);
      const crease = region.creaseRects[0];
      const lower = screens.find(item => {
        if (item.id === region.displayId || !item.alive) return false;
        const origin = display.convertRelativeToGlobalCoordinate({ displayId: item.id, position: { x: 0, y: 0 } });
        return Math.abs(origin.y - crease.top - crease.height) <= 1 && origin.x === 0;
      });
      hilog.info(0, 'CompanionHost', 'Fold displays: %{public}s', JSON.stringify(screens.map((item): FoldDisplayInfo => ({ id: item.id, width: item.width, height: item.height, alive: item.alive, origin: display.convertRelativeToGlobalCoordinate({ displayId: item.id, position: { x: 0, y: 0 } }) }))));
      if (!lower) return;
      this.foldUpperId = region.displayId;
      this.foldLowerId = lower.id;
      this.foldCrease = crease;
      this.foldScreen = { left: 0, top: 0, width: Math.min(source.width, lower.width), height: crease.top + crease.height + lower.height };

    } catch (error) {
      hilog.warn(0, 'CompanionHost', 'Fold transfer unavailable: %{public}s', String(error));
    }
  }

  private context: common.UIAbilityContext;
  constructor(context: common.UIAbilityContext) { this.context = context; CompanionWindow.instance = this; }

  static attach(data: WebviewInitData): JsHelper | undefined {
    if (data.webTag !== 'agent-companion-pet') return undefined;
    const host = CompanionWindow.instance;
    const node = CompanionContent.controller;
    if (!host?.floating || !node) throw new Error('Companion native container is not ready');
    data.style = { backgroundColor: Color.Transparent };
    const result = node.addWebview(data);
    host.webTag = result.webTag;
    host.webview = result.controller;
    result.controller.setVisible = (visible: boolean) => {
      data.style = { backgroundColor: Color.Transparent, visible };
      node.updateWebviewStyle(result.webTag, data.style);
    };
    result.controller.setBackgroundColor = (_color: string) => {
      data.style = { backgroundColor: Color.Transparent };
      node.updateWebviewStyle(result.webTag, data.style);
    };
    result.controller.dispose = () => {
      node.removeWebview(result.webTag);
      if (host.webTag === result.webTag) { host.webTag = null; host.webview = null; }
    };
    return result.controller;
  }

  perform(raw: string): Promise<string> {
    const task = async (): Promise<string> => {
      const request = JSON.parse(raw) as Operation;
      try {
        const result = await this.execute(request);
        if (request.action === 'show' || request.action === 'destroy') hilog.info(0, 'CompanionHost', 'Window operation completed: %{public}s', request.action);
        return result;
      } catch (error) {
        hilog.error(0, 'CompanionHost', 'Window operation failed: %{public}s %{public}s', request.action, String(error));
        throw new Error(String(error));
      }
    };
    this.chain = this.chain.then(task, task);
    return this.chain;
  }

  private number(value: number | undefined, name: string): number {
    if (value === undefined || !Number.isFinite(value)) throw new Error('Invalid companion ' + name);
    return value;
  }

  private async execute(request: Operation): Promise<string> {
    if (request.action === 'prepare') {
      if (this.floating) return '{}';
      const floating = await window.createWindow({ name: 'OpenBitFunCompanion', windowType: window.WindowType.TYPE_FLOAT, ctx: this.context });
      this.floating = floating;
      try {
        await floating.setUIContent('pages/Companion');
        floating.setWindowBackgroundColor('#00000000');
        floating.setWindowShadowRadius(0);
        await floating.resize(320, 300);
        const last = this.position;
        await floating.moveWindowTo(last?.left ?? 800, last?.top ?? 400);
        await floating.showWindow();
        await CompanionContent.waitUntilReady();
      } catch (error) {
        await floating.destroyWindow();
        this.floating = null;
        CompanionContent.controller = null;
        throw new Error(String(error));
      }
      return '{}';
    }
    if (request.action === 'destroy') {
      if (this.webTag) CompanionContent.controller?.removeWebview(this.webTag);
      if (this.floating) {
        this.position = this.floating.getWindowProperties().windowRect;
        await this.floating.destroyWindow();
      }
      this.floating = null;
      this.webTag = null;
      this.webview = null;
      CompanionContent.controller = null;
      return '{}';
    }
    const floating = this.floating;
    if (!floating) {
      if (request.action === 'hide' || request.action === 'resize') return '{}';
      throw new Error('Companion window is not open');
    }
    const ui = floating.getUIContext();
    switch (request.action) {
      case 'show':
        if (!this.webTag) throw new Error('Companion WebView is not attached');
        await floating.showWindow();
        break;
      
      case 'focus':
        await floating.showWindow();
        this.webview?.requestFocus();
        break;
      case 'position': {
        const rect = floating.getWindowProperties().windowRect;
        return JSON.stringify({ x: rect.left, y: rect.top, displayId: floating.getWindowProperties().displayId });
      }
      case 'scale': return JSON.stringify(ui.vp2px(1));
      case 'move': {
        let x = Math.round(ui.vp2px(this.number(request.x, 'x')));
        let y = Math.round(ui.vp2px(this.number(request.y, 'y')));
        if (request.dragId !== undefined && request.dragId !== this.dragId) await this.beginDrag(request.dragId);
        if (request.dragId !== undefined && this.dragTransferred) return JSON.stringify({ transferred: true });
        const touch = request.dragId !== undefined ? this.nativeTouch : null;
        if (touch && !touch.valid) break;
        if (touch) {
          const nativeX = Math.round(touch.origin.left + ui.vp2px(touch.x - touch.grabX));
          const nativeY = Math.round(touch.origin.top + ui.vp2px(touch.y - touch.grabY));
          if (Math.abs(x - nativeX) > ui.vp2px(12) && this.correctionLogs < 4) {
            this.correctionLogs++;
            hilog.info(0, 'CompanionHost', 'Corrected asynchronous drag coordinates: %{public}s', JSON.stringify({ dragId: this.dragId, webX: x, nativeX, nativeY, touchX: touch.x, touchY: touch.y }));
          }
          x = nativeX;
          y = nativeY;
        }
        if (request.dragId !== undefined && this.foldCrease && this.foldScreen
          && display.getFoldStatus() === display.FoldStatus.FOLD_STATUS_HALF_FOLDED) {
          const props = floating.getWindowProperties();
          const before = props.windowRect;
          const sourceId = props.displayId;
          if (sourceId === this.foldUpperId || sourceId === this.foldLowerId) {
            const lowerTop = this.foldCrease.top + this.foldCrease.height;
            const offset = sourceId === this.foldLowerId ? lowerTop : 0;
            const globalBefore: FoldRect = { left: before.left, top: before.top + offset, width: before.width, height: before.height };
            const target = companionFoldTarget(globalBefore, x, y + offset, this.foldCrease, this.foldScreen, ui.vp2px(48), ui.vp2px(24));
            if (target) {
              const targetId = sourceId === this.foldUpperId ? this.foldLowerId : this.foldUpperId;
              const targetY = target.y - (targetId === this.foldLowerId ? lowerTop : 0);
              await floating.moveWindowToGlobal(target.x, targetY, { displayId: targetId });
              const actual = floating.getWindowProperties();
              if (actual.displayId !== targetId || Math.abs(actual.windowRect.top - targetY) > 4) throw new Error('Companion fold transfer did not reach the target screen');
              this.dragTransferred = true;
              hilog.info(0, 'CompanionHost', 'Fold transfer completed: %{public}s', JSON.stringify({ from: sourceId, to: actual.displayId, y: actual.windowRect.top }));
              return JSON.stringify({ transferred: true });
            }
          }
        }
        await floating.moveWindowTo(x, y);
        if (touch) {
          const reply: NativeDragReply = { pointer: { x: touch.x, y: touch.y }, grabX: touch.grabX };
          return JSON.stringify(reply);
        }
        break;
      }
      case 'resize': {
        const width = this.number(request.width, 'width');
        const height = this.number(request.height, 'height');
        if (width < 1 || height < 1 || width > 720 || height > 720) throw new Error('Invalid companion dimensions');
        const before = floating.getWindowProperties().windowRect;
        const w = Math.round(ui.vp2px(width));
        const h = Math.round(ui.vp2px(height));
        await floating.resize(w, h);
        await floating.moveWindowTo(Math.max(0, before.left + before.width - w), Math.max(0, before.top + before.height - h));
        break;
      }
      default: throw new Error('Unsupported companion window operation');
    }
    return '{}';
  }
}
