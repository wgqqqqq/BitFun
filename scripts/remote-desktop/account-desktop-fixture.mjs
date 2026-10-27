import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, createPublicKey, diffieHellman, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { createRequire } from 'node:module';

// Use the existing browser fixture package's declared test dependency.
const { WebSocketServer } = createRequire(new URL('../../src/mobile-web/package.json', import.meta.url))('ws');

function encrypt(key, nonce, value) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
}
function decrypt(key, nonce, value) {
  const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, nonce);
  cipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString());
}

/** Synthetic authenticated Relay + host, not a production auth/provider path. */
export class AccountDesktopFixture {
  constructor(page, ice, port) {
    this.page = page; this.ice = ice; this.port = port;
    this.testIceSessions = ice.test_sessions; this.testIceIndex = 0;
    const pair = generateKeyPairSync('x25519'); this.hostSecret = pair.privateKey;
    this.hostPublic = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url');
    this.sockets = new WebSocketServer({ noServer: true });
    this.connections = new Set(); this.tokens = new Map(); this.errors = [];
    this.counts = {}; this.allowView = true; this.stages = []; this.revision = 1; this.mediaStarts = 0;
    this.sourceObservations = [];
  }
  attach(server) {
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, `http://127.0.0.1:${this.port}`);
      if (request.headers.host !== `127.0.0.1:${this.port}` || url.pathname !== '/v1/updates/'
        || url.searchParams.get('EIO') !== '4' || url.searchParams.get('transport') !== 'websocket') { socket.destroy(); return; }
      this.sockets.handleUpgrade(request, socket, head, ws => this.socket(ws));
    });
  }
  key(auth) {
    const sorted = [this.hostPublic, auth.publicKey].sort((a, b) => Buffer.compare(a, b));
    const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: auth.publicKey.toString('base64url') }, format: 'jwk' });
    const shared = diffieHellman({ privateKey: this.hostSecret, publicKey: peer });
    try { return Buffer.from(hkdfSync('sha256', shared, 'OpenBitFun Relay v1.0.0 device key', Buffer.concat(sorted), 32)); }
    finally { shared.fill(0); }
  }
  async api(request, response, body) {
    const url = new URL(request.url, `http://127.0.0.1:${this.port}`);
    if (this.stages.length < 200) this.stages.push(`http:${url.pathname}`);
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/api/auth/github/start') {
      assert.equal(request.method, 'POST');
      this.transaction = randomBytes(16).toString('hex'); this.transactionSecret = randomBytes(32).toString('hex');
      return json(200, { transactionId: this.transaction, transactionSecret: this.transactionSecret,
        authorizationUrl: 'https://github.com/login/oauth/authorize?state=isolated-fixture', expiresAt: Math.floor(Date.now() / 1000) + 60, pollIntervalSeconds: 1 });
    }
    if (url.pathname === '/api/auth/github/poll') {
      assert.equal(body.transactionId, this.transaction); assert.equal(body.transactionSecret, this.transactionSecret);
      this.accessToken = randomBytes(24).toString('hex');
      return json(200, { status: 'authorized', tokens: { accessToken: this.accessToken } });
    }
    if (url.pathname === '/api/auth/login') {
      assert.equal(body.access_token, this.accessToken); assert.equal(body.device_kind, 'mobile');
      const publicKey = Buffer.from(body.public_key, 'base64'); assert.equal(publicKey.length, 32);
      const token = randomBytes(24).toString('hex'); this.tokens.set(token, { publicKey, deviceId: body.device_id });
      this.counts.logins = (this.counts.logins || 0) + 1;
      return json(200, { token, user_id: 'android-account-fixture' });
    }
    if (url.pathname === '/api/info') return json(200, { capabilities: [
      'remote_desktop_route_v1', 'remote_desktop_turn_v1', 'remote_desktop_credential_binding_v1'] });
    const auth = this.tokens.get((request.headers.authorization || '').replace(/^Bearer /, ''));
    if (!auth) return json(401, { error: 'unauthorized' });
    if (url.pathname === '/api/auth/logout') { this.tokens.delete((request.headers.authorization || '').slice(7)); return json(200, {}); }
    if (url.pathname === '/api/devices') return json(200, ['chat-target', 'media-target'].map(device_id => ({
      device_id, device_name: device_id === 'media-target' ? 'Fixture desktop' : 'Fixture chat host',
      online: true, device_kind: 'desktop' })));
    if (url.pathname === '/api/devices/media-target/key') return json(200, { device_id: 'media-target', public_key: Buffer.from(this.hostPublic).toString('base64') });
    if (url.pathname === '/api/remote-desktop/turn') {
      assert.ok(this.allowView && this.attachment); assert.equal(url.searchParams.get('target_device_id'), 'media-target');
      assert.equal(url.searchParams.get('attach_id'), this.attachment.id);
      this.counts.turn = (this.counts.turn || 0) + 1;
      return json(200, { target_device_id: 'media-target', attach_id: this.attachment.id,
        expires_at: this.ice.expires_at, ice_servers: this.attachment.ice.ice_servers });
    }
    throw new Error('Unexpected fixture HTTP route');
  }
  socket(ws) {
    this.connections.add(ws); ws.once('close', () => this.connections.delete(ws));
    let auth;
    ws.send('0' + JSON.stringify({ sid: randomBytes(8).toString('hex'), upgrades: [], pingInterval: 60000, pingTimeout: 60000, maxPayload: 160000 }));
    ws.on('message', async data => {
      try {
        const frame = data.toString(); assert.ok(frame.length <= 160000);
        if (frame.startsWith('40')) {
          auth = this.tokens.get(JSON.parse(frame.slice(2)).token); assert.ok(auth);
          ws.send('40' + JSON.stringify({ sid: 'fixture-controller' }));
          ws.send('42' + JSON.stringify(['auth-ok', { userId: 'android-account-fixture', deviceId: auth.deviceId }])); return;
        }
        if (frame === '3') return;
        if (frame === '41' || frame === '1') { ws.close(); return; }
        assert.ok(auth); assert.ok(frame.startsWith('42'));
        const start = frame.indexOf('['), ack = frame.slice(2, start); assert.match(ack, /^\d+$/);
        const [event, request] = JSON.parse(frame.slice(start));
        if (this.stages.length < 200) this.stages.push(`socket:${event}`);
        assert.equal(event, 'rd-call', 'Remote desktop must not borrow the Agent RPC lane');
        assert.equal(request.version, 1); assert.equal(request.targetDeviceId, 'media-target');
        const key = this.key(auth), envelope = request.params;
        const command = decrypt(key, Buffer.from(envelope.nonce, 'base64'), envelope.encrypted_data);
        assert.equal(command.version, 1);
        const result = await this.host(command, request.attachId);
        const nonce = randomBytes(12), encrypted = encrypt(key, nonce, result);
        key.fill(0);
        ws.send(`43${ack}` + JSON.stringify([{ ok: true, result: { nonce: nonce.toString('base64'), encrypted_data: Buffer.from(encrypted).toString('base64') } }]));
      } catch (error) { this.errors.push(`Unexpected fixture socket message: ${error.name}`); ws.close(); }
    });
  }
  snapshot() {
    return { state_revision: `fixture:${this.revision}`, cleanup_pending: false,
      attachment: this.attachment ? { attach_id: this.attachment.id, connection_id: this.attachment.connection,
        display_id: this.attachment.display, phase: this.attachment.suspended ? 'suspended' : this.attachment.streaming ? 'streaming' : 'binding' } : null };
  }
  async startPeer() {
    const name = ['first', 'old', 'new', 'navigation'][this.mediaStarts++];
    const configuration = this.ice.profiles?.[name] || this.ice;
    assert.ok(Array.isArray(configuration.ice_servers));
    this.answerAccepted = false;
    this.offer = null;
    this.hostBudgetEndsAt = null;
    Object.assign(this.attachment, { connection: `pc-${randomBytes(16).toString('hex')}`, streaming: false, suspended: false, ice: configuration });
    this.offer = await this.page.evaluate(value => window.androidMediaSource(value), {
      operation: 'start', id: this.attachment.id, attach_id: this.attachment.id, connection_id: this.attachment.connection, configuration,
      width: this.attachment.display === 'fixture-other-display' ? 480 : 320,
      height: this.attachment.display === 'fixture-other-display' ? 270 : 180,
      alternate: this.attachment.display === 'fixture-other-display', control: this.controlSupported, gestures: this.gestures,
      control_grant: this.controlGrant, revision: `fixture:${this.revision}`,
      expected_text_commits: this.actualKeyboard ? ['h', 'i', 'H'] : this.textSupported ? ['\u4f60\u597d', '123'] : [] });
  }
  async host(command, scope) {
    const { op, body } = command;
    if (this.stages.length < 200) this.stages.push(`host:${op}`);
    this.counts[op] = (this.counts[op] || 0) + 1;
    if (op === 'capabilities') return { availability: 'ready', authorization: this.allowView ? 'view' : 'none',
      protocol_versions: [1], capabilities: ['read_only_video_v1', 'gathered_sdp_v1', 'source_lifecycle_v1',
        ...(this.controlSupported ? ['ordered_control_v1'] : []),
        ...(this.textSupported ? ['text_commit_v1'] : []),
        ...(this.renewalSupported ? ['credential_rebuild_v1'] : [])] };
    assert.ok(this.allowView);
    if (op === 'list_displays') {
      assert.ok(scope == null, 'Catalog requests must not carry an outer attachment');
      return { state_revision: `fixture:${this.revision}`, displays: [
        { display_id: 'fixture-display', width: 320, height: 180 },
        { display_id: 'fixture-other-display', width: 480, height: 270 }] };
    }
    if (op === 'attach') {
      this.lastAttachPolicy = { force_relay: body.force_relay === true, expected_display: body.display_id === 'fixture-display', matching_revision: body.expected_state_revision === `fixture:${this.revision}` };
      assert.equal(scope, body.attach_id); assert.ok(!this.attachment); assert.equal(body.expected_state_revision, `fixture:${this.revision}`);
      assert.equal(body.display_id, 'fixture-display'); assert.equal(body.force_relay, true);
      this.revision++; this.attachment = { id: body.attach_id, display: body.display_id };
      await this.startPeer();
      return { state: this.snapshot() };
    }
    assert.ok(this.attachment && scope === this.attachment.id);
    if (op === 'select_display') {
      assert.equal(body.attach_id, scope); assert.equal(body.expected_state_revision, `fixture:${this.revision}`);
      assert.equal(this.attachment.suspended, true);
      assert.ok(['fixture-display', 'fixture-other-display'].includes(body.display_id));
      this.attachment.display = body.display_id; this.revision++;
      return { state: this.snapshot() };
    }
    if (op === 'get_state') {
      if (this.attachment.suspended) return { state: this.snapshot() };
      if (this.answerAccepted) {
        const stats = await this.page.evaluate(() => window.androidMediaSource({ operation: 'stats' }));
        const status = await this.page.evaluate(() => window.androidMediaSource({ operation: 'status' }));
        // The real host starts capture only after this PC's authenticated bind.
        // Canvas encoding by itself must not stand in for that source evidence.
        this.attachment.streaming = stats.frames_encoded > 0 && status.bound?.matches === true;
        await this.page.evaluate(() => window.androidMediaSource({ operation: 'probe' }));
      }
      return { state: this.snapshot(), media: { offer_sdp: this.offer?.offer_sdp || null, answer_accepted: this.answerAccepted === true,
        source_first_frame: this.attachment.streaming, force_relay: true,
        credentials_remaining_ms: Math.max(0, Math.min(this.hostBudgetEndsAt ?? Infinity, this.ice.expires_at * 1000) - Date.now()) } };
    }
    if (op === 'suspend' || op === 'resume') {
      assert.equal(body.attach_id, scope); assert.equal(body.expected_state_revision, `fixture:${this.revision}`);
      if (op === 'suspend') {
        await this.page.evaluate(() => window.androidMediaSource({ operation: 'stop' }));
        this.attachment.suspended = true; this.attachment.streaming = false;
      } else {
        assert.equal(this.attachment.suspended, true);
        this.revision++;
        await this.startPeer();
        return { state: this.snapshot() };
      }
      this.revision++; return { state: this.snapshot() };
    }
    if (op === 'signal') {
      assert.equal(body.attach_id, scope); assert.equal(body.connection_id, this.attachment.connection);
      await this.page.evaluate(sdp => window.androidMediaSource({ operation: 'answer', sdp }), body.answer_sdp);
      this.answerAccepted = true; return { answer_accepted: true };
    }
    if (op === 'detach') { await this.page.evaluate(() => window.androidMediaSource({ operation: 'stop' })); this.attachment = null; this.revision++; return { state: this.snapshot() }; }
    throw new Error('Unexpected fixture host operation');
  }
  async control(body) {
    if (body.operation === 'reset') {
      assert.ok(!this.attachment);
      // Independent test controllers must not share one REST username/quota.
      // Legacy single-session configs remain readable; production issuing is unchanged.
      if (this.testIceSessions) {
        assert.ok(this.testIceIndex < this.testIceSessions.length, 'Fresh per-test ICE profiles exhausted');
        this.ice = this.testIceSessions[this.testIceIndex++];
      }
      this.allowView = body.allow_view === true; this.answerAccepted = false;
      this.renewalSupported = body.renewal_supported === true;
      this.gestures = body.gestures === true; this.controlSupported = body.control_supported === true; this.controlGrant = body.control_grant !== false;
      this.textSupported = this.controlSupported && body.text_supported === true;
      this.actualKeyboard = this.textSupported && body.actual_keyboard === true;
      this.lastAttachPolicy = undefined;
      this.counts = {}; this.revision = 1; this.mediaStarts = 0; return {};
    }
    if (body.operation === 'shorten_host_budget') {
      // Shorten the synthetic host's reported budget, never the real TURN
      // credential or a production clock. The next PC receives its own budget.
      assert.ok(this.renewalSupported && this.attachment?.streaming && !this.hostBudgetEndsAt);
      this.hostBudgetEndsAt = Date.now() + 61_000;
      return {};
    }
    assert.equal(body.operation, 'status');
    const source = await this.page.evaluate(() => window.androidMediaSource({ operation: 'status' }));
    const observation = { input_count: source.inputs.length, text_commits: source.inputs.filter(value => value.kind === 'text_commit').length,
      key_events: source.inputs.filter(value => value.kind === 'key').length,
      pointer_moves: source.inputs.filter(value => value.kind === 'pointer_move').length,
      wheel_events: source.inputs.filter(value => value.kind === 'wheel').length,
      held_buttons: source.held_buttons.length, lease: source.lease != null,
      unexpected_input: source.unexpected_input, control_counts: source.control_counts, text_rejection: source.text_rejection };
    if (this.sourceObservations.length < 64 && JSON.stringify(observation) !== JSON.stringify(this.sourceObservations.at(-1))) this.sourceObservations.push(observation);
    const stats = this.attachment?.streaming ? await this.page.evaluate(() => window.androidMediaSource({ operation: 'stats' })) : {};
    return { counts: this.counts, attachment: !!this.attachment, account_sockets: this.connections.size, state: this.snapshot(), source, local: stats.candidate_type, remote: stats.remote_candidate_type,
      errors: this.errors.length };
  }
  async close() {
    await this.page.evaluate(() => window.androidMediaSource?.({ operation: 'stop' })).catch(() => {});
    for (const socket of this.connections) socket.terminate();
    await new Promise(resolve => this.sockets.close(resolve)); this.hostSecret = null;
  }
}
