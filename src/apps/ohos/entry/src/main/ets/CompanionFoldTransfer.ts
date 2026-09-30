export interface FoldRect { left: number; top: number; width: number; height: number }
export interface FoldTransferTarget { x: number; y: number }

/** Physical pixels throughout; the crease comes from DisplayManager, not half the screen height. */
export function companionFoldTarget(
  before: FoldRect, x: number, y: number, crease: FoldRect,
  screen: FoldRect, threshold: number, margin: number,
): FoldTransferTarget | null {
  if (crease.width <= crease.height || before.height + margin * 2 > crease.top - screen.top
    || before.height + margin * 2 > screen.top + screen.height - crease.top - crease.height) return null;
  const movingDown = y > before.top;
  const movingUp = y < before.top;
  let targetY: number;
  if (movingDown && before.top + before.height / 2 < crease.top
    && y + before.height >= crease.top - threshold) {
    targetY = crease.top + crease.height + margin;
  } else if (movingUp && before.top + before.height / 2 > crease.top + crease.height
    && y <= crease.top + crease.height + threshold) {
    targetY = crease.top - before.height - margin;
  } else return null;
  const targetX = Math.min(screen.left + screen.width - before.width - margin, Math.max(screen.left + margin, x));
  if (targetX + before.width <= crease.left || targetX >= crease.left + crease.width) return null;
  return { x: Math.round(targetX), y: Math.round(targetY) };
}
