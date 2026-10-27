/** Dedicated v1 desktop wire shapes. Never sent as RemoteCommand or HostInvoke. */
export interface RemoteDesktopError { code: string; retryable?: boolean; }
export interface RemoteDesktopDisplay { display_id: string; width: number; height: number; }
export const REMOTE_DESKTOP_QUALITIES: string[] = ['data_saver', 'balanced', 'clear'];
export interface RemoteDesktopAttachment { attach_id: string; connection_id: string; display_id: string; phase: string; quality?: string; }
export interface RemoteDesktopSnapshot { state_revision: string; busy: boolean; cleanup_pending: boolean; attachment?: RemoteDesktopAttachment; }
export interface RemoteDesktopMediaHealth { candidate?: boolean; }
export interface RemoteDesktopMedia { health?: RemoteDesktopMediaHealth; credentials_remaining_ms?: number | null; offer_sdp?: string; answer_accepted: boolean; source_first_frame: boolean; source_frames_submitted?: number; force_relay: boolean; }
export interface RemoteDesktopReply {
  error?: RemoteDesktopError; availability?: string; authorization?: string;
  protocol_versions?: number[]; capabilities?: string[]; codecs?: string[];
  displays?: RemoteDesktopDisplay[]; state_revision?: string;
  state?: RemoteDesktopSnapshot; media?: RemoteDesktopMedia; media_error?: string;
  answer_accepted?: boolean;
}
export interface RemoteDesktopRequest { version: number; op: string; body?: Object; }
export interface RemoteDesktopAttach { attach_id: string; expected_state_revision: string; display_id: string; force_relay: boolean; }
export interface RemoteDesktopAnswer { attach_id: string; connection_id: string; answer_sdp: string; }
export interface RemoteDesktopDetach { attach_id: string; }
export interface RemoteDesktopSourceRequest { attach_id: string; expected_state_revision: string; }
export interface RemoteDesktopSelectDisplayRequest extends RemoteDesktopSourceRequest { display_id: string; }
export interface RemoteDesktopSetQualityRequest extends RemoteDesktopSourceRequest { quality: string; }
export interface RemoteDesktopIceServer { urls: string[]; username: string; credential: string; }
export interface RemoteDesktopTurn { target_device_id: string; attach_id: string; expires_at: number; ice_servers: RemoteDesktopIceServer[]; }
export interface RemoteDesktopPeerKey { device_id: string; public_key: string; }
export interface RemoteDesktopRelayInfo { capabilities?: string[]; }
export interface RemoteDesktopRendererStart {
  kind: string; renderer_id: string; attach_id: string; connection_id: string;
  control_supported?: boolean; native_focus?: boolean; control_epoch?: string;
  offer_sdp: string; ice_servers: RemoteDesktopIceServer[]; force_relay: boolean;
}
export interface RemoteDesktopRendererEvent {
  kind: string; renderer_id?: string; attach_id?: string; connection_id?: string;
  answer_sdp?: string; code?: string; stage?: string; width?: number; height?: number;
  control_generation?: string; pending?: string; control_epoch?: string; capabilities?: string[];
  frames_decoded?: number; candidate_type?: string; remote_candidate_type?: string;
  protocol?: string; relay_protocol?: string;
}

/** A locally captured intent retains the host-issued generation until delivery. */
export interface RemoteDesktopInputBody {
  x?: number; y?: number; dx?: number; dy?: number;
  button?: string; down?: boolean; usage?: number; text?: string;
}
export interface RemoteDesktopInput extends RemoteDesktopControlIntent {
  renderer_id: string;
  control_generation: string; kind: string; body: RemoteDesktopInputBody;
}
export interface RemoteDesktopQueuedControl { kind: string; }
export interface RemoteDesktopQueuedCommand { kind: string; body?: RemoteDesktopQueuedControl; }
export interface RemoteDesktopControlIntent {
  kind: string; expected_state_revision?: string; control_generation?: string; body?: RemoteDesktopInputBody;
}
