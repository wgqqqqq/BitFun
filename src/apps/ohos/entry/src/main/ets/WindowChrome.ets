import window from '@ohos.window';
import webview from '@ohos.web.webview';
import { ConfigurationConstant } from '@kit.AbilityKit';
import { JsHelper, WebviewInitData } from '@ohos-rs/ability';
import { CompanionWindow } from './CompanionWindow';

interface ChromeRect { x: number; y: number; width: number; height: number; }
interface ChromeHitRegions { bars: ChromeRect[]; controls: ChromeRect[]; }

// Only the primary workbench owns native caption layout. Companion WebViews
// keep their transparent, independent window and never receive this bridge.
export class WindowChrome {
  private static main: window.Window | null = null;
  private static controller: webview.WebviewController | null = null;
  private static inset: number = 0;
  private static dark: boolean | null = null;
  private static regions: ChromeHitRegions = { bars: [], controls: [] };

  static onTouch(event: TouchEvent): void {
    if (event.type !== TouchType.Down || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const contains = (r: ChromeRect): boolean => touch.windowX >= r.x && touch.windowX < r.x + r.width &&
      touch.windowY >= r.y && touch.windowY < r.y + r.height;
    if (!WindowChrome.regions.bars.some(contains) || WindowChrome.regions.controls.some(contains)) return;
    WindowChrome.main?.startMoving().catch((error: Error) => console.warn('Native caption drag failed: ' + String(error)));
  }
  private static updateRect = (rect: window.TitleButtonRect): void => {
    WindowChrome.inset = Math.max(0, rect.width + rect.right);
    WindowChrome.controller?.runJavaScript(
      `window.__openbitfunSetCaptionInset?.(${WindowChrome.inset})`
    ).catch(() => {});
  };

  static configure(main: window.Window): void {
    WindowChrome.main = main;
    try {
      main.setWindowDecorHeight(45);
      main.setDecorButtonStyle({ buttonBackgroundSize: 28, buttonIconSize: 16,
        spacingBetweenButtons: 8, closeButtonRightMargin: 12, buttonBackgroundCornerRadius: 6 });
      main.setWindowDecorVisible(false);
      main.setWindowTitleMoveEnabled(true);
      WindowChrome.updateRect(main.getTitleButtonRect());
      main.on('windowTitleButtonRectChange', WindowChrome.updateRect);
    } catch (error) {
      // Preserve usable system chrome if immersive caption layout is unavailable.
      WindowChrome.inset = 0;
      main.setWindowDecorVisible(true);
      console.warn('Native immersive caption is unavailable: ' + String(error));
    }
  }

  static attach(data: WebviewInitData): JsHelper | undefined {
    const companion = CompanionWindow.attach(data);
    if (companion) return companion;
    data.onControllerAttached = (controller: webview.WebviewController): void => {
      WindowChrome.controller = controller;
      controller.registerJavaScriptProxy({
        setHitRegions: (json: string): void => {
          WindowChrome.regions = JSON.parse(json) as ChromeHitRegions;
        },
        getInset: (): number => {
          try {
            const rect = WindowChrome.main?.getTitleButtonRect();
            if (rect) WindowChrome.inset = Math.max(0, rect.width + rect.right);
          } catch (_) {}
          return WindowChrome.inset;
        },
        setDark: (dark: boolean): void => {
          if (WindowChrome.dark === dark) return;
          WindowChrome.dark = dark;
          try {
            WindowChrome.main?.setDecorButtonStyle({ colorMode: dark ?
              ConfigurationConstant.ColorMode.COLOR_MODE_DARK : ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT,
              buttonBackgroundSize: 28, buttonIconSize: 16, spacingBetweenButtons: 8,
              closeButtonRightMargin: 12, buttonBackgroundCornerRadius: 6 });
          } catch (error) { console.warn('Native caption theme update failed: ' + String(error)); }
        }
      }, 'openbitfunNativeCaption', ['setDark', 'getInset', 'setHitRegions']);
    };
    data.initializationScripts = [...(data.initializationScripts ?? []), {
      scriptRules: ['*'],
      script: `(() => {
        window.__openbitfunSetCaptionInset = value => {
          document.documentElement?.style.setProperty('--openbitfun-host-title-buttons-inset', value + 'px');
        };
        const install = () => {
          const syncInset = () => window.__openbitfunSetCaptionInset(
            window.openbitfunNativeCaption?.getInset() ?? ${WindowChrome.inset});
          syncInset();
          window.addEventListener('resize', syncInset);
          window.addEventListener('focus', syncInset);
          let previousRegions = '';
          const syncRegions = () => {
            const bars = [...document.querySelectorAll('.openbitfun-scene-top-bar, .openbitfun-nav-bar')];
            const rect = element => {
              const r = element.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            };
            const selector = 'button, a, input, select, [role="button"], [role="tab"], [contenteditable="true"], [draggable="true"]';
            const regions = JSON.stringify({
              bars: document.querySelector('[role="dialog"], [role="menu"]') ? [] : bars.map(rect),
              controls: bars.flatMap(bar => [...bar.querySelectorAll(selector)].map(rect))
            });
            if (regions !== previousRegions) {
              previousRegions = regions;
              window.openbitfunNativeCaption?.setHitRegions(regions);
            }
          };
          let regionsScheduled = false;
          const queueRegions = () => {
            if (regionsScheduled) return;
            regionsScheduled = true;
            requestAnimationFrame(() => { regionsScheduled = false; syncRegions(); });
          };
          new MutationObserver(queueRegions).observe(document.body, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['class', 'style', 'role'] });
          new ResizeObserver(queueRegions).observe(document.body);
          queueRegions();
          let scheduled = false;
          const syncTheme = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
              scheduled = false;
              const bar = document.querySelector('.openbitfun-scene-top-bar');
              if (!bar) return;
              const rgb = getComputedStyle(bar).backgroundColor.match(/[\\d.]+/g);
              if (rgb && rgb.length >= 3) {
                const brightness = Number(rgb[0]) * .2126 + Number(rgb[1]) * .7152 + Number(rgb[2]) * .0722;
                window.openbitfunNativeCaption?.setDark(brightness < 128);
              }
            });
          };
          new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true });
          new MutationObserver(syncTheme).observe(document.head, { childList: true, subtree: true, characterData: true });
          const mountObserver = new MutationObserver(() => {
            if (document.querySelector('.openbitfun-scene-top-bar')) {
              mountObserver.disconnect();
              syncInset();
              syncTheme();
            }
          });
          mountObserver.observe(document.body, { childList: true, subtree: true });
          syncTheme();
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
        else install();
      })();`
    }];
    return undefined;
  }

  static dispose(): void {
    try { WindowChrome.main?.off('windowTitleButtonRectChange', WindowChrome.updateRect); } catch (_) {}
    WindowChrome.controller = null;
    WindowChrome.main = null;
    WindowChrome.dark = null;
    WindowChrome.regions = { bars: [], controls: [] };
  }
}
