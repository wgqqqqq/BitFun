import { afterEach, expect, it, vi } from 'vitest';
import { clampCompanionScale, pinchCompanionScale, readCompanionScale, saveCompanionScale } from './AgentCompanionScaleService';
vi.mock('./AgentCompanionHostService', () => ({ isHarmonyCompanionHost: () => true }));
afterEach(() => vi.unstubAllGlobals());
it('bounds pinch distance, including invalid and coincident touches', () => {
  expect(pinchCompanionScale(1, 100, 150)).toBe(1.5);
  expect(pinchCompanionScale(1, 100, 1)).toBe(0.75);
  expect(pinchCompanionScale(1, 100, 900)).toBe(3);
  expect(pinchCompanionScale(1, 0, 90)).toBe(1);
  expect(clampCompanionScale(NaN)).toBe(1);
});
it('keeps original size on old installs and round trips the device preference', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  expect(readCompanionScale()).toBe(1);
  saveCompanionScale(1.5);
  expect(readCompanionScale()).toBe(1.5);
  saveCompanionScale(2.5);
  expect(readCompanionScale()).toBe(2.5);
  saveCompanionScale(0.01);
  expect(readCompanionScale()).toBe(0.75);
  values.set('openbitfun.companion.window-scale.v1', 'unreadable');
  expect(readCompanionScale()).toBe(1);
  expect(values.get('openbitfun.companion.window-scale.v1')).toBe('unreadable');
});
