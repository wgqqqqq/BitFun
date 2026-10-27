import { useEffect, useSyncExternalStore } from 'react';
import { remoteDesktopAPI, type RemoteDesktopServiceStatus } from '../api/service-api/RemoteDesktopAPI';

let snapshot: RemoteDesktopServiceStatus | null = null;
let revision = 0;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;

function publish(next: RemoteDesktopServiceStatus): void {
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export const remoteDesktopService = {
  getSnapshot: () => snapshot,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    stop ??= remoteDesktopAPI.onServiceChanged(() => { void remoteDesktopService.refresh().catch(() => {}); });
    return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined; } };
  },
  async refresh(): Promise<void> {
    const request = ++revision;
    const next = await remoteDesktopAPI.serviceStatus();
    if (request === revision) publish(next);
  },
  async connect(url: string, key: string, name: string): Promise<RemoteDesktopServiceStatus> {
    const request = ++revision;
    const next = await remoteDesktopAPI.connectService(url, key, name);
    if (request === revision) publish(next);
    return next;
  },
  async disconnect(): Promise<void> {
    const request = ++revision;
    await remoteDesktopAPI.disconnectService();
    if (request === revision) await remoteDesktopService.refresh();
  },
};

export function useRemoteDesktopService(): RemoteDesktopServiceStatus | null {
  const value = useSyncExternalStore(remoteDesktopService.subscribe, remoteDesktopService.getSnapshot);
  useEffect(() => { void remoteDesktopService.refresh().catch(() => {}); }, []);
  return value;
}
