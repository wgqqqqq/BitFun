/* Native RTC/decode adapter for WebViews without WebRTC. The existing receiver
 * and ordered-control client continue to own presentation/health/input policy. */
(function (root) {
  'use strict';
  function install(platform, canvas, call) {
    const peers = new Map();
    let nextFrame = 0, pendingPaint, pendingPresentation;
    const callbacks = new Map();
    const scratch = platform.document.createElement('canvas');
    const video = { paused: true, videoWidth: 0, videoHeight: 0, stream: null,
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; platform.cancelAnimationFrame(pendingPaint); platform.cancelAnimationFrame(pendingPresentation); callbacks.clear(); canvas.width = 0; canvas.height = 0; },
      requestVideoFrameCallback(callback) { const id = ++nextFrame; callbacks.set(id, callback); return id; },
      cancelVideoFrameCallback(id) { callbacks.delete(id); },
      get srcObject() { return this.stream; }, set srcObject(value) { this.stream = value; if (!value) this.pause(); },
    };
    class Peer {
      constructor(config) {
        this.id = platform.crypto.randomUUID(); this.config = config; this.connectionState = 'new'; this.iceGatheringState = 'new';
        this.channel = null; this.track = null; this.closed = false; peers.set(this.id, this);
      }
      async setRemoteDescription(description) { this.offer = description.sdp; }
      async createAnswer() {
        const result = await call('open', { renderer_id: this.id, config: { offer_sdp: this.offer,
          ice_servers: this.config.iceServers, force_relay: this.config.iceTransportPolicy === 'relay' } });
        if (this.closed) throw new Error('renderer_reloaded');
        this.iceGatheringState = 'complete'; return { type: 'answer', sdp: result.sdp };
      }
      async setLocalDescription(description) { this.localDescription = description; }
      async getStats() {
        const reports = await call('stats', { renderer_id: this.id });
        if (this.closed || !Array.isArray(reports)) throw new Error('renderer_reloaded');
        return new Map(reports.map(report => [report.id, report]));
      }
      close() {
        if (this.closed) return;
        this.closed = true; peers.delete(this.id); this.channel?.retire();
        if (this.track) this.track.readyState = 'ended';
        void call('close', { renderer_id: this.id }).catch(() => {});
      }
      receive(event) {
        if (this.closed) return;
        if (event.kind === 'connection') { this.connectionState = event.state; this.onconnectionstatechange?.(); }
        if (event.kind === 'channel') {
          if (!this.channel) { this.channel = channel(this); this.ondatachannel?.({ channel: this.channel }); }
          this.channel.readyState = event.state;
          if (event.state === 'open') this.channel.onopen?.();
          else if (event.state === 'closed' || event.state === 'closing') this.channel.onclose?.();
        }
        if (event.kind === 'message') this.channel?.onmessage?.({ data: event.data });
        if (event.kind === 'track') {
          if (this.track) { this.close(); return; }
          this.track = { kind: 'video', readyState: 'live', muted: true, enabled: true, peer: this,
            stop() { this.readyState = 'ended'; } };
          this.ontrack?.({ track: this.track });
        }
        if (event.kind === 'ended') { if (this.track) { this.track.readyState = 'ended'; this.track.onended?.(); } }
      }
    }
    function channel(peer) {
      let queue = [], sending = false, retired = false;
      const result = { label: 'rd', ordered: true, maxRetransmits: null, maxPacketLifeTime: null,
        readyState: 'connecting', bufferedAmount: 0,
        send(data) {
          const bytes = new TextEncoder().encode(data).length;
          if (retired || peer.closed || this.readyState !== 'open' || bytes > 32 * 1024
            || queue.length >= 64 || this.bufferedAmount + bytes > 64 * 1024) throw new Error('input_backpressure');
          queue.push({ data, bytes }); this.bufferedAmount += bytes; void flush();
        },
        retire() { retired = true; queue = []; this.bufferedAmount = 0; this.readyState = 'closed'; },
        close() { this.retire(); peer.close(); },
      };
      async function flush() {
        if (sending || retired) return;
        sending = true;
        try {
          while (queue.length && !retired && !peer.closed) {
            const item = queue.shift();
            await call('send', { renderer_id: peer.id, body: item.data });
            if (!retired) result.bufferedAmount -= item.bytes;
          }
        } catch (_) { if (!retired) { result.onerror?.(); peer.close(); } }
        finally { sending = false; }
      }
      return result;
    }
    function frame(id, packet) {
      const peer = peers.get(id);
      if (!peer || peer.closed || !(packet instanceof ArrayBuffer) || packet.byteLength < 32) return;
      const header = new DataView(packet);
      const width = header.getUint32(12, true), height = header.getUint32(16, true), rotation = header.getUint32(20, true);
      if (header.getUint32(0, false) !== 0x52444631 || width < 2 || height < 2 || Math.max(width, height) > 3840 || Math.min(width, height) > 2160
        || packet.byteLength !== 32 + width * height * 4 || ![0, 90, 180, 270].includes(rotation)) { peer.close(); return; }
      const sequence = header.getBigUint64(4, true).toString();
      const mediaTime = Number(header.getBigInt64(24, true)) / 1e6;
      if (!Number.isFinite(mediaTime) || mediaTime < 0 || !peer.track || video.stream?.tracks?.[0] !== peer.track || video.paused) { peer.close(); return; }
      const image = new platform.ImageData(new Uint8ClampedArray(packet, 32), width, height);
      scratch.width = width; scratch.height = height;
      const context = scratch.getContext('2d');
      if (!context) { peer.close(); return; }
      context.putImageData(image, 0, 0);
      pendingPaint = platform.requestAnimationFrame(() => {
        if (peer.closed || video.paused || video.stream?.tracks?.[0] !== peer.track) return;
        const swapped = rotation === 90 || rotation === 270;
        canvas.width = swapped ? height : width; canvas.height = swapped ? width : height;
        const target = canvas.getContext('2d');
        if (!target) { peer.close(); return; }
        target.translate(canvas.width / 2, canvas.height / 2); target.rotate(rotation * Math.PI / 180);
        target.drawImage(scratch, -width / 2, -height / 2);
        pendingPresentation = platform.requestAnimationFrame(time => {
          if (peer.closed || video.paused || video.stream?.tracks?.[0] !== peer.track) return;
          peer.track.muted = false; video.videoWidth = canvas.width; video.videoHeight = canvas.height;
          const current = [...callbacks.values()]; callbacks.clear();
          for (const callback of current) callback(time, { width: canvas.width, height: canvas.height, mediaTime });
          void call('frame_ack', { renderer_id: peer.id, sequence }).catch(() => peer.close());
        });
      });
    }
    platform.RTCPeerConnection = Peer;
    platform.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };
    const adapter = { video, ready: true, receive(id, event) { peers.get(id)?.receive(event); }, frame,
      stop() { for (const peer of peers.values()) peer.close(); video.pause(); } };
    platform.OpenBitFunNativeMedia = adapter;
    return adapter;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { install };
  root.OpenBitFunNativeTransport = { install };
})(typeof window === 'undefined' ? globalThis : window);
