import { http } from '@kit.NetworkKit';

/** Isolated developer probe transport; fixed loopback reached via hdc rport. */
export class RemoteDesktopProbeService {
  static onLifecycle?: (visible: boolean) => void;
  private pending: Set<http.HttpRequest> = new Set();
  private closed: boolean = false;
  private accessKey: string;
  constructor(accessKey: string) { this.accessKey = accessKey; }
  async request(path: string, body?: string): Promise<string> {
    if (this.closed) throw new Error('Probe transport closed');
    const request = http.createHttp(); this.pending.add(request);
    try {
      const options: http.HttpRequestOptions = {
        method: body === undefined ? http.RequestMethod.GET : http.RequestMethod.POST,
        header: { 'Authorization': `Bearer ${this.accessKey}`, 'Content-Type': 'application/json' },
        expectDataType: http.HttpDataType.STRING, maxLimit: 128 * 1024,
        connectTimeout: 3000, readTimeout: 3000
      };
      if (body !== undefined) options.extraData = body;
      const reply = await request.request(`http://127.0.0.1:18765/api/${path}`, options);
      if (this.closed) throw new Error('Probe transport closed');
      if (reply.responseCode !== 200 || typeof reply.result !== 'string') throw new Error(`Probe HTTP ${reply.responseCode}`);
      return reply.result;
    } finally { this.pending.delete(request); request.destroy(); }
  }
  close(): void { this.closed = true; this.pending.forEach((request: http.HttpRequest) => request.destroy()); this.pending.clear(); }
}
