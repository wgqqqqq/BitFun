import { RemoteDesktopProbeService } from '../../services/RemoteDesktopProbeService';

interface ProbeEvent { type?: string; kind?: string; runId?: string; message?: string; }
@ObservedV2
export class RemoteDesktopProbeViewModel {
  @Trace diagnostics: string = '';
  private transport?: RemoteDesktopProbeService;
  private timer?: number;
  private active: boolean = false;
  private busy: boolean = false;
  private send?: (config: string) => Promise<void>;
  private stopMedia?: () => void;
  start(key: string, send: (config: string) => Promise<void>, stop: () => void): void {
    this.close(); this.transport = new RemoteDesktopProbeService(key);
    this.send = send; this.stopMedia = stop; this.active = true; this.busy = false;
    RemoteDesktopProbeService.onLifecycle = (visible: boolean): void => {
      this.active = visible;
      if (!visible) this.stopMedia?.();
    };
    this.timer = setInterval(() => { void this.poll(); }, 1000);
    void this.poll();
  }
  private async poll(): Promise<void> {
    if (!this.active || this.busy || !this.transport) return;
    this.busy = true; const transport = this.transport;
    try {
      const config = await transport.request('receiver');
      if (this.active && this.transport === transport) await this.send?.(config);
    } catch (error) { if (this.active) this.diagnostics = String(error); }
    finally { if (this.transport === transport) this.busy = false; }
  }
  receive(raw: string): void {
    if (!this.active || !this.transport) return;
    try {
      const event = JSON.parse(raw) as ProbeEvent;
      // Both the legacy echo fixture and the production shared renderer can
      // supply answers. SDP stays in the private fixture transport, never UI.
      if (event.type !== 'answer' && event.kind !== 'answer') this.diagnostics = raw;
      const transport = this.transport;
      void transport.request('event', raw).catch((error: Error) => { if (this.active && this.transport === transport) this.diagnostics = error.message; });
    } catch (_error) { this.diagnostics = 'Invalid probe event'; }
  }
  close(): void {
    this.active = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined; this.transport?.close(); this.transport = undefined;
    this.stopMedia?.(); RemoteDesktopProbeService.onLifecycle = undefined;
  }
}
