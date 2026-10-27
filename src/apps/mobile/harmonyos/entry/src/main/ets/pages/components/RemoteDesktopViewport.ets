import { RemoteDesktopActions, RemoteDesktopState, emptyRemoteDesktopActions } from '../state/RemoteDesktopState';
import { DesktopTouchPoint, RemoteDesktopTouchPolicy } from '../policy/RemoteDesktopTouchPolicy';
import { RemoteDesktopInput } from '../../model/RemoteDesktopModels';
import { RemoteDesktopGestureClock } from '../../services/RemoteDesktopGestureClock';
import { RemoteDesktopMediaView } from './RemoteDesktopMediaView';
import { INK, SOFT, TRANSPARENT } from './Theme';

/** Native gesture leaf around the fixed media renderer. Coordinates are viewport vp. */
@ComponentV2
export struct RemoteDesktopViewport {
  @Param state: RemoteDesktopState = new RemoteDesktopState();
  @Param actions: RemoteDesktopActions = emptyRemoteDesktopActions();
  @Param screenshotRequest: number = 0;
  @Event onScreenshot: (path: string) => void = (_path: string): void => {};
  @Local viewportWidth: number = 0; @Local viewportHeight: number = 0;
  @Local zoom: number = 1; @Local panX: number = 0; @Local panY: number = 0;
  @Local cursorX: number = 0; @Local cursorY: number = 0;
  private active: boolean = true;
  private pressStarted: number = -1;
  private lastTouchTime: number = -1;
  private clearPress(): void { this.pressStarted = -1; }
  private gestureTime(timestamp: number): number | undefined {
    const now = RemoteDesktopGestureClock.fromEvent(timestamp);
    if (now === undefined) {
      this.clearPress(); this.touch.cancel(); this.actions.releaseControl('input_suspended');
    }
    return now;
  }
  aboutToDisappear(): void { this.active = false; this.clearPress(); this.touch.cancel(); }
  private touch: RemoteDesktopTouchPolicy = new RemoteDesktopTouchPolicy({
    input: (message: RemoteDesktopInput): void => this.actions.input(message),
    release: (): void => this.actions.releaseControl()
  });
  @Monitor('state.controlGeneration', 'state.rendererId', 'state.directTouch', 'state.panMode', 'state.videoWidth', 'state.videoHeight')
  private contextChanged(): void { this.clearPress(); this.configure(); }
  private configure(): void {
    this.touch.configure({ generation: this.state.controlGeneration, rendererId: this.state.rendererId, width: this.viewportWidth, height: this.viewportHeight,
      sourceWidth: this.state.videoWidth, sourceHeight: this.state.videoHeight,
      direct: this.state.directTouch, pan: this.state.panMode });
    this.project();
  }
  private project(): void {
    this.zoom = this.touch.scale; this.panX = this.touch.panX; this.panY = this.touch.panY;
    const point = this.touch.cursor(); this.cursorX = point[0]; this.cursorY = point[1];
  }
  private touchEvent(event: TouchEvent): void {
    if (this.state.stage !== 'observing') return;
    this.configure();
    const now = this.gestureTime(event.timestamp); if (now === undefined) return;
    if (now < this.lastTouchTime) {
      this.clearPress(); this.touch.cancel(); this.actions.releaseControl('input_suspended'); return;
    }
    this.lastTouchTime = now;
    const points: DesktopTouchPoint[] = event.touches.map((p: TouchObject): DesktopTouchPoint => ({ id: p.id, x: p.x, y: p.y }));
    if (event.type === TouchType.Down) {
      this.pressStarted = points.length === 1 ? now : -1;
      this.touch.begin(points, now);
    }
    else if (event.type === TouchType.Move) this.touch.move(points);
    else if (event.type === TouchType.Up) {
      this.clearPress();
      this.touch.move(event.changedTouches.map((p: TouchObject): DesktopTouchPoint => ({ id: p.id, x: p.x, y: p.y })));
      const remaining = points.filter((p: DesktopTouchPoint): boolean => !event.changedTouches.some((ended: TouchObject): boolean => ended.id === p.id)).length;
      this.touch.end(remaining, now);
    } else if (event.type === TouchType.Cancel) { this.clearPress(); this.touch.cancel(); }
    this.project();
  }
  private longPressEvent(event: GestureEvent, binding: string): void {
    if (!this.active || this.state.stage !== 'observing' || this.pressStarted < 0
      || binding !== `${this.state.rendererId}:${this.state.controlGeneration}`) return;
    const now = this.gestureTime(event.timestamp); if (now === undefined) return;
    // GestureEvent may retain the last touch time. Recognition, rather than
    // subtracting callback timestamps, supplies the duration proof.
    if (now < this.pressStarted) return;
    this.touch.longPress(); this.project();
  }
  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      RemoteDesktopMediaView({ state: this.state, onMessage: this.actions.receive,
        screenshotRequest: this.screenshotRequest, onScreenshot: this.onScreenshot })
        .scale({ x: this.zoom, y: this.zoom }).translate({ x: this.panX, y: this.panY })
      ForEach([`${this.state.rendererId}:${this.state.controlGeneration}`], (binding: string) => {
        Column().width('100%').height('100%').backgroundColor(TRANSPARENT)
          .onTouch((event: TouchEvent): void => {
            if (this.active && binding === `${this.state.rendererId}:${this.state.controlGeneration}`) this.touchEvent(event);
          })
          .gesture(LongPressGesture({ fingers: 1, repeat: false, duration: 500 })
            .onAction((event: GestureEvent): void => this.longPressEvent(event, binding)))
          .id('rd-input-surface')
      }, (binding: string): string => binding)
      if (this.state.controlState === 'controlling' && !this.state.directTouch) {
        Circle().width(12).height(12).fill(INK).stroke(SOFT).strokeWidth(2)
          .position({ x: this.cursorX - 6, y: this.cursorY - 6 }).hitTestBehavior(HitTestMode.None)
      }
    }.width('100%').height('100%').clip(true)
      .onAreaChange((_old: Area, area: Area): void => {
        this.viewportWidth = Number(area.width); this.viewportHeight = Number(area.height); this.configure();
      })
  }
}
