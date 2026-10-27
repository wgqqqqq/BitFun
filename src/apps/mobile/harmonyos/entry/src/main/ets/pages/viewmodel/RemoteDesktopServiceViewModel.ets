import { util } from '@kit.ArkTS';
import { CloudAccountBinding, CloudAccountClient, CloudAccountDevice } from '../../services/CloudAccountClient';
import { CloudAccountSessionStore, PersistedRemoteDesktopProfile } from '../../services/CloudAccountSessionStore';
import { Encoding } from '../../services/Encoding';
import { normalizeRemoteDesktopServiceUrl } from '../../services/RemoteDesktopServiceEndpoint';
import { RemoteDesktopServiceState } from '../state/RemoteDesktopServiceState';

/** Separate secure storage, transport and lifecycle from OpenBitFun login. */
export class RemoteDesktopServiceViewModel {
  readonly state: RemoteDesktopServiceState = new RemoteDesktopServiceState();
  private readonly client: CloudAccountClient = new CloudAccountClient(true);
  private readonly store: CloudAccountSessionStore = new CloudAccountSessionStore(true);
  private initialized?: Promise<void>;
  private profile?: PersistedRemoteDesktopProfile;
  private current?: CloudAccountBinding;
  private generation: number = 0;
  private storageAvailable: boolean = false;
  private writes: Promise<void> = Promise.resolve();
  binding(): CloudAccountBinding | undefined { return this.current; }

  async init(context: Context): Promise<void> {
    if (!this.initialized) this.initialized = this.restore(context);
    return this.initialized;
  }

  private async restore(context: Context): Promise<void> {
    const generation = this.generation;
    try {
      await this.store.init(context);
      const saved = await this.store.loadDesktopProfile();
      if (!saved) { this.storageAvailable = true; return; }
      if (saved.version !== 1 || normalizeRemoteDesktopServiceUrl(saved.serviceUrl) !== saved.serviceUrl
        || typeof saved.deviceId !== 'string' || !/^[a-f0-9]{32}$/.test(saved.deviceId)
        || typeof saved.privateKey !== 'string' || Encoding.base64ToBytes(saved.privateKey).length !== 32
        || typeof saved.token !== 'string' || saved.token.length > 1024
        || typeof saved.requestId !== 'string' || !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(saved.requestId)
        || typeof saved.deviceName !== 'string' || !saved.deviceName.trim() || saved.deviceName.length > 256
        || (saved.connectOnStartup !== undefined && typeof saved.connectOnStartup !== 'boolean')
        || saved.principal !== 'remote-desktop-self-hosted') throw new Error('invalid_service_profile');
      this.profile = saved;
      this.storageAvailable = true;
      this.state.serviceUrl = saved.serviceUrl;
      this.state.deviceId = saved.deviceId;
      if (generation !== this.generation) {
        saved.connectOnStartup = false;
        await this.persist(saved);
      } else if (saved.token && saved.connectOnStartup !== false) this.adopt(saved);
    } catch (_error) { this.state.failed = true; }
  }

  private adopt(profile: PersistedRemoteDesktopProfile): void {
    this.current = { client: this.client, relayUrl: profile.serviceUrl,
      session: { token: profile.token, userId: profile.principal, masterKey: Encoding.base64ToBytes(profile.privateKey) } };
    this.state.connected = true;
    this.state.serviceUrl = profile.serviceUrl;
    this.state.deviceId = profile.deviceId;
  }

  private persist(profile: PersistedRemoteDesktopProfile): Promise<void> {
    // Snapshot now and serialize writes so disconnect cannot be overwritten by
    // a delayed enrollment save. Preserve additive fields from newer installs.
    const saved = JSON.parse(JSON.stringify(profile)) as PersistedRemoteDesktopProfile;
    const writing = this.writes.then((): Promise<void> => this.store.saveDesktopProfile(saved));
    this.writes = writing.catch((): void => {});
    return writing;
  }

  async connect(context: Context, address: string, key: string): Promise<void> {
    const intent = this.generation;
    await this.init(context);
    if (intent !== this.generation) return;
    if (this.state.busy) return;
    if (!this.storageAvailable) { this.state.failed = true; return; }
    const serviceUrl = normalizeRemoteDesktopServiceUrl(address);
    if (!serviceUrl) { this.state.failed = true; return; }
    // Do not overwrite a retained deployment's credentials with another URL.
    if (this.profile && this.profile.serviceUrl !== serviceUrl) { this.state.failed = true; return; }
    const generation = ++this.generation;
    this.state.busy = true; this.state.failed = false;
    this.current?.session.masterKey.fill(0); this.current = undefined;
    this.client.closeAccount(); this.state.connected = false;
    try {
      let profile = this.profile;
      if (!profile) {
        profile = { version: 1, serviceUrl, deviceId: util.generateRandomUUID(false).replace(/-/g, ''),
          deviceName: 'HarmonyOS Phone', requestId: util.generateRandomUUID(false),
          privateKey: Encoding.bytesToBase64(Encoding.randomBytes(32)), token: '', principal: 'remote-desktop-self-hosted',
          connectOnStartup: false };
        this.profile = profile;
        await this.persist(profile);
      }
      if (generation !== this.generation) return;
      if (!profile.token || key.length > 0) {
        const issued = await this.client.pairDesktopService(profile.serviceUrl, key, profile.deviceId,
          profile.deviceName, profile.requestId, Encoding.base64ToBytes(profile.privateKey));
        if (generation !== this.generation) return;
        profile.token = issued.token;
      }
      profile.connectOnStartup = true;
      await this.persist(profile);
      if (generation === this.generation) this.adopt(profile);
    } catch (_error) { if (generation === this.generation) this.state.failed = true; }
    finally { if (generation === this.generation) this.state.busy = false; }
  }

  disconnect(): void {
    ++this.generation; this.current?.session.masterKey.fill(0); this.current = undefined;
    this.client.closeAccount(); this.state.connected = false; this.state.busy = false;
    if (this.profile) {
      const generation = this.generation;
      this.profile.connectOnStartup = false;
      this.persist(this.profile).catch((): void => {
        if (generation === this.generation) this.state.failed = true;
      });
    }
  }

  async listDevices(): Promise<CloudAccountDevice[]> {
    const current = this.current;
    if (!current) throw new Error('remote_desktop_service_not_connected');
    const devices = await this.client.listDevices(current.relayUrl, current.session, this.state.deviceId);
    if (current !== this.current) throw new Error('remote_desktop_connection_changed');
    return devices;
  }
}
