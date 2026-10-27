const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const loaded = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '../../../../../shared/remote-desktop-media/receiver.js'), 'utf8'))(loaded);
const { createReceiver } = loaded.exports;
function fixture(context, deferredRemote = false, onEvent = () => {}) {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const peers = [], events = [], frames = new Map(); let frameId = 0, resume;
  const wait = deferredRemote ? new Promise(resolve => { resume = resolve; }) : Promise.resolve();
  class Peer {
    constructor(options) { this.options = options; peers.push(this); this.iceGatheringState = 'complete'; this.connectionState = 'connected'; this.answerSdp = 'v=0\r\na=candidate:1 1 udp 1 192.0.2.1 5000 typ host\r\n'; }
    async setRemoteDescription(value) { this.remote = value; await wait; }
    async createAnswer() { return { type: 'answer', sdp: this.answerSdp }; }
    async setLocalDescription(value) { this.localDescription = value; this.localSet = true; }
    close() { this.closed = true; }
    async getStats() { return new Map(); }
  }
  const video = { srcObject: null, async play() {}, pause() {}, requestVideoFrameCallback(callback) { frames.set(++frameId, callback); return frameId; }, cancelVideoFrameCallback(id) { frames.delete(id); } };
  const platform = { performance: { now: () => Date.now() }, RTCPeerConnection: Peer, MediaStream: class { constructor(tracks) { this.tracks = tracks; } } };
  const receiver = createReceiver(video, event => { events.push(event); onEvent(event); }, platform);
  const config = { kind: 'start', renderer_id: 'renderer', attach_id: 'attachment', connection_id: 'connection', offer_sdp: 'offer', ice_servers: [], force_relay: true };
  return { platform, peers, events, frames, receiver, config, video, resume, flushTasks() { context.mock.timers.tick(0); }, present() { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(0, { width: 1280, height: 830 }); } };
}

test('complete ICE gathering without any candidate fails and closes instead of sending an unusable answer', async context => {
  const f = fixture(context, true), started = f.receiver.accept(f.config);
  f.peers[0].answerSdp = 'v=0\r\n';
  f.resume(); await started;
  assert.equal(f.events.some(event => event.kind === 'answer'), false);
  assert.deepEqual(f.events.filter(event => event.kind === 'failed').map(event => event.code), ['media_unreachable']);
  assert.equal(f.peers[0].closed, true);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.frames.size, 0);
});

test('P2P discovery stays on the approved UDP endpoint and forced relay adds no STUN', async context => {
  const f = fixture(context);
  const original = [{ urls: ['turn:trial.example:3478?transport=udp', 'turn:trial.example:3478?transport=tcp',
    'turns:secure.example:5349'], username: 'short-lived', credential: 'private' }];
  const before = JSON.stringify(original);
  try {
    await f.receiver.accept({ ...f.config, ice_servers: original, force_relay: false });
    assert.deepEqual(f.peers[0].options.iceServers, [...original, { urls: ['stun:trial.example:3478'] }]);
    assert.equal(f.peers[0].options.iceTransportPolicy, 'all');
    assert.equal(JSON.stringify(original), before);
    await f.receiver.accept({ ...f.config, renderer_id: 'forced', ice_servers: original });
    assert.deepEqual(f.peers[1].options.iceServers, original);
    assert.equal(f.peers[1].options.iceTransportPolicy, 'relay');
    await f.receiver.accept({ ...f.config, renderer_id: 'tls-only', ice_servers: [{ urls: ['turns:secure.example:5349',
      'turn:tcp.example:3478?transport=tcp'] }], force_relay: false });
    assert.equal(f.peers[2].options.iceServers.length, 1, 'TCP/TLS policy must not cause UDP discovery');
  } finally { f.receiver.stop(); }
});

test('local control epochs stamp reports at creation and never enter DC input', async context => {
  const f = fixture(context), received = [];
  f.platform.OpenBitFunRemoteDesktopControl = { createController(hooks) { return {
    acquire() { hooks.state({ code: 'ok', control_generation: '1' }); return true; },
    release() { hooks.state({ code: 'ok' }); }, input(value) { received.push(value); }, stop() {},
  }; } };
  try {
    await f.receiver.accept({ ...f.config, control_supported: true, control_epoch: '0' });
    const send = (epoch, body) => f.receiver.accept({ kind: 'control', renderer_id: 'renderer', attach_id: 'attachment',
      connection_id: 'connection', control_epoch: epoch, body });
    await send('1', { kind: 'acquire_control', expected_state_revision: 'boot:1' });
    const grant = f.events.find(event => event.kind === 'control_state');
    assert.equal(grant.control_epoch, '1');
    const input = { kind: 'pointer_button', control_generation: '1', body: { x: 0.5, y: 0.5, button: 'left', down: true } };
    await send('1', input); assert.deepEqual(received, [input]);
    assert.equal(Object.hasOwn(received[0], 'control_epoch'), false);
    await send('2', { kind: 'release_control' });
    assert.equal(f.events.at(-1).control_epoch, '2'); assert.equal(grant.control_epoch, '1');
    const before = f.events.length;
    await send('1', { kind: 'acquire_control', expected_state_revision: 'boot:1' });
    await send('1', input); await send(undefined, input);
    assert.equal(f.events.length, before); assert.equal(received.length, 1);
    await send('3', input); assert.equal(received.length, 1, 'input cannot advance a local control epoch');
  } finally { f.receiver.stop(); }
});

test('legacy control reports remain readable without a local epoch contract', async context => {
  const f = fixture(context);
  f.platform.OpenBitFunRemoteDesktopControl = { createController(hooks) { return {
    acquire() { hooks.state({ code: 'ok', control_generation: '1' }); return true; }, release() {}, input() {}, stop() {},
  }; } };
  try {
    await f.receiver.accept({ ...f.config, control_supported: true });
    await f.receiver.accept({ kind: 'control', renderer_id: 'renderer', attach_id: 'attachment', connection_id: 'connection',
      body: { kind: 'acquire_control', expected_state_revision: 'boot:1' } });
    assert.equal(Object.hasOwn(f.events.find(event => event.kind === 'control_state'), 'control_epoch'), false);
  } finally { f.receiver.stop(); }
});

test('invalid local control epochs fail config and rejected acquire still carries its epoch', async context => {
  const f = fixture(context);
  for (const control_epoch of ['01', '-1', '9223372036854775808', 1]) {
    await f.receiver.accept({ ...f.config, control_epoch });
    assert.equal(f.events.at(-1).kind, 'failed');
  }
  f.platform.OpenBitFunRemoteDesktopControl = { createController() { return { acquire() { return false; }, release() {}, input() {}, stop() {} }; } };
  try {
    await f.receiver.accept({ ...f.config, control_supported: true, control_epoch: '0' });
    await f.receiver.accept({ kind: 'control', renderer_id: 'renderer', attach_id: 'attachment', connection_id: 'connection',
      control_epoch: '1', body: { kind: 'acquire_control', expected_state_revision: 'boot:1' } });
    assert.equal(f.events.at(-1).control_epoch, '1'); assert.equal(f.events.at(-1).code, 'input_suspended');
  } finally { f.receiver.stop(); }
});

function healthChannel(f) {
  const channel = { label: 'rd', ordered: true, maxRetransmits: null, maxPacketLifeTime: null,
    readyState: 'open', bufferedAmount: 0, sent: [], send(value) { this.sent.push(JSON.parse(value)); }, close() { this.closed = true; } };
  f.peers[0].ondatachannel({ channel }); channel.onopen(); f.flushTasks(); return channel;
}

for (const initial of ['open', 'connecting']) {
  test(`a delivered ${initial} DataChannel binds exactly once even when open preceded handler installation`, async context => {
    const f = fixture(context);
    await f.receiver.accept(f.config);
    const channel = { label: 'rd', ordered: true, maxRetransmits: null, maxPacketLifeTime: null,
      readyState: initial, bufferedAmount: 0, sent: [],
      send(value) { this.sent.push(JSON.parse(value)); }, close() { this.closed = true; } };
    try {
      f.peers[0].ondatachannel({ channel });
      assert.equal(channel.sent.length, 0, 'native event dispatch must return before the first send');
      channel.readyState = 'open'; channel.onopen(); channel.onopen();
      f.flushTasks(); channel.onopen(); f.flushTasks();
      assert.deepEqual(channel.sent, [{ version: 1, kind: 'bind', attach_id: 'attachment', connection_id: 'connection' }]);
      assert.equal(f.events.filter(event => event.kind === 'bound').length, 1);
      assert.equal(f.events.some(event => event.kind === 'failed'), false);
    } finally { f.receiver.stop(); }
  });
}

for (const failure of ['send_throws', 'not_open', 'error_event', 'closed']) {
  test(`current DataChannel ${failure} fails visibly and retires its media`, async context => {
    const f = fixture(context);
    await f.receiver.accept(f.config);
    const channel = { label: 'rd', ordered: true, maxRetransmits: null, maxPacketLifeTime: null,
      readyState: failure === 'not_open' ? 'connecting' : 'open', bufferedAmount: 0,
      send() { if (failure === 'send_throws') throw new Error('send failed'); }, close() { this.closed = true; } };
    f.peers[0].ondatachannel({ channel });
    assert.doesNotThrow(() => channel.onopen());
    f.flushTasks();
    if (failure === 'error_event') channel.onerror();
    if (failure === 'closed') channel.onclose();
    assert.deepEqual(f.events.filter(event => event.kind === 'failed').map(event => event.code), ['media_unreachable']);
    assert.equal(f.peers[0].closed, true); assert.equal(channel.closed, true);
    assert.equal(f.video.srcObject, null);
    if (failure === 'send_throws' || failure === 'not_open') assert.equal(f.events.some(event => event.kind === 'bound'), false);
  });
}

test('retired channel error and close callbacks cannot retire a successor', async context => {
  const f = fixture(context);
  await f.receiver.accept(f.config); const old = healthChannel(f);
  await f.receiver.accept({ ...f.config, renderer_id: 'new', connection_id: 'new-pc' });
  const before = f.events.length;
  old.onerror(); old.onclose();
  assert.equal(f.events.length, before); assert.notEqual(f.peers[1].closed, true);
  f.receiver.stop();
});

test('bind leaves native event dispatch and a retired pending bind never reaches a successor', async context => {
  const f = fixture(context);
  await f.receiver.accept(f.config);
  let dispatching = true;
  const channel = { label: 'rd', ordered: true, maxRetransmits: null, maxPacketLifeTime: null,
    readyState: 'open', bufferedAmount: 0, sent: [],
    send(value) { assert.equal(dispatching, false); this.sent.push(JSON.parse(value)); }, close() { this.closed = true; } };
  f.peers[0].ondatachannel({ channel }); channel.onopen();
  assert.equal(channel.sent.length, 0);
  dispatching = false; f.flushTasks(); assert.equal(channel.sent.length, 1);
  await f.receiver.accept({ ...f.config, renderer_id: 'new', connection_id: 'new-pc' });
  const successor = { ...channel, sent: [] };
  f.peers[1].ondatachannel({ channel: successor });
  f.receiver.stop(); f.flushTasks();
  assert.equal(successor.sent.length, 0); assert.equal(successor.closed, true);
  assert.equal(f.events.some(event => event.kind === 'failed'), false);
});

for (const failure of ['peer_failed', 'peer_closed', 'track_ended', 'play_rejected', 'stats_rejected']) {
  test(`current media ${failure} retires the track, video and PC without waiting for the app`, async context => {
    const f = fixture(context);
    await f.receiver.accept(f.config); const channel = healthChannel(f);
    const track = { kind: 'video', readyState: 'live', stop() { this.stopped = true; } };
    if (failure === 'play_rejected') f.video.play = async () => { throw new Error('play denied'); };
    f.peers[0].ontrack({ track });
    if (failure.startsWith('peer_')) {
      f.peers[0].connectionState = failure.slice(5); f.peers[0].onconnectionstatechange();
    } else if (failure === 'track_ended') track.onended();
    else if (failure === 'stats_rejected') {
      f.peers[0].getStats = async () => { throw new Error('stats failed'); };
      context.mock.timers.tick(1000);
    }
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(f.events.filter(e => e.kind === 'failed').map(e => e.code),
      [failure === 'play_rejected' ? 'media_playback_failed' : 'media_unreachable']);
    assert.equal(f.peers[0].closed, true); assert.equal(channel.closed, true);
    assert.equal(track.stopped, true); assert.equal(f.frames.size, 0); assert.equal(f.video.srcObject, null);
    const before = f.events.length;
    track.onended(); f.peers[0].onconnectionstatechange(); channel.onclose();
    context.mock.timers.tick(2000); await Promise.resolve();
    assert.equal(f.events.length, before, 'terminal callbacks cannot repeat failure or rearm work');
    f.receiver.stop();
  });
}

test('a failed start callback may start a successor without old failure cleanup closing it', async context => {
  let successor;
  const f = fixture(context, true, event => {
    if (event.kind === 'failed') successor = f.receiver.accept({ ...f.config, renderer_id: 'next', connection_id: 'next-pc' });
  });
  const started = f.receiver.accept(f.config); f.peers[0].answerSdp = 'v=0\r\n'; f.resume();
  await started; await successor;
  assert.equal(f.peers.length, 2); assert.equal(f.peers[0].closed, true);
  assert.notEqual(f.peers[1].closed, true);
  assert.deepEqual(f.events.filter(e => e.kind === 'answer').map(e => e.renderer_id), ['next']);
  f.receiver.stop();
});

test('retired track, peer, play and stats failures cannot fail or close a successor', async context => {
  const f = fixture(context); let rejectPlay, rejectStats;
  await f.receiver.accept(f.config); const old = f.peers[0]; healthChannel(f);
  f.video.play = () => new Promise((_, reject) => { rejectPlay = reject; });
  const track = { kind: 'video', stop() {} }; old.ontrack({ track });
  old.getStats = () => new Promise((_, reject) => { rejectStats = reject; });
  context.mock.timers.tick(1000);
  await f.receiver.accept({ ...f.config, renderer_id: 'next', connection_id: 'next-pc' });
  const before = f.events.length;
  old.connectionState = 'failed'; old.onconnectionstatechange(); track.onended();
  rejectPlay(new Error('late play rejection')); rejectStats(new Error('late stats rejection'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.events.length, before); assert.notEqual(f.peers[1].closed, true);
  f.receiver.stop();
});

test('stopping inside the answer callback cannot install a periodic stats task after cleanup', async context => {
  let stats = 0;
  const f = fixture(context, false, event => {
    if (event.kind !== 'answer') return;
    f.peers[0].getStats = async () => { stats++; return new Map(); };
    f.receiver.stop();
  });
  await f.receiver.accept(f.config);
  context.mock.timers.tick(2000); await Promise.resolve();
  assert.equal(f.peers[0].closed, true); assert.equal(stats, 0);
});

test('desktop parent focus must answer the current bound health challenge', async context => {
  const f = fixture(context);
  f.platform.document = { visibilityState: 'visible', hasFocus: () => false };
  try {
    await f.receiver.accept({ ...f.config, parent_focus: true }); const channel = healthChannel(f);
    const pending = channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '1' }) });
    await Promise.resolve();
    assert.equal(f.events.at(-1).kind, 'focus_probe');
    const binding = { renderer_id: 'renderer', attach_id: 'attachment', connection_id: 'connection' };
    await f.receiver.accept({ kind: 'focus_reply', ...binding, renderer_id: 'old', echo: '1', focused: true });
    await f.receiver.accept({ kind: 'focus_reply', ...binding, echo: '0', focused: true });
    assert.equal(channel.sent.length, 1, 'old frame/challenge cannot supply focus');
    await f.receiver.accept({ kind: 'focus_reply', ...binding, echo: '1', focused: true }); await pending;
    assert.equal(channel.sent.at(-1).focused, true);
    const next = channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '2' }) });
    await Promise.resolve(); f.platform.document.visibilityState = 'hidden';
    await f.receiver.accept({ kind: 'focus_reply', ...binding, echo: '1', focused: true });
    context.mock.timers.tick(1000); await next;
    assert.equal(channel.sent.at(-1).focused, false, 'a cached positive cannot answer another probe');
    assert.equal(channel.sent.at(-1).visible, false, 'sample visibility after waiting for the parent');
  } finally { f.receiver.stop(); }
});

test('stopping a receiver cancels its pending parent focus request without an old health reply', async context => {
  const f = fixture(context);
  await f.receiver.accept({ ...f.config, parent_focus: true }); const channel = healthChannel(f);
  const pending = channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '1' }) });
  await Promise.resolve(); f.receiver.stop(); await pending;
  assert.equal(channel.sent.length, 1); assert.equal(channel.closed, true);
});

test('a previous desktop focus answer expires even while transport and the last health probe remain recent', async context => {
  const f = fixture(context); let clock = 0, hooks;
  f.platform.performance = { now: () => clock };
  f.platform.document = { visibilityState: 'visible', hasFocus: () => true };
  f.platform.OpenBitFunRemoteDesktopControl = { createController(value) { hooks = value; return { release() {}, stop() {} }; } };
  try {
    await f.receiver.accept({ ...f.config, parent_focus: true, control_supported: true }); const channel = healthChannel(f);
    f.peers[0].ontrack({ track: { kind: 'video', readyState: 'live', muted: false, enabled: true, stop() {} } }); f.present();
    await f.receiver.accept({ kind: 'source_ready', renderer_id: 'renderer', connection_id: 'connection' });
    const pending = channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '1' }) }); await Promise.resolve();
    await f.receiver.accept({ kind: 'focus_reply', renderer_id: 'renderer', attach_id: 'attachment', connection_id: 'connection', echo: '1', focused: true }); await pending;
    assert.equal(hooks.healthy(), true);
    clock = 2500; assert.equal(hooks.healthy(), false, 'document focus cannot replace an expired delegated-focus answer');
  } finally { f.receiver.stop(); }
});

test('health round trips require fresh stats, observed presentation and current document visibility', async context => {
  const f = fixture(context);
  try {
    // Unknown native visibility/focus is reported negatively, never assumed.
    await f.receiver.accept(f.config); const channel = healthChannel(f);
    f.peers[0].getStats = async () => new Map([['video',{type:'inbound-rtp',kind:'video',framesDecoded:1}]]);
    f.peers[0].ontrack({ track: {kind:'video',readyState:'live',muted:false,enabled:true,stop() {}} });
    const [id, callback] = f.frames.entries().next().value; f.frames.delete(id);
    callback(0,{width:1280,height:830,mediaTime:1});
    await f.receiver.accept({kind:'source_ready',renderer_id:'renderer',connection_id:'connection'});
    await channel.onmessage({ data: JSON.stringify({version:1,kind:'health_probe',echo:'0'}) });
    const reply = channel.sent.at(-1);
    assert.equal(reply.kind,'health_reply'); assert.equal(reply.echo,'0');
    assert.equal(reply.first_frame,true); assert.equal(reply.receiving,true);
    assert.equal(reply.visible,false); assert.equal(reply.focused,false);
    assert.equal(reply.decoded,'1'); assert.equal(reply.presented,'1');
    const [nextId, repeated] = f.frames.entries().next().value; f.frames.delete(nextId);
    repeated(0,{width:1280,height:830,mediaTime:1});
    await channel.onmessage({ data: JSON.stringify({version:1,kind:'health_probe',echo:'2000'}) });
    assert.equal(channel.sent.at(-1).presented,'1','repeated metadata cannot revive presentation progress');
    channel.bufferedAmount = 64*1024+1;
    const before = channel.sent.length;
    await channel.onmessage({ data: JSON.stringify({version:1,kind:'health_probe',echo:'4000'}) });
    assert.equal(channel.sent.length,before);
  } finally { f.receiver.stop(); }
});

test('live presentation counters advance with constant WebKit mediaTime and never fall back after counter failure', async context => {
  const f = fixture(context);
  f.platform.document = { visibilityState: 'visible', hasFocus: () => true };
  f.video.paused = false;
  try {
    await f.receiver.accept(f.config); const channel = healthChannel(f);
    f.peers[0].getStats = async () => new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 100 }]]);
    f.peers[0].ontrack({ track: { kind: 'video', readyState: 'live', muted: false, enabled: true, stop() {} } });
    await f.receiver.accept({ kind: 'source_ready', renderer_id: 'renderer', connection_id: 'connection' });
    const present = metadata => {
      const [id, callback] = f.frames.entries().next().value; f.frames.delete(id);
      callback(0, { width: 1280, height: 830, mediaTime: 0, ...metadata });
    };
    const probe = echo => channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo }) });
    present({ presentedFrames: 10 }); await probe('0');
    assert.equal(channel.sent.at(-1).presented, '1');
    present({ presentedFrames: 11 }); await probe('2000');
    assert.equal(channel.sent.at(-1).presented, '2');
    assert.equal(channel.sent.at(-1).receiving, true);
    present({ presentedFrames: 11, mediaTime: 1 }); await probe('4000');
    assert.equal(channel.sent.at(-1).presented, '2', 'a duplicate compositor count cannot borrow advancing media time');
    present({ presentedFrames: 9, mediaTime: 2 }); await probe('6000');
    assert.equal(channel.sent.at(-1).receiving, false);
    present({ presentedFrames: 12, mediaTime: 3 }); await probe('8000');
    assert.equal(channel.sent.at(-1).presented, '2', 'counter rollback invalidates this presentation lifetime');
    assert.equal(channel.sent.at(-1).receiving, false);
  } finally { f.receiver.stop(); }
});

test('a disabled or unobservable video track cannot report receiving or permit control', async context => {
  const f = fixture(context); let hooks;
  f.platform.document = { visibilityState: 'visible', hasFocus: () => true };
  f.platform.OpenBitFunRemoteDesktopControl = { createController(value) {
    hooks = value; return { release() {}, stop() {} };
  } };
  try {
    await f.receiver.accept({ ...f.config, control_supported: true }); const channel = healthChannel(f);
    f.peers[0].getStats = async () => new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 1 }]]);
    const track = { kind: 'video', readyState: 'live', muted: false, enabled: true, stop() {} };
    f.peers[0].ontrack({ track });
    const [id, frame] = f.frames.entries().next().value; f.frames.delete(id);
    frame(0, { width: 1280, height: 830, mediaTime: 1 });
    await f.receiver.accept({ kind: 'source_ready', renderer_id: 'renderer', connection_id: 'connection' });
    await channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '1' }) });
    assert.equal(channel.sent.at(-1).receiving, true);
    assert.equal(hooks.healthy(), true);
    for (const enabled of [false, undefined]) {
      track.enabled = enabled;
      assert.equal(track.readyState, 'live'); assert.equal(track.muted, false);
      assert.equal(hooks.healthy(), false, 'live/unmuted cannot substitute for an enabled track');
      await channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '2' }) });
      assert.equal(channel.sent.at(-1).receiving, false);
    }
    assert.equal(f.events.some(event => event.kind === 'failed'), false, 'input gating does not rebuild video');
  } finally { f.receiver.stop(); }
});

test('a stats completion after stop or replacement cannot reply through the old channel', async context => {
  const f = fixture(context);
  await f.receiver.accept(f.config); const channel = healthChannel(f);
  let finish; f.peers[0].getStats = () => new Promise(resolve => { finish = resolve; });
  const pending = channel.onmessage({data:JSON.stringify({version:1,kind:'health_probe',echo:'1'})});
  f.receiver.stop(); finish(new Map()); await pending;
  assert.equal(channel.sent.length,1); assert.equal(channel.closed,true);
});
test('stop during pending SDP fences its continuation after page exit', async context => {
  const f = fixture(context, true), started = f.receiver.accept(f.config);
  f.receiver.stop(); f.resume(); await started;
  assert.equal(f.peers[0].closed, true); assert.equal(f.peers[0].localSet, undefined); assert.equal(f.events.some(event => event.kind === 'answer'), false); assert.equal(f.video.srcObject, null);
});
test('new start immediately closes old PC; only successor emits an answer', async context => {
  const f = fixture(context);
  try {
    await Promise.all([f.receiver.accept(f.config), f.receiver.accept({ ...f.config, renderer_id: 'next', connection_id: 'next-pc' })]);
    assert.equal(f.peers[0].closed, true); assert.deepEqual(f.events.filter(event => event.kind === 'answer').map(event => event.renderer_id), ['next']);
  } finally { f.receiver.stop(); }
});
test('single reliable ordered channel binds negotiated IDs and rejects extras', async context => {
  const f = fixture(context);
  try {
    await f.receiver.accept(f.config);
    const channel = { label: 'rd', ordered: true, maxRetransmits: null, maxPacketLifeTime: null, readyState: 'open', send(value) { this.value = JSON.parse(value); }, close() { this.closed = true; } };
    f.peers[0].ondatachannel({ channel }); channel.onopen(); f.flushTasks(); assert.deepEqual(channel.value, { version: 1, kind: 'bind', attach_id: 'attachment', connection_id: 'connection' });
    const extra = { ...channel }; f.peers[0].ondatachannel({ channel: extra }); assert.equal(extra.closed, true); assert.equal(f.peers[0].options.iceTransportPolicy, 'relay');
  } finally { f.receiver.stop(); }
});
test('first frame requires both current source confirmation and presentation', async context => {
  const f = fixture(context);
  try {
    await f.receiver.accept(f.config); f.peers[0].ontrack({ track: { kind: 'video', stop() {} } }); f.present();
    assert.equal(f.events.some(event => event.kind === 'first_frame_presented'), false);
    await f.receiver.accept({ kind: 'source_ready', renderer_id: 'wrong', connection_id: 'connection' }); f.present(); assert.equal(f.events.some(event => event.kind === 'first_frame_presented'), false);
    await f.receiver.accept({ kind: 'source_ready', renderer_id: 'renderer', connection_id: 'connection' });
    assert.equal(f.events.filter(event => event.kind === 'first_frame_presented').length, 1, 'A static presented first frame must not require a second frame');
    f.present(); f.present(); assert.equal(f.events.filter(event => event.kind === 'first_frame_presented').length, 1);
  } finally { f.receiver.stop(); }
});
test('stop cancels presentation and rejects an already queued frame callback', async context => {
  const f = fixture(context); await f.receiver.accept(f.config); f.peers[0].ontrack({ track: { kind: 'video', stop() {} } });
  const late = f.frames.values().next().value; f.receiver.stop(); late(0, { width: 1280, height: 830 });
  assert.equal(f.frames.size, 0); assert.equal(f.video.srcObject, null); assert.equal(f.events.some(event => event.kind === 'first_frame_presented'), false);
});

test('native controls use app-window focus without weakening document visibility', async context => {
  const f = fixture(context);
  f.platform.document = { visibilityState: 'visible', hasFocus: () => false };
  try {
    await f.receiver.accept({ ...f.config, native_focus: true });
    const channel = healthChannel(f);
    await channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '1' }) });
    assert.equal(channel.sent.at(-1).focused, true);
    assert.equal(channel.sent.at(-1).visible, true);
    f.platform.document.visibilityState = 'hidden';
    await channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '2' }) });
    assert.equal(channel.sent.at(-1).visible, false);
    f.receiver.stop();
    const before = channel.sent.length;
    await channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '3' }) });
    assert.equal(channel.sent.length, before);
  } finally { f.receiver.stop(); }
});
test('web controllers still require the actual document focus by default', async context => {
  const f = fixture(context);
  f.platform.document = { visibilityState: 'visible', hasFocus: () => false };
  try {
    await f.receiver.accept(f.config); const channel = healthChannel(f);
    await channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '1' }) });
    assert.equal(channel.sent.at(-1).focused, false);
  } finally { f.receiver.stop(); }
});

for (const clockMode of ['monotonic', 'missing', 'invalid']) {
  test(`control health freshness with ${clockMode} monotonic clock`, async context => {
    const f = fixture(context); let clock = 100, wall = 1000000, hooks;
    context.mock.method(Date, 'now', () => wall);
    f.platform.performance = clockMode === 'missing' ? undefined : { now: () => clockMode === 'invalid' ? NaN : clock };
    f.platform.document = { visibilityState: 'visible', hasFocus: () => true };
    f.platform.OpenBitFunRemoteDesktopControl = { createController(value) {
      hooks = value; return { release() {}, stop() {} };
    } };
    try {
      await f.receiver.accept({ ...f.config, control_supported: true }); const channel = healthChannel(f);
      f.peers[0].ontrack({ track: { kind: 'video', readyState: 'live', muted: false, enabled: true, stop() {} } });
      f.present(); await f.receiver.accept({ kind: 'source_ready', renderer_id: 'renderer', connection_id: 'connection' });
      assert.equal(hooks.healthy(), false, 'A frame without a health round trip grants no input');
      await channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '1' }) });
      if (clockMode !== 'monotonic') {
        assert.equal(hooks.healthy(), false, 'Missing or unobservable monotonic time must not fall back to wall time');
        return;
      }
      assert.equal(hooks.healthy(), true);
      clock -= 1; assert.equal(hooks.healthy(), false, 'Negative sample ages are unknown, not healthy'); clock += 1;
      wall -= 60000;
      {
        clock += 5999; assert.equal(hooks.healthy(), true);
        clock += 1; assert.equal(hooks.healthy(), false, 'Clock rollback must not extend the six-second health budget');
        wall += 120000; assert.equal(hooks.healthy(), false, 'Wall clock correction cannot revive an expired sample');
        await channel.onmessage({ data: JSON.stringify({ version: 1, kind: 'health_probe', echo: '2' }) });
        assert.equal(hooks.healthy(), true, 'A new authenticated round trip may restore freshness');
        wall += 120000; assert.equal(hooks.healthy(), true, 'Wall clock changes do not change monotonic freshness');
      }
    } finally { f.receiver.stop(); }
  });
}
test('presented-size changes retire input before the local resize event without inventing another first frame', async context => {
  const f = fixture(context); let releases = 0;
  f.platform.OpenBitFunRemoteDesktopControl = { createController() { return { release() { releases++; }, stop() {} }; } };
  const present = (width, height) => { const [id, callback] = f.frames.entries().next().value; f.frames.delete(id); callback(0, { width, height, mediaTime: width }); };
  try {
    await f.receiver.accept({ ...f.config, control_supported: true }); f.peers[0].ontrack({ track: { kind: 'video', stop() {} } });
    present(1280, 830); present(640, 415);
    assert.equal(f.events.some(e => e.kind === 'frame_resized'), false);
    await f.receiver.accept({ kind: 'source_ready', renderer_id: 'renderer', connection_id: 'connection' });
    assert.deepEqual(f.events.find(e => e.kind === 'first_frame_presented'), { kind: 'first_frame_presented', renderer_id: 'renderer', attach_id: 'attachment', connection_id: 'connection', width: 640, height: 415 });
    present(320, 208); assert.equal(releases, 1);
    assert.deepEqual(f.events.filter(e => e.kind === 'frame_resized').map(e => [e.width, e.height]), [[320, 208]]);
    present(320, 208); assert.equal(releases, 1); assert.equal(f.events.filter(e => e.kind === 'first_frame_presented').length, 1);
    const late = f.frames.values().next().value; f.receiver.stop(); late(0, { width: 1280, height: 830 });
    assert.equal(f.frames.size, 0); assert.equal(f.events.filter(e => e.kind === 'frame_resized').length, 1);
  } finally { f.receiver.stop(); }
});
test('a resize that closes control cannot rearm a frame callback on the retired receiver', async context => {
  const f = fixture(context);
  f.platform.OpenBitFunRemoteDesktopControl = { createController() { return { release() { f.receiver.stop(); }, stop() {} }; } };
  try {
    await f.receiver.accept({ ...f.config, control_supported: true }); f.peers[0].ontrack({ track: { kind: 'video', stop() {} } }); f.present();
    await f.receiver.accept({ kind: 'source_ready', renderer_id: 'renderer', connection_id: 'connection' });
    const [id, callback] = f.frames.entries().next().value; f.frames.delete(id); callback(0, { width: 640, height: 415, mediaTime: 2 });
    assert.equal(f.frames.size, 0); assert.equal(f.video.srcObject, null); assert.equal(f.events.some(e => e.kind === 'frame_resized'), false);
  } finally { f.receiver.stop(); }
});


test('screenshot captures the complete current video frame and refuses retired or unpresented sources', async context => {
  const f = fixture(context), drawn = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => drawn.push(args) }),
    toDataURL: type => { assert.equal(type,'image/png'); return 'data:image/png;base64,frame'; } };
  f.platform.document = { createElement: tag => { assert.equal(tag,'canvas'); return canvas; } };
  f.video.videoWidth = 1280; f.video.videoHeight = 830;
  try {
    await f.receiver.accept(f.config);
    assert.equal(f.receiver.capture('renderer'),'');
    f.peers[0].ontrack({ track: { kind: 'video', readyState: 'live', muted: false, stop() {} } });
    f.present(); await f.receiver.accept({ kind: 'source_ready', renderer_id: 'renderer', connection_id: 'connection' });
    assert.equal(f.receiver.capture('wrong'),'');
    assert.equal(f.receiver.capture('renderer'),'data:image/png;base64,frame');
    assert.deepEqual(drawn[0],[f.video,0,0,1280,830]);
    assert.equal(canvas.width,0); assert.equal(canvas.height,0);
    f.receiver.stop(); assert.equal(f.receiver.capture('renderer'),'');
  } finally { f.receiver.stop(); }
});
