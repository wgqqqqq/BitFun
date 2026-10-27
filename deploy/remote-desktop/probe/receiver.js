/* Read-only ArkWeb capability probe. No input injection or account credentials. */
(() => {
  'use strict';
  let pc, runId, statsTimer, stopTimer, presented = 0, active = true;
  const video = document.querySelector('video');
  const bridge = (event) => {
    if (active && window.OpenBitFunProbeHost) window.OpenBitFunProbeHost.postMessage(JSON.stringify(event));
  };
  function stop() {
    clearInterval(statsTimer); clearTimeout(stopTimer);
    if (pc) { pc.close(); pc = null; }
    video.srcObject = null;
  }
  async function gather(peer) {
    if (peer.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ICE gathering timeout')), 15000);
      const check = () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve(); } };
      peer.addEventListener('icegatheringstatechange', check);
    });
  }
  async function sample(peer, id) {
    if (pc !== peer) return;
    const report = await peer.getStats();
    if (pc !== peer) return;
    const event = { type: 'stats', runId: id, connectionState: peer.connectionState, presented, width: video.videoWidth, height: video.videoHeight, paused: video.paused };
    for (const stat of report.values()) {
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
        Object.assign(event, { framesDecoded: stat.framesDecoded, bytesReceived: stat.bytesReceived, packetsLost: stat.packetsLost, codec: report.get(stat.codecId)?.mimeType });
      }
      if (stat.type === 'transport' && stat.selectedCandidatePairId) {
        const pair = report.get(stat.selectedCandidatePairId);
        const local = report.get(pair?.localCandidateId), remote = report.get(pair?.remoteCandidateId);
        Object.assign(event, { localCandidateType: local?.candidateType, remoteCandidateType: remote?.candidateType, protocol: local?.protocol, relayProtocol: local?.relayProtocol, rtt: pair?.currentRoundTripTime });
      }
    }
    bridge(event);
  }
  async function accept(config) {
    if (!active || !config.offer || config.runId === runId) return;
    stop(); runId = config.runId; presented = 0;
    const peer = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: config.policy, bundlePolicy: 'max-bundle' }); pc = peer;
    peer.onconnectionstatechange = () => bridge({ type: 'connection', runId: config.runId, state: peer.connectionState });
    peer.onicecandidateerror = (e) => bridge({ type: 'ice-error', runId: config.runId, code: e.errorCode, message: e.errorText });
    peer.ondatachannel = ({ channel }) => {
      channel.onopen = () => bridge({ type: 'data-open', runId: config.runId, ordered: channel.ordered, maxRetransmits: channel.maxRetransmits });
      channel.onmessage = ({ data }) => { if (pc === peer && channel.readyState === 'open') channel.send(data); };
    };
    peer.ontrack = async ({ track }) => {
      if (pc !== peer) return;
      video.srcObject = new MediaStream([track]);
      try { await video.play(); if (pc !== peer) return; bridge({ type: 'playing', runId: config.runId }); }
      catch (error) { bridge({ type: 'error', runId: config.runId, message: String(error) }); }
      if (video.requestVideoFrameCallback) {
        const frame = (_now, meta) => {
          if (pc !== peer) return;
          presented++;
          if (presented === 1) bridge({ type: 'first-frame', runId: config.runId, width: meta.width, height: meta.height, mediaTime: meta.mediaTime });
          video.requestVideoFrameCallback(frame);
        };
        video.requestVideoFrameCallback(frame);
      }
    };
    await peer.setRemoteDescription(config.offer);
    await peer.setLocalDescription(await peer.createAnswer()); await gather(peer);
    if (pc !== peer) return;
    bridge({ type: 'answer', runId: config.runId, answer: peer.localDescription.toJSON() });
    statsTimer = setInterval(() => sample(peer, config.runId).catch((e) => bridge({ type: 'error', runId: config.runId, message: String(e) })), 2000);
    stopTimer = setTimeout(() => { sample(peer, config.runId).finally(() => { if (pc !== peer) return; stop(); bridge({ type: 'stopped', runId: config.runId, reason: 'bounded-probe-complete' }); }); }, 65000);
  }
  window.OpenBitFunProbe = { accept: (config) => accept(config).catch((e) => bridge({ type: 'error', runId, message: String(e) })), stop };
  window.addEventListener('pagehide', () => { stop(); active = false; });
  window.OpenBitFunProbe.reportCapabilities = () => bridge({ type: 'capabilities', origin: location.origin, secureContext: isSecureContext, userAgent: navigator.userAgent,
    peerConnection: typeof RTCPeerConnection === 'function', dataChannel: typeof RTCDataChannel === 'function', frameCallback: typeof video.requestVideoFrameCallback === 'function',
    codecs: typeof RTCRtpReceiver === 'function' ? RTCRtpReceiver.getCapabilities('video')?.codecs.map((c) => ({ mimeType: c.mimeType, sdpFmtpLine: c.sdpFmtpLine })) : [] });
  window.OpenBitFunProbe.reportCapabilities();
})();
