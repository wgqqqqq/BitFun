import { RemoteDesktopInput, RemoteDesktopInputBody } from '../../model/RemoteDesktopModels';

export interface DesktopTouchPoint { id: number; x: number; y: number; }
export interface DesktopTouchContext {
  generation: string; rendererId: string; width: number; height: number; sourceWidth: number; sourceHeight: number;
  direct: boolean; pan: boolean;
}
export interface DesktopTouchHooks { input: (message: RemoteDesktopInput) => void; release: () => void; }
const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/** Pure gesture classification and viewport geometry. No OS, timers or transport. */
export class RemoteDesktopTouchPolicy {
  x: number = 0.5; y: number = 0.5;
  scale: number = 1; panX: number = 0; panY: number = 0;
  private context: DesktopTouchContext = { generation: '', rendererId: '', width: 0, height: 0, sourceWidth: 0, sourceHeight: 0, direct: false, pan: false };
  private readonly hooks: DesktopTouchHooks;
  private mode: string = 'idle';
  private started: number = 0;
  private anchor: DesktopTouchPoint = { id: 0, x: 0, y: 0 };
  private previous: DesktopTouchPoint = { id: 0, x: 0, y: 0 };
  private secondTap: boolean = false;
  private lastTap: number = -1000;
  private held: boolean = false;
  private lastTapPoint: DesktopTouchPoint = { id: 0, x: 0, y: 0 };
  private distance: number = 1;
  private initialScale: number = 1;
  private initialPanX: number = 0;
  private initialPanY: number = 0;
  constructor(hooks: DesktopTouchHooks) { this.hooks = hooks; }
  configure(next: DesktopTouchContext): void {
    const old = this.context;
    if (old.generation === next.generation && old.rendererId === next.rendererId && old.width === next.width && old.height === next.height
      && old.sourceWidth === next.sourceWidth && old.sourceHeight === next.sourceHeight
      && old.direct === next.direct && old.pan === next.pan) return;
    const active = this.mode !== 'idle';
    this.cancel();
    if (this.context.generation !== next.generation || this.context.rendererId !== next.rendererId) { this.x = 0.5; this.y = 0.5; }
    this.context = next; this.limitPan();
    const authorityOrGeometryChanged = old.generation !== next.generation || old.rendererId !== next.rendererId
      || old.width !== next.width || old.height !== next.height || old.sourceWidth !== next.sourceWidth || old.sourceHeight !== next.sourceHeight;
    if (active && authorityOrGeometryChanged) this.hooks.release();
  }
  private dimensions(): number[] {
    const c = this.context;
    if (![c.width, c.height, c.sourceWidth, c.sourceHeight].every((v: number): boolean => Number.isFinite(v) && v > 0)) return [0, 0];
    const fit = Math.min(c.width / c.sourceWidth, c.height / c.sourceHeight);
    return [c.sourceWidth * fit * this.scale, c.sourceHeight * fit * this.scale];
  }
  private point(p: DesktopTouchPoint): number[] | undefined {
    const size = this.dimensions(), c = this.context;
    const x = (p.x - (c.width - size[0]) / 2 - this.panX) / size[0];
    const y = (p.y - (c.height - size[1]) / 2 - this.panY) / size[1];
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? [x, y] : undefined;
  }
  cursor(): number[] {
    const size = this.dimensions(), c = this.context;
    return [(c.width - size[0]) / 2 + this.panX + this.x * size[0], (c.height - size[1]) / 2 + this.panY + this.y * size[1]];
  }
  private emit(kind: string, body: RemoteDesktopInputBody): void {
    if (this.context.generation && this.context.rendererId) this.hooks.input({ renderer_id: this.context.rendererId, control_generation: this.context.generation, kind, body });
  }
  private button(down: boolean, button: string = 'left'): void { this.emit('pointer_button', { button, down, x: this.x, y: this.y }); }
  private click(button: string): void { this.button(true, button); this.button(false, button); }
  private limitPan(): void {
    const size = this.dimensions();
    this.panX = clamp(this.panX, Math.max(0, (size[0] - this.context.width) / 2));
    this.panY = clamp(this.panY, Math.max(0, (size[1] - this.context.height) / 2));
  }
  private center(points: DesktopTouchPoint[]): DesktopTouchPoint {
    return { id: points[0].id, x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  }
  private separation(points: DesktopTouchPoint[]): number { return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y); }
  begin(points: DesktopTouchPoint[], now: number): void {
    if (points.length > 2) { this.cancel(); this.mode = 'wait'; this.hooks.release(); return; }
    if (points.length === 2 && ['idle', 'one', 'pointer', 'drag', 'pan'].includes(this.mode)) {
      // Finish the old button sequence before classifying wheel/pinch. The
      // remaining fingers cannot keep a previous drag or double-tap alive.
      this.cancel();
      if (!points.every((p: DesktopTouchPoint): boolean => this.point(p) !== undefined)) { this.mode = 'wait'; return; }
      this.mode = 'two'; this.anchor = this.center(points); this.previous = this.anchor;
      this.distance = Math.max(1, this.separation(points)); this.initialScale = this.scale;
      this.initialPanX = this.panX; this.initialPanY = this.panY; return;
    }
    if (points.length !== 1 || this.mode !== 'idle' || !this.point(points[0])) return;
    this.mode = 'one'; this.started = now; this.anchor = points[0]; this.previous = points[0];
    this.secondTap = now >= this.lastTap && now - this.lastTap <= 300
      && Math.hypot(points[0].x - this.lastTapPoint.x, points[0].y - this.lastTapPoint.y) <= 20;
    if (this.context.direct) { const point = this.point(points[0])!; this.x = point[0]; this.y = point[1]; }
  }
  move(points: DesktopTouchPoint[]): void {
    if (points.length === 2 && ['two', 'wheel', 'pinch', 'canvas'].includes(this.mode)) {
      const center = this.center(points), distance = this.separation(points);
      const travel = Math.hypot(center.x - this.anchor.x, center.y - this.anchor.y);
      if (this.mode === 'two') {
        if (Math.abs(distance - this.distance) >= 8 && Math.abs(distance - this.distance) > travel) this.mode = 'pinch';
        else if (travel >= 8) this.mode = this.context.pan || this.scale > 1 ? 'canvas' : 'wheel';
        else return;
      }
      if (this.mode === 'pinch') {
        this.scale = Math.max(1, Math.min(3, this.initialScale * distance / this.distance));
        const ratio = this.scale / this.initialScale, c = this.context;
        this.panX = center.x - c.width / 2 - (this.anchor.x - c.width / 2 - this.initialPanX) * ratio;
        this.panY = center.y - c.height / 2 - (this.anchor.y - c.height / 2 - this.initialPanY) * ratio;
        this.limitPan();
      } else if (this.mode === 'canvas') {
        this.panX += center.x - this.previous.x; this.panY += center.y - this.previous.y; this.limitPan();
      } else {
        const dx = -(center.x - this.previous.x) * 2, dy = -(center.y - this.previous.y) * 2;
        if (dx || dy) this.emit('wheel', { x: this.x, y: this.y, dx, dy });
      }
      this.previous = center; return;
    }
    if (points.length !== 1 || !['one', 'pointer', 'drag', 'pan'].includes(this.mode) || points[0].id !== this.anchor.id) return;
    const p = points[0], travel = Math.hypot(p.x - this.anchor.x, p.y - this.anchor.y);
    if (this.mode === 'one') {
      if (travel < 8) return;
      this.mode = this.context.pan ? 'pan' : this.secondTap ? 'drag' : 'pointer';
      if (this.mode === 'drag') { this.button(true); this.held = true; }
    }
    if (this.mode === 'pan') {
      this.panX += p.x - this.previous.x; this.panY += p.y - this.previous.y; this.limitPan();
    } else {
      const point = this.point(p), size = this.dimensions();
      if (this.context.direct) { if (!point) return; this.x = point[0]; this.y = point[1]; }
      else { this.x = Math.max(0, Math.min(1, this.x + (p.x - this.previous.x) / size[0])); this.y = Math.max(0, Math.min(1, this.y + (p.y - this.previous.y) / size[1])); }
      this.emit('pointer_move', { x: this.x, y: this.y });
    }
    this.previous = p;
  }
  /** Called only after the platform recognizer confirms a long press. */
  longPress(): void {
    if (this.mode !== 'one' || this.context.pan) return;
    if (this.secondTap) { this.button(true); this.held = true; this.mode = 'drag'; }
    else { this.click('right'); this.mode = 'wait'; }
    this.lastTap = -1000;
  }
  end(remaining: number, now: number): void {
    if (this.held) { this.button(false); this.held = false; }
    if (this.mode === 'one' && remaining === 0 && !this.context.pan) {
      const long = now - this.started >= 500;
      // A second held tap is a primary-button drag intent even if the native
      // long-press callback was delayed until after Up.
      this.click(long && !this.secondTap ? 'right' : 'left'); this.lastTap = long ? -1000 : now; this.lastTapPoint = this.anchor;
    } else this.lastTap = -1000;
    this.mode = remaining > 0 ? 'wait' : 'idle';
  }
  cancel(): void {
    const held = this.held;
    this.held = false; this.mode = 'idle'; this.lastTap = -1000; this.secondTap = false;
    if (held) this.button(false);
  }
}
