import { inputMethod } from '@kit.IMEKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { RemoteDesktopInput } from '../model/RemoteDesktopModels';
import { RemoteDesktopKeyboardInput, RemoteKeyboardHooks } from './RemoteDesktopKeyboardInput';

/** One serialized platform IME owner; late callbacks cannot type into a new lease. */
export class RemoteDesktopKeyboardService {
  private static tail: Promise<void> = Promise.resolve();
  private static current: RemoteDesktopKeyboardService | undefined = undefined;
  private active: boolean = false;
  private controller: inputMethod.InputMethodController | undefined = undefined;
  private gate: RemoteDesktopKeyboardInput;
  private timer: number = -1;
  private hooks: RemoteKeyboardHooks;
  private hidden: () => void;
  private renderer: string;
  private generation: string;
  constructor(renderer: string, generation: string, hooks: RemoteKeyboardHooks, hidden: () => void) {
    this.hooks = hooks; this.hidden = hidden; this.renderer = renderer; this.generation = generation;
    this.gate = new RemoteDesktopKeyboardInput(renderer, generation, { input: hooks.input, unavailable: (): void => this.fail() });
  }
  private fail(reason: string = 'input_contract'): void {
    if (!this.active) return;
    console.warn(`Remote desktop IME paused reason=${reason}`);
    this.close(); this.hooks.unavailable();
  }
  private readonly insert = (text: string): void => { if (this.active) this.gate.commit(text); };
  private readonly deleteLeft = (length: number): void => { if (this.active) this.gate.delete(true, length); };
  private readonly deleteRight = (length: number): void => { if (this.active) this.gate.delete(false, length); };
  private readonly preview = (text: string, range: inputMethod.Range): void => { if (this.active) this.gate.setPreview(text, range.start, range.end); };
  private readonly finish = (): void => { if (this.active) this.gate.finishPreview(); };
  private readonly left = (length: number): string => this.active ? this.gate.leftContext(length) : '';
  private readonly right = (_length: number): string => '';
  private readonly index = (): number => this.active ? this.gate.cursor() : 0;
  private readonly selection = (range: inputMethod.Range): void => {
    if (range.start !== 0 || range.end !== 0) this.fail('selection');
  };
  private readonly selectionMove = (_movement: inputMethod.Movement): void => this.fail('selection_movement');
  private readonly extended = (_action: inputMethod.ExtendAction): void => this.fail('extended_action');
  private readonly functionKey = (_key: inputMethod.FunctionKey): void => { if (this.active) this.gate.key(40); };
  private readonly move = (direction: inputMethod.Direction): void => {
    if (!this.active) return;
    if (direction === inputMethod.Direction.CURSOR_LEFT) this.gate.key(80);
    else if (direction === inputMethod.Direction.CURSOR_RIGHT) this.gate.key(79);
    else if (direction === inputMethod.Direction.CURSOR_UP) this.gate.key(82);
    else if (direction === inputMethod.Direction.CURSOR_DOWN) this.gate.key(81);
    else this.fail('cursor_movement');
  };
  private readonly status = (status: inputMethod.KeyboardStatus): void => {
    if (this.active && status === inputMethod.KeyboardStatus.HIDE) { this.close(); this.hidden(); }
  };
  open(textSupported: boolean = true): void {
    RemoteDesktopKeyboardService.current?.close();
    RemoteDesktopKeyboardService.current = this;
    this.active = true;
    if (!textSupported) return; // Physical keys remain usable without Unicode support.
    this.timer = setTimeout((): void => this.fail('attach_timeout'), 5000);
    RemoteDesktopKeyboardService.tail = RemoteDesktopKeyboardService.tail.then(async (): Promise<void> => {
      if (!this.active) return;
      try {
        const c = inputMethod.getController(); this.controller = c;
        c.on('setPreviewText', this.preview); c.on('finishTextPreview', this.finish);
        await c.attach(true, { inputAttribute: { textInputType: inputMethod.TextInputType.TEXT, enterKeyType: inputMethod.EnterKeyType.NEWLINE } });
        if (!this.active) return;
        c.on('insertText', this.insert); c.on('deleteLeft', this.deleteLeft); c.on('deleteRight', this.deleteRight);
        c.on('getLeftTextOfCursor', this.left); c.on('getRightTextOfCursor', this.right); c.on('getTextIndexAtCursor', this.index);
        c.on('sendFunctionKey', this.functionKey); c.on('moveCursor', this.move); c.on('sendKeyboardStatus', this.status);
        c.on('selectByRange', this.selection); c.on('selectByMovement', this.selectionMove); c.on('handleExtendAction', this.extended);
        clearTimeout(this.timer);
      } catch (error) {
        const code = (error as BusinessError).code;
        console.warn(`Remote desktop IME attachment failed: ${Number.isInteger(code) ? code : 0}`);
        this.fail('attach_failed');
      }
    });
  }
  key(usage: number): void { if (this.active) this.gate.key(usage); }
  static beforePointer(message: RemoteDesktopInput): void {
    if (message.kind !== 'pointer_button' || message.body.down !== true) return;
    const current = RemoteDesktopKeyboardService.current;
    if (current && current.renderer === message.renderer_id && current.generation === message.control_generation) {
      current.close(); current.hidden();
    }
  }
  close(): void {
    if (!this.active) return;
    this.active = false; this.gate.close(); clearTimeout(this.timer);
    if (RemoteDesktopKeyboardService.current === this) RemoteDesktopKeyboardService.current = undefined;
    RemoteDesktopKeyboardService.tail = RemoteDesktopKeyboardService.tail.then(async (): Promise<void> => {
      const c = this.controller; this.controller = undefined;
      if (!c) return;
      // Only remove this owner's callbacks. Do not unregister another editor.
      let cleanupFailed = false;
      const remove = (unsubscribe: () => void): void => {
        try { unsubscribe(); } catch (_error) { cleanupFailed = true; }
      };
      // A missing registration or one platform error must not skip unrelated
      // callbacks. Any callback the platform retains is already inactive.
      remove((): void => c.off('setPreviewText', this.preview)); remove((): void => c.off('finishTextPreview', this.finish));
      remove((): void => c.off('insertText', this.insert)); remove((): void => c.off('deleteLeft', this.deleteLeft)); remove((): void => c.off('deleteRight', this.deleteRight));
      remove((): void => c.off('getLeftTextOfCursor', this.left)); remove((): void => c.off('getRightTextOfCursor', this.right)); remove((): void => c.off('getTextIndexAtCursor', this.index));
      remove((): void => c.off('sendFunctionKey', this.functionKey)); remove((): void => c.off('moveCursor', this.move)); remove((): void => c.off('sendKeyboardStatus', this.status));
      remove((): void => c.off('selectByRange', this.selection)); remove((): void => c.off('selectByMovement', this.selectionMove)); remove((): void => c.off('handleExtendAction', this.extended));
      if (cleanupFailed) console.warn('Remote desktop IME callback cleanup incomplete');
      try { await c.detach(); } catch (_error) { /* Keep callbacks inactive. */ }
    });
  }
}
