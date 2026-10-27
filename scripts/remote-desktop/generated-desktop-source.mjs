// Generated video and ordered-channel fixture only. No account or OS input.
export function generatedDesktopSource() {
    let current;
    function stop() {
      if (!current) return;
      clearInterval(current.timer); current.stream.getTracks().forEach(track => track.stop()); current.peer.close(); current = undefined;
    }
    function status() { return { channel: current?.channel.readyState || 'closed', peer: current?.peer.connectionState || 'closed',
      sctp: current?.peer.sctp?.state || 'closed', messages_received: current?.received || 0,
      lease: current?.lease || null, inputs: current?.inputs || [], control_counts: current?.controlCounts || {},
      text_rejection: current?.textRejection || null, held_buttons: current ? [...current.heldButtons] : [],
      bound: current?.bound || null, health: current?.health || null, unexpected_input: current?.unexpected === true }; }
    window.androidMediaSource = async value => {
      if (value.operation === 'stop') { stop(); return {}; }
      if (value.operation === 'start') {
        stop(); const id = value.id, config = value.configuration;
        const canvas = document.createElement('canvas'); canvas.width = value.width ?? 320; canvas.height = value.height ?? 180;
        const context = canvas.getContext('2d'); let frame = 0;
        const draw = () => {
          const colors = value.alternate ? ['yellow', 'cyan'] : ['red', 'blue'];
          context.fillStyle = colors[++frame % 2]; context.fillRect(0, 0, canvas.width, canvas.height);
        }; draw();
        const stream = canvas.captureStream(10);
        const peer = new RTCPeerConnection({ iceServers: config.ice_servers || [], iceTransportPolicy: config.force_relay ? 'relay' : 'all' });
        stream.getTracks().forEach(track => peer.addTrack(track, stream));
        peer.getTransceivers()[0].setCodecPreferences(RTCRtpSender.getCapabilities('video').codecs.filter(codec => ['video/vp8', 'video/h264'].includes(codec.mimeType.toLowerCase())));
        const channel = peer.createDataChannel('rd', { ordered: true });
        const attach = value.attach_id ?? `attach-${id}`, connection = value.connection_id ?? `pc-${id}`;
        const run = { id, peer, channel, stream, timer: setInterval(draw, 100), echo: 0, received: 0,
          inputs: [], controlCounts: {}, nextGeneration: 0, heldButtons: new Set() }; current = run;
        channel.onclose = () => { run.lease = undefined; run.heldButtons.clear(); };
        channel.onmessage = event => {
          if (current !== run) return; run.received++; const message = JSON.parse(event.data);
          if (message.kind === 'bind') run.bound = { version: message.version, matches: message.attach_id === attach && message.connection_id === connection, label: channel.label, ordered: channel.ordered };
          else if (message.kind === 'health_reply') run.health = message;
          else if (value.control === true && ['acquire_control', 'renew_control', 'release_control'].includes(message.kind)) {
            run.controlCounts[message.kind] = (run.controlCounts[message.kind] || 0) + 1;
            let code = 'ok';
            if (message.version !== 1 || typeof message.request_id !== 'string') { run.unexpected = true; return; }
            if (message.kind === 'acquire_control') {
              if (message.body?.expected_state_revision !== value.revision) code = 'stale_revision';
              else if (value.control_grant === false) code = 'device_approval_required';
              else if (run.lease) code = 'control_busy';
              else run.lease = String(++run.nextGeneration);
            } else if (message.body?.control_generation !== run.lease) code = 'stale_control';
            else if (message.kind === 'release_control') { run.lease = undefined; run.heldButtons.clear(); }
            channel.send(JSON.stringify({ version: 1, kind: 'control_result', request_id: message.request_id, code,
              ...(code === 'ok' && run.lease ? { control_generation: run.lease } : {}) }));
          }
          else if (value.control === true && message.kind === 'pointer_button') {
            const body = message.body;
            if (!run.lease || message.control_generation !== run.lease || !body || !(value.gestures ? ['left', 'right'] : ['left']).includes(body.button)
              || typeof body.down !== 'boolean' || !Number.isFinite(body.x) || !Number.isFinite(body.y)
              || body.x < 0 || body.x > 1 || body.y < 0 || body.y > 1 || Object.hasOwn(message, 'control_epoch')) run.unexpected = true;
            else if (run.inputs.length < 32) {
              if (body.down === run.heldButtons.has(body.button)) run.unexpected = true;
              else {
                if (body.down) run.heldButtons.add(body.button); else run.heldButtons.delete(body.button);
                run.inputs.push({ ...body, generation: message.control_generation });
              }
            }
            else run.unexpected = true;
          }
          else if (value.control === true && value.gestures === true && ['pointer_move', 'wheel'].includes(message.kind)) {
            const body = message.body;
            if (!run.lease || message.control_generation !== run.lease || !body || !Number.isFinite(body.x) || !Number.isFinite(body.y)
              || body.x < 0 || body.x > 1 || body.y < 0 || body.y > 1 || Object.hasOwn(message, 'control_epoch') || run.inputs.length >= 32
              || message.kind === 'wheel' && (!Number.isFinite(body.dx) || !Number.isFinite(body.dy) || Math.abs(body.dx) > 65536
                || Math.abs(body.dy) > 65536 || body.dx === 0 && body.dy === 0)) run.unexpected = true;
            else run.inputs.push({ kind: message.kind, ...body, generation: message.control_generation });
          }
          else if (value.control === true && message.kind === 'text_commit') {
            const text = message.body?.text, expected = value.expected_text_commits?.[run.textCommits || 0];
            if (!run.lease || message.control_generation !== run.lease || typeof text !== 'string' || !text
              || text.includes('\0') || new TextEncoder().encode(text).length > 4096 || Object.hasOwn(message, 'control_epoch')
              || text !== expected || run.inputs.length >= 32) {
              run.unexpected = true;
              run.textRejection = { type_valid: typeof text === 'string', bytes: typeof text === 'string' ? new TextEncoder().encode(text).length : null,
                case_only: typeof text === 'string' && typeof expected === 'string' && text !== expected && text.toLowerCase() === expected.toLowerCase() };
            }
            else { run.textCommits = (run.textCommits || 0) + 1; run.inputs.push({ kind: 'text_commit', matches_expected: true }); }
          }
          else if (value.control === true && message.kind === 'key') {
            const body = message.body;
            if (!run.lease || message.control_generation !== run.lease || !body || ![0x28, 0x2a].includes(body.usage)
              || typeof body.down !== 'boolean' || Object.hasOwn(message, 'control_epoch') || run.inputs.length >= 32) run.unexpected = true;
            else run.inputs.push({ kind: 'key', usage: body.usage, down: body.down, generation: message.control_generation });
          }
          else run.unexpected = true;
        };
        await peer.setLocalDescription(await peer.createOffer());
        if (peer.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
          const ready = () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', ready); resolve(); } };
          const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', ready); reject(new Error('ICE timeout')); }, 12000);
          peer.addEventListener('icegatheringstatechange', ready); ready();
        });
        return { kind: 'start', renderer_id: id, attach_id: attach, connection_id: connection, offer_sdp: peer.localDescription.sdp,
          ice_servers: config.ice_servers || [], force_relay: config.force_relay === true, control_supported: false };
      }
      if (value.operation === 'answer') { await current.peer.setRemoteDescription({ type: 'answer', sdp: value.sdp }); return {}; }
      if (value.operation === 'probe' && current?.channel.readyState === 'open') current.channel.send(JSON.stringify({ version: 1, kind: 'health_probe', echo: String(++current.echo) }));
      if (value.operation !== 'stats') return status();
      const run = current;
      if (!run) return {};
      const reports = await run.peer.getStats();
      if (current !== run) return {};
      let result;
      reports.forEach(report => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') result = { codec: reports.get(report.codecId)?.mimeType, frames_encoded: report.framesEncoded };
      });
      let pair;
      reports.forEach(report => { if (report.type === 'transport' && report.selectedCandidatePairId) pair = reports.get(report.selectedCandidatePairId); });
      const local = pair && reports.get(pair.localCandidateId), remote = pair && reports.get(pair.remoteCandidateId);
      return { ...result, candidate_type: local?.candidateType, remote_candidate_type: remote?.candidateType,
        protocol: local?.protocol, relay_protocol: local?.relayProtocol };
    };
}
