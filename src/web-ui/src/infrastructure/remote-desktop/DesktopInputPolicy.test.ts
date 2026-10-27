import { expect, it, vi } from 'vitest';
import { DesktopInputPolicy, desktopKeyUsage } from './DesktopInputPolicy';
import type { DesktopInput } from './RemoteDesktopController';

const context = { renderer: 'r', generation: '6', left: 100, top: 50, width: 1000, height: 1000, sourceWidth: 2000, sourceHeight: 1000 };
function fixture() {
  const inputs: DesktopInput[] = [], release = vi.fn();
  const policy = new DesktopInputPolicy({ input: input => inputs.push(input), release }); policy.configure(context);
  return { policy, inputs, release };
}
it('maps the actual video rectangle and ignores letterbox areas', () => {
  const f = fixture(); f.policy.button(1, 0, true, 600, 100); expect(f.inputs).toEqual([]);
  f.policy.move(1, 600, 550); expect(f.inputs.at(-1)).toMatchObject({ kind: 'pointer_move', body: { x: 0.5, y: 0.5 } });
  f.policy.button(1, 0, true, 100, 300); f.policy.move(1, 2000, -100); f.policy.button(1, 0, false, 2000, -100);
  expect(f.inputs.slice(-3)).toMatchObject([
    { kind: 'pointer_button', body: { x: 0, y: 0, down: true } },
    { kind: 'pointer_move', body: { x: 1, y: 0 } },
    { kind: 'pointer_button', body: { x: 1, y: 0, down: false } },
  ]);
  expect(f.inputs.every(input => input.renderer_id === 'r' && input.control_generation === '6')).toBe(true);
});
it('pairs clicks without inventing double-clicks and does not cancel after normal pointer release', () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) { f.policy.button(1, 2, true, 600, 550); f.policy.button(1, 2, false, 600, 550); f.policy.lostCapture(); }
  expect(f.inputs).toHaveLength(4); expect(f.release).not.toHaveBeenCalled();
  expect(f.inputs.every(input => input.kind === 'pointer_button' && input.body.button === 'right')).toBe(true);
});
it('reconciles chorded buttons reported by pointermove without duplicating edges', () => {
  const f = fixture();
  f.policy.button(1, 0, true, 600, 550);
  f.policy.move(1, 600, 550, 3); // Right pressed while left remains down.
  f.policy.move(1, 620, 550, 3);
  f.policy.move(1, 620, 550, 2); // Left released while right remains down.
  f.policy.button(1, 2, false, 620, 550);
  f.policy.lostCapture();
  expect(f.inputs.filter(input => input.kind === 'pointer_button').map(input => input.body)).toEqual([
    { x: 0.5, y: 0.5, button: 'left', down: true },
    { x: 0.5, y: 0.5, button: 'right', down: true },
    { x: 0.52, y: 0.5, button: 'left', down: false },
    { x: 0.52, y: 0.5, button: 'right', down: false },
  ]);
  expect(f.release).not.toHaveBeenCalled();
});
it('does not adopt a held button from outside the surface or after local cleanup', () => {
  const f = fixture();
  f.policy.move(1, 600, 550, 1);
  f.policy.button(1, 0, true, 600, 550);
  f.policy.move(2, 600, 550, 3);
  f.policy.clearHeld();
  f.policy.move(1, 600, 550, 3);
  expect(f.inputs.filter(input => input.kind === 'pointer_button').map(input => input.body)).toEqual([
    { x: 0.5, y: 0.5, button: 'left', down: true },
    { x: 0.5, y: 0.5, button: 'left', down: false },
  ]);
  expect(f.release).not.toHaveBeenCalled();
});
it('keeps chord edges clamped to the remote screen while a captured drag leaves the viewport', () => {
  const f = fixture();
  f.policy.button(1, 0, true, 600, 550);
  f.policy.move(1, 2000, -100, 3);
  f.policy.move(1, 2000, -100, 2);
  f.policy.button(1, 2, false, 2000, -100);
  expect(f.inputs.filter(input => input.kind === 'pointer_button').slice(1).map(input => input.body)).toEqual([
    { x: 1, y: 0, button: 'right', down: true },
    { x: 1, y: 0, button: 'left', down: false },
    { x: 1, y: 0, button: 'right', down: false },
  ]);
});
it('cleans every held chord button once and ignores later snapshots after cancellation', () => {
  const f = fixture();
  f.policy.button(1, 0, true, 600, 550);
  f.policy.move(1, 600, 550, 7);
  f.policy.cancel();
  const edges = f.inputs.filter(input => input.kind === 'pointer_button').map(input => [input.body.button, input.body.down]);
  expect(edges).toEqual([['left', true], ['right', true], ['middle', true], ['left', false], ['right', false], ['middle', false]]);
  const stopped = f.inputs.length;
  f.policy.move(1, 600, 550, 7); f.policy.button(1, 2, false, 600, 550);
  expect(f.inputs).toHaveLength(stopped);
  expect(f.release).toHaveBeenCalledOnce();
});
it('cleans held input before a scoped release and rejects a second pointer', () => {
  const f = fixture(); f.policy.key('ControlLeft', true); f.policy.key('KeyA', true); f.policy.button(1, 0, true, 600, 550);
  f.policy.button(2, 0, true, 600, 550);
  expect(f.inputs.slice(-3)).toMatchObject([
    { kind: 'pointer_button', body: { down: false } }, { kind: 'key', body: { usage: 4, down: false } },
    { kind: 'key', body: { usage: 224, down: false } },
  ]);
  expect(f.release).toHaveBeenCalledWith({ renderer: 'r', generation: '6' });
  const stopped = f.inputs.length; f.policy.key('KeyB', true); f.policy.move(2, 600, 550); expect(f.inputs).toHaveLength(stopped);
});
it('releases old geometry/lease state without giving old cleanup authority over a new lease', () => {
  const f = fixture(); f.policy.key('AltRight', true);
  f.policy.configure({ ...context, renderer: 'new', generation: '7', width: 500 });
  expect(f.inputs.at(-1)).toMatchObject({ renderer_id: 'r', control_generation: '6', body: { down: false } });
  expect(f.release).toHaveBeenCalledWith({ renderer: 'r', generation: '6' });
  f.policy.key('ArrowLeft', true);
  expect(f.inputs.at(-1)).toMatchObject({ renderer_id: 'new', control_generation: '7', body: { usage: 80, down: true } });
});
it('uses physical keyboard codes, handles repeats, and keeps IME composition local', () => {
  const f = fixture(); f.policy.key('KeyZ', true, true); expect(f.inputs).toEqual([]);
  f.policy.key('KeyZ', true); f.policy.key('KeyZ', true); f.policy.key('KeyZ', false); f.policy.key('KeyZ', false);
  expect(f.inputs).toHaveLength(3); expect(f.inputs[0]).toMatchObject({ body: { usage: 29 } });
  expect(desktopKeyUsage('Digit0')).toBe(39); expect(desktopKeyUsage('F12')).toBe(69);
  expect(desktopKeyUsage('Numpad9')).toBe(97); expect(desktopKeyUsage('MetaRight')).toBe(231);
  expect(desktopKeyUsage('CapsLock')).toBeUndefined(); expect(desktopKeyUsage('Unidentified')).toBeUndefined();
  f.policy.key('Escape', true); expect(f.release).toHaveBeenCalledWith({ renderer: 'r', generation: '6' });
  const unsupported = vi.fn(), release = vi.fn();
  const policy = new DesktopInputPolicy({ input: vi.fn(), release, unsupported }); policy.configure(context);
  policy.key('CapsLock', true);
  expect(unsupported).toHaveBeenCalledWith({ renderer: 'r', generation: '6' }); expect(release).toHaveBeenCalledTimes(1);
});
it('normalizes wheel units, bounds deltas, and rejects invalid geometry', () => {
  const f = fixture(); f.policy.wheel(600, 100, 1, 2, 0); expect(f.inputs).toEqual([]);
  f.policy.wheel(600, 550, 0, 2, 1, 20); expect(f.inputs.at(-1)).toMatchObject({ kind: 'wheel', body: { dy: 40 } });
  f.policy.wheel(600, 550, 0, 2, 2); expect(f.inputs.at(-1)).toMatchObject({ kind: 'wheel', body: { dy: 2000 } });
  f.policy.wheel(600, 550, 1e9, -1e9, 0); expect(f.inputs.at(-1)).toMatchObject({ kind: 'wheel', body: { dx: 65536, dy: -65536 } });
  f.policy.configure({ ...context, width: 0 }); const before = f.inputs.length;
  f.policy.move(1, NaN, 0); f.policy.button(1, 0, true, 1, 1); expect(f.inputs).toHaveLength(before);
});
it('maps the visible portion of an actual-size canvas after local scrolling', () => {
  const f = fixture();
  f.policy.configure({ ...context, left: -220, top: -180, width: 1280, height: 828, sourceWidth: 1280, sourceHeight: 828 });
  f.inputs.length = 0;
  f.policy.button(1, 0, true, 420, 234);
  expect(f.inputs).toMatchObject([{ kind: 'pointer_button', body: { x: 0.5, y: 0.5, down: true } }]);
  f.policy.button(1, 0, false, 420, 234);
  expect(f.inputs.at(-1)).toMatchObject({ body: { x: 0.5, y: 0.5, down: false } });
});
