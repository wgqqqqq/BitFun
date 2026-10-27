/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { DesktopMediaFrame, desktopMediaDocument } from './DesktopMediaFrame';
import * as runtime from '../runtime';
import { remoteDesktopAPI } from '../api/service-api/RemoteDesktopAPI';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('reports actual API availability from the opaque document without changing other receiver events', () => {
  const html = new DOMParser().parseFromString(desktopMediaDocument('a'.repeat(32)), 'text/html');
  const script = html.querySelector('script')!.textContent!;
  for (const [peer, frameCallback, available] of [[class {}, () => {}, true], [undefined, () => {}, false],
    [class {}, undefined, false], [{}, () => {}, false]] as const) {
    const post = vi.fn();
    const local: { RTCPeerConnection: unknown; OpenBitFunDesktopHost?: { postMessage(raw: string): void } } = { RTCPeerConnection: peer };
    runInNewContext(script, { window: local, parent: { postMessage: post }, addEventListener: vi.fn(),
      document: { querySelector: () => ({ requestVideoFrameCallback: frameCallback }) } }, { timeout: 1000 });
    local.OpenBitFunDesktopHost!.postMessage(JSON.stringify({ kind: 'bridge_ready', capabilities: ['control_epoch_v1'], receiver_api_available: true }));
    expect(post.mock.calls[0][0]).toEqual({ token: 'a'.repeat(32), event: {
      kind: 'bridge_ready', capabilities: ['control_epoch_v1'], receiver_api_available: available,
    } });
    local.OpenBitFunDesktopHost!.postMessage(JSON.stringify({ kind: 'bound', renderer_id: 'r' }));
    expect(post.mock.calls[1][0]).toEqual({ token: 'a'.repeat(32), event: { kind: 'bound', renderer_id: 'r' } });
  }
});

it('bundles only the fixed receiver behind a nonce CSP and an opaque sandbox', () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const media = new DesktopMediaFrame(frame, vi.fn(), vi.fn());
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame.srcdoc).toContain("default-src 'none'");
  expect(frame.srcdoc).toContain("connect-src 'none'");
  expect(frame.srcdoc).not.toContain('script src=');
  expect(frame.srcdoc).not.toContain('__TAURI');
  expect(frame.srcdoc).not.toContain('account_token');
  expect(() => desktopMediaDocument('</script>')).toThrow('invalid_renderer_token');
  media.dispose();
});
it('ignores a sibling frame or old bridge token and stops accepting events after disposal', () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const receive = vi.fn(), failed = vi.fn(); const media = new DesktopMediaFrame(frame, receive, failed);
  const token = /nonce-([a-f0-9]{32})/.exec(frame.srcdoc)![1];
  const send = (source: MessageEventSource | null, value: string) => window.dispatchEvent(new MessageEvent('message', {
    source, data: { token: value, event: { kind: 'bridge_ready' } },
  }));
  send(window, token); send(frame.contentWindow, '0'.repeat(32)); expect(receive).not.toHaveBeenCalled();
  const peer = frame.contentWindow; send(peer, token); expect(receive).toHaveBeenCalledTimes(1);
  media.dispose(); send(peer, token); expect(receive).toHaveBeenCalledTimes(1); expect(frame.srcdoc).toBe('');
  expect(failed).not.toHaveBeenCalled();
});
it('closes the old document on unexpected navigation and oversized bridge messages', () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const failed = vi.fn(); const media = new DesktopMediaFrame(frame, vi.fn(), failed);
  frame.dispatchEvent(new Event('load')); frame.dispatchEvent(new Event('load'));
  expect(failed).toHaveBeenCalledWith('renderer_reloaded'); expect(frame.srcdoc).toBe(''); media.dispose();
  const next = new DesktopMediaFrame(frame, vi.fn(), failed);
  const token = /nonce-([a-f0-9]{32})/.exec(frame.srcdoc)![1];
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { token, event: { kind: 'answer', answer_sdp: 'x'.repeat(100000) } } }));
  expect(failed).toHaveBeenCalledTimes(2); expect(failed).toHaveBeenLastCalledWith('invalid_response'); expect(frame.srcdoc).toBe(''); next.dispose();
});

it('serializes renderer commands, merges only adjacent moves, and clears old input before release', () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const media = new DesktopMediaFrame(frame, vi.fn(), vi.fn());
  const token = /nonce-([a-f0-9]{32})/.exec(frame.srcdoc)![1];
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  const message = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { token, ...data } }));
  message({ event: { kind: 'bridge_ready' } });
  const binding = { renderer_id: 'r', attach_id: 'a', connection_id: 'pc' };
  const move = (x: number) => media.send({ kind: 'control', ...binding, body: { kind: 'pointer_move', control_generation: '6', body: { x, y: 0.5 } } });
  move(0.1); move(0.2); move(0.3);
  expect(post).toHaveBeenCalledTimes(1);
  const first = post.mock.calls[0][0] as { seq: number }; message({ ack: first.seq - 1, ok: true });
  expect(post).toHaveBeenCalledTimes(1); message({ ack: first.seq, ok: true });
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[1][0]).toMatchObject({ command: { body: { body: { x: 0.3 } } } });
  move(0.4);
  media.send({ kind: 'focus_reply', ...binding, echo: '1', focused: false });
  expect(post.mock.calls.at(-1)![0]).toMatchObject({ command: { kind: 'focus_reply', focused: false } });
  media.send({ kind: 'control', ...binding, body: { kind: 'release_control' } });
  const count = post.mock.calls.length;
  message({ ack: (post.mock.calls[1][0] as { seq: number }).seq, ok: true });
  expect(post).toHaveBeenCalledTimes(count);
  media.dispose();
});

it('bounds a stalled iframe bridge and destroys it instead of dropping keyboard edges', () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const failed = vi.fn(); const media = new DesktopMediaFrame(frame, vi.fn(), failed);
  const token = /nonce-([a-f0-9]{32})/.exec(frame.srcdoc)![1];
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { token, event: { kind: 'bridge_ready' } } }));
  for (let i = 0; i < 66; i++) media.send({ kind: 'control', renderer_id: 'r', attach_id: 'a', connection_id: 'pc',
    body: { kind: 'key', control_generation: '6', body: { usage: 80, down: i % 2 === 0 } } });
  expect(failed).toHaveBeenCalledWith('input_backpressure'); expect(frame.srcdoc).toBe(''); media.dispose();
});

it('preserves local control stamps rather than merging moves across different intents', () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const media = new DesktopMediaFrame(frame, vi.fn(), vi.fn());
  const token = /nonce-([a-f0-9]{32})/.exec(frame.srcdoc)![1];
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  const message = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { token, ...data } }));
  message({ event: { kind: 'bridge_ready', capabilities: ['control_epoch_v1'] } });
  const move = (epoch: string, x: number) => media.send({ kind: 'control', renderer_id: 'r', attach_id: 'a', connection_id: 'pc',
    control_epoch: epoch, body: { kind: 'pointer_move', control_generation: '6', body: { x, y: 0.5 } } });
  move('1', 0.1); move('1', 0.2); move('3', 0.3);
  message({ ack: (post.mock.calls[0][0] as { seq: number }).seq, ok: true });
  expect(post.mock.calls[1][0]).toMatchObject({ command: { control_epoch: '1', body: { body: { x: 0.2 } } } });
  message({ ack: (post.mock.calls[1][0] as { seq: number }).seq, ok: true });
  expect(post.mock.calls[2][0]).toMatchObject({ command: { control_epoch: '3', body: { body: { x: 0.3 } } } });
  media.dispose();
});

it('awaits native backend selection before treating document loads as renderer reloads', async () => {
  vi.spyOn(runtime, 'isTauriRuntime').mockReturnValue(true);
  vi.stubGlobal('RTCPeerConnection', undefined);
  let resolve!: (value: { backend: string }) => void;
  vi.spyOn(remoteDesktopAPI, 'receiver').mockReturnValue(new Promise(done => { resolve = done; }));
  const frame = document.createElement('iframe'); document.body.append(frame);
  const receive = vi.fn(), failed = vi.fn();
  const media = new DesktopMediaFrame(frame, receive, failed);
  frame.dispatchEvent(new Event('load')); // Initial about:blank while IPC is pending.
  expect(failed).not.toHaveBeenCalled(); expect(frame.srcdoc).toBe('');
  resolve({ backend: 'native' }); await Promise.resolve(); await Promise.resolve();
  expect(frame.srcdoc).toContain('<canvas>'); expect(frame.srcdoc).not.toContain('__TAURI');
  frame.dispatchEvent(new Event('load'));
  expect(failed).not.toHaveBeenCalled();
  const token = /nonce-([a-f0-9]{32})/.exec(frame.srcdoc)![1];
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
    data: { token, event: { kind: 'bridge_ready', receiver_api_available: true } } }));
  expect(receive).toHaveBeenCalledWith({ kind: 'bridge_ready', receiver_api_available: true });
  media.dispose();
});
it('never installs a native iframe after disposal during pending backend selection', async () => {
  vi.spyOn(runtime, 'isTauriRuntime').mockReturnValue(true);
  vi.stubGlobal('RTCPeerConnection', undefined);
  let resolve!: (value: { backend: string }) => void;
  vi.spyOn(remoteDesktopAPI, 'receiver').mockReturnValue(new Promise(done => { resolve = done; }));
  const frame = document.createElement('iframe'); document.body.append(frame);
  const failed = vi.fn(); const media = new DesktopMediaFrame(frame, vi.fn(), failed);
  media.dispose(); resolve({ backend: 'native' }); await Promise.resolve(); await Promise.resolve();
  expect(frame.srcdoc).toBe(''); expect(failed).not.toHaveBeenCalled();
});
