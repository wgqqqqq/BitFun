/** @vitest-environment jsdom */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DesktopFullscreen, type DesktopFullscreenState } from './DesktopFullscreen';

let active: Element | null, request: ReturnType<typeof vi.fn>, exit: ReturnType<typeof vi.fn>;
const instances: DesktopFullscreen[] = [], elements: HTMLElement[] = [];
const changed = () => document.dispatchEvent(new Event('fullscreenchange'));
function fixture() {
  const element = document.createElement('section'); document.body.append(element); elements.push(element);
  const retireInput = vi.fn(), states: DesktopFullscreenState[] = [];
  const owner = new DesktopFullscreen(element, { retireInput, changed: state => states.push(state) }); instances.push(owner);
  return { owner, element, retireInput, states, state: () => states.at(-1)! };
}
beforeEach(() => {
  active = null;
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => active });
  request = vi.fn(function (this: Element) { active = this; changed(); return Promise.resolve(); });
  exit = vi.fn(() => { active = null; changed(); return Promise.resolve(); });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
});
afterEach(async () => {
  for (const instance of instances.splice(0)) instance.dispose();
  await Promise.resolve(); for (const element of elements.splice(0)) element.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
  Reflect.deleteProperty(document, 'exitFullscreen');
  Reflect.deleteProperty(document, 'fullscreenEnabled');
  Reflect.deleteProperty(document, 'fullscreenElement');
  vi.unstubAllGlobals();
});
it('retires input before requesting local fullscreen and captures Escape before remote input handlers', async () => {
  const f = fixture(); request.mockImplementationOnce(function (this: Element) {
    expect(f.retireInput).toHaveBeenCalledOnce(); active = this; changed(); return Promise.resolve();
  });
  await f.owner.enter(); expect(f.state()).toMatchObject({ supported: true, active: true, pending: false, failed: false });
  const remote = vi.fn(); f.element.addEventListener('keydown', remote);
  f.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await Promise.resolve(); expect(remote).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledOnce(); expect(f.state().active).toBe(false);
});
it('retires a newly held lease when the OS exits fullscreen independently', async () => {
  const f = fixture(); await f.owner.enter(); f.retireInput.mockClear(); active = null; changed();
  expect(f.retireInput).toHaveBeenCalledOnce(); expect(f.state().active).toBe(false);
});
it('cancels late entry after hiding without letting another viewer stack on its pending request', async () => {
  const f = fixture(), other = fixture(); let complete!: () => void;
  request.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const entering = f.owner.enter(), exiting = f.owner.exit(); await other.owner.enter();
  expect(request).toHaveBeenCalledOnce(); expect(other.state().failed).toBe(true);
  active = f.element; changed(); complete(); await Promise.all([entering, exiting]); await Promise.resolve();
  expect(active).toBeNull(); await other.owner.enter(); expect(active).toBe(other.element);
});
it('disposes an in-flight request and cleans its late success without publishing after retirement', async () => {
  const f = fixture(); let complete!: () => void;
  request.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const entering = f.owner.enter(); f.owner.dispose(); const updates = f.states.length;
  active = f.element; complete(); await entering;
  expect(active).toBeNull(); expect(f.states).toHaveLength(updates);
});
it('waits for the native exit to settle for every caller before releasing document ownership', async () => {
  const f = fixture(), other = fixture(); await f.owner.enter();
  let complete!: () => void;
  exit.mockImplementationOnce(() => {
    active = null; changed(); return new Promise<void>(resolve => { complete = resolve; });
  });
  const firstDone = vi.fn(), secondDone = vi.fn();
  const first = f.owner.exit().then(firstDone), second = f.owner.exit().then(secondDone);
  await Promise.resolve();
  expect(f.state().pending).toBe(true); expect(firstDone).not.toHaveBeenCalled(); expect(secondDone).not.toHaveBeenCalled();
  await other.owner.enter(); expect(other.state().failed).toBe(true); expect(request).toHaveBeenCalledOnce();
  complete(); await Promise.all([first, second]);
  expect(exit).toHaveBeenCalledOnce(); expect(f.state().pending).toBe(false);
  await other.owner.enter(); expect(active).toBe(other.element);
});
it('cancels a rejected pending entry without poisoning the next explicit request', async () => {
  const f = fixture(); let reject!: (error: Error) => void;
  request.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
  const entering = f.owner.enter(), exiting = f.owner.exit();
  reject(new Error('native transition rejected')); await Promise.all([entering, exiting]);
  expect(f.state()).toMatchObject({ active: false, pending: false, failed: false }); expect(exit).not.toHaveBeenCalled();
  await f.owner.enter(); expect(f.state()).toMatchObject({ active: true, pending: false, failed: false });
});
it('never exits another surface and reports unsupported/rejected requests without changing it', async () => {
  const f = fixture(), other = fixture(); active = other.element; await f.owner.enter(); expect(f.state().failed).toBe(true);
  await f.owner.exit(); expect(f.state().failed).toBe(false); expect(request).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
  active = null; request.mockRejectedValueOnce(new Error('denied')); await f.owner.enter(); expect(f.state()).toMatchObject({ active: false, pending: false, failed: true });
  vi.spyOn(document, 'fullscreenEnabled', 'get').mockReturnValue(false);
  const unsupported = fixture(); await unsupported.owner.enter(); expect(unsupported.state().supported).toBe(false);
});
it('does not reveal its abandoned fullscreen underneath an unrelated surface', async () => {
  const f = fixture(), external = document.createElement('aside'); document.body.append(external); elements.push(external);
  request.mockImplementationOnce(() => { active = external; changed(); return Promise.resolve(); });
  await f.owner.enter(); expect(active).toBe(external); expect(f.state().failed).toBe(true); expect(exit).not.toHaveBeenCalled();
  active = f.element; changed(); await Promise.resolve(); expect(active).toBeNull();
});
