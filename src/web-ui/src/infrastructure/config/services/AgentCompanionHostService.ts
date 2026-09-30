import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, type LogicalPosition } from '@tauri-apps/api/window';

export function isHarmonyCompanionHost(): boolean {
  return typeof window !== 'undefined' && (window as Window & { __OPENBITFUN_COMPANION_HOST__?: string }).__OPENBITFUN_COMPANION_HOST__ === 'ohos';
}

let nextCompanionDragId = Date.now();

interface CompanionWindowHost {
  usesNativePointer?: boolean;
  beginDrag?(): void;
  hide(): Promise<void>;
  setFocus(): Promise<void>;
  outerPosition(): Promise<{ x: number; y: number }>;
  scaleFactor(): Promise<number>;
  setPosition(position: LogicalPosition): Promise<void | { pointer?: { x: number; y: number }; grabX?: number; transferred?: boolean }>;
}

export function getCompanionWindow(): CompanionWindowHost {
  if (!isHarmonyCompanionHost()) return getCurrentWindow();
  const operation = <T>(action: string, values: Record<string, number> = {}) =>
    invoke<T>('plugin:companion|operation', { request: { action, ...values } });
  let dragId: number | undefined;
  return {
    usesNativePointer: true,
    beginDrag: () => { dragId = ++nextCompanionDragId; },
    hide: () => operation<void>('hide'),
    setFocus: () => operation<void>('focus'),
    outerPosition: () => operation<{ x: number; y: number }>('position'),
    scaleFactor: () => operation<number>('scale'),
    setPosition: ({ x, y }) => operation<{ pointer?: { x: number; y: number }; grabX?: number; transferred?: boolean }>('move', { x, y, ...(dragId === undefined ? {} : { dragId }) }),
  };
}

/** ArkWeb touch screenX/Y are window-relative; both terms below use CSS pixels. */
export function getCompanionPointerPosition(event: {
  clientX: number; clientY: number; screenX: number; screenY: number;
}): { x: number; y: number } {
  if (isHarmonyCompanionHost()) {
    return { x: window.screenX + event.clientX, y: window.screenY + event.clientY };
  }
  return { x: event.screenX, y: event.screenY };
}
