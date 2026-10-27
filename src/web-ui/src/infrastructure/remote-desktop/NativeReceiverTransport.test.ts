import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ receiver: vi.fn(), channels: [] as Array<{ onmessage?: (event: unknown) => void }> }));
vi.mock('../api/service-api/RemoteDesktopAPI', () => ({ remoteDesktopAPI: mocks }));
vi.mock('@tauri-apps/api/core', () => ({ Channel: class { onmessage?: (event: unknown) => void; constructor() { mocks.channels.push(this); } } }));
import { NativeReceiverTransport } from './NativeReceiverTransport';
beforeEach(() => { vi.resetAllMocks(); mocks.channels.length = 0; mocks.receiver.mockResolvedValue(null); });
it('retires an in-flight native open and discards its late pixel/control callbacks', async () => {
  let resolve!: (value: unknown) => void;
  mocks.receiver.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const event = vi.fn(), transport = new NativeReceiverTransport(event);
  const opening = transport.request('open', { renderer_id: 'pc-a', config: { offer_sdp: 'fixture' } });
  transport.dispose(); mocks.channels[0].onmessage?.(new ArrayBuffer(32)); resolve({ sdp: 'late-answer' }); await opening;
  expect(event).not.toHaveBeenCalled();
  expect(mocks.receiver).toHaveBeenCalledWith({ op: 'close', renderer_id: 'pc-a' });
  await expect(transport.request('send', { renderer_id: 'pc-a', body: '{}' })).rejects.toThrow('renderer_reloaded');
});
it('does not forward unknown peers or operations and keeps independent peer channels scoped', async () => {
  const event = vi.fn(), transport = new NativeReceiverTransport(event);
  await expect(transport.request('send', { renderer_id: 'unknown', body: '{}' })).rejects.toThrow('invalid_request');
  expect(mocks.receiver).not.toHaveBeenCalled();
  await transport.request('open', { renderer_id: 'pc-a', config: {} });
  await expect(transport.request('invoke', { renderer_id: 'pc-a' })).rejects.toThrow('invalid_request');
  mocks.channels[0].onmessage?.({ kind: 'channel', state: 'open' });
  expect(event).toHaveBeenCalledWith('pc-a', { kind: 'channel', state: 'open' });
  transport.dispose();
});
