import { RemoteDesktopInput, RemoteDesktopInputBody } from '../model/RemoteDesktopModels';

export interface RemoteKeyboardHooks {
  input: (message: RemoteDesktopInput) => void;
  unavailable: () => void;
}

/** Input-only IME proxy. It never mirrors or guesses the remote field's text. */
export class RemoteDesktopKeyboardInput {
  private active: boolean = true;
  private preview: string = '';
  private composing: boolean = false;
  private renderer: string;
  private generation: string;
  private hooks: RemoteKeyboardHooks;
  constructor(renderer: string, generation: string, hooks: RemoteKeyboardHooks) {
    this.renderer = renderer; this.generation = generation; this.hooks = hooks;
  }
  close(): void { this.active = false; this.preview = ''; this.composing = false; }
  private fail(): void { if (this.active) { this.close(); this.hooks.unavailable(); } }
  private valid(text: string): boolean {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit === 0) return false;
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = text.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
        bytes += 4;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
      else bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
      if (bytes > 4096) return false;
    }
    return true;
  }
  private emit(kind: string, body: RemoteDesktopInputBody): void {
    if (this.active && this.renderer && this.generation) {
      this.hooks.input({ renderer_id: this.renderer, control_generation: this.generation, kind, body });
    }
  }
  commit(text: string): void {
    if (!this.active) return;
    if (!this.valid(text)) { this.fail(); return; }
    this.preview = ''; this.composing = false;
    const parts = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    parts.forEach((part: string, index: number): void => {
      if (index > 0) this.key(40);
      if (part.length > 0) this.emit('text_commit', { text: part });
    });
  }
  setPreview(text: string, start: number, end: number): void {
    if (!this.active) return;
    if (!this.valid(text)) { this.fail(); return; }
    let next = text;
    if (start !== -1 || end !== -1) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > this.preview.length) { this.fail(); return; }
      next = this.preview.slice(0, start) + text + this.preview.slice(end);
    }
    if (!this.valid(next)) { this.fail(); return; }
    this.preview = next; this.composing = true;
  }
  finishPreview(): void { if (this.composing) this.commit(this.preview); }
  leftContext(length: number): string {
    if (!this.active || !this.composing || !Number.isInteger(length) || length < 1) return '';
    const text = this.preview.slice(-Math.min(length, 1024));
    const first = text.charCodeAt(0);
    return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
  }
  cursor(): number { return this.active && this.composing ? this.preview.length : 0; }
  delete(left: boolean, length: number): void {
    if (!this.active) return;
    if (!Number.isInteger(length) || length < 1) { this.fail(); return; }
    if (this.composing) {
      if (left) this.preview = this.preview.slice(0, Math.max(0, this.preview.length - length));
      if (!this.valid(this.preview)) this.fail();
      return;
    }
    // IME deletion lengths are UTF-16 units. Without the remote field context,
    // bulk deletion cannot safely be converted into that many backspaces.
    if (length !== 1) { this.fail(); return; }
    this.key(left ? 42 : 76);
  }
  key(usage: number): void {
    if (!this.active) return;
    if (this.composing) { this.fail(); return; }
    this.emit('key', { usage, down: true }); this.emit('key', { usage, down: false });
  }
}
