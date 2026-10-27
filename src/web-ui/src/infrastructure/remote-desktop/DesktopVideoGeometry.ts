export interface DesktopVideoRect { left: number; top: number; width: number; height: number; }
export interface DesktopVideoGeometry extends DesktopVideoRect { sourceWidth: number; sourceHeight: number; }

/** CSS-pixel content rectangle for object-fit: contain. No DOM or renderer state. */
export function desktopVideoRect(geometry: DesktopVideoGeometry): DesktopVideoRect | undefined {
  const { left, top, width, height, sourceWidth, sourceHeight } = geometry;
  if (![left, top, width, height, sourceWidth, sourceHeight].every(Number.isFinite)
    || [width, height, sourceWidth, sourceHeight].some(value => value <= 0)) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const videoWidth = sourceWidth * scale, videoHeight = sourceHeight * scale;
  const result = { left: left + (width - videoWidth) / 2, top: top + (height - videoHeight) / 2,
    width: videoWidth, height: videoHeight };
  if (!Object.values(result).every(Number.isFinite) || videoWidth <= 0 || videoHeight <= 0) return;
  return result;
}
