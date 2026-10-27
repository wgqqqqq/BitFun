import type {
  RemoteDesktopControllerContext, RemoteDesktopDisplay, RemoteDesktopSignalReply,
  RemoteDesktopSignalRequest, RemoteDesktopTurnCredentials,
} from '../api/service-api/RemoteDesktopAPI';
import { isRemoteDesktopQuality, type RemoteDesktopQuality } from './RemoteDesktopQuality';

export type DesktopViewStage = 'idle' | 'probing' | 'waiting_for_host' | 'choose_display' | 'connecting' | 'observing'
  | 'pausing' | 'paused' | 'resuming' | 'loading_sources' | 'choose_source' | 'selecting_source' | 'setting_quality' | 'closed' | 'failed';
export interface DesktopViewState {
  stage: DesktopViewStage;
  displays: RemoteDesktopDisplay[];
  error: string;
  width: number;
  height: number;
  path: 'unknown' | 'direct' | 'relay';
  sourceLifecycleSupported: boolean;
  qualitySupported: boolean;
  quality: RemoteDesktopQuality;
  signalingInterrupted: boolean;
  selectedDisplayId: string;
  controlSupported: boolean;
  textSupported: boolean;
  controlState: 'viewing' | 'acquiring' | 'controlling';
  controlGeneration: string;
  rendererId: string;
  controlError: string;
}
interface Binding { renderer_id: string; attach_id: string; connection_id: string; }
export type DesktopInputBody =
  | { kind: 'pointer_move'; body: { x: number; y: number } }
  | { kind: 'pointer_button'; body: { x: number; y: number; button: 'left' | 'right' | 'middle'; down: boolean } }
  | { kind: 'wheel'; body: { x: number; y: number; dx: number; dy: number } }
  | { kind: 'key'; body: { usage: number; down: boolean } }
  | { kind: 'text_commit'; body: { text: string } };
export type DesktopInput = DesktopInputBody & { renderer_id: string; control_generation: string };
export type DesktopControlIntent =
  | { kind: 'acquire_control'; expected_state_revision: string }
  | { kind: 'release_control' }
  | (DesktopInputBody & { control_generation: string });
export type DesktopRendererCommand =
  | ({ kind: 'start'; offer_sdp: string; ice_servers: RemoteDesktopTurnCredentials['ice_servers'];
      force_relay: boolean; control_supported: boolean; parent_focus?: boolean; control_epoch?: string } & Binding)
  | ({ kind: 'source_ready' } & Binding)
  | ({ kind: 'focus_reply'; echo: string; focused: boolean } & Binding)
  | ({ kind: 'control'; body: DesktopControlIntent; control_epoch?: string } & Binding)
  | { kind: 'stop' };
export interface DesktopControllerPorts {
  request(target: string, payload: RemoteDesktopSignalRequest, context?: RemoteDesktopControllerContext,
    attachment?: string): Promise<RemoteDesktopSignalReply>;
  turn(target: string, attachment: string, context: RemoteDesktopControllerContext): Promise<RemoteDesktopTurnCredentials>;
  renderer(command: DesktopRendererCommand): void;
  update(state: DesktopViewState): void;
  /** Native account-change events, independent of the selected Peer workspace. */
  onInvalidated(close: () => void): () => void;
  identifier(): string;
  now(): number;
  monotonicNow?(): number;
  focused(): boolean;
}
interface Run {
  target: string;
  context?: RemoteDesktopControllerContext;
  revision: string;
  binding: Binding;
  display: string;
  forceRelay: boolean;
  started: boolean;
  sourceReady: boolean;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  signalingTimer?: ReturnType<typeof setTimeout>;
  rendererWait?: { timer: ReturnType<typeof setTimeout>; resolve(ready: boolean): void };
  stopInvalidation: () => void;
  pendingMutation?: Promise<unknown>;
  phase: number;
  controlIntent: number;
  retiredControlGeneration: string;
  credentialRebuildSupported: boolean;
  credentialRebuild: boolean;
  credentialDeadline: number;
  credentialWallDeadline: number;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const dimension = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 32768;
const displayId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && new TextEncoder().encode(value).length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const candidate = (value: unknown) => ['host', 'srflx', 'prflx', 'relay'].includes(String(value));
const controlGeneration = (value: unknown): value is string => typeof value === 'string'
  && /^[1-9][0-9]{0,19}$/.test(value) && (value.length < 20 || value <= '18446744073709551615');
const sameContext = (a: RemoteDesktopControllerContext, b: RemoteDesktopControllerContext) =>
  a.account_generation === b.account_generation && a.connection_id === b.connection_id
  && a.socket_generation === b.socket_generation && a.target_device_id === b.target_device_id
  && a.public_key_fingerprint === b.public_key_fingerprint;
const ERROR_CODES = new Set([
  'target_unavailable', 'unsupported', 'protocol_unsupported', 'relay_upgrade_required', 'device_approval_required',
  'host_locked', 'media_backend_unavailable', 'permission_required', 'turn_unavailable', 'turn_credentials_expired',
  'attachment_busy', 'cleanup_pending', 'target_lost', 'sharing_ended', 'delivery_unknown', 'authorization_required',
  'authorization_expired', 'authorization_unknown', 'controller_context_changed', 'controller_context_required',
  'invalid_response', 'media_unreachable', 'relay_not_selected', 'renderer_reloaded', 'remote_desktop_requires_https',
  'control_busy', 'stale_revision', 'lease_expired', 'input_suspended', 'control_delivery_unknown',
  'input_backpressure', 'stale_control', 'control_revoked', 'invalid_input', 'relay_unavailable',
]);
function code(error: unknown): string {
  const value = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return ERROR_CODES.has(value) ? value : 'media_unreachable';
}
export const initialDesktopViewState = (): DesktopViewState => ({ stage: 'idle', displays: [], error: '', width: 0, height: 0,
  path: 'unknown', sourceLifecycleSupported: false, qualitySupported: false, quality: 'data_saver', signalingInterrupted: false, selectedDisplayId: '', controlSupported: false, textSupported: false,
  controlState: 'viewing', controlGeneration: '', rendererId: '', controlError: '' });

function displayChoices(reply: Record<string, unknown>): RemoteDesktopDisplay[] {
  if (!displayId(reply.state_revision) || !Array.isArray(reply.displays) || reply.displays.length === 0
    || reply.displays.length > 64) throw new Error('invalid_response');
  const seen = new Set<string>();
  return reply.displays.map(value => {
    const display = record(value);
    if (!display || !displayId(display.display_id) || !dimension(display.width) || !dimension(display.height)
      || seen.has(display.display_id)) throw new Error('invalid_response');
    seen.add(display.display_id);
    return { display_id: display.display_id, width: display.width, height: display.height };
  });
}

/** One explicitly selected remote desktop. No Agent session, workspace switch,
 * device keys, renderer handle, or automatic mutation replay. The host must
 * advertise control; viewing never creates a lease on its own. */
export class RemoteDesktopController {
  private run?: Run;
  private bridgeReady = false;
  private receiverApiUnavailable = false;
  private epochReports = false;
  private visible = true;
  private restoreOnVisible = false;
  private state = initialDesktopViewState();
  constructor(private readonly ports: DesktopControllerPorts) {}

  private publish(stage: DesktopViewStage, error = ''): void {
    this.state = { ...this.state, stage, error };
    this.ports.update({ ...this.state, displays: this.state.displays.map(display => ({ ...display })) });
  }
  private current(run: Run, phase = run.phase): boolean { return this.run === run && run.phase === phase; }
  private rendererPrepared(run: Run, ready: boolean): void {
    const wait = run.rendererWait;
    run.rendererWait = undefined;
    if (wait) { clearTimeout(wait.timer); wait.resolve(ready); }
  }
  private waitForRenderer(run: Run): Promise<boolean> {
    if (!this.current(run)) return Promise.resolve(false);
    if (this.bridgeReady) return Promise.resolve(!this.receiverApiUnavailable);
    return new Promise(resolve => {
      run.rendererWait = { resolve, timer: setTimeout(() => {
        if (this.current(run)) this.fail(run, 'media_backend_unavailable');
      }, 4000) };
    });
  }
  /** Scene visibility is independent of mounting and never restores input. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible && this.run) this.run.credentialRebuild = false;
    if (visible) { this.restoreViewing(); return; }
    if (this.state.signalingInterrupted) { this.close(); return; }
    if (this.state.stage === 'observing' && this.state.sourceLifecycleSupported) {
      this.restoreOnVisible = true; void this.pauseSource();
    } else if (['loading_sources', 'choose_source'].includes(this.state.stage)) {
      this.cancelSourceChoice();
    } else if (!['pausing', 'paused', 'closed', 'failed'].includes(this.state.stage)) {
      // A legacy or still-negotiating connection cannot be retained safely.
      // Return to an explicit new probe instead of replaying attach.
      this.close();
    }
  }
  private restoreViewing(): void {
    if (this.visible && this.restoreOnVisible && this.state.stage === 'paused') {
      this.restoreOnVisible = false; void this.resumeSource();
    }
  }
  private async call(run: Run, payload: RemoteDesktopSignalRequest): Promise<Record<string, unknown>> {
    if (!this.current(run)) throw new Error('controller_context_changed');
    const phase = run.phase;
    // Discovery is authenticated by the fixed context, without an attachment
    // route. Source mutations and state reads retain the attachment binding.
    const attachment = ['capabilities', 'list_displays'].includes(payload.op) ? undefined : run.binding.attach_id || undefined;
    const reply = await this.ports.request(run.target, payload, run.context, attachment);
    if (!this.current(run, phase)) throw new Error('controller_context_changed');
    if (!reply.context || reply.context.target_device_id !== run.target
      || (run.context && !sameContext(run.context, reply.context))) throw new Error('controller_context_changed');
    run.context ??= { ...reply.context };
    const value = record(reply.payload);
    if (!value) throw new Error('invalid_response');
    if (value.error) throw new Error(code(record(value.error)?.code));
    return value;
  }
  async open(target: { device_id: string; device_kind?: string | null; online: boolean }): Promise<void> {
    this.close(); this.state = initialDesktopViewState();
    if (!id(target.device_id) || !target.online) { this.publish('failed', 'target_unavailable'); return; }
    if (target.device_kind && target.device_kind !== 'desktop') { this.publish('failed', 'unsupported'); return; }
    if (this.receiverApiUnavailable) { this.publish('failed', 'media_backend_unavailable'); return; }
    const run: Run = { target: target.device_id, revision: '', binding: { renderer_id: '', attach_id: '', connection_id: '' },
      display: '', forceRelay: false, started: false, sourceReady: false, deadline: 0, stopInvalidation: () => {},
      phase: 0, controlIntent: 0, retiredControlGeneration: '', credentialRebuildSupported: false,
      credentialRebuild: false, credentialDeadline: Infinity, credentialWallDeadline: Infinity };
    this.run = run;
    run.stopInvalidation = this.ports.onInvalidated(() => { if (this.current(run)) this.fail(run, 'controller_context_changed'); });
    if (!this.current(run)) { run.stopInvalidation(); return; }
    this.publish('probing');
    try {
      // The frame may still be loading when the owning view mounts. Discover
      // host state only after its local API report; cancellation never replays.
      if (!await this.waitForRenderer(run) || !this.current(run)) return;
      const probe = await this.call(run, { version: 1, op: 'capabilities' });
      if (!this.current(run)) return;
      if (probe.availability !== 'ready') throw new Error(code(probe.availability));
      if (!Array.isArray(probe.protocol_versions) || !probe.protocol_versions.includes(1)
        || !Array.isArray(probe.capabilities) || !['read_only_video_v1', 'gathered_sdp_v1'].every(v => probe.capabilities instanceof Array && probe.capabilities.includes(v))) throw new Error('protocol_unsupported');
      if (probe.authorization !== 'view') throw new Error('device_approval_required');
      this.state.controlSupported = probe.capabilities.includes('ordered_control_v1');
      this.state.sourceLifecycleSupported = probe.capabilities.includes('source_lifecycle_v1');
      this.state.qualitySupported = this.state.sourceLifecycleSupported && probe.capabilities.includes('quality_presets_v1');
      run.credentialRebuildSupported = this.state.sourceLifecycleSupported && probe.capabilities.includes('credential_rebuild_v1');
      this.state.textSupported = this.state.controlSupported && probe.capabilities.includes('text_commit_v1');
      if (this.state.sourceLifecycleSupported && !await this.waitForIdleHost(run)) return;
      const reply = await this.call(run, { version: 1, op: 'list_displays' });
      if (!this.current(run)) return;
      this.state.displays = displayChoices(reply);
      run.revision = reply.state_revision as string;
      this.publish('choose_display');
    } catch (error) { if (this.current(run)) this.fail(run, code(error)); }
  }
  /** A fresh setup waits for old resources, never adopts or ends the old share. */
  private async waitForIdleHost(run: Run): Promise<boolean> {
    const phase = run.phase;
    let started: number | undefined, last = 0;
    while (this.current(run, phase)) {
      const reply = await this.call(run, { version: 1, op: 'get_state' });
      if (!this.current(run, phase)) return false;
      const state = record(reply.state);
      if (!state || typeof state.busy !== 'boolean' || typeof state.cleanup_pending !== 'boolean'
        || (!state.busy && state.attachment != null)) throw new Error('invalid_response');
      const now = this.ports.monotonicNow ? this.ports.monotonicNow() : performance.now();
      if (started !== undefined) {
        if (!Number.isFinite(now) || now < last) throw new Error('invalid_response');
        if (now - started >= 60000) throw new Error(state.cleanup_pending ? 'cleanup_pending' : 'attachment_busy');
      }
      if (!state.busy && !state.cleanup_pending) {
        if (started !== undefined) this.publish('probing');
        return true;
      }
      // Host snapshots disclose an attachment only to its authenticated owner.
      if (state.busy && state.attachment == null) throw new Error('attachment_busy');
      if (state.busy && !record(state.attachment)) throw new Error('invalid_response');
      if (!Number.isFinite(now) || now < 0) throw new Error('invalid_response');
      if (started === undefined) { started = now; this.publish('waiting_for_host'); }
      last = now;
      await new Promise<void>(resolve => { setTimeout(resolve, 350); });
    }
    return false;
  }
  async attach(display: string, forceRelay: boolean): Promise<void> {
    const run = this.run;
    if (!run || this.state.stage !== 'choose_display' || !this.state.displays.some(value => value.display_id === display)) return;
    run.binding.attach_id = this.ports.identifier(); run.binding.renderer_id = this.ports.identifier();
    this.state.rendererId = run.binding.renderer_id;
    if (!id(run.binding.attach_id) || !id(run.binding.renderer_id)) { this.fail(run, 'invalid_response'); return; }
    run.display = display; this.state.selectedDisplayId = display;
    run.forceRelay = forceRelay; run.deadline = this.ports.now() + 60000;
    this.publish('connecting');
    try {
      let reply: Record<string, unknown>;
      const pending = this.call(run, { version: 1, op: 'attach', body: { attach_id: run.binding.attach_id,
        display_id: display, expected_state_revision: run.revision, force_relay: forceRelay } });
      run.pendingMutation = pending;
      try { reply = await pending; }
      catch (error) {
        if (!this.current(run) || code(error) !== 'delivery_unknown') throw error;
        reply = await this.call(run, { version: 1, op: 'get_state' });
      } finally { if (run.pendingMutation === pending) run.pendingMutation = undefined; }
      if (!this.current(run)) return;
      const attachment = record(record(reply.state)?.attachment);
      if (!attachment || attachment.attach_id !== run.binding.attach_id || !id(attachment.connection_id)
        || attachment.display_id !== run.display) throw new Error('delivery_unknown');
      this.updateQuality(attachment);
      run.binding.connection_id = attachment.connection_id;
      this.schedule(run);
    } catch (error) { if (this.current(run)) this.fail(run, code(error)); }
  }
  private beginSourceChange(run: Run, stage: DesktopViewStage): number {
    // Retire local input now, but keep the old PC until the host has marked
    // its close as intentional. Closing it first would end the attachment.
    this.releaseControl();
    clearTimeout(run.timer);
    run.credentialRebuild = false;
    run.credentialDeadline = Infinity; run.credentialWallDeadline = Infinity;
    ++run.phase; run.started = false; run.sourceReady = false;
    run.deadline = this.ports.now() + 60000;
    this.state.rendererId = ''; this.state.path = 'unknown'; this.state.controlError = '';
    this.publish(stage);
    return run.phase;
  }
  private async mutateSource(run: Run, op: 'suspend' | 'resume' | 'select_display' | 'set_quality', choice?: string): Promise<Record<string, unknown>> {
    const before = await this.call(run, { version: 1, op: 'get_state' });
    const snapshot = record(before.state), attachment = record(snapshot?.attachment);
    const revision = snapshot?.state_revision;
    if (!displayId(revision) || revision.length > 128 || before.media_error
      || attachment?.attach_id !== run.binding.attach_id || attachment.connection_id !== run.binding.connection_id
      || attachment.display_id !== run.display || !['binding', 'streaming', 'suspended'].includes(String(attachment.phase))
      || (op !== 'suspend' && (attachment.phase !== 'suspended' || snapshot?.cleanup_pending !== false))) throw new Error('sharing_ended');
    const body = { attach_id: run.binding.attach_id, expected_state_revision: revision };
    let request: RemoteDesktopSignalRequest;
    if (op === 'set_quality') {
      if (!isRemoteDesktopQuality(choice)) throw new Error('invalid_response');
      request = { version: 1, op, body: { ...body, quality: choice } };
    } else if (op === 'select_display') {
      if (!displayId(choice)) throw new Error('invalid_response');
      request = { version: 1, op, body: { ...body, display_id: choice } };
    } else request = { version: 1, op, body };
    const pending = this.call(run, request);
    run.pendingMutation = pending;
    try {
      try { return await pending; }
      catch (error) {
        if (!this.current(run) || code(error) !== 'delivery_unknown') throw error;
        // One authoritative read can resolve an uncertain ACK; never replay.
        return await this.call(run, { version: 1, op: 'get_state' });
      }
    } finally { if (run.pendingMutation === pending) run.pendingMutation = undefined; }
  }
  async pauseSource(): Promise<void> { await this.suspendSource(false); }
  private updateQuality(attachment: Record<string, unknown>): void {
    if (!this.state.qualitySupported) return;
    if (!isRemoteDesktopQuality(attachment.quality)) throw new Error('invalid_response');
    this.state.quality = attachment.quality;
  }
  async setQuality(quality: RemoteDesktopQuality): Promise<void> {
    const run = this.run;
    if (!run || !this.visible || !this.state.qualitySupported || this.state.signalingInterrupted || this.state.stage !== 'paused'
      || !isRemoteDesktopQuality(quality) || quality === this.state.quality) return;
    const phase = this.beginSourceChange(run, 'setting_quality');
    try {
      const reply = await this.mutateSource(run, 'set_quality', quality);
      const snapshot = record(reply.state), attachment = record(snapshot?.attachment);
      if (!this.current(run, phase)) return;
      if (attachment?.attach_id !== run.binding.attach_id || attachment.connection_id !== run.binding.connection_id
        || attachment.display_id !== run.display || attachment.phase !== 'suspended' || snapshot?.cleanup_pending !== false
        || attachment.quality !== quality) throw new Error('delivery_unknown');
      this.updateQuality(attachment);
      this.publish('paused'); this.schedule(run);
    } catch (error) { if (this.current(run, phase)) this.fail(run, code(error)); }
  }
  private async suspendSource(renewCredentials: boolean): Promise<void> {
    if (this.state.signalingInterrupted) return;
    const run = this.run;
    if (!run || !this.state.sourceLifecycleSupported || this.state.stage !== 'observing') return;
    const phase = this.beginSourceChange(run, 'pausing');
    run.credentialRebuild = renewCredentials;
    try {
      const reply = await this.mutateSource(run, 'suspend'), snapshot = record(reply.state), attachment = record(snapshot?.attachment);
      if (!this.current(run, phase)) return;
      if (attachment?.attach_id !== run.binding.attach_id || attachment.connection_id !== run.binding.connection_id
        || attachment.display_id !== run.display || attachment.phase !== 'suspended'
        || typeof snapshot?.cleanup_pending !== 'boolean') throw new Error('delivery_unknown');
      this.ports.renderer({ kind: 'stop' });
      this.publish(snapshot.cleanup_pending ? 'pausing' : 'paused'); this.schedule(run);
      this.restoreViewing();
      await this.resumeCredentials(run);
    } catch (error) { if (this.current(run, phase)) this.fail(run, code(error)); }
  }
  async resumeSource(): Promise<void> {
    const run = this.run;
    if (!run || !this.state.sourceLifecycleSupported || this.state.stage !== 'paused') return;
    const previous = run.binding.connection_id, phase = this.beginSourceChange(run, 'resuming');
    try {
      const reply = await this.mutateSource(run, 'resume'), attachment = record(record(reply.state)?.attachment);
      if (!this.current(run, phase)) return;
      if (attachment?.attach_id !== run.binding.attach_id || !id(attachment.connection_id) || attachment.connection_id === previous
        || attachment.display_id !== run.display || !['binding', 'streaming'].includes(String(attachment.phase))) throw new Error('delivery_unknown');
      this.updateQuality(attachment);
      const renderer = this.ports.identifier();
      if (!id(renderer)) throw new Error('invalid_response');
      run.binding = { ...run.binding, connection_id: attachment.connection_id, renderer_id: renderer };
      this.state.rendererId = renderer; run.retiredControlGeneration = '';
      this.publish('connecting'); this.schedule(run);
    } catch (error) { if (this.current(run, phase)) this.fail(run, code(error)); }
  }
  async chooseSource(): Promise<void> {
    const run = this.run;
    if (!run || !this.state.sourceLifecycleSupported || this.state.stage !== 'paused') return;
    const phase = this.beginSourceChange(run, 'loading_sources');
    this.schedule(run);
    try {
      const reply = await this.call(run, { version: 1, op: 'list_displays' });
      if (!this.current(run, phase)) return;
      this.state.displays = displayChoices(reply); this.publish('choose_source');
    } catch (error) { if (this.current(run, phase)) this.fail(run, code(error)); }
  }
  cancelSourceChoice(): void {
    const run = this.run;
    if (!run || !['loading_sources', 'choose_source'].includes(this.state.stage)) return;
    this.beginSourceChange(run, 'paused'); this.schedule(run);
  }
  async selectSource(display: string): Promise<void> {
    const run = this.run;
    if (!run || !this.state.sourceLifecycleSupported || this.state.stage !== 'choose_source'
      || !this.state.displays.some(item => item.display_id === display)) return;
    const phase = this.beginSourceChange(run, 'selecting_source');
    try {
      const reply = await this.mutateSource(run, 'select_display', display), snapshot = record(reply.state), attachment = record(snapshot?.attachment);
      if (!this.current(run, phase)) return;
      if (attachment?.attach_id !== run.binding.attach_id || attachment.connection_id !== run.binding.connection_id
        || attachment.display_id !== display || attachment.phase !== 'suspended' || snapshot?.cleanup_pending !== false) throw new Error('delivery_unknown');
      run.display = display; this.state.selectedDisplayId = display;
      this.publish('paused'); await this.resumeSource();
    } catch (error) { if (this.current(run, phase)) this.fail(run, code(error)); }
  }
  private schedule(run: Run): void {
    if (!this.current(run)) return;
    clearTimeout(run.timer);
    const phase = run.phase;
    run.timer = setTimeout(() => { if (this.current(run, phase)) void this.poll(run); }, this.state.stage === 'observing' ? 1000 : 350);
  }
  private credentialClock(): number {
    const now = this.ports.monotonicNow ? this.ports.monotonicNow() : performance.now();
    if (!Number.isFinite(now) || now < 0) throw new Error('turn_credentials_expired');
    return now;
  }
  private constrainCredentials(run: Run, remaining: number, started: number): void {
    const now = this.credentialClock(), elapsed = now - started, wall = this.ports.now();
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 660000 || elapsed < 0 || !Number.isFinite(wall) || wall < 0) throw new Error('invalid_response');
    const budget = Math.max(0, remaining - elapsed);
    run.credentialDeadline = Math.min(run.credentialDeadline, now + budget);
    run.credentialWallDeadline = Math.min(run.credentialWallDeadline, wall + budget);
  }
  private credentialsRemaining(run: Run): number {
    return Math.min(run.credentialDeadline - this.credentialClock(), run.credentialWallDeadline - this.ports.now());
  }
  private async resumeCredentials(run: Run): Promise<void> {
    if (this.current(run) && run.credentialRebuild && this.visible && this.state.stage === 'paused') {
      run.credentialRebuild = false;
      await this.resumeSource();
    }
  }
  private async poll(run: Run): Promise<void> {
    if (!this.current(run)) return;
    const phase = run.phase;
    try {
      const requestedAt = run.credentialRebuildSupported ? this.credentialClock() : 0;
      let reply: Record<string, unknown>;
      try { reply = await this.call(run, { version: 1, op: 'get_state' }); }
      catch (error) {
        if (this.current(run, phase) && this.retainVideoOnReadError(run, code(error))) return;
        throw error;
      }
      if (!this.current(run)) return;
      const attachment = record(record(reply.state)?.attachment);
      if (!attachment || attachment.attach_id !== run.binding.attach_id || attachment.connection_id !== run.binding.connection_id
        || attachment.display_id !== run.display) throw new Error(code(reply.media_error || 'sharing_ended'));
      if (reply.media_error) throw new Error(code(reply.media_error));
      this.updateQuality(attachment);
      if (this.state.signalingInterrupted) {
        if (attachment.phase !== 'streaming') throw new Error('sharing_ended');
        clearTimeout(run.signalingTimer); run.signalingTimer = undefined;
        this.state.signalingInterrupted = false; this.publish(this.state.stage);
      }
      if (['pausing', 'paused', 'loading_sources', 'choose_source'].includes(this.state.stage)) {
        const snapshot = record(reply.state);
        if (attachment.phase !== 'suspended' || typeof snapshot?.cleanup_pending !== 'boolean') throw new Error('sharing_ended');
        if (snapshot.cleanup_pending && this.ports.now() >= run.deadline) throw new Error('cleanup_pending');
        if (snapshot.cleanup_pending) this.publish('pausing');
        else if (this.state.stage === 'pausing') this.publish('paused');
        this.restoreViewing();
        await this.resumeCredentials(run);
        return;
      }
      const media = record(reply.media);
      if (run.credentialRebuildSupported && (run.started || media?.offer_sdp)) {
        const remaining = media?.credentials_remaining_ms;
        if (typeof remaining !== 'number' || !Number.isSafeInteger(remaining)) throw new Error('invalid_response');
        this.constrainCredentials(run, remaining, requestedAt);
        const budget = this.credentialsRemaining(run);
        if (budget <= 0) throw new Error('turn_credentials_expired');
        if (this.state.stage === 'observing' && budget <= 60000) {
          await this.suspendSource(true); return;
        }
      }
      if (!run.started && this.bridgeReady && media?.offer_sdp) {
        if (typeof media.offer_sdp !== 'string' || new TextEncoder().encode(media.offer_sdp).length > 90 * 1024
          || media.force_relay !== run.forceRelay) throw new Error('invalid_response');
        const turnAt = run.credentialRebuildSupported ? this.credentialClock() : 0;
        const turn = await this.ports.turn(run.target, run.binding.attach_id, run.context!);
        if (!this.current(run, phase)) return;
        if (turn.target_device_id !== run.target || turn.attach_id !== run.binding.attach_id
          || !Number.isSafeInteger(turn.expires_at) || turn.expires_at * 1000 <= this.ports.now()
          || !Array.isArray(turn.ice_servers) || turn.ice_servers.length === 0) throw new Error('turn_unavailable');
        if (run.credentialRebuildSupported) {
          this.constrainCredentials(run, turn.expires_at * 1000 - this.ports.now(), turnAt);
          if (this.credentialsRemaining(run) <= 60000) throw new Error('turn_credentials_expired');
        }
        // An older bundled receiver can still show video, but cannot fence
        // reports queued across multiple control intents.
        this.state.controlSupported &&= this.epochReports;
        this.state.textSupported &&= this.state.controlSupported;
        run.started = true;
        this.ports.renderer({ kind: 'start', ...run.binding, offer_sdp: media.offer_sdp,
          ice_servers: turn.ice_servers, force_relay: run.forceRelay, control_supported: this.state.controlSupported,
          parent_focus: this.state.controlSupported,
          ...(this.state.controlSupported ? { control_epoch: String(run.controlIntent) } : {}) });
      }
      if (run.started && media?.source_first_frame === true && !run.sourceReady) {
        run.sourceReady = true;
        this.ports.renderer({ kind: 'source_ready', ...run.binding });
      }
      if (this.state.stage !== 'observing' && this.ports.now() >= run.deadline) throw new Error('media_unreachable');
    } catch (error) { if (this.current(run, phase)) this.fail(run, code(error)); }
    finally { if (this.current(run, phase)) this.schedule(run); }
  }
  private retainVideoOnReadError(run: Run, error: string): boolean {
    if (this.state.stage !== 'observing' || !run.started || !run.sourceReady
      || !['delivery_unknown', 'target_unavailable', 'relay_unavailable'].includes(error)) return false;
    if (!this.state.signalingInterrupted) {
      this.state.signalingInterrupted = true; this.releaseControl();
      // Bounded from the first failed read, independent of subsequent polling.
      run.signalingTimer = setTimeout(() => {
        if (this.current(run) && this.state.signalingInterrupted) this.fail(run, 'media_unreachable');
      }, 30000);
    }
    return true;
  }
  async receive(value: unknown): Promise<void> {
    const event = record(value);
    const run = this.run;
    if (!event) { if (run) this.fail(run, 'invalid_response'); return; }
    if (event.kind === 'bridge_ready') {
      if (this.bridgeReady && run) this.fail(run, 'renderer_reloaded');
      this.bridgeReady = true;
      this.epochReports = Array.isArray(event.capabilities) && event.capabilities.includes('control_epoch_v1');
      // Local renderer fact only. Legacy bundled bridges omit it. A known
      // negative remains terminal for this renderer, including across reopen.
      if (event.receiver_api_available !== undefined && (typeof event.receiver_api_available !== 'boolean' || !event.receiver_api_available)) {
        this.receiverApiUnavailable = true;
        const error = typeof event.receiver_api_available === 'boolean' ? 'media_backend_unavailable' : 'invalid_response';
        if (run) this.fail(run, error); else this.publish('failed', error);
      }
      if (run && this.current(run) && !this.receiverApiUnavailable) this.rendererPrepared(run, true);
      return;
    }
    if (!run || !run.started || event.renderer_id !== run.binding.renderer_id || event.attach_id !== run.binding.attach_id
      || event.connection_id !== run.binding.connection_id) return;
    const phase = run.phase;
    try {
      if (event.kind === 'focus_probe') {
        if (typeof event.echo !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(event.echo)) throw new Error('invalid_response');
        this.ports.renderer({ kind: 'focus_reply', ...run.binding, echo: event.echo, focused: this.ports.focused() === true });
      } else if (event.kind === 'control_state') {
        if (!this.state.controlSupported) throw new Error('invalid_response');
        const epoch = event.control_epoch;
        if (epoch !== '0' && !controlGeneration(epoch)) throw new Error('invalid_response');
        if (Number(epoch) > run.controlIntent) throw new Error('invalid_response');
        // Compare the stamp captured when JS created this event, not the
        // generation from only the last retired lease or native arrival time.
        if (epoch !== String(run.controlIntent)) return;
        if (event.control_generation) {
          if (event.control_generation === run.retiredControlGeneration) return;
          if (!controlGeneration(event.control_generation) || !this.state.controlSupported
            || !['acquiring', 'controlling'].includes(this.state.controlState)) throw new Error('control_delivery_unknown');
          this.state.controlGeneration = event.control_generation; this.state.controlState = 'controlling';
        } else if (event.pending !== 'acquire_control') {
          if (this.state.controlGeneration) run.retiredControlGeneration = this.state.controlGeneration;
          this.state.controlGeneration = ''; this.state.controlState = 'viewing';
        }
        this.state.controlError = event.code && event.code !== 'ok' ? code(event.code) : '';
        this.publish(this.state.stage);
      } else if (event.kind === 'answer') {
        if (typeof event.answer_sdp !== 'string' || !event.answer_sdp || new TextEncoder().encode(event.answer_sdp).length > 90 * 1024) throw new Error('invalid_response');
        await this.call(run, { version: 1, op: 'signal', body: { attach_id: run.binding.attach_id,
          connection_id: run.binding.connection_id, answer_sdp: event.answer_sdp } });
      } else if (event.kind === 'first_frame_presented' || event.kind === 'frame_resized') {
        if (event.kind === 'frame_resized' && this.state.stage !== 'observing') return;
        if (!run.sourceReady || !dimension(event.width) || !dimension(event.height)) throw new Error('invalid_response');
        if (this.state.stage === 'observing' && this.state.controlState !== 'viewing'
          && (this.state.width !== event.width || this.state.height !== event.height)) this.releaseControl();
        this.state.width = event.width; this.state.height = event.height; this.publish('observing');
      } else if (event.kind === 'health') {
        if (run.forceRelay && (event.candidate_type !== 'relay' || event.remote_candidate_type !== 'relay')) throw new Error('relay_not_selected');
        this.state.path = event.candidate_type === 'relay' || event.remote_candidate_type === 'relay' ? 'relay'
          : candidate(event.candidate_type) && candidate(event.remote_candidate_type) ? 'direct' : 'unknown';
        this.publish(this.state.stage);
      } else if (['failed', 'bridge_failed', 'bridge_closed'].includes(String(event.kind))) throw new Error(code(event.code));
    } catch (error) { if (this.current(run, phase)) this.fail(run, code(error)); }
  }
  private rendererControl(run: Run, body: DesktopControlIntent): void {
    if (!Number.isSafeInteger(run.controlIntent)) { this.fail(run, 'invalid_response'); return; }
    this.ports.renderer({ kind: 'control', ...run.binding, control_epoch: String(run.controlIntent), body });
  }
  async acquireControl(): Promise<void> {
    const run = this.run;
    if (!run || !this.visible || this.state.signalingInterrupted || this.state.stage !== 'observing' || !this.state.controlSupported || this.state.controlState !== 'viewing') return;
    const intent = ++run.controlIntent;
    this.state.controlState = 'acquiring'; this.state.controlError = ''; this.publish(this.state.stage);
    try {
      const reply = await this.call(run, { version: 1, op: 'get_state' });
      if (!this.current(run) || intent !== run.controlIntent) return;
      const state = record(reply.state), attachment = record(state?.attachment);
      const revision = state?.state_revision;
      if (!displayId(revision) || revision.length > 128) throw new Error('input_suspended');
      if (attachment?.attach_id !== run.binding.attach_id || attachment.connection_id !== run.binding.connection_id
        || attachment.display_id !== run.display || reply.media_error || !this.ports.focused()) throw new Error('input_suspended');
      this.rendererControl(run, { kind: 'acquire_control', expected_state_revision: revision });
    } catch {
      if (!this.current(run) || intent !== run.controlIntent) return;
      this.state.controlState = 'viewing'; this.state.controlError = 'input_suspended'; this.publish(this.state.stage);
    }
  }
  releaseControl(expected?: { renderer: string; generation: string }): void {
    const run = this.run;
    if (!run) return;
    if (expected && (expected.renderer !== run.binding.renderer_id || expected.generation !== this.state.controlGeneration)) return;
    ++run.controlIntent;
    if (this.state.controlGeneration) run.retiredControlGeneration = this.state.controlGeneration;
    this.state.controlGeneration = ''; this.state.controlState = 'viewing'; this.publish(this.state.stage);
    if (run.started && this.state.controlSupported) this.rendererControl(run, { kind: 'release_control' });
  }
  inputUnsupported(expected: { renderer: string; generation: string }): void {
    if (expected.renderer !== this.state.rendererId || expected.generation !== this.state.controlGeneration) return;
    this.releaseControl(expected); this.state.controlError = 'unsupported_input'; this.publish(this.state.stage);
  }
  input(message: DesktopInput): void {
    const run = this.run;
    if (!run || !this.visible || this.state.signalingInterrupted || this.state.stage !== 'observing' || this.state.controlState !== 'controlling'
      || message.renderer_id !== run.binding.renderer_id || message.control_generation !== this.state.controlGeneration
      || !controlGeneration(message.control_generation)) return;
    if (!this.ports.focused()) { this.releaseControl(); return; }
    if (message.kind === 'text_commit' && !this.state.textSupported) return;
    if (new TextEncoder().encode(JSON.stringify(message)).length > 32 * 1024) { this.fail(run, 'invalid_input'); return; }
    // Keep the generation captured by the UI. Never add a newer lease to a
    // delayed DOM/IME intent. The bound renderer and host validate it again.
    const { renderer_id: _renderer, ...body } = message;
    this.rendererControl(run, body);
  }
  private detach(run: Run): void {
    if (run.context && run.binding.attach_id) {
      // Preserve the old fence. A new account/socket/key cannot clean up by
      // silently acquiring authority over an old attachment.
      void this.ports.request(run.target, { version: 1, op: 'detach', body: { attach_id: run.binding.attach_id } },
        run.context, run.binding.attach_id).catch(() => {});
    }
  }
  private retire(): void {
    const run = this.run;
    this.run = undefined;
    this.restoreOnVisible = false;
    this.state.controlGeneration = ''; this.state.controlState = 'viewing'; this.state.rendererId = '';
    this.state.signalingInterrupted = false;
    this.ports.renderer({ kind: 'stop' });
    if (!run) return;
    this.rendererPrepared(run, false);
    clearTimeout(run.timer); clearTimeout(run.signalingTimer); run.stopInvalidation();
    // Closing while a mutation awaits its ACK must also retire the eventual host
    // attachment. Do not let detach race ahead of that mutation on the shared
    // account socket, and never tear down the socket/chat connection itself.
    if (run.pendingMutation) void run.pendingMutation.then(() => this.detach(run), () => this.detach(run));
    else this.detach(run);
  }
  private fail(run: Run, error: string): void {
    if (!this.current(run)) return;
    this.retire(); this.publish('failed', error);
  }
  rendererFailed(error = 'media_backend_unavailable'): void { if (this.run) this.fail(this.run, code(error)); }
  close(): void { this.retire(); this.publish('closed'); }
}
