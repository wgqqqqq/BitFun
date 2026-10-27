import { remoteDesktopService } from '@/infrastructure/remote-desktop/RemoteDesktopService';
import { LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import { deviceDisplayName, type AccountDeviceInfo } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useContentResourceStore } from '@/app/workbench/contentResourceStore';

export interface RemoteDesktopResourceData { serviceId: string; generation: string; device: AccountDeviceInfo; }

/** A controller-local content resource. Opening never activates a Peer or session. */
export function openRemoteDesktopResource(serviceId: string, device: AccountDeviceInfo, title: string): string {
  const current = remoteDesktopService.getSnapshot();
  if (!current?.connected || current.service_id !== serviceId) throw new Error('controller_context_changed');
  if (!device.online || (device.device_kind && device.device_kind !== 'desktop')) throw new Error('unsupported');
  const data: RemoteDesktopResourceData = { serviceId, generation:current.generation, device: { device_id: device.device_id,
    device_name: deviceDisplayName(device), device_kind: device.device_kind, online: device.online, last_seen_at: device.last_seen_at } };
  const id = useContentResourceStore.getState().open({ type: 'remote-desktop', title, data },
    { surfaceId: LOCAL_SURFACE_ID }, JSON.stringify([serviceId, current.generation, device.device_id]));
  useSceneStore.getState().openContentScene(id);
  return id;
}
