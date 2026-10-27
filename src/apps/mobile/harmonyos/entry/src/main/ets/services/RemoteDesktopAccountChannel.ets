import { AccountRealtime } from './AccountRealtime';
import { Encoding } from './Encoding';
import { RemoteLogger } from './RemoteLogger';
import { HarmonyRemoteCryptoCipher } from './RemoteCrypto';
import { EncryptedPayload } from '../model/RemoteModels';
import { RemoteDesktopReply, RemoteDesktopRequest, RemoteDesktopTurn } from '../model/RemoteDesktopModels';

export interface RemoteDesktopChannelOptions {
  socket: AccountRealtime; target: string; key: Uint8Array; capabilities: string[];
  current: () => boolean; turn: (attachment: string) => Promise<RemoteDesktopTurn>;
}

/** Fixed peer key for one controller attachment. Closing never closes chat's socket. */
export class RemoteDesktopAccountChannel {
  private readonly options: RemoteDesktopChannelOptions;
  private readonly cipher: HarmonyRemoteCryptoCipher = new HarmonyRemoteCryptoCipher();
  private closed: boolean = false;
  constructor(options: RemoteDesktopChannelOptions) { this.options = options; }
  current(): boolean { return !this.closed && this.options.current(); }
  async call(request: RemoteDesktopRequest, attachment: string = ''): Promise<RemoteDesktopReply> {
    if (!this.current()) throw new Error('account_changed');
    const text = JSON.stringify(request);
    if (Encoding.utf8ToBytes(text).length > 96 * 1024 - 64) throw new Error('invalid_request');
    const nonce = Encoding.randomBytes(12);
    let encrypted: Uint8Array;
    try { encrypted = await this.cipher.encrypt(Encoding.utf8ToBytes(text), this.options.key, nonce); }
    catch (_error) { throw new Error('signal_encryption_failed'); }
    if (!this.current()) throw new Error('account_changed');
    const payload: EncryptedPayload = { encrypted_data: Encoding.bytesToBase64(encrypted), nonce: Encoding.bytesToBase64(nonce) };
    let response: EncryptedPayload;
    try { response = await this.options.socket.callRemoteDesktop(this.options.target, payload, 10000, this.options.capabilities, attachment); }
    catch (error) {
      if (this.current() && error instanceof Error && error.message === 'target_unavailable') {
        RemoteLogger.warn('remote desktop target unavailable origin=relay_response');
      }
      throw error as Error;
    }
    if (!this.current()) throw new Error('account_changed');
    let plain: Uint8Array;
    try { plain = await this.cipher.decrypt(Encoding.base64ToBytes(response.encrypted_data), this.options.key, Encoding.base64ToBytes(response.nonce)); }
    catch (_error) { throw new Error('signal_decryption_failed'); }
    if (!this.current()) throw new Error('account_changed');
    if (plain.length > 96 * 1024) throw new Error('invalid_response');
    const reply = Encoding.parseJsonObject<RemoteDesktopReply>(Encoding.bytesToUtf8(plain));
    if (reply.error) {
      if (reply.error.code === 'target_unavailable') RemoteLogger.warn('remote desktop target unavailable origin=host_response');
      throw new Error(reply.error.code || 'invalid_response');
    }
    return reply;
  }
  async turn(attachment: string): Promise<RemoteDesktopTurn> {
    if (!this.current()) throw new Error('account_changed');
    const result = await this.options.turn(attachment);
    if (!this.current()) throw new Error('account_changed');
    return result;
  }
  close(): void { this.closed = true; this.options.key.fill(0); }
}
