const test = require('node:test'), assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, writeFile, mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('closing the current ordered channel stops actual receiver video and reports failure', { timeout: 30000 }, () => withReceiver(async page => {
  await page.evaluate(() => window.senderChannel.close());
  await page.waitForFunction(() => window.events.some(event => event.kind === 'failed' && event.code === 'media_unreachable')
    && document.querySelector('video').srcObject === null);
  assert.equal(await page.evaluate(() => document.querySelector('video').paused), true);
  assert.equal(await page.evaluate(() => window.events.filter(event => event.kind === 'failed').length), 1);
}));

async function withReceiver(check, options = {}) {
  const { launchBrowser } = await import('../../../../../mobile-web/tests/helpers/browser-account-harness.mjs');
  const root = path.resolve(__dirname, '../../../../../shared/remote-desktop-media');
  const server = createServer(async (request, response) => {
    const file = request.url === '/' ? 'index.html' : ['/receiver.js', '/control.js'].includes(request.url) ? request.url.slice(1) : undefined;
    if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', file.endsWith('.html') ? 'text/html' : 'text/javascript');
    response.end(await readFile(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await launchBrowser(); const page = await browser.newPage();
    await page.setViewport({ width: 400, height: 600 });
    await page.evaluateOnNewDocument(() => {
      window.events = []; window.OpenBitFunDesktopHost = { postMessage: raw => window.events.push(JSON.parse(raw)) };
      const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        return original.call(this, (now, metadata) => {
          // Fault injection suppresses the application's presentation witness,
          // not the physical compositor. Actual RTP/decoder work continues.
          if (!window.freezePresentationWitness) callback(now,metadata);
        });
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.events.some(event => event.kind === 'bridge_ready'));
    await page.evaluate(async controlSupported => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      window.testCanvas = canvas;
      const context = canvas.getContext('2d'); let frame = 0;
      const draw = () => { context.fillStyle = (++frame % 2) ? 'red' : 'blue'; context.fillRect(0, 0, 320, 180); };
      draw(); window.frameTimer = setInterval(draw, 100);
      const stream = canvas.captureStream(10); window.sender = new RTCPeerConnection();
      stream.getTracks().forEach(track => window.sender.addTrack(track, stream));
      window.senderChannel = window.sender.createDataChannel('rd', { ordered: true });
      window.healthReplies = [];
      window.controlRequests = []; window.inputMessages = [];
      window.senderChannel.onmessage = event => {
        const value = JSON.parse(event.data);
        if (value.kind === 'bind') window.binding = value;
        else if (value.kind === 'health_reply') window.healthReplies.push(value);
        else if (['acquire_control', 'renew_control', 'release_control'].includes(value.kind)) window.controlRequests.push(value);
        else window.inputMessages.push(value);
      };
      await window.sender.setLocalDescription(await window.sender.createOffer());
      if (window.sender.iceGatheringState !== 'complete') await new Promise(resolve => {
        window.sender.onicegatheringstatechange = () => { if (window.sender.iceGatheringState === 'complete') resolve(); };
      });
      await window.OpenBitFunDesktopReceiver.accept({ kind: 'start', renderer_id: 'browser', attach_id: 'attachment', connection_id: 'connection',
        offer_sdp: window.sender.localDescription.sdp, ice_servers: [], force_relay: false, control_supported: controlSupported });
      const answer = window.events.find(event => event.kind === 'answer');
      await window.sender.setRemoteDescription({ type: 'answer', sdp: answer.answer_sdp });
      // This fixture confirms its canvas source, not a native desktop capture provider.
      await window.OpenBitFunDesktopReceiver.accept({ kind: 'source_ready', renderer_id: 'browser', connection_id: 'connection' });
    }, options.controlSupported === true);
    await page.waitForFunction(() => window.events.some(event => event.kind === 'first_frame_presented') && window.binding?.kind === 'bind', { timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => window.binding), { version: 1, kind: 'bind', attach_id: 'attachment', connection_id: 'connection' });
    assert.deepEqual(await page.evaluate(() => { const e = window.events.find(event => event.kind === 'first_frame_presented'); return [e.width, e.height]; }), [320, 180]);
    await page.setViewport({ width: 900, height: 600 });
    assert.equal(await page.evaluate(() => window.sender.connectionState), 'connected');
    assert.equal(await page.evaluate(() => window.events.filter(event => event.kind === 'bridge_ready').length), 1);
    await check(page);
    await page.evaluate(() => { window.OpenBitFunDesktopReceiver.stop(); clearInterval(window.frameTimer); clearInterval(window.healthTimer); window.sender.close(); });
    assert.equal(await page.$eval('video', video => video.srcObject), null);
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
}

test('bundled receiver presents loopback video, binds rd, survives resize and closes media', { timeout: 30000 }, () => withReceiver(async () => {}));

async function probe(page, echo) {
  await page.evaluate(echo => window.senderChannel.send(JSON.stringify({version:1,kind:'health_probe',echo})),echo);
  await page.waitForFunction(echo => window.healthReplies.some(reply => reply.echo === echo),{timeout:3000},echo);
  return page.evaluate(echo => window.healthReplies.find(reply => reply.echo === echo),echo);
}

test('a real disabled receive track reports no receiving while its connection stays live', {timeout:30000}, () => withReceiver(async page => {
  await page.bringToFront();
  const before = await probe(page, '0');
  assert.equal(before.receiving, true);
  assert.deepEqual(await page.$eval('video', video => {
    const track = video.srcObject.getVideoTracks()[0];
    track.enabled = false;
    return { enabled: track.enabled, readyState: track.readyState, muted: track.muted };
  }), { enabled: false, readyState: 'live', muted: false });
  const after = await probe(page, '2000');
  assert.equal(after.first_frame, true);
  assert.equal(after.receiving, false, 'a disabled live track cannot justify remote input');
  assert.equal(await page.evaluate(() => window.sender.connectionState), 'connected');
  assert.equal(await page.evaluate(() => window.events.filter(event => event.kind === 'bridge_ready').length), 1);
}));

test('real decoder progress cannot conceal a frozen presentation witness; static source is observable separately', {timeout:30000}, () => withReceiver(async page => {
  await page.bringToFront();
  const first = await probe(page,'0');
  assert.equal(first.first_frame,true);
  assert.equal(first.visible,true);
  assert.equal(first.focused,true);
  assert.equal(first.receiving,true);
  assert.ok(Number(first.decoded)>0 && Number(first.presented)>0);
  await page.waitForFunction(() => window.events.some(event => event.kind==='health' && event.frames_decoded>1));
  await page.evaluate(() => { window.freezePresentationWitness = true; });
  // Let the single already scheduled callback be suppressed, then take two
  // fresh round trips while real decoder statistics continue increasing.
  await new Promise(resolve => setTimeout(resolve,250));
  const frozen = await probe(page,'2000');
  await new Promise(resolve => setTimeout(resolve,400));
  const later = await probe(page,'4000');
  assert.ok(Number(later.decoded)>Number(frozen.decoded));
  assert.equal(later.presented,frozen.presented);
  assert.equal(later.receiving,true,'live RTP alone cannot mean live presentation');
  await page.evaluate(() => clearInterval(window.frameTimer));
  await new Promise(resolve => setTimeout(resolve,500));
  const stoppedSource = await probe(page,'6000');
  await new Promise(resolve => setTimeout(resolve,400));
  const staticSource = await probe(page,'8000');
  assert.equal(staticSource.decoded,stoppedSource.decoded);
  assert.equal(staticSource.presented,stoppedSource.presented);
  const directory = await mkdtemp(path.join(tmpdir(),'openbitfun-rd-health-browser-'));
  await writeFile(path.join(directory,'observations.json'),JSON.stringify({
    scope:'Chromium loopback canvas; presentation-witness fault, not physical scanout/native capture or phone',
    first, frozen, later, stoppedSource, staticSource
  },null,2),{mode:0o600});
  console.log(`Browser health evidence: ${directory}`);
}));

test('real ordered channel preserves release ACK barrier and closes on an unknown release', { timeout: 30000 }, () => withReceiver(async page => {
  await page.bringToFront(); await probe(page, '1');
  await page.evaluate(() => {
    let echo = 1;
    window.healthTimer = setInterval(() => {
      if (window.senderChannel.readyState === 'open') window.senderChannel.send(JSON.stringify({ version: 1, kind: 'health_probe', echo: String(++echo) }));
    }, 500);
  });
  const command = body => page.evaluate(body => window.OpenBitFunDesktopReceiver.accept({ kind: 'control',
    renderer_id: 'browser', attach_id: 'attachment', connection_id: 'connection', body }), body);
  const count = kind => page.evaluate(kind => window.controlRequests.filter(request => request.kind === kind).length, kind);
  const reply = (request, generation) => page.evaluate((request, generation) => window.senderChannel.send(JSON.stringify({
    version: 1, kind: 'control_result', request_id: request.request_id, code: 'ok', control_generation: generation
  })), request, generation);
  await command({ kind: 'acquire_control', expected_state_revision: 'boot:1' });
  await page.waitForFunction(() => window.controlRequests.some(request => request.kind === 'acquire_control'));
  const acquire = await page.evaluate(() => window.controlRequests.find(request => request.kind === 'acquire_control'));
  await reply(acquire, '1');
  await page.waitForFunction(() => window.events.some(event => event.kind === 'control_state' && event.control_generation === '1'));
  await page.waitForFunction(() => window.controlRequests.some(request => request.kind === 'renew_control'));
  const renew = await page.evaluate(() => window.controlRequests.find(request => request.kind === 'renew_control'));
  await command({ kind: 'release_control' }); await command({ kind: 'release_control' });
  await page.waitForFunction(() => window.controlRequests.some(request => request.kind === 'release_control'));
  const release = await page.evaluate(() => window.controlRequests.find(request => request.kind === 'release_control'));
  await reply(renew, '1');
  await command({ kind: 'key', control_generation: '1', body: { usage: 40, down: true } });
  await command({ kind: 'acquire_control', expected_state_revision: 'boot:3' });
  assert.equal(await count('acquire_control'), 1, 'New acquisition crossed an unconfirmed release');
  assert.equal(await count('release_control'), 1, 'Duplicate release was sent');
  assert.equal(await page.evaluate(() => window.inputMessages.length), 0, 'Retired input crossed the DataChannel');
  assert.equal(await page.evaluate(() => window.sender.connectionState), 'connected');
  await reply(release, '1');
  await page.waitForFunction(() => {
    const state = window.events.filter(event => event.kind === 'control_state').at(-1);
    return state?.code === 'ok' && state.pending === undefined && state.control_generation === undefined;
  });
  await command({ kind: 'acquire_control', expected_state_revision: 'boot:3' });
  await page.waitForFunction(() => window.controlRequests.filter(request => request.kind === 'acquire_control').length === 2);
  await reply(await page.evaluate(() => window.controlRequests.filter(request => request.kind === 'acquire_control').at(-1)), '3');
  await page.waitForFunction(() => window.events.filter(event => event.kind === 'control_state').at(-1)?.control_generation === '3');
  await command({ kind: 'release_control' }); await command({ kind: 'release_control' });
  await page.waitForFunction(() => window.controlRequests.filter(request => request.kind === 'release_control').length === 2);
  // This fixture host deliberately withholds the second release ACK. No OS
  // provider exists here; this checks real browser/DC timeout and local closure.
  await page.waitForFunction(() => window.events.some(event => event.kind === 'failed' && event.code === 'control_delivery_unknown'), { timeout: 7000 });
  assert.equal(await page.$eval('video', video => video.srcObject), null);
  assert.equal(await count('acquire_control'), 2, 'Timeout automatically reacquired control');
}, { controlSupported: true }));

test('real ordered channel accepts a matching post-drain revocation without a release ACK', { timeout: 30000 }, () => withReceiver(async page => {
  await page.bringToFront(); await probe(page, '1');
  await page.evaluate(() => {
    let echo = 1;
    window.healthTimer = setInterval(() => window.senderChannel.send(JSON.stringify({
      version: 1, kind: 'health_probe', echo: String(++echo)
    })), 500);
  });
  const command = body => page.evaluate(body => window.OpenBitFunDesktopReceiver.accept({ kind: 'control',
    renderer_id: 'browser', attach_id: 'attachment', connection_id: 'connection', body }), body);
  const send = message => page.evaluate(message => window.senderChannel.send(JSON.stringify(message)), message);
  const reply = (request, generation) => send({ version: 1, kind: 'control_result', request_id: request.request_id,
    code: 'ok', control_generation: generation });
  await command({ kind: 'acquire_control', expected_state_revision: 'boot:1' });
  await page.waitForFunction(() => window.controlRequests.some(r => r.kind === 'acquire_control'));
  await reply(await page.evaluate(() => window.controlRequests.at(-1)), '1');
  await page.waitForFunction(() => window.events.filter(e => e.kind === 'control_state').at(-1)?.control_generation === '1');
  await command({ kind: 'release_control' });
  await page.waitForFunction(() => window.controlRequests.some(r => r.kind === 'release_control'));
  const release = await page.evaluate(() => window.controlRequests.at(-1));
  await send({ version: 1, kind: 'control_revoked', control_generation: '9' });
  await command({ kind: 'acquire_control', expected_state_revision: 'boot:3' });
  assert.equal(await page.evaluate(() => window.controlRequests.filter(r => r.kind === 'acquire_control').length), 1);
  // Emulate the native host discarding the queued release on health loss and
  // notifying after drainage. This fixture has no native input provider.
  await send({ version: 1, kind: 'control_revoked', control_generation: '1' });
  await page.waitForFunction(() => {
    const state = window.events.filter(e => e.kind === 'control_state').at(-1);
    return state?.code === 'control_revoked' && state.pending === undefined && state.control_generation === undefined;
  });
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal(await page.evaluate(() => window.events.some(e => e.kind === 'failed')), false, 'Confirmed revocation timed out');
  assert.equal(await page.evaluate(() => window.sender.connectionState), 'connected');
  await command({ kind: 'key', control_generation: '1', body: { usage: 40, down: true } });
  assert.equal(await page.evaluate(() => window.inputMessages.length), 0);
  await command({ kind: 'acquire_control', expected_state_revision: 'boot:3' });
  await page.waitForFunction(() => window.controlRequests.filter(r => r.kind === 'acquire_control').length === 2);
  const acquire = await page.evaluate(() => window.controlRequests.at(-1));
  await reply(release, '1');
  await send({ version: 1, kind: 'control_revoked', control_generation: '1' });
  await page.waitForFunction(() => window.events.filter(e => e.kind === 'control_state').at(-1)?.pending === 'acquire_control');
  await reply(acquire, '3');
  await page.waitForFunction(() => window.events.filter(e => e.kind === 'control_state').at(-1)?.control_generation === '3');
  await command({ kind: 'key', control_generation: '3', body: { usage: 40, down: false } });
  await page.waitForFunction(() => window.inputMessages.length === 1);
}, { controlSupported: true }));

test('real decoded size changes emit local resize metadata on the same receiver connection', () => withReceiver(async page => {
  await page.waitForFunction(() => window.events.some(e => e.kind === 'first_frame_presented'));
  await page.evaluate(() => { window.testCanvas.width = 640; window.testCanvas.height = 360; });
  await page.waitForFunction(() => window.events.some(e => e.kind === 'frame_resized' && e.width === 640 && e.height === 360), { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.events.filter(e => e.kind === 'first_frame_presented').length), 1);
  assert.equal(await page.evaluate(() => window.sender.connectionState), 'connected');
  assert.equal(await page.evaluate(() => window.events.some(e => e.kind === 'failed')), false);
}));
