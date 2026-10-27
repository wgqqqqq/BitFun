import receiver from '../../../../shared/remote-desktop-media/receiver.js?raw';
import control from '../../../../shared/remote-desktop-media/control.js?raw';
import nativeTransport from '../../../../shared/remote-desktop-media/native-transport.js?raw';

/** Fixed, bundled receiver in an opaque-origin sandbox. Never loads a URL
 * supplied by a peer or exposes the main document's Tauri/account bridge. */
export function desktopMediaDocument(token: string, native = false): string {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('invalid_renderer_token');
  const bridge = `(() => {
    const token = '${token}';
    window.OpenBitFunDesktopHost = { postMessage(raw) {
      if (typeof raw === 'string' && raw.length <= 96 * 1024) {
        try {
          const event = JSON.parse(raw);
          if (event?.kind === 'bridge_ready') {
            event.receiver_api_available = window.OpenBitFunNativeMedia?.ready === true || typeof window.RTCPeerConnection === 'function'
              && typeof document.querySelector('video')?.requestVideoFrameCallback === 'function';
          }
          parent.postMessage({ token, event }, '*');
        } catch (_) {}
      }
    }};
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.token !== token) return;
      const command = event.data.command;
      if (command && ['start', 'source_ready', 'stop', 'control', 'focus_reply'].includes(command.kind)) {
        Promise.resolve(window.OpenBitFunDesktopReceiver?.accept(command)).then(
          () => { if (Number.isSafeInteger(event.data.seq)) parent.postMessage({ token, ack: event.data.seq, ok: true }, '*'); },
          () => { if (Number.isSafeInteger(event.data.seq)) parent.postMessage({ token, ack: event.data.seq, ok: false }, '*'); });
      }
    });
  })();`;
  const nativeBridge = `(() => {
    const pending = new Map(); let sequence = 0;
    const call = (op, body) => new Promise((resolve, reject) => {
      const id = ++sequence;
      if (!Number.isSafeInteger(id) || pending.size >= 64) { reject(new Error('input_backpressure')); return; }
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('media_unreachable')); }, op === 'open' ? 25000 : 4000);
      pending.set(id, { resolve, reject, timer }); parent.postMessage({ token: '${token}', nativeRequest: { id, op, body } }, '*');
    });
    const media = window.OpenBitFunNativeTransport.install(window, document.querySelector('canvas'), call);
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.token !== '${token}') return;
      const reply = event.data.nativeReply;
      if (reply) { const item = pending.get(reply.id); if (!item) return; pending.delete(reply.id); clearTimeout(item.timer);
        if (reply.ok) item.resolve(reply.result); else item.reject(new Error('media_unreachable')); }
      if (event.data.nativePeer && event.data.nativeFrame) media.frame(event.data.nativePeer, event.data.nativeFrame);
      if (event.data.nativePeer && event.data.nativeEvent) media.receive(event.data.nativePeer, event.data.nativeEvent);
    });
    addEventListener('pagehide', () => { media.stop(); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('renderer_reloaded')); } pending.clear(); });
  })();`;
  const script = (source: string) => `<script nonce="${token}">${source.replace(/<\/script/gi, '<\\/script')}</script>`;
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; media-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}video,canvas{width:100%;height:100%;object-fit:contain;display:block}</style>
    </head><body>${native ? '<canvas></canvas>' : '<video autoplay playsinline muted></video>'}${script(bridge)}${native ? script(nativeTransport) + script(nativeBridge) : ''}${script(control)}${script(receiver)}</body></html>`;
}
