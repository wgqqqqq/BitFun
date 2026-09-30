type TauriInternals = {
  invoke?: unknown;
  metadata?: {
    currentWindow?: {
      label?: string;
    };
  };
};

const getTauriInternals = (): TauriInternals | undefined => {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
};

export const isTauriRuntime = (): boolean => {
  const internals = getTauriInternals();
  return typeof internals?.invoke === 'function';
};

export const supportsNativeWindowControls = (): boolean => {
  // System-decorated hosts own their controls and dragging. This flag belongs to
  // the local controller even when product commands are routed to a peer.
  if (typeof window !== 'undefined') {
    const host = window as Window & {
      __OPENBITFUN_HOST_CAPABILITIES__?: { nativeWindowControls?: boolean };
    };
    if (host.__OPENBITFUN_HOST_CAPABILITIES__?.nativeWindowControls === false) return false;
  }
  // Tauri window APIs read metadata.currentWindow; browser builds must not call them without it.
  const currentWindow = getTauriInternals()?.metadata?.currentWindow;
  return isTauriRuntime() && typeof currentWindow?.label === 'string';
};

export const supportsNativeWindowDragging = supportsNativeWindowControls;

export const isMacOSDesktopRuntime = (): boolean =>
  supportsNativeWindowControls() &&
  typeof navigator !== 'undefined' &&
  typeof navigator.platform === 'string' &&
  navigator.platform.toUpperCase().includes('MAC');

export const isWindowsDesktopRuntime = (): boolean =>
  supportsNativeWindowControls() &&
  typeof navigator !== 'undefined' &&
  (
    (typeof navigator.userAgent === 'string' && navigator.userAgent.toUpperCase().includes('WINDOWS'))
    || (typeof navigator.platform === 'string' && navigator.platform.toUpperCase().includes('WIN'))
  );
