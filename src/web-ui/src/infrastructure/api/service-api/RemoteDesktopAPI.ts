import { getTransportAdapter } from '../adapters';
import type { RemoteDesktopQuality } from '../../remote-desktop/RemoteDesktopQuality';
import type { AccountDeviceInfo } from './RemoteConnectAPI';
import { api } from './ApiClient';

export interface RemoteDesktopServiceStatus {
  generation: string;
  connected: boolean;
  service_url: string | null;
  device_id: string | null;
  service_id: string | null;
}

export interface RemoteDesktopDisplay {
  display_id: string;
  width: number;
  height: number;
}
export interface RemoteDesktopViewGrant {
  account_id: string;
  device_id: string;
  public_key_fingerprint: string;
  display_ids: string[];
  control_display_ids?: string[];
}
export interface RemoteDesktopLocalSettings {
  controller_directory_state?: 'ready' | 'unsupported' | 'unavailable';
  controller_devices?: RemoteDesktopControllerDevice[];
  displays: RemoteDesktopDisplay[];
  grants: RemoteDesktopViewGrant[];
  storage_available: boolean;
  availability: string;
  state_revision: string;
  control_grant_supported?: boolean;
  control_available?: boolean;
}
export interface RemoteDesktopControllerDevice {
  device_id: string;
  device_kind: string;
  device_name?: string | null;
  device_alias?: string | null;
}

/** Local request fence; never a remote grant or DataChannel input envelope. */
export interface RemoteDesktopControllerContext {
  account_generation: string;
  connection_id: string;
  socket_generation: string;
  target_device_id: string;
  public_key_fingerprint: string;
}
export type RemoteDesktopSignalRequest = { version: 1 } & (
  | { op: 'capabilities' | 'list_displays' | 'get_state' }
  | { op: 'attach'; body: { attach_id: string; expected_state_revision: string; display_id: string; force_relay?: boolean } }
  | { op: 'signal'; body: { attach_id: string; connection_id: string; answer_sdp: string } }
  | { op: 'suspend' | 'resume'; body: { attach_id: string; expected_state_revision: string } }
  | { op: 'select_display'; body: { attach_id: string; expected_state_revision: string; display_id: string } }
  | { op: 'set_quality'; body: { attach_id: string; expected_state_revision: string; quality: RemoteDesktopQuality } }
  | { op: 'detach'; body: { attach_id: string } }
);
export interface RemoteDesktopSignalReply {
  context: RemoteDesktopControllerContext;
  payload: Record<string, unknown>;
}
export interface RemoteDesktopTurnCredentials {
  target_device_id: string;
  attach_id: string;
  expires_at: number;
  ice_servers: { urls: string[]; username: string; credential: string }[];
}

// Registry-derived ControllerLocal routing keeps this computer's trust settings
// local even while the shell displays a peer workspace.
export const remoteDesktopAPI = {
  receiver: (request: Record<string, unknown>) => getTransportAdapter().request<unknown>('remote_desktop_receiver', { request }),
  serviceStatus: () => getTransportAdapter().request<RemoteDesktopServiceStatus>('remote_desktop_service_status', { request: {} }),
  connectService: (serviceUrl: string, pairingKey: string, deviceName: string) => getTransportAdapter().request<RemoteDesktopServiceStatus>(
    'remote_desktop_service_connect', { request: { service_url: serviceUrl, pairing_key: pairingKey || null, device_name: deviceName } }),
  disconnectService: () => getTransportAdapter().request<void>('remote_desktop_service_disconnect', { request: {} }),
  serviceDevices: () => getTransportAdapter().request<AccountDeviceInfo[]>('remote_desktop_service_devices', { request: {} }),
  onServiceChanged: (handler: () => void) => api.listen('remote-desktop-service-changed', handler),
  // Only the initial capabilities probe may omit context. Keep the returned
  // context for the attachment; never refresh it to retry an old mutation.
  request: (targetDeviceId: string, payload: RemoteDesktopSignalRequest,
    context?: RemoteDesktopControllerContext, attachId?: string) => getTransportAdapter().request<RemoteDesktopSignalReply>(
    'remote_desktop_request', { request: { target_device_id: targetDeviceId, payload, context, attach_id: attachId } }),
  turn: (targetDeviceId: string, attachId: string, context: RemoteDesktopControllerContext) =>
    getTransportAdapter().request<RemoteDesktopTurnCredentials>('remote_desktop_turn', {
      request: { target_device_id: targetDeviceId, attach_id: attachId, context },
    }),
  captureConsent: (action: 'request' | 'open_settings') => getTransportAdapter().request<unknown>(
    'remote_desktop_capture_consent', { request: { action } }),
  settings: () => getTransportAdapter().request<RemoteDesktopLocalSettings>(
    'remote_desktop_local_settings', { request: {} }),
  approveView: (deviceId: string, displayId: string) => getTransportAdapter().request<void>(
    'remote_desktop_approve_view', { request: { device_id: deviceId, display_ids: [displayId] } }),
  approveControl: (deviceId: string, displayId: string) => getTransportAdapter().request<void>(
    'remote_desktop_approve_control', { request: { device_id: deviceId, display_ids: [displayId] } }),
  revokeView: (deviceId: string) => getTransportAdapter().request<void>(
    'remote_desktop_revoke_view', { request: { device_id: deviceId } }),
  stop: () => getTransportAdapter().request<void>('remote_desktop_local_stop', { request: {} }),
};
