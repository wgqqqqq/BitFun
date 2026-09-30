/** True when running inside the Tauri desktop shell (not pure browser dev). */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/** Manual update actions are available in every desktop build. */
export function canCheckForAppUpdates(): boolean {
  if (!isTauriRuntime()) return false;
  const host = window as Window & {
    __OPENBITFUN_HOST_CAPABILITIES__?: { desktopUpdater?: boolean };
  };
  // Older desktop hosts do not advertise this field. Preserve their update path.
  return host.__OPENBITFUN_HOST_CAPABILITIES__?.desktopUpdater !== false;
}

/** Development builds skip background discovery. */
export function canAutoCheckForAppUpdates(): boolean {
  return canCheckForAppUpdates() && !import.meta.env.DEV;
}
