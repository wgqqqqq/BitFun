/* Bundled WebRTC renderer and ordered channel bridge. No account IO or app UI. */
(function (root) {
  'use strict';
  const localEpoch = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
    && (value.length < 19 || value <= '9223372036854775807');
  const olderEpoch = (a, b) => a.length < b.length || a.length === b.length && a < b;
  function receiverIceServers(servers, relay) {
    if (relay) return servers;
    const stun = new Set();
    for (const server of servers) for (const url of Array.isArray(server?.urls) ? server.urls : []) {
      if (typeof url !== 'string' || !url.startsWith('turn:')) continue;
      const parts = url.slice(5).split('?');
      if (parts.length > 2 || (parts.length === 2 && parts[1] !== 'transport=udp')) continue;
      if (!parts[0] || parts[0].length > 1019 || /[\s/@#?]/.test(parts[0])) continue;
      stun.add(`stun:${parts[0]}`);
    }
    return stun.size ? [...servers, { urls: [...stun] }] : servers;
  }
  function createReceiver(video, post, platform = root) {
    let current;
    let generation = 0;
    const now = () => platform.performance?.now?.() ?? NaN;
    const recent = (sample, budget) => {
      const age = now() - sample;
      return Number.isFinite(age) && age >= 0 && age < budget;
    };
    const focused = run => run.parentFocus
      ? run.parentFocused === true && recent(run.parentFocusAt, 2500)
      : run.nativeFocus || platform.document?.hasFocus?.() === true;
    const fresh = run => current === run && !run.closed && run.generation === generation;
    const emit = (run, kind, extra = {}) => {
      if (!fresh(run)) return;
      post({ kind, renderer_id: run.id, attach_id: run.attach, connection_id: run.connection, ...extra });
    };
    const controlState = (run, value) => emit(run, 'control_state', { ...value,
      ...(run.controlEpoch === undefined ? {} : { control_epoch: run.controlEpoch }) });
    function confirmPresentation(run) {
      // The sender never encodes placeholders. Its authenticated source status
      // and a presented frame from this exact PC may arrive in either order.
      // Retain metadata only, so a static first frame needs no extra encoding.
      if (!fresh(run) || !run.source || run.presented || !run.lastFrame || run.track?.readyState === 'ended') return;
      run.presented = true;
      emit(run, 'first_frame_presented', run.lastFrame);
    }
    function closeCurrent() {
      const run = current;
      current = undefined;
      if (run) {
        run.focusRequest?.finish(false);
        run.control?.stop();
        run.closed = true;
        clearTimeout(run.bindTask);
        clearInterval(run.stats);
        if (run.frame !== undefined && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(run.frame);
        run.channel?.close();
        run.peer?.close();
        run.track?.stop();
      }
      video.pause();
      video.srcObject = null;
    }
    function stop() { generation++; closeCurrent(); }
    function fail(run, code, stage) {
      if (!fresh(run)) return;
      emit(run, 'failed', { code, ...(stage ? { stage } : {}) });
      // The app callback may synchronously replace this connection.
      if (fresh(run)) stop();
    }
    async function start(config, expected) {
      if (expected !== generation) return;
      closeCurrent();
      if (!platform.RTCPeerConnection || !video.requestVideoFrameCallback) throw new Error('media_backend_unavailable');
      if (!config.renderer_id || !config.attach_id || !config.connection_id || typeof config.offer_sdp !== 'string'
        || config.offer_sdp.length > 90 * 1024 || !Array.isArray(config.ice_servers)
        || config.control_epoch !== undefined && !localEpoch(config.control_epoch)) throw new Error('invalid_media_config');
      const run = { id: config.renderer_id, attach: config.attach_id, connection: config.connection_id, generation: expected,
        nativeFocus: config.native_focus === true, parentFocus: config.parent_focus === true,
        closed: false, source: false, presented: false, decoded: 0, presentedCount: 0, controlEpoch: config.control_epoch };
      current = run;
      const peer = new platform.RTCPeerConnection({ iceServers: receiverIceServers(config.ice_servers, config.force_relay), iceTransportPolicy: config.force_relay ? 'relay' : 'all' });
      run.peer = peer;
      peer.onicecandidateerror = event => {
        if (fresh(run)) run.iceError = [401, 403, 437, 438, 441, 486, 508, 701].includes(event.errorCode) ? event.errorCode : undefined;
      };
      if (config.control_supported === true) {
        const createController = platform.OpenBitFunRemoteDesktopControl?.createController;
        if (!createController) throw new Error('control_not_available');
        run.control = createController({
          current: () => fresh(run),
          healthy: () => fresh(run) && run.presented && peer.connectionState === 'connected'
            && run.channel?.readyState === 'open' && run.track?.readyState === 'live' && !run.track.muted && run.track.enabled === true
            && platform.document?.visibilityState === 'visible' && focused(run)
            && recent(run.lastProbe, 6000),
          send: message => {
            if (!fresh(run) || run.channel?.readyState !== 'open' || run.channel.bufferedAmount > 64 * 1024) return false;
            try {
              const value = JSON.stringify(message);
              if (new TextEncoder().encode(value).length > 32 * 1024) return false;
              run.channel.send(value); return true;
            } catch (_) { return false; }
          },
          state: value => controlState(run, value),
          fail: code => fail(run, code),
        });
      }
      peer.onconnectionstatechange = () => {
        if (!fresh(run)) return;
        if (peer.connectionState === 'connected') emit(run, 'transport_connected');
        if (['failed', 'closed'].includes(peer.connectionState)) fail(run, 'media_unreachable', 'peer');
        if (peer.connectionState === 'disconnected') { run.control?.release(); emit(run, 'reconnecting'); }
      };
      peer.ondatachannel = event => {
        const channel = event.channel;
        if (!fresh(run) || run.channel || channel.label !== 'rd' || !channel.ordered
          || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) { channel.close(); return; }
        run.channel = channel;
        const channelFailed = () => fail(run, 'media_unreachable', 'channel');
        channel.onmessage = async event => {
          if (!fresh(run) || typeof event.data !== 'string' || event.data.length > 1024) return;
          let probe;
          try { probe = JSON.parse(event.data); } catch (_) { return; }
          if (['control_result', 'control_revoked', 'control_error'].includes(probe.kind)) { run.control?.receive(probe); return; }
          if (probe.version !== 1 || probe.kind !== 'health_probe' || typeof probe.echo !== 'string'
            || !/^(0|[1-9][0-9]{0,19})$/.test(probe.echo) || run.probeBusy) return;
          run.probeBusy = true;
          try {
            // Sample anew for this round trip, never relabel a cached/queued
            // positive report with a new echo. Missing stats are not healthy.
            const reports = await peer.getStats();
            if (!fresh(run) || run.channel !== channel || channel.readyState !== 'open' || channel.bufferedAmount > 64 * 1024) return;
            let observed = false;
            reports.forEach(report => {
              if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')
                && Number.isSafeInteger(report.framesDecoded) && report.framesDecoded >= 0) {
                observed = true; run.decoded = report.framesDecoded;
              }
            });
            let hasFocus;
            if (run.parentFocus) {
              // The opaque frame cannot inspect the app's editor/toolbar focus.
              // Bind a fresh answer to this exact host probe. Cached positives
              // and a frozen parent must never renew remote control forever.
              hasFocus = await new Promise(resolve => {
                const request = { echo: probe.echo, finish(value) {
                  if (run.focusRequest !== request) return;
                  clearTimeout(request.timer); run.focusRequest = undefined;
                  run.parentFocused = value; run.parentFocusAt = now(); resolve(value);
                } };
                request.timer = setTimeout(() => request.finish(false), 1000);
                run.focusRequest = request;
                emit(run, 'focus_probe', { echo: probe.echo });
              });
              if (!fresh(run) || run.channel !== channel || channel.readyState !== 'open' || channel.bufferedAmount > 64 * 1024) return;
            } else hasFocus = focused(run);
            const visible = platform.document?.visibilityState === 'visible';
            channel.send(JSON.stringify({ version: 1, kind: 'health_reply', echo: probe.echo,
              first_frame: run.presented, visible, focused: hasFocus,
              receiving: observed && peer.connectionState === 'connected' && run.track?.readyState === 'live'
                && !run.track.muted && run.track.enabled === true && !video.paused && run.presentationObservable === true,
              decoded: String(run.decoded), presented: String(run.presentedCount) }));
            run.lastProbe = now();
            if (!visible || !hasFocus) run.control?.release();
          } catch (_) { /* An unanswered round trip expires on the host. */ }
          finally { run.probeBusy = false; }
        };
        let bound = false;
        const opened = () => {
          if (!fresh(run) || bound || run.bindTask !== undefined) return;
          if (channel.readyState !== 'open') { channelFailed(); return; }
          // Leave native open/datachannel dispatch before the first send. A
          // WebView may expose cached open state while its native callback is
          // still unwinding. This is one scheduled send, never a retry.
          run.bindTask = setTimeout(() => {
            run.bindTask = undefined;
            if (!fresh(run) || bound) return;
            if (channel.readyState !== 'open') { channelFailed(); return; }
            bound = true;
            try {
              channel.send(JSON.stringify({ version: 1, kind: 'bind', attach_id: run.attach, connection_id: run.connection }));
            } catch (_) { channelFailed(); return; }
            emit(run, 'bound');
          }, 0);
        };
        channel.onopen = opened;
        channel.onerror = channelFailed;
        channel.onclose = channelFailed;
        // Native WebViews may deliver datachannel after its open transition.
        // Install handlers first, then reconcile current state without a second bind.
        if (channel.readyState === 'open') opened();
      };
      peer.ontrack = event => {
        if (!fresh(run) || event.track.kind !== 'video' || run.track) { event.track.stop(); return; }
        run.track = event.track;
        const stream = new platform.MediaStream([event.track]);
        video.srcObject = stream;
        event.track.onended = () => fail(run, 'media_unreachable', 'track');
        void video.play().catch(() => fail(run, 'media_playback_failed', 'playback'));
        const presented = (_time, metadata) => {
          if (!fresh(run)) return;
          if (metadata.width > 0 && metadata.height > 0) {
            // Live WebKit tracks can keep mediaTime constant. Prefer the
            // compositor's monotonically advancing presentedFrames counter;
            // never replace a stuck/regressed counter with decoder progress.
            let advanced = false;
            if (metadata.presentedFrames !== undefined || run.presentationCounter !== undefined) {
              const counter = metadata.presentedFrames;
              if (!Number.isSafeInteger(counter) || counter < 0
                || (run.presentationCounter !== undefined && counter < run.presentationCounter)) {
                run.presentationBroken = true;
                run.presentationObservable = false;
              } else {
                advanced = counter > 0 && (run.presentationCounter === undefined || counter > run.presentationCounter);
                run.presentationCounter = counter;
              }
            } else if (Number.isFinite(metadata.mediaTime) && metadata.mediaTime >= 0
              && (run.mediaTime === undefined || metadata.mediaTime > run.mediaTime)) {
              run.mediaTime = metadata.mediaTime; advanced = true;
            }
            if (advanced && !run.presentationBroken) {
              run.presentedCount += 1;
              run.presentationObservable = Number.isSafeInteger(run.presentedCount);
            }
            const resized = run.presented && (run.lastFrame.width !== metadata.width || run.lastFrame.height !== metadata.height);
            run.lastFrame = { width: metadata.width, height: metadata.height };
            if (resized) {
              // Local presentation geometry changed, not the authorized OS
              // display. Retire old input before notifying its native shell.
              run.control?.release();
              emit(run, 'frame_resized', run.lastFrame);
            }
            confirmPresentation(run);
          }
          if (fresh(run)) run.frame = video.requestVideoFrameCallback(presented);
        };
        run.frame = video.requestVideoFrameCallback(presented);
      };
      await peer.setRemoteDescription({ type: 'offer', sdp: config.offer_sdp });
      if (!fresh(run)) return;
      const answer = await peer.createAnswer();
      if (!fresh(run)) return;
      await peer.setLocalDescription(answer);
      if (!fresh(run)) return;
      const deadline = Date.now() + 20000;
      while (peer.iceGatheringState !== 'complete') {
        if (!fresh(run)) return;
        if (Date.now() >= deadline) throw new Error('media_unreachable');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!fresh(run)) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp || sdp.length > 90 * 1024) throw new Error('invalid_answer');
      // gathered_sdp_v1 has no later trickle path to supply a missing candidate.
      if (!/^a=candidate:/m.test(sdp)) {
        fail(run, 'media_unreachable', run.iceError ? `ice_${run.iceError}` : 'ice_no_candidates');
        return;
      }
      emit(run, 'answer', { answer_sdp: sdp });
      if (!fresh(run)) return;
      run.stats = setInterval(async () => {
        try {
          const reports = await peer.getStats();
          if (!fresh(run)) return;
          let decoded = 0, pair;
          reports.forEach(report => {
            if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) decoded = report.framesDecoded || 0;
            if (report.type === 'transport' && report.selectedCandidatePairId) pair = reports.get(report.selectedCandidatePairId);
          });
          if (!pair || pair.state !== 'succeeded') return;
          const local = reports.get(pair.localCandidateId), remote = reports.get(pair.remoteCandidateId);
          emit(run, 'health', { frames_decoded: decoded, candidate_type: local?.candidateType,
            remote_candidate_type: remote?.candidateType, protocol: local?.protocol,
            relay_protocol: local?.relayProtocol });
        } catch (_) { fail(run, 'media_unreachable', 'stats'); }
      }, 1000);
    }
    function accept(command) {
      if (command.kind === 'stop') { stop(); return Promise.resolve(); }
      if (command.kind === 'focus_reply') {
        const run = current;
        if (run && fresh(run) && run.parentFocus && command.renderer_id === run.id
          && command.attach_id === run.attach && command.connection_id === run.connection
          && run.focusRequest?.echo === command.echo) {
          run.focusRequest.finish(command.focused === true);
        }
        return Promise.resolve();
      }
      if (command.kind === 'control') {
        const run = current;
        if (run && fresh(run) && command.renderer_id === run.id && command.attach_id === run.attach
          && command.connection_id === run.connection && run.control) {
          const epoch = command.control_epoch;
          const action = command.body?.kind;
          // App/renderer causality only; this field never enters DC input.
          if (epoch !== undefined) {
            if (!localEpoch(epoch) || run.controlEpoch !== undefined && olderEpoch(epoch, run.controlEpoch)) return Promise.resolve();
            if (action !== 'acquire_control' && action !== 'release_control' && epoch !== run.controlEpoch) return Promise.resolve();
            run.controlEpoch = epoch;
          } else if (run.controlEpoch !== undefined && action !== 'release_control') return Promise.resolve();
          if (command.body?.kind === 'acquire_control') {
            if (!run.control.acquire(command.body.expected_state_revision)) controlState(run, { code: 'input_suspended' });
          }
          else if (command.body?.kind === 'release_control') run.control.release();
          else if (command.body) run.control.input(command.body);
        }
        return Promise.resolve();
      }
      if (command.kind === 'source_ready') {
        if (current && command.renderer_id === current.id && command.connection_id === current.connection) {
          current.source = true;
          confirmPresentation(current);
        }
        return Promise.resolve();
      }
      if (command.kind !== 'start') return Promise.resolve();
      const expected = ++generation;
      return start(command, expected).catch(error => {
        if (expected !== generation) return;
        const run = current;
        if (run) fail(run, error.message, 'setup');
        else {
          post({kind: 'failed', renderer_id: command.renderer_id, attach_id: command.attach_id, connection_id: command.connection_id, code: error.message});
          if (expected === generation) stop();
        }
      });
    }
    function capture(rendererId) {
      const run = current, width = video.videoWidth, height = video.videoHeight;
      if (!run || !fresh(run) || run.id !== rendererId || !run.presented || !run.source
        || run.peer.connectionState !== 'connected' || run.track?.readyState !== 'live' || run.track.muted
        || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
        || width * height > 16777216) return '';
      const canvas = platform.document.createElement('canvas');
      try {
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(video, 0, 0, width, height);
        const png = canvas.toDataURL('image/png');
        return png.length <= 24 * 1024 * 1024 ? png : '';
      } finally { canvas.width = 0; canvas.height = 0; }
    }
    return { accept, stop, capture };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createReceiver };
  root.OpenBitFunRemoteDesktopMedia = { createReceiver };
  if (root.document) {
    const post = event => root.OpenBitFunDesktopHost?.postMessage(JSON.stringify(event));
    const receiver = createReceiver(root.OpenBitFunNativeMedia?.video ?? root.document.querySelector('video'), post);
    root.OpenBitFunDesktopReceiver = receiver;
    post({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'] });
    root.addEventListener('pagehide', () => receiver.stop());
    root.addEventListener('beforeunload', () => receiver.stop());
  }
})(typeof window === 'undefined' ? globalThis : window);
