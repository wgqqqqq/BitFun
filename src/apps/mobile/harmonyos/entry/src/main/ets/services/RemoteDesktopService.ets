import { CloudAccountBinding, CloudAccountDevice } from './CloudAccountClient';
import { RemoteDesktopAccountChannel } from './RemoteDesktopAccountChannel';
import { Encoding } from './Encoding';
import { RemoteLogger } from './RemoteLogger';
import { RemoteDesktopGestureClock } from './RemoteDesktopGestureClock';
import { REMOTE_DESKTOP_QUALITIES, RemoteDesktopAttachment, RemoteDesktopSetQualityRequest } from '../model/RemoteDesktopModels';
import { RemoteDesktopAnswer, RemoteDesktopControlIntent, RemoteDesktopAttach, RemoteDesktopDetach, RemoteDesktopDisplay, RemoteDesktopInput, RemoteDesktopRendererEvent, RemoteDesktopRendererStart, RemoteDesktopReply, RemoteDesktopSnapshot, RemoteDesktopSourceRequest, RemoteDesktopSelectDisplayRequest, RemoteDesktopRequest } from '../model/RemoteDesktopModels';

export interface RemoteDesktopProjection {
  stage: string; canReconnect: boolean; deviceName: string; displays: RemoteDesktopDisplay[];
  sourceLifecycleSupported: boolean;
  qualitySupported: boolean; quality: string;
  signalingInterrupted: boolean;
  selectedDisplayId: string;
  errorCode: string; forceRelay: boolean; candidateType: string;
  videoWidth: number; videoHeight: number; rendererId: string;
  controlReady: boolean; controlSupported: boolean; textSupported: boolean; controlState: string; controlGeneration: string; controlError: string;
}
export interface RemoteDesktopServiceHooks {
  binding: () => CloudAccountBinding | undefined;
  update: (projection: RemoteDesktopProjection) => void;
  renderer: (command: string) => void;
}

interface RemoteDesktopReconnectTarget { deviceId: string; userId: string; relayUrl: string; }

/** Explicit target, one attachment and a fixed peer key. Never selects a workspace. */
export class RemoteDesktopService {
  static onLifecycle?: (visible: boolean) => void;
  private readonly hooks: RemoteDesktopServiceHooks;
  private readonly lifecycle: (visible: boolean) => void = (visible: boolean): void => { if (!visible) this.close('background'); };
  private channel?: RemoteDesktopAccountChannel;
  private reconnectTarget?: RemoteDesktopReconnectTarget;
  private binding?: CloudAccountBinding;
  private generation: number = 0;
  private timer: number = -1;
  private authorityTimer: number = -1;
  private signalingTimer: number = -1;
  private projection: RemoteDesktopProjection = { stage: 'idle', canReconnect: false, deviceName: '', displays: [], sourceLifecycleSupported: false, qualitySupported: false, quality: 'data_saver', signalingInterrupted: false, selectedDisplayId: '', errorCode: '', forceRelay: false, candidateType: '',
    videoWidth: 0, videoHeight: 0, rendererId: '', controlReady: false, controlSupported: false, textSupported: false, controlState: 'viewing', controlGeneration: '', controlError: '' };
  private controlIntent: number = 0;
  private retiredControlGeneration: string = '';
  private revision: string = '';
  private attachment: string = '';
  private connection: string = '';
  private rendererId: string = '';
  private bridgeRendererId: string = '';
  private lastTransportReport: string = '';
  private rendererStarted: boolean = false;
  private bridgeReady: boolean = false;
  private epochReports: boolean = false;
  private sourceReady: boolean = false;
  private deadline: number = 0;
  private pollBusy: boolean = false;
  private pendingMutation?: Promise<RemoteDesktopReply>;
  private credentialRebuildSupported: boolean = false;
  private credentialRebuild: boolean = false;
  private credentialDeadline: number = Infinity;
  private credentialWallDeadline: number = Infinity;
  constructor(hooks: RemoteDesktopServiceHooks) { this.hooks = hooks; }
  private publish(stage: string, errorCode: string = ''): void {
    this.projection.stage = stage; this.projection.errorCode = errorCode;
    const binding = this.hooks.binding(), target = this.reconnectTarget;
    this.projection.canReconnect = (stage === 'closed' || stage === 'failed') && target !== undefined && !!target.userId
      && binding?.session.userId === target.userId && binding?.relayUrl === target.relayUrl;
    this.hooks.update(this.projection);
  }
  private current(generation: number): boolean {
    const binding = this.hooks.binding();
    if (generation !== this.generation) return false;
    if (!this.binding || this.binding.session !== binding?.session || this.binding.relayUrl !== binding?.relayUrl
      || (this.channel && !this.channel.current())) {
      this.close('account_changed');
      return false;
    }
    return this.channel !== undefined;
  }
  async open(device: CloudAccountDevice): Promise<void> {
    this.close('replace');
    this.projection = { stage: 'probing', canReconnect: false, deviceName: device.deviceName || device.deviceId, displays: [], sourceLifecycleSupported: false, qualitySupported: false, quality: 'data_saver', signalingInterrupted: false, selectedDisplayId: '', errorCode: '', forceRelay: false, candidateType: '',
    videoWidth: 0, videoHeight: 0, rendererId: '', controlReady: false, controlSupported: false, textSupported: false, controlState: 'viewing', controlGeneration: '', controlError: '' };
    this.publish('probing');
    if (device.deviceKind && device.deviceKind !== 'desktop') { this.publish('failed', 'unsupported'); return; }
    const binding = this.hooks.binding();
    if (!binding) { this.publish('failed', 'authorization_required'); return; }
    this.reconnectTarget = { deviceId: device.deviceId, userId: binding.session.userId, relayUrl: binding.relayUrl };
    if (!device.online) { this.publish('failed', 'target_unavailable'); return; }
    this.binding = binding;
    const generation = this.generation;
    RemoteDesktopService.onLifecycle = this.lifecycle;
    this.watchAuthority(generation, binding);
    let operation = 'open_channel';
    try {
      const channel = await binding.client.remoteDesktopChannel(binding.relayUrl, binding.session, device.deviceId);
      if (generation !== this.generation) { channel.close(); return; }
      if (this.hooks.binding()?.session !== binding.session || this.hooks.binding()?.relayUrl !== binding.relayUrl) { channel.close(); this.close('account_changed'); return; }
      this.channel = channel;
      operation = 'capabilities';
      const probe = await channel.call({ version: 1, op: 'capabilities' });
      if (!this.current(generation)) return;
      if (!probe.protocol_versions?.includes(1)) throw new Error('protocol_unsupported');
      if (probe.availability !== 'ready') throw new Error(probe.availability || 'media_backend_unavailable');
      if (!probe.capabilities?.includes('read_only_video_v1') || !probe.capabilities?.includes('gathered_sdp_v1')) throw new Error('protocol_unsupported');
      this.projection.controlSupported = probe.capabilities.includes('ordered_control_v1');
      this.projection.sourceLifecycleSupported = probe.capabilities.includes('source_lifecycle_v1');
      this.projection.qualitySupported = this.projection.sourceLifecycleSupported && probe.capabilities.includes('quality_presets_v1');
      this.credentialRebuildSupported = this.projection.sourceLifecycleSupported && probe.capabilities.includes('credential_rebuild_v1');
      this.projection.textSupported = this.projection.controlSupported && probe.capabilities.includes('text_commit_v1');
      if (probe.authorization !== 'view') throw new Error('device_approval_required');
      if (this.projection.sourceLifecycleSupported) {
        operation = 'get_state';
        if (!await this.waitForIdleHost(generation, channel)) return;
      }
      operation = 'list_displays';
      const reply = await channel.call({ version: 1, op: 'list_displays' });
      if (!this.current(generation)) return;
      this.projection.displays = this.displayChoices(reply);
      this.revision = reply.state_revision!;
      this.publish('choose_display');
    } catch (error) { if (generation === this.generation) this.fail(error, operation); }
  }
  /** Fresh setup waits for old viewing/cleanup, without adopting or ending it. */
  private async waitForIdleHost(generation: number, channel: RemoteDesktopAccountChannel): Promise<boolean> {
    let started: number | undefined;
    let last: number | undefined;
    while (this.current(generation)) {
      const reply = await channel.call({ version: 1, op: 'get_state' });
      if (!this.current(generation)) return false;
      const state = reply.state;
      if (!state || typeof state.busy !== 'boolean' || typeof state.cleanup_pending !== 'boolean'
        || (!state.busy && !!state.attachment)) throw new Error('invalid_response');
      const now = RemoteDesktopGestureClock.now();
      if (started !== undefined) {
        if (now === undefined || !Number.isFinite(now) || now < last!) throw new Error('invalid_response');
        if (now - started >= 60000) throw new Error(state.cleanup_pending ? 'cleanup_pending' : 'attachment_busy');
      }
      if (!state.busy && !state.cleanup_pending) {
        if (started !== undefined) {
          RemoteLogger.info('remote desktop prior source ended; refreshing display choices');
          this.publish('probing');
        }
        return true;
      }
      // The host discloses attachment IDs only to their authenticated owner.
      // Another controller stays busy; this setup never takes it over.
      if (state.busy && !state.attachment) throw new Error('attachment_busy');
      if (now === undefined || !Number.isFinite(now) || now < 0) throw new Error('invalid_response');
      if (started === undefined) {
        started = now;
        RemoteLogger.info('remote desktop waiting for prior source to end');
        this.publish('waiting_for_host');
      }
      last = now;
      await new Promise<void>((resolve): void => { setTimeout(resolve, 350); });
    }
    return false;
  }
  /** Explicit user retry. Fresh directory, peer key and authorization; never replay attach/input. */
  async reconnect(): Promise<void> {
    if (this.projection.stage !== 'closed' && this.projection.stage !== 'failed') return;
    const target = this.reconnectTarget, binding = this.hooks.binding();
    if (!target || !binding || !target.userId || binding.session.userId !== target.userId || binding.relayUrl !== target.relayUrl) {
      this.close('account_changed'); return;
    }
    const generation = ++this.generation;
    // Keep identity checks valid while no channel exists; late old renderer
    // events must be ignored, not mistaken for an account change.
    this.binding = binding;
    this.publish('probing');
    RemoteDesktopService.onLifecycle = this.lifecycle;
    try {
      const devices = await binding.client.listDevices(binding.relayUrl, binding.session);
      if (generation !== this.generation) return;
      const current = this.hooks.binding();
      if (current?.session !== binding.session || current?.client !== binding.client || current?.relayUrl !== binding.relayUrl) {
        this.close('account_changed'); return;
      }
      const device = devices.find((item: CloudAccountDevice): boolean => item.deviceId === target.deviceId);
      if (!device) { this.publish('failed', 'target_unavailable'); return; }
      await this.open(device);
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  async attach(displayId: string, forceRelay: boolean): Promise<void> {
    const channel = this.channel;
    const generation = this.generation;
    if (!channel || !this.current(generation) || this.attachment.length > 0 || this.projection.stage !== 'choose_display'
      || !this.projection.displays.some((display: RemoteDesktopDisplay): boolean => display.display_id === displayId)) return;
    const display = this.projection.displays.find((item: RemoteDesktopDisplay): boolean => item.display_id === displayId)!;
    this.projection.selectedDisplayId = displayId;
    this.projection.videoWidth = display.width; this.projection.videoHeight = display.height;
    this.attachment = this.identifier();
    this.rendererId = this.identifier(); this.projection.rendererId = this.rendererId;
    this.projection.forceRelay = forceRelay;
    const request: RemoteDesktopAttach = { attach_id: this.attachment, expected_state_revision: this.revision, display_id: displayId, force_relay: forceRelay };
    this.deadline = Date.now() + 60000;
    this.publish('connecting');
    let operation = 'attach';
    try {
      let snapshot: RemoteDesktopSnapshot | undefined;
      const pending = channel.call({ version: 1, op: 'attach', body: request }, this.attachment);
      this.pendingMutation = pending;
      try { snapshot = (await pending).state; }
      catch (error) {
        if (!(error instanceof Error)) throw new Error('invalid_response');
        if (error.message !== 'delivery_unknown') throw error as Error;
        // Lost mutation ACKs are resolved by the authoritative snapshot, never
        // by changing the revision/id and replaying attach automatically.
        if (!this.current(generation)) return;
        operation = 'get_state';
        snapshot = (await channel.call({ version: 1, op: 'get_state' }, this.attachment)).state;
      }
      finally { if (this.pendingMutation === pending) this.pendingMutation = undefined; }
      if (!this.current(generation)) return;
      if (!snapshot?.attachment || snapshot.attachment.attach_id !== this.attachment || !this.validId(snapshot.attachment.connection_id)) throw new Error('delivery_unknown');
      this.updateQuality(snapshot.attachment);
      this.connection = snapshot.attachment.connection_id;
      this.schedule(generation);
    } catch (error) { if (generation === this.generation) this.fail(error, operation); }
  }
  private watchAuthority(generation: number, binding: CloudAccountBinding): void {
    clearInterval(this.authorityTimer);
    this.authorityTimer = setInterval((): void => {
      if (generation !== this.generation) return;
      const active = this.hooks.binding();
      if (active?.session !== binding.session || active?.relayUrl !== binding.relayUrl
        || (this.channel && !this.channel.current())) this.close('account_changed');
    }, 250);
  }
  private beginSourceChange(stage: string): number {
    const generation = ++this.generation;
    this.credentialRebuild = false;
    this.credentialDeadline = Infinity; this.credentialWallDeadline = Infinity;
    clearTimeout(this.timer); this.timer = -1; this.pollBusy = false;
    ++this.controlIntent;
    this.projection.controlGeneration = ''; this.projection.controlState = 'viewing'; this.projection.controlError = '';
    // Retire callbacks and native input now, but keep the old PC until the
    // host has marked its closure intentional. Closing it first detaches it.
    this.rendererId = ''; this.projection.rendererId = '';
    this.rendererStarted = false; this.sourceReady = false;
    this.projection.controlReady = false; this.projection.candidateType = ''; this.lastTransportReport = '';
    this.deadline = Date.now() + 60000;
    this.watchAuthority(generation, this.binding!);
    this.publish(stage);
    return generation;
  }
  private async mutateSource(operation: string, generation: number, choice: string = ''): Promise<RemoteDesktopSnapshot | undefined> {
    const channel = this.channel!, attachment = this.attachment, connection = this.connection;
    const before = await channel.call({ version: 1, op: 'get_state' }, attachment);
    if (!this.current(generation)) return undefined;
    const snapshot = before.state, current = snapshot?.attachment;
    if (!snapshot?.state_revision || !this.validDisplayId(snapshot.state_revision) || snapshot.state_revision.length > 128
      || current?.attach_id !== attachment || current.connection_id !== connection || before.media_error
      || !['binding', 'streaming', 'suspended'].includes(current.phase)
      || (operation !== 'suspend' && (current.phase !== 'suspended' || snapshot.cleanup_pending !== false))) throw new Error('sharing_ended');
    const body: RemoteDesktopSourceRequest = { attach_id: attachment, expected_state_revision: snapshot.state_revision };
    const request: RemoteDesktopRequest = { version: 1, op: operation, body };
    if (operation === 'select_display') {
      const selected: RemoteDesktopSelectDisplayRequest = { attach_id: attachment, expected_state_revision: snapshot.state_revision, display_id: choice };
      request.body = selected;
    }
    if (operation === 'set_quality') {
      const selected: RemoteDesktopSetQualityRequest = { attach_id: attachment, expected_state_revision: snapshot.state_revision, quality: choice };
      request.body = selected;
    }
    const pending = channel.call(request, attachment);
    this.pendingMutation = pending;
    try {
      try { return (await pending).state; }
      catch (error) {
        if (!(error instanceof Error)) throw new Error('invalid_response');
        if (error.message !== 'delivery_unknown') throw error as Error;
        if (!this.current(generation)) return undefined;
        // Resolve one uncertain mutation by reading; never refresh CAS and replay.
        return (await channel.call({ version: 1, op: 'get_state' }, attachment)).state;
      }
    } finally { if (this.pendingMutation === pending) this.pendingMutation = undefined; }
  }
  async pauseSource(): Promise<void> { await this.suspendSource(false); }
  private updateQuality(attachment: RemoteDesktopAttachment): void {
    if (!this.projection.qualitySupported) return;
    if (typeof attachment.quality !== 'string' || !REMOTE_DESKTOP_QUALITIES.includes(attachment.quality)) throw new Error('invalid_response');
    this.projection.quality = attachment.quality;
  }
  async setQuality(quality: string): Promise<void> {
    if (!this.projection.qualitySupported || this.projection.signalingInterrupted || this.projection.stage !== 'paused'
      || !REMOTE_DESKTOP_QUALITIES.includes(quality) || !this.current(this.generation) || quality === this.projection.quality) return;
    const generation = this.beginSourceChange('setting_quality');
    try {
      const snapshot = await this.mutateSource('set_quality', generation, quality);
      if (!this.current(generation)) return;
      const current = snapshot?.attachment;
      if (current?.attach_id !== this.attachment || current.connection_id !== this.connection || current.phase !== 'suspended'
        || current.display_id !== this.projection.selectedDisplayId || snapshot!.cleanup_pending !== false || current.quality !== quality) throw new Error('delivery_unknown');
      this.updateQuality(current);
      // Manual pause stays paused. A separate explicit resume creates the new PC.
      this.publish('paused'); this.schedule(generation);
    } catch (error) { if (generation === this.generation) this.fail(error, 'set_quality'); }
  }
  private async suspendSource(renewCredentials: boolean): Promise<void> {
    if (this.projection.signalingInterrupted) return;
    if (!this.projection.sourceLifecycleSupported || this.projection.stage !== 'observing' || !this.current(this.generation)) return;
    const generation = this.beginSourceChange('pausing');
    this.credentialRebuild = renewCredentials;
    try {
      const snapshot = await this.mutateSource('suspend', generation);
      if (!this.current(generation)) return;
      if (snapshot?.attachment?.attach_id !== this.attachment || snapshot.attachment.connection_id !== this.connection
        || snapshot.attachment.phase !== 'suspended' || typeof snapshot.cleanup_pending !== 'boolean') throw new Error('delivery_unknown');
      this.hooks.renderer(JSON.stringify({ kind: 'stop' }));
      this.publish(snapshot.cleanup_pending ? 'pausing' : 'paused');
      this.schedule(generation);
      await this.resumeCredentials();
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  async resumeSource(): Promise<void> {
    if (!this.projection.sourceLifecycleSupported || this.projection.stage !== 'paused' || !this.current(this.generation)) return;
    const previous = this.connection, generation = this.beginSourceChange('resuming');
    try {
      const snapshot = await this.mutateSource('resume', generation);
      if (!this.current(generation)) return;
      const current = snapshot?.attachment;
      if (current?.attach_id !== this.attachment || !this.validId(current.connection_id) || current.connection_id === previous
        || !['binding', 'streaming'].includes(current.phase)) throw new Error('delivery_unknown');
      this.updateQuality(current);
      this.connection = current.connection_id;
      this.rendererId = this.identifier(); this.projection.rendererId = this.rendererId;
      this.retiredControlGeneration = '';
      this.publish('connecting'); this.schedule(generation);
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  async chooseSource(): Promise<void> {
    if (!this.projection.sourceLifecycleSupported || this.projection.stage !== 'paused' || !this.current(this.generation)) return;
    const generation = this.beginSourceChange('loading_sources');
    this.schedule(generation);
    try {
      // Discovery is authenticated by the fixed-key channel, without an outer
      // attachment route. Only the subsequent source mutation carries it.
      const reply = await this.channel!.call({ version: 1, op: 'list_displays' });
      if (!this.current(generation)) return;
      this.projection.displays = this.displayChoices(reply);
      this.publish('choose_source');
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  cancelSourceChoice(): void {
    if (!['loading_sources', 'choose_source'].includes(this.projection.stage) || !this.current(this.generation)) return;
    const generation = this.beginSourceChange('paused');
    this.schedule(generation);
  }
  async selectSource(displayId: string): Promise<void> {
    if (!this.projection.sourceLifecycleSupported || this.projection.stage !== 'choose_source' || !this.current(this.generation)) return;
    const display = this.projection.displays.find((item: RemoteDesktopDisplay): boolean => item.display_id === displayId);
    if (!display) return;
    const generation = this.beginSourceChange('selecting_source');
    try {
      const snapshot = await this.mutateSource('select_display', generation, displayId);
      if (!this.current(generation)) return;
      const current = snapshot?.attachment;
      if (current?.attach_id !== this.attachment || current.connection_id !== this.connection || current.display_id !== displayId
        || current.phase !== 'suspended' || snapshot!.cleanup_pending !== false) throw new Error('delivery_unknown');
      this.projection.selectedDisplayId = displayId;
      this.projection.videoWidth = display.width; this.projection.videoHeight = display.height;
      // Selection is an explicit request to view this source. Resume still
      // obtains a fresh CAS and PC; it never acquires control.
      this.publish('paused');
      await this.resumeSource();
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  private displayChoices(reply: RemoteDesktopReply): RemoteDesktopDisplay[] {
    if (!reply.state_revision || !reply.displays || reply.displays.length === 0) throw new Error('target_lost');
    const displays = reply.displays;
    if (displays.length > 64 || displays.some((display: RemoteDesktopDisplay): boolean =>
      !this.validDisplayId(display.display_id) || !Number.isInteger(display.width) || !Number.isInteger(display.height)
      || display.width <= 0 || display.height <= 0 || display.width > 32768 || display.height > 32768)
      || new Set(displays.map((display: RemoteDesktopDisplay): string => display.display_id)).size !== displays.length) throw new Error('invalid_response');
    return displays;
  }
  private schedule(generation: number): void {
    if (!this.current(generation)) return;
    this.timer = setTimeout(() => { void this.poll(generation); }, 350);
  }
  private validId(value: string): boolean { return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value); }
  private validDisplayId(value: string): boolean {
    return typeof value === 'string' && value.length > 0 && Encoding.utf8ToBytes(value).length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
  }
  private identifier(): string {
    return Array.from(Encoding.randomBytes(16)).map((value: number): string => value.toString(16).padStart(2, '0')).join('');
  }
  // Native uptime includes sleep. Wall time may shorten the window; neither
  // repeated snapshots nor clock rollback may renew an existing PC's budget.
  private credentialClock(): number {
    const now = RemoteDesktopGestureClock.now();
    if (now === undefined || !Number.isFinite(now) || now < 0) throw new Error('turn_credentials_expired');
    return now;
  }
  private constrainCredentials(remaining: number, started: number): void {
    const now = this.credentialClock(), elapsed = now - started, wall = Date.now();
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 660000 || elapsed < 0 || !Number.isFinite(wall) || wall < 0) throw new Error('invalid_response');
    const budget = Math.max(0, remaining - elapsed);
    this.credentialDeadline = Math.min(this.credentialDeadline, now + budget);
    this.credentialWallDeadline = Math.min(this.credentialWallDeadline, wall + budget);
  }
  private credentialsRemaining(): number {
    return Math.min(this.credentialDeadline - this.credentialClock(), this.credentialWallDeadline - Date.now());
  }
  private async resumeCredentials(): Promise<void> {
    if (this.credentialRebuild && this.projection.stage === 'paused') {
      this.credentialRebuild = false;
      await this.resumeSource();
    }
  }
  private async poll(generation: number): Promise<void> {
    if (!this.current(generation) || this.pollBusy) return;
    this.pollBusy = true;
    let operation = 'get_state';
    try {
      const channel = this.channel!;
      const requestedAt = this.credentialRebuildSupported ? this.credentialClock() : 0;
      let reply: RemoteDesktopReply;
      try { reply = await channel.call({ version: 1, op: 'get_state' }, this.attachment); }
      catch (error) {
        if (this.current(generation) && this.retainVideoOnReadError(error, generation)) return;
        if (error instanceof Error) throw error as Error;
        throw new Error('invalid_response');
      }
      if (!this.current(generation)) return;
      const current = reply.state?.attachment;
      if (!current || current.attach_id !== this.attachment || current.connection_id !== this.connection) throw new Error(reply.media_error || 'sharing_ended');
      if (reply.media_error) throw new Error(reply.media_error);
      this.updateQuality(current);
      // Use the host's existing input-health observation rather than ICE alone.
      // Older hosts without this field remain available for manual recovery.
      const controlReady = current.phase === 'streaming' && reply.media?.health?.candidate === true;
      if (this.projection.controlReady !== controlReady) {
        this.projection.controlReady = controlReady; this.hooks.update(this.projection);
      }
      if (this.projection.signalingInterrupted) {
        if (current.phase !== 'streaming' || current.display_id !== this.projection.selectedDisplayId) throw new Error('sharing_ended');
        this.clearSignalingWait(); this.hooks.update(this.projection);
        RemoteLogger.info('remote desktop signaling restored; viewing only');
      }
      if (['pausing', 'paused', 'loading_sources', 'choose_source'].includes(this.projection.stage)) {
        if (current.phase !== 'suspended' || typeof reply.state?.cleanup_pending !== 'boolean') throw new Error('sharing_ended');
        if (reply.state.cleanup_pending && Date.now() > this.deadline) throw new Error('cleanup_pending');
        if (reply.state.cleanup_pending) this.publish('pausing');
        else if (this.projection.stage === 'pausing') this.publish('paused');
        await this.resumeCredentials();
        return;
      }
      if (this.credentialRebuildSupported && (this.rendererStarted || reply.media?.offer_sdp)) {
        const remaining = reply.media?.credentials_remaining_ms;
        if (typeof remaining !== 'number' || !Number.isSafeInteger(remaining)) throw new Error('invalid_response');
        this.constrainCredentials(remaining, requestedAt);
        const budget = this.credentialsRemaining();
        if (budget <= 0) throw new Error('turn_credentials_expired');
        if (this.projection.stage === 'observing' && budget <= 60000) {
          RemoteLogger.info('remote desktop renewing media credentials; viewing only');
          await this.suspendSource(true); return;
        }
      }
      if (!this.rendererStarted && this.bridgeReady && reply.media?.offer_sdp) {
        const turnAt = this.credentialRebuildSupported ? this.credentialClock() : 0;
        operation = 'turn';
        const turn = await channel.turn(this.attachment);
        if (!this.current(generation)) return;
        if (this.credentialRebuildSupported) {
          if (!Number.isSafeInteger(turn.expires_at)) throw new Error('turn_unavailable');
          this.constrainCredentials(turn.expires_at * 1000 - Date.now(), turnAt);
          // A token near expiry cannot create an endless rebuild loop.
          if (this.credentialsRemaining() <= 60000) throw new Error('turn_credentials_expired');
        }
        this.projection.controlSupported = this.projection.controlSupported && this.epochReports;
        this.projection.textSupported = this.projection.textSupported && this.projection.controlSupported;
        const config: RemoteDesktopRendererStart = { kind: 'start', renderer_id: this.rendererId, attach_id: this.attachment,
          connection_id: this.connection, offer_sdp: reply.media.offer_sdp, ice_servers: turn.ice_servers, force_relay: this.projection.forceRelay,
          control_supported: this.projection.controlSupported, native_focus: true };
        if (this.projection.controlSupported) config.control_epoch = String(this.controlIntent);
        this.rendererStarted = true;
        this.bridgeRendererId = this.rendererId;
        operation = 'renderer_start';
        this.hooks.renderer(JSON.stringify(config));
      }
      if (reply.media?.source_first_frame && !this.sourceReady) {
        this.sourceReady = true;
        operation = 'renderer_source_ready';
        this.hooks.renderer(JSON.stringify({ kind: 'source_ready', renderer_id: this.rendererId, connection_id: this.connection }));
      }
      if (this.projection.stage !== 'observing' && Date.now() > this.deadline) throw new Error('media_unreachable');
    } catch (error) { if (generation === this.generation) this.fail(error, operation); }
    finally { if (generation === this.generation) { this.pollBusy = false; this.schedule(generation); } }
  }
  private clearSignalingWait(): void {
    clearTimeout(this.signalingTimer); this.signalingTimer = -1;
    this.projection.signalingInterrupted = false;
  }
  private retainVideoOnReadError(error: Object, generation: number): boolean {
    if (this.projection.stage !== 'observing' || !this.rendererStarted || !this.sourceReady
      || !(error instanceof Error) || !['delivery_unknown', 'target_unavailable', 'relay_disconnected', 'relay_connect_timeout'].includes(error.message)) return false;
    if (!this.projection.signalingInterrupted) {
      this.projection.signalingInterrupted = true;
      this.releaseControl();
      RemoteLogger.info('remote desktop signaling interrupted; input suspended');
      // One timer from the first failed read. Repeated failures never extend it.
      this.signalingTimer = setTimeout((): void => {
        if (this.current(generation) && this.projection.signalingInterrupted) this.fail(new Error('media_unreachable'), 'signaling');
      }, 30000);
    }
    return true;
  }
  async receive(raw: string): Promise<void> {
    if (raw.length > 96 * 1024) { this.fail(new Error('invalid_response')); return; }
    let event: RemoteDesktopRendererEvent;
    try { event = Encoding.parseJsonObject<RemoteDesktopRendererEvent>(raw); } catch (_error) { this.fail(new Error('invalid_response')); return; }
    if (event.kind === 'bridge_ready') {
      if (this.rendererStarted) this.fail(new Error('renderer_reloaded'));
      this.bridgeReady = true;
      this.epochReports = Array.isArray(event.capabilities) && event.capabilities.includes('control_epoch_v1');
      return;
    }
    if (event.kind === 'bridge_closed') {
      if (event.renderer_id && event.renderer_id !== this.bridgeRendererId) return;
      this.bridgeReady = false;
      if (event.renderer_id === this.bridgeRendererId && this.attachment.length > 0) this.close();
      return;
    }
    const generation = this.generation;
    if (!this.current(generation) || event.renderer_id !== this.rendererId || event.attach_id !== this.attachment || event.connection_id !== this.connection) return;
    if (event.kind === 'answer') {
      if (!event.answer_sdp || Encoding.utf8ToBytes(event.answer_sdp).length > 90 * 1024) { this.fail(new Error('invalid_answer')); return; }
      const answer: RemoteDesktopAnswer = { attach_id: this.attachment, connection_id: this.connection, answer_sdp: event.answer_sdp };
      try { await this.channel!.call({ version: 1, op: 'signal', body: answer }, this.attachment); }
      catch (error) { if (generation === this.generation) this.fail(error, 'signal'); }
    } else if (event.kind === 'control_state') {
      const epoch = event.control_epoch;
      if (!this.projection.controlSupported || typeof epoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(epoch)
        || !Number.isSafeInteger(Number(epoch)) || Number(epoch) > this.controlIntent) {
        this.fail(new Error('invalid_response'), 'control_state'); return;
      }
      // This stamp was captured by JS when it created the report. Arrival time
      // or remembering just the last retired lease cannot fence older reports.
      if (epoch !== String(this.controlIntent)) return;
      if (event.control_generation) {
        // A renewal state already crossing the JS bridge can arrive after a
        // native release. It cannot restore this PC's retired local authority.
        if (event.control_generation === this.retiredControlGeneration) return;
        if (!this.validGeneration(event.control_generation) || !this.projection.controlSupported
          || !['acquiring', 'controlling'].includes(this.projection.controlState)) { this.fail(new Error('control_delivery_unknown'), 'control_state'); return; }
        this.projection.controlGeneration = event.control_generation; this.projection.controlState = 'controlling';
      } else if (event.pending !== 'acquire_control') {
        if (this.projection.controlGeneration) this.retiredControlGeneration = this.projection.controlGeneration;
        this.projection.controlGeneration = ''; this.projection.controlState = 'viewing';
      }
      // A release acknowledgement is cleanup, not recovery of paused input.
      this.projection.controlError = event.code && event.code !== 'ok' ? event.code
        : this.projection.controlState === 'viewing' ? this.projection.controlError : '';
      if (event.pending === 'release_control') RemoteLogger.info('remote desktop control release pending');
      else if (event.code === 'control_revoked') RemoteLogger.info('remote desktop control revoked');
      this.hooks.update(this.projection);
    } else if ((event.kind === 'first_frame_presented' || event.kind === 'frame_resized') && this.sourceReady) {
      if (event.kind === 'frame_resized' && this.projection.stage !== 'observing') return;
      if (!Number.isInteger(event.width) || !Number.isInteger(event.height) || event.width! <= 0 || event.height! <= 0
        || event.width! > 32768 || event.height! > 32768) { this.fail(new Error('invalid_response'), 'renderer'); return; }
      if (event.kind === 'frame_resized' && this.projection.controlState !== 'viewing') this.releaseControl();
      this.projection.videoWidth = event.width!; this.projection.videoHeight = event.height!;
      if (event.kind === 'first_frame_presented') RemoteLogger.info(`remote desktop first frame width=${event.width} height=${event.height}`);
      this.publish('observing');
    }
    else if (event.kind === 'failed' || event.kind === 'bridge_failed') {
      const stage = ['peer', 'channel', 'track', 'stats', 'ice_no_candidates',
        'ice_401', 'ice_403', 'ice_437', 'ice_438', 'ice_441', 'ice_486', 'ice_508', 'ice_701'].includes(event.stage || '')
        ? event.stage! : 'unknown';
      RemoteLogger.warn(`remote desktop renderer failed stage=${stage}`);
      this.fail(new Error(event.code || 'media_unreachable'), 'renderer');
    }
    else if (event.kind === 'health') {
      if (this.projection.forceRelay && (event.candidate_type !== 'relay' || event.remote_candidate_type !== 'relay')) {
        this.fail(new Error('relay_not_selected')); return;
      }
      this.projection.candidateType = event.candidate_type || '';
      const local = ['host', 'srflx', 'prflx', 'relay'].includes(event.candidate_type || '') ? event.candidate_type! : 'unknown';
      const remote = ['host', 'srflx', 'prflx', 'relay'].includes(event.remote_candidate_type || '') ? event.remote_candidate_type! : 'unknown';
      const protocol = ['udp', 'tcp'].includes(event.protocol || '') ? event.protocol! : 'unknown';
      const relay = ['udp', 'tcp', 'tls'].includes(event.relay_protocol || '') ? event.relay_protocol! : 'unknown';
      const path = `local=${local} remote=${remote} protocol=${protocol} relay_protocol=${relay}`;
      const report = `${this.rendererId}:${path}`;
      if (report !== this.lastTransportReport) {
        this.lastTransportReport = report;
        // Closed enums only: no candidate addresses, SDP or credentials.
        RemoteLogger.info(`remote desktop transport ${path}`);
      }
      this.hooks.update(this.projection);
    }
  }
  private validGeneration(value: string): boolean {
    return /^[1-9][0-9]{0,19}$/.test(value) && (value.length < 20 || value <= '18446744073709551615');
  }
  private rendererControl(body: RemoteDesktopControlIntent): void {
    if (!Number.isSafeInteger(this.controlIntent)) { this.fail(new Error('invalid_response')); return; }
    this.hooks.renderer(JSON.stringify({ kind: 'control', renderer_id: this.rendererId,
      attach_id: this.attachment, connection_id: this.connection, control_epoch: String(this.controlIntent), body }));
  }
  async acquireControl(): Promise<void> {
    if (this.projection.signalingInterrupted || !this.projection.controlSupported || this.projection.stage !== 'observing'
      || this.projection.controlState !== 'viewing' || !this.current(this.generation)) return;
    const generation = this.generation, intent = ++this.controlIntent;
    this.projection.controlState = 'acquiring'; this.projection.controlError = ''; this.hooks.update(this.projection);
    try {
      // Read the current CAS after attach/cleanup; never reuse the directory revision.
      const reply = await this.channel!.call({ version: 1, op: 'get_state' }, this.attachment);
      if (intent !== this.controlIntent || !this.current(generation)) return;
      if (!reply.state?.state_revision || reply.state.attachment?.attach_id !== this.attachment
        || reply.state.attachment.connection_id !== this.connection || reply.media_error) throw new Error('input_suspended');
      this.rendererControl({ kind: 'acquire_control', expected_state_revision: reply.state.state_revision });
    } catch (_error) {
      if (intent !== this.controlIntent || !this.current(generation)) return;
      this.projection.controlState = 'viewing'; this.projection.controlError = 'input_suspended'; this.hooks.update(this.projection);
    }
  }
  releaseControl(reason?: 'input_suspended'): void {
    ++this.controlIntent;
    if (this.projection.controlGeneration) this.retiredControlGeneration = this.projection.controlGeneration;
    this.projection.controlGeneration = ''; this.projection.controlState = 'viewing';
    if (reason) this.projection.controlError = reason;
    this.hooks.update(this.projection);
    if (this.rendererStarted && this.projection.controlSupported) this.rendererControl({ kind: 'release_control' });
  }
  input(message: RemoteDesktopInput): void {
    if (this.projection.signalingInterrupted || this.projection.stage !== 'observing' || this.projection.controlState !== 'controlling'
      || message.renderer_id !== this.rendererId || message.control_generation !== this.projection.controlGeneration || !this.validGeneration(message.control_generation)
      || !this.current(this.generation)) return;
    if (!['pointer_move', 'pointer_button', 'wheel', 'key', 'text_commit'].includes(message.kind)) { this.fail(new Error('invalid_input')); return; }
    if (message.kind === 'text_commit' && !this.projection.textSupported) return;
    // The renderer/host validate the bounded wire shape again. This port never
    // relabels a delayed intent with a later lease's generation.
    const body = JSON.stringify(message);
    if (Encoding.utf8ToBytes(body).length > 32 * 1024) { this.fail(new Error('invalid_input')); return; }
    const input: RemoteDesktopControlIntent = { kind: message.kind, control_generation: message.control_generation, body: message.body };
    this.rendererControl(input);
  }
  rendererFailed(): void { this.fail(new Error('input_backpressure')); }
  private fail(error: Object, origin: string = 'controller'): void {
    const code = error instanceof Error ? error.message : 'media_unreachable';
    const diagnostic = /^[a-z_]{1,64}$/.test(code) ? code : 'unclassified';
    RemoteLogger.warn(`remote desktop failed stage=${this.projection.stage} control=${this.projection.controlState} origin=${origin} code=${diagnostic}`);
    this.close('failed'); this.publish('failed', code);
  }
  close(reason: string = 'local_close'): void {
    if (this.projection.stage !== 'idle' && this.projection.stage !== 'closed') {
      RemoteLogger.info(`remote desktop closed stage=${this.projection.stage} reason=${reason}`);
    }
    ++this.generation; ++this.controlIntent;
    this.credentialRebuildSupported = false; this.credentialRebuild = false;
    this.credentialDeadline = Infinity; this.credentialWallDeadline = Infinity;
    this.clearSignalingWait();
    if (reason !== 'background' && reason !== 'failed') this.reconnectTarget = undefined;
    this.retiredControlGeneration = '';
    this.projection.controlGeneration = ''; this.projection.controlState = 'viewing'; this.projection.rendererId = '';
    clearInterval(this.authorityTimer); this.authorityTimer = -1;
    clearTimeout(this.timer); this.timer = -1; this.pollBusy = false;
    this.hooks.renderer(JSON.stringify({ kind: 'stop' }));
    const channel = this.channel; const attachment = this.attachment; const pending = this.pendingMutation;
    this.pendingMutation = undefined;
    this.channel = undefined; this.binding = undefined;
    this.attachment = ''; this.connection = ''; this.rendererId = ''; this.bridgeRendererId = ''; this.rendererStarted = false; this.sourceReady = false;
    if (RemoteDesktopService.onLifecycle === this.lifecycle) RemoteDesktopService.onLifecycle = undefined;
    if (channel && attachment.length > 0) {
      const body: RemoteDesktopDetach = { attach_id: attachment };
      const detach = (): void => {
        void channel.call({ version: 1, op: 'detach', body }, attachment).catch(() => {}).finally(() => channel.close());
      };
      // Local media/input are already closed. Keep this request's fixed peer
      // key until the bounded mutation settles so detach cannot overtake it.
      // A replacement uses its own channel; never close the shared account socket.
      if (pending) void pending.then(detach, detach);
      else detach();
    } else channel?.close();
    this.publish('closed');
  }
}
