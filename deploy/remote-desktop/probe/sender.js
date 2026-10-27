(() => {
  const key = location.hash.slice(1); history.replaceState(null, '', location.pathname);
  const status = document.querySelector('#status');
  let pc, stream, timer, endTimer;
  const api = async (route, body) => {
    const response = await fetch(`/api/${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`Probe HTTP ${response.status}`);
    return response.json();
  };
  const report = (value) => { status.textContent = JSON.stringify(value, null, 2); };
  const stop = () => { clearInterval(timer); clearTimeout(endTimer); pc?.close(); stream?.getTracks().forEach((t) => t.stop()); pc = null; stream = null; };
  async function start(policy, codec = 'VP8') {
    stop();
    stream = await navigator.mediaDevices.getDisplayMedia({ selfBrowserSurface: 'include', video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 15 } }, audio: false });
    endTimer = setTimeout(stop, 60000);
    const config = await api('config'), runId = crypto.randomUUID();
    const peer = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: policy, bundlePolicy: 'max-bundle' }); pc = peer;
    const sender = peer.addTrack(stream.getVideoTracks()[0], stream);
    const transceiver = peer.getTransceivers().find((t) => t.sender === sender);
    const codecs = RTCRtpSender.getCapabilities('video').codecs.filter((c) => c.mimeType.toUpperCase() === `VIDEO/${codec}`);
    if (!codecs.length) throw new Error(`Sender codec unavailable: ${codec}`);
    transceiver.setCodecPreferences(codecs);
    const parameters = sender.getParameters(); parameters.encodings ||= [{}]; parameters.encodings[0].maxBitrate = 350000; await sender.setParameters(parameters);
    const channel = peer.createDataChannel('rd', { ordered: true });
    channel.onopen = () => { timer = setInterval(() => { if (channel.readyState === 'open') channel.send(JSON.stringify({ sentAt: performance.now() })); }, 2000); };
    channel.onmessage = ({ data }) => api('event', { type: 'echo', runId, rttMs: performance.now() - JSON.parse(data).sentAt }).catch(console.error);
    peer.onconnectionstatechange = () => { report({ policy, runId, state: peer.connectionState }); api('event', { type: 'sender-connection', runId, policy, state: peer.connectionState }).catch(console.error); };
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ICE gathering timeout')), 15000);
      const check = () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', check); resolve(); } }; peer.addEventListener('icegatheringstatechange', check);
    });
    if (pc !== peer) return;
    await api('offer', { runId, policy, codec, offer: peer.localDescription.toJSON() }); report({ policy, runId, waiting: 'ArkWeb answer' });
    for (let tries = 0; tries < 60 && pc === peer; tries++) {
      const answer = await api(`answer?runId=${encodeURIComponent(runId)}`);
      if (answer.type === 'answer') { await peer.setRemoteDescription(answer); break; }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  document.querySelector('#direct').onclick = () => start('all').catch((e) => { stop(); report({ error: String(e) }); });
  document.querySelector('#relay').onclick = () => start('relay').catch((e) => { stop(); report({ error: String(e) }); });
  document.querySelector('#relayh264').onclick = () => start('relay', 'H264').catch((e) => { stop(); report({ error: String(e) }); });
  document.querySelector('#stop').onclick = stop;
  setInterval(() => { document.querySelector('#clock').textContent = new Date().toISOString(); document.querySelector('#motion').value = (Date.now() / 100) % 100; }, 100);
})();
