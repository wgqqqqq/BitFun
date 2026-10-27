import { Channel } from '@tauri-apps/api/core';
import { remoteDesktopAPI } from '../api/service-api/RemoteDesktopAPI';

/** A local, per-frame bridge. Device credentials and peer workspace transports
 * never enter the sandbox. Native authority is fenced again by the host. */
export class NativeReceiverTransport {
  private disposed = false;
  private readonly peers = new Set<string>();
  constructor(private readonly event: (peer: string, value: unknown) => void) {}
  async request(op: string, body: Record<string, unknown>): Promise<unknown> {
    const id = body.renderer_id;
    if (this.disposed || typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw new Error('renderer_reloaded');
    if (op === 'open') {
      if (this.peers.has(id) || this.peers.size >= 2) throw new Error('invalid_request');
      this.peers.add(id);
      const events = new Channel<unknown>();
      events.onmessage = value => { if (!this.disposed && this.peers.has(id)) this.event(id, value); };
      return remoteDesktopAPI.receiver({ op, renderer_id: id, config: body.config, events });
    }
    if (!this.peers.has(id) || !['stats', 'send', 'frame_ack', 'close'].includes(op)) throw new Error('invalid_request');
    if (op === 'close') this.peers.delete(id);
    return remoteDesktopAPI.receiver({ ...body, op });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.peers) void remoteDesktopAPI.receiver({ op: 'close', renderer_id: id }).catch(() => {});
    this.peers.clear();
  }
}
