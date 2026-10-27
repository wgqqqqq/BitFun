import type { DesktopInput, DesktopInputBody } from './RemoteDesktopController';
import { desktopVideoRect, type DesktopVideoGeometry } from './DesktopVideoGeometry';

export interface DesktopInputContext extends DesktopVideoGeometry {
  renderer: string; generation: string;
}
const EMPTY: DesktopInputContext = { renderer: '', generation: '', left: 0, top: 0, width: 0, height: 0, sourceWidth: 0, sourceHeight: 0 };
const POINTER_BUTTONS = [
  { name: 'left', button: 0, mask: 1 }, { name: 'right', button: 2, mask: 2 }, { name: 'middle', button: 1, mask: 4 },
] as const;
const KEYS: Record<string, number> = {
  Enter: 40, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56,
  Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, Numpad0: 98,
  NumpadDecimal: 99, NumpadEqual: 103, ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
  ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
};
/** USB Keyboard page, based on physical code. Never guess a remote layout from
 * event.key. Escape stays local so a remote surface cannot trap the operator. */
export function desktopKeyUsage(code: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 65 + 4;
  if (/^Digit[1-9]$/.test(code)) return Number(code.slice(5)) - 1 + 30;
  if (code === 'Digit0') return 39;
  if (/^F([1-9]|1[0-2])$/.test(code)) return Number(code.slice(1)) - 1 + 58;
  if (/^Numpad[1-9]$/.test(code)) return Number(code.slice(6)) - 1 + 89;
  return KEYS[code];
}

/** Pure PC pointer/key policy. No DOM, timer, account or transport owner. */
export class DesktopInputPolicy {
  private context = EMPTY;
  private pointer?: number;
  private buttons = new Set<'left' | 'right' | 'middle'>();
  private keys = new Set<number>();
  private last = { x: 0.5, y: 0.5 };
  constructor(private readonly hooks: { input(message: DesktopInput): void; release(binding: { renderer: string; generation: string }): void;
    unsupported?(binding: { renderer: string; generation: string }): void }) {}
  configure(context: DesktopInputContext): void {
    if (Object.keys(EMPTY).every(key => this.context[key as keyof DesktopInputContext] === context[key as keyof DesktopInputContext])) return;
    const old = this.context;
    this.clear(); this.context = { ...context };
    if (old.renderer !== context.renderer || old.generation !== context.generation) this.last = { x: 0.5, y: 0.5 };
    if (old.generation) this.hooks.release({ renderer: old.renderer, generation: old.generation });
  }
  private emit(input: DesktopInputBody): void {
    if (this.context.renderer && this.context.generation) this.hooks.input({ ...input,
      renderer_id: this.context.renderer, control_generation: this.context.generation });
  }
  private point(x: number, y: number, clamp: boolean): { x: number; y: number } | undefined {
    const video = desktopVideoRect(this.context);
    if (!video) return;
    const point = { x: (x - video.left) / video.width, y: (y - video.top) / video.height };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    if (!clamp && (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return;
    return { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) };
  }
  move(pointer: number, x: number, y: number, buttons?: number): void {
    if (this.pointer !== undefined && this.pointer !== pointer) return;
    // Pointer Events report chord edges as pointermove; pointerdown/up only
    // delimit the first/last held button. Reconcile only an owned drag, never
    // adopt buttons pressed outside the surface or released by local cleanup.
    if (this.pointer === pointer && buttons !== undefined) {
      if (!Number.isInteger(buttons) || buttons < 0 || buttons > 31) { this.cancel(); return; }
      for (const edge of POINTER_BUTTONS) {
        if (this.buttons.has(edge.name) && !(buttons & edge.mask)) this.button(pointer, edge.button, false, x, y);
      }
      for (const edge of POINTER_BUTTONS) {
        if (!this.buttons.has(edge.name) && (buttons & edge.mask)) this.button(pointer, edge.button, true, x, y);
      }
    }
    const point = this.point(x, y, this.buttons.size > 0); if (!point) return;
    this.last = point; this.emit({ kind: 'pointer_move', body: point });
  }
  button(pointer: number, button: number, down: boolean, x: number, y: number): void {
    const name = button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : undefined;
    if (!name) return;
    if (this.pointer !== undefined && this.pointer !== pointer) { if (down) this.cancel(); return; }
    if (!down && !this.buttons.has(name)) return;
    const point = this.point(x, y, !down || this.buttons.size > 0); if (!point) return;
    if (down) { if (this.buttons.has(name)) return; this.pointer = pointer; this.buttons.add(name); }
    else { this.buttons.delete(name); if (this.buttons.size === 0) this.pointer = undefined; }
    this.last = point; this.emit({ kind: 'pointer_button', body: { ...point, button: name, down } });
  }
  wheel(x: number, y: number, dx: number, dy: number, mode: number, lineHeight = 16): void {
    const point = this.point(x, y, false); if (!point || ![dx, dy, lineHeight].every(Number.isFinite) || lineHeight <= 0) return;
    const unit = mode === 0 ? 1 : mode === 1 ? lineHeight : mode === 2 ? this.context.height : 0;
    if (!unit) return;
    const bounded = (value: number) => Math.max(-65536, Math.min(65536, value * unit));
    const delta = { dx: bounded(dx), dy: bounded(dy) };
    if (delta.dx || delta.dy) this.emit({ kind: 'wheel', body: { ...point, ...delta } });
  }
  key(code: string, down: boolean, composing = false): void {
    if (code === 'Escape') { this.cancel(); return; }
    const usage = desktopKeyUsage(code);
    if (composing && down) return;
    if (usage === undefined) {
      if (down && this.context.generation) {
        this.hooks.unsupported?.({ renderer: this.context.renderer, generation: this.context.generation }); this.cancel();
      }
      return;
    }
    if (!down && !this.keys.has(usage)) return;
    if (down) this.keys.add(usage); else this.keys.delete(usage);
    this.emit({ kind: 'key', body: { usage, down } });
  }
  lostCapture(): void { if (this.buttons.size) this.cancel(); }
  clearHeld(): void { this.clear(); }
  private clear(): void {
    for (const button of this.buttons) this.emit({ kind: 'pointer_button', body: { ...this.last, button, down: false } });
    for (const usage of [...this.keys].sort((a, b) => Number(a >= 224) - Number(b >= 224))) this.emit({ kind: 'key', body: { usage, down: false } });
    this.buttons.clear(); this.keys.clear(); this.pointer = undefined;
  }
  cancel(): void {
    const old = this.context;
    this.clear(); this.context = { ...old, generation: '' };
    if (old.generation) this.hooks.release({ renderer: old.renderer, generation: old.generation });
  }
}
