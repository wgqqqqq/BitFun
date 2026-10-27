export interface DesktopFullscreenState { supported: boolean; active: boolean; pending: boolean; failed: boolean; }

// A pending native fullscreen request must settle before another viewer can
// claim this document. Do not stack a retiring viewer underneath its successor.
const owners = new WeakMap<Document, DesktopFullscreen>();

/** Controller-local DOM presentation. No remote window or media authority. */
export class DesktopFullscreen {
  private readonly document: Document;
  private pending = false;
  private exiting = false;
  private wanted = false;
  private disposed = false;
  private failed = false;
  private wasActive = false;
  private entryTask?: Promise<void>;
  private exitTask?: Promise<void>;
  constructor(private readonly element: HTMLElement, private readonly hooks: {
    retireInput(): void; changed(state: DesktopFullscreenState): void;
  }) {
    this.document = element.ownerDocument;
    this.document.addEventListener('fullscreenchange', this.changed);
    this.document.addEventListener('keydown', this.key, true);
    this.publish();
  }
  private get active(): boolean { return this.document.fullscreenElement === this.element; }
  private releaseOwner(): void {
    if (!this.pending && !this.exiting && !this.active && owners.get(this.document) === this) owners.delete(this.document);
  }
  private publish(): void {
    if (!this.disposed) this.hooks.changed({ supported: this.document.fullscreenEnabled === true
      && typeof this.element.requestFullscreen === 'function' && typeof this.document.exitFullscreen === 'function',
      active: this.active, pending: this.pending || this.exiting, failed: this.failed });
  }
  private readonly changed = (): void => {
    if (this.wasActive && !this.active) {
      this.wanted = false;
      if (!this.exiting && !this.pending) this.hooks.retireInput();
    }
    this.wasActive = this.active;
    if (this.active && !this.wanted) void this.exit();
    this.releaseOwner(); this.publish();
  };
  private readonly key = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || (!this.active && !(this.pending && owners.get(this.document) === this))) return;
    event.preventDefault(); event.stopPropagation(); void this.exit();
  };
  async enter(): Promise<void> {
    if (this.disposed || this.pending || this.exiting || this.active) return;
    owners.get(this.document)?.releaseOwner();
    if (this.document.fullscreenEnabled !== true || typeof this.element.requestFullscreen !== 'function'
      || typeof this.document.exitFullscreen !== 'function'
      || (owners.has(this.document) && owners.get(this.document) !== this)
      || (this.document.fullscreenElement && !this.active)) { this.failed = true; this.publish(); return; }
    owners.set(this.document, this); this.wanted = true; this.pending = true; this.failed = false;
    this.hooks.retireInput(); this.publish();
    try {
      // Start synchronously inside the user's click, before any await.
      this.entryTask = this.element.requestFullscreen();
      await this.entryTask;
      if (this.disposed || !this.wanted || !this.element.isConnected) { await this.exit(); return; }
      if (!this.active) { this.wanted = false; this.failed = true; }
    } catch { if (!this.disposed && this.wanted) this.failed = true; }
    finally { this.pending = false; this.entryTask = undefined; this.releaseOwner(); this.publish(); }
  }
  async exit(): Promise<void> {
    this.wanted = false;
    if (!this.active && this.pending && this.entryTask) {
      try { await this.entryTask; } catch { /* A rejected entry needs no exit. */ }
    }
    if (this.exiting) { try { await this.exitTask; } catch { /* The active exit reports its failure. */ } return; }
    this.failed = false;
    if (!this.active) { this.releaseOwner(); this.publish(); return; }
    this.exiting = true;
    if (!this.disposed) this.hooks.retireInput();
    this.publish();
    try { this.exitTask = this.document.exitFullscreen(); await this.exitTask; }
    catch { this.failed = true; }
    finally { this.exiting = false; this.exitTask = undefined; this.releaseOwner(); this.publish(); }
  }
  dispose(): void {
    this.disposed = true;
    this.document.removeEventListener('fullscreenchange', this.changed);
    this.document.removeEventListener('keydown', this.key, true);
    void this.exit();
  }
}
