/** Closed v1 wire choices. Labels belong to the surface; encoder limits to the host. */
export const REMOTE_DESKTOP_QUALITIES = ['data_saver', 'balanced', 'clear'] as const;
export type RemoteDesktopQuality = typeof REMOTE_DESKTOP_QUALITIES[number];
export const isRemoteDesktopQuality = (value: unknown): value is RemoteDesktopQuality =>
  REMOTE_DESKTOP_QUALITIES.some(quality => quality === value);
