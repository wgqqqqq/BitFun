/**
 * Remote Connect API — calls Tauri commands for remote connection management.
 */

import { getTransportAdapter } from '../adapters';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('RemoteConnectAPI');

export interface DeviceInfo {
  device_id: string;
  device_name: string;
  mac_address: string;
}

export interface ConnectionMethodInfo {
  id: string;
  name: string;
  available: boolean;
  description: string;
}

export interface ConnectionResult {
  method: string;
  qr_data: string | null;
  qr_svg: string | null;
  qr_url: string | null;
  bot_pairing_code: string | null;
  bot_link: string | null;
  pairing_state: string;
}

export interface RemoteConnectStatus {
  is_connected: boolean;
  pairing_state: string;
  active_method: string | null;
  peer_device_name: string | null;
  bot_connected: string | null;
}

class RemoteConnectAPIService {
  private adapter = getTransportAdapter();

  async getDeviceInfo(): Promise<DeviceInfo> {
    try {
      return await this.adapter.request<DeviceInfo>('remote_connect_get_device_info');
    } catch (e) {
      log.error('getDeviceInfo failed', e);
      throw e;
    }
  }

  async getConnectionMethods(): Promise<ConnectionMethodInfo[]> {
    try {
      return await this.adapter.request<ConnectionMethodInfo[]>('remote_connect_get_methods');
    } catch (e) {
      log.error('getConnectionMethods failed', e);
      throw e;
    }
  }

  async startConnection(method: string, customServerUrl?: string): Promise<ConnectionResult> {
    try {
      return await this.adapter.request<ConnectionResult>('remote_connect_start', {
        request: { method, custom_server_url: customServerUrl ?? null },
      });
    } catch (e) {
      log.error('startConnection failed', e);
      throw e;
    }
  }

  async stopConnection(): Promise<void> {
    try {
      await this.adapter.request<void>('remote_connect_stop');
    } catch (e) {
      log.error('stopConnection failed', e);
      throw e;
    }
  }

  async getStatus(): Promise<RemoteConnectStatus> {
    try {
      return await this.adapter.request<RemoteConnectStatus>('remote_connect_status');
    } catch (e) {
      log.error('getStatus failed', e);
      throw e;
    }
  }

  async stopBot(): Promise<void> {
    try {
      await this.adapter.request<void>('remote_connect_stop_bot');
    } catch (e) {
      log.error('stopBot failed', e);
      throw e;
    }
  }

  async configureCustomServer(url: string): Promise<void> {
    try {
      await this.adapter.request<void>('remote_connect_configure_custom_server', { url });
    } catch (e) {
      log.error('configureCustomServer failed', e);
      throw e;
    }
  }

  async configureBot(params: {
    botType: string;
    appId?: string;
    appSecret?: string;
    botToken?: string;
  }): Promise<void> {
    try {
      await this.adapter.request<void>('remote_connect_configure_bot', {
        request: {
          bot_type: params.botType,
          app_id: params.appId ?? null,
          app_secret: params.appSecret ?? null,
          bot_token: params.botToken ?? null,
        },
      });
    } catch (e) {
      log.error('configureBot failed', e);
      throw e;
    }
  }
}

export const remoteConnectAPI = new RemoteConnectAPIService();
