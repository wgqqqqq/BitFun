import { desktopMediaDocument } from './DesktopMediaDocument';
export { desktopMediaDocument } from './DesktopMediaDocument';
import { isTauriRuntime } from '../runtime';
import { remoteDesktopAPI } from '../api/service-api/RemoteDesktopAPI';
import { NativeReceiverTransport } from './NativeReceiverTransport';
import type { DesktopRendererCommand } from './RemoteDesktopController';
export type DesktopMediaFailure = 'renderer_reloaded' | 'invalid_response' | 'media_unreachable' | 'input_backpressure' | 'media_backend_unavailable';


export class DesktopMediaFrame {
  private readonly token = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
  private disposed = false;
  private ready = false;
  private loads = 0;
  private installed = false;
  private sequence = 0;
  private queue: { command: DesktopRendererCommand; bytes: number }[] = [];
  private queuedBytes = 0;
  private pending?: { seq: number; timer: ReturnType<typeof setTimeout> };
  private native?: NativeReceiverTransport;
  constructor(private readonly frame: HTMLIFrameElement, private readonly receive: (event: unknown) => void,
    private readonly failed: (code: DesktopMediaFailure) => void) {
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.addEventListener('load', this.loaded);
    window.addEventListener('message', this.message);
    if (isTauriRuntime() && (typeof window.RTCPeerConnection !== 'function' || !document.createElement('video').requestVideoFrameCallback)) {
      void this.prepareNative();
    } else { this.installed = true; frame.srcdoc = desktopMediaDocument(this.token); }
  }
  private async prepareNative(): Promise<void> {
    try {
      const reply = await remoteDesktopAPI.receiver({ op: 'backend' }) as { backend?: string };
      if (this.disposed) return;
      if (reply.backend !== 'native') { this.fail('media_backend_unavailable'); return; }
      this.native = new NativeReceiverTransport((peer, value) => {
        if (this.disposed) return;
        if (value instanceof ArrayBuffer) {
          if (value.byteLength > 32 + 3840 * 2160 * 4) { this.fail('invalid_response'); return; }
          this.frame.contentWindow?.postMessage({ token: this.token, nativePeer: peer, nativeFrame: value }, '*', [value]);
        } else this.frame.contentWindow?.postMessage({ token: this.token, nativePeer: peer, nativeEvent: value }, '*');
      });
      this.installed = true;
      this.frame.srcdoc = desktopMediaDocument(this.token, true);
    } catch { if (!this.disposed) this.fail('media_backend_unavailable'); }
  }
  private readonly loaded = (): void => {
    if (!this.installed) return;
    if (!this.disposed && ++this.loads > 1) this.fail('renderer_reloaded');
  };
  private readonly message = (event: MessageEvent): void => {
    if (this.disposed || event.source !== this.frame.contentWindow || event.data?.token !== this.token) return;
    try {
      const nativeRequest = event.data.nativeRequest;
      if (nativeRequest && this.native) {
        if (!Number.isSafeInteger(nativeRequest.id) || nativeRequest.id <= 0
          || new TextEncoder().encode(JSON.stringify(nativeRequest)).length > 96 * 1024) throw new Error('invalid_request');
        void this.native.request(nativeRequest.op, nativeRequest.body).then(result => {
          if (!this.disposed) this.frame.contentWindow?.postMessage({ token: this.token, nativeReply: { id: nativeRequest.id, ok: true, result } }, '*');
        }, () => { if (!this.disposed) this.frame.contentWindow?.postMessage({ token: this.token, nativeReply: { id: nativeRequest.id, ok: false } }, '*'); });
        return;
      }
      if (event.data.ack !== undefined) {
        if (!this.pending || event.data.ack !== this.pending.seq) return;
        if (event.data.ok !== true) { this.fail('media_unreachable'); return; }
        clearTimeout(this.pending.timer); this.pending = undefined; this.flush(); return;
      }
      if (new TextEncoder().encode(JSON.stringify(event.data.event)).length > 96 * 1024) throw new Error('invalid_renderer_event');
      if (event.data.event?.kind === 'bridge_ready') this.ready = true;
      this.receive(event.data.event);
    } catch { this.fail('invalid_response'); }
  };
  private fail(code: DesktopMediaFailure): void { this.dispose(); this.failed(code); }
  private clearQueue(): void {
    clearTimeout(this.pending?.timer); this.pending = undefined; this.queue = []; this.queuedBytes = 0;
  }
  private flush(): void {
    if (this.disposed || !this.ready || this.pending || this.queue.length === 0) return;
    const item = this.queue.shift()!; this.queuedBytes -= item.bytes;
    const seq = ++this.sequence;
    if (!Number.isSafeInteger(seq)) { this.fail('invalid_response'); return; }
    this.pending = { seq, timer: setTimeout(() => this.fail('media_unreachable'), item.command.kind === 'start' ? 25000 : 4000) };
    this.frame.contentWindow?.postMessage({ token: this.token, seq, command: item.command }, '*');
  }
  send(command: DesktopRendererCommand): void {
    if (this.disposed) return;
    if (!this.ready) {
      if (command.kind !== 'stop') this.failed('media_backend_unavailable');
      return;
    }
    if (command.kind === 'stop') {
      this.clearQueue(); this.frame.contentWindow?.postMessage({ token: this.token, command }, '*'); return;
    }
    // Focus answers are tied to a fresh host challenge and must not wait behind
    // input. Release clears queued old input before crossing the same bridge;
    // the shared DC controller retains its separate host-ACK barrier.
    if (command.kind === 'focus_reply' || (command.kind === 'control' && command.body.kind === 'release_control')) {
      if (command.kind === 'control') {
        this.queue = this.queue.filter(item => item.command.kind !== 'control');
        this.queuedBytes = this.queue.reduce((bytes, item) => bytes + item.bytes, 0);
      }
      this.frame.contentWindow?.postMessage({ token: this.token, command }, '*'); return;
    }
    const encoded = JSON.stringify(command), bytes = new TextEncoder().encode(encoded).length;
    const tail = this.queue[this.queue.length - 1]?.command;
    if (command.kind === 'control' && command.body.kind === 'pointer_move' && tail?.kind === 'control'
      && tail.body.kind === 'pointer_move' && command.renderer_id === tail.renderer_id
      && command.attach_id === tail.attach_id && command.connection_id === tail.connection_id
      && command.control_epoch === tail.control_epoch
      && command.body.control_generation === tail.body.control_generation) {
      this.queuedBytes -= this.queue.pop()!.bytes;
    }
    if (this.queue.length >= 64 || this.queuedBytes + bytes > 128 * 1024) { this.fail('input_backpressure'); return; }
    this.queue.push({ command: JSON.parse(encoded) as DesktopRendererCommand, bytes }); this.queuedBytes += bytes;
    this.flush();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.native?.dispose();
    this.clearQueue();
    window.removeEventListener('message', this.message);
    this.frame.removeEventListener('load', this.loaded);
    // Navigation destroys the old PeerConnection even if its JS loop is stuck.
    this.frame.srcdoc = '';
  }
}
