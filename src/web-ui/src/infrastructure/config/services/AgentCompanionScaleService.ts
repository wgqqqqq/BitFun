import { isHarmonyCompanionHost } from './AgentCompanionHostService';
import { createLogger } from '@/shared/utils/logger';

export const MIN_COMPANION_SCALE = 0.75;
// Other desktop hosts still cap the native pet window height at 240 logical pixels.
export const MAX_COMPANION_SCALE = isHarmonyCompanionHost() ? 3 : 2;
const STORAGE_KEY = 'openbitfun.companion.window-scale.v1';
const log = createLogger('AgentCompanionScaleService');

export function clampCompanionScale(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_COMPANION_SCALE, Math.max(MIN_COMPANION_SCALE, value)) : 1;
}

// Window presentation belongs to this controller device, including in peer mode.
// Missing or unreadable preferences retain the original size without deleting data.
export function readCompanionScale(): number {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === null ? 1 : clampCompanionScale(Number(value));
  } catch (error) {
    log.warn('Failed to read companion window scale', error);
    return 1;
  }
}

export function saveCompanionScale(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampCompanionScale(value)));
  } catch (error) {
    log.warn('Failed to save companion window scale', error);
  }
}

export function pinchCompanionScale(initialScale: number, initialDistance: number, distance: number): number {
  return initialDistance > 0 && Number.isFinite(distance)
    ? clampCompanionScale(initialScale * distance / initialDistance)
    : clampCompanionScale(initialScale);
}
