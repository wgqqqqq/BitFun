import { createLogger } from '@/shared/utils/logger';
import { getCompanionWindow } from './AgentCompanionHostService';
import { LogicalPosition } from '@tauri-apps/api/window';

const log = createLogger('AgentCompanionPointerDragService');

export interface CompanionPointerPosition { x: number; y: number }
export interface CompanionPointerDrag {
  move: (position: CompanionPointerPosition) => void;
  finish: () => void;
  cancel: () => void;
}

/**
 * Host-normalized pointer coordinates and window positions share logical screen
 * space. Capture the window origin at pointer-down, then coalesce pointer moves
 * while an IPC is in flight. No global cursor polling or native drag handoff.
 */
export function prepareAgentCompanionPointerDrag(
  grab: CompanionPointerPosition,
  onDirection: (direction: 'left' | 'right') => void,
  onError: (error: unknown) => void,
): CompanionPointerDrag {
  const petWindow = getCompanionWindow();
  petWindow.beginDrag?.();
  let origin: CompanionPointerPosition | null = null;
  let latest: CompanionPointerPosition | null = null;
  let previous = grab;
  let direction: 'left' | 'right' | null = null;
  let directionAnchorX = grab.x;
  let cancelled = false;
  let finished = false;
  let moving = false;

  const updateDirection = (pointer: CompanionPointerPosition) => {
    // Only the facing direction has hysteresis; every pointer position still moves the window.
    if (direction === 'right') directionAnchorX = Math.max(directionAnchorX, pointer.x);
    if (direction === 'left') directionAnchorX = Math.min(directionAnchorX, pointer.x);
    const horizontalTravel = pointer.x - directionAnchorX;
    if (Math.abs(horizontalTravel) >= 12) {
      const nextDirection = horizontalTravel > 0 ? 'right' : 'left';
      if (nextDirection !== direction) {
        log.info('Drag facing changed', { from: direction, to: nextDirection, pointerX: pointer.x, anchorX: directionAnchorX, horizontalTravel, native: !!petWindow.usesNativePointer });
        onDirection(nextDirection);
      }
      direction = nextDirection;
      directionAnchorX = pointer.x;
    }
  };

  const cancel = () => { cancelled = true; latest = null; };
  const fail = (error: unknown) => {
    if (cancelled) return;
    cancel();
    onError(error);
  };
  const flush = async () => {
    if (cancelled || moving || !origin || !latest) return;
    moving = true;
    try {
      while (!cancelled && latest) {
        const pointer = latest;
        latest = null;
        const response = await petWindow.setPosition(new LogicalPosition(
          origin.x + pointer.x - grab.x,
          origin.y + pointer.y - grab.y,
        ));
        if (response?.transferred) { cancel(); return; }
        if (petWindow.usesNativePointer && !cancelled) {
          if (direction === null && response?.grabX !== undefined) directionAnchorX = response.grabX;
          updateDirection(response?.pointer ?? pointer);
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      moving = false;
    }
  };

  void Promise.all([petWindow.outerPosition(), petWindow.scaleFactor()])
    .then(([position, scale]) => {
      if (cancelled) return;
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid companion window scale factor');
      origin = { x: position.x / scale, y: position.y / scale };
      void flush();
    }).catch(fail);

  return {
    move: pointer => {
      if (cancelled || finished) return;
      if (pointer.x === previous.x && pointer.y === previous.y) return;
      if (!petWindow.usesNativePointer) updateDirection(pointer);
      previous = pointer;
      latest = pointer;
      void flush();
    },
    // A quick release may precede origin acquisition or the last IPC. Keep the
    // final requested position, but accept no further pointer events.
    finish: () => { finished = true; void flush(); },
    cancel,
  };
}
