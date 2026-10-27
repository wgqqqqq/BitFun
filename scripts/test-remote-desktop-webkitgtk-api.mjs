// Prepare the production opaque receiver for a native Linux API probe.
// No account, network signaling, generated video, capture or OS input.
import { build } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = process.argv[2];
if (process.argv.length !== 3 || !destination) {
  throw new Error('Usage: node scripts/test-remote-desktop-webkitgtk-api.mjs <new-output-directory>');
}
const output = path.resolve(destination);
await mkdir(output, { mode: 0o700 });
const mediaFrame = path.join(root, 'src/web-ui/src/infrastructure/remote-desktop/DesktopMediaFrame.ts');
const apiScript = `(() => {
  let videoCodecs = [], capabilitiesReadable = false;
  try {
    videoCodecs = RTCRtpReceiver.getCapabilities('video').codecs.map(codec => codec.mimeType);
    capabilitiesReadable = true;
  } catch (_) {}
  parent.postMessage({ probeApi: true, secure_context: isSecureContext,
    origin: location.origin, peer_api: typeof RTCPeerConnection,
    frame_callback: typeof HTMLVideoElement.prototype.requestVideoFrameCallback,
    capabilities_readable: capabilitiesReadable, video_codecs: videoCodecs }, '*');
})();`;
const apiDocument = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-api-probe'">
  <script nonce="api-probe">${apiScript}</script>`;
const entry = path.join(output, 'fixture-entry.ts');
await writeFile(entry, `import { DesktopMediaFrame } from ${JSON.stringify(mediaFrame)};
import { RemoteDesktopController } from ${JSON.stringify(path.join(root, 'src/web-ui/src/infrastructure/remote-desktop/RemoteDesktopController.ts'))};
const post = (event: unknown) => (window as any).webkit.messageHandlers.probe.postMessage(JSON.stringify(event));
const frame = document.createElement('iframe');
frame.style.cssText = 'width:800px;height:450px;border:0'; document.body.append(frame);
let media: DesktopMediaFrame, state: any, requestCount = 0, turnCount = 0;
let opening = Promise.resolve(), opened = false, bridgeSeen = false;
const owner = new RemoteDesktopController({
  request: async () => { requestCount++; throw new Error('unexpected_probe_host_request'); },
  turn: async () => { turnCount++; throw new Error('unexpected_probe_turn_request'); },
  renderer: command => media.send(command), update: value => { state = value; },
  onInvalidated: () => () => {}, identifier: () => crypto.randomUUID(),
  now: () => Date.now(), monotonicNow: () => performance.now(), focused: () => false,
});
media = new DesktopMediaFrame(frame, async event => {
  const value = event as Record<string, unknown>;
  if (value?.kind === 'bridge_ready') {
    const openedBeforeReady = opened && !bridgeSeen;
    bridgeSeen = true;
    if (value.receiver_api_available === false) {
      await owner.receive(value); await opening;
      post({ kind: 'controller_preflight', request_count: requestCount, turn_count: turnCount,
        opened_before_ready: openedBeforeReady, stage: state?.stage, error: state?.error });
    } else {
      // This fixture has no host. Positive API presence cancels the pending
      // preparation before readiness can permit discovery.
      owner.close(); await opening;
    }
  }
  post(event);
}, code => post({ kind: 'fixture_failed', code }));
opened = true;
opening = owner.open({ device_id: 'generated-probe-host', device_kind: 'desktop', online: true });
(window as any).probeCommand = (command: any) => media.send(command);
(window as any).probeStop = () => {
  media.send({ kind: 'stop' });
  setTimeout(() => { media.dispose(); post({ kind: 'fixture_stopped' }); }, 100);
};
post({ kind: 'environment', secure_context: isSecureContext, origin: location.origin,
  peer_api: typeof RTCPeerConnection,
  frame_callback: typeof HTMLVideoElement.prototype.requestVideoFrameCallback });
const api = document.createElement('iframe');
api.setAttribute('sandbox', 'allow-scripts'); api.hidden = true;
api.srcdoc = ${JSON.stringify(apiDocument)};
addEventListener('message', event => {
  if (event.source === api.contentWindow && event.data?.probeApi === true)
    post({ kind: 'opaque_api', ...event.data });
});
document.body.append(api);
`);
const bundle = await build({
  configFile: false, root, publicDir: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src/web-ui/src') } },
  build: { write: false, minify: false, lib: { entry, name: 'WebKitGTKProbe', formats: ['iife'] } },
});
const builds = Array.isArray(bundle) ? bundle : [bundle];
if (builds.length !== 1 || !('output' in builds[0])) throw new Error('Unexpected probe bundle');
const chunks = builds[0].output.filter(item => item.type === 'chunk');
if (chunks.length !== 1) throw new Error('Expected one self-contained probe chunk');
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${chunks[0].code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
const htmlPath = path.join(output, 'fixture.html');
await writeFile(htmlPath, html, { mode: 0o600 });
const sources = [mediaFrame, 'src/web-ui/src/infrastructure/remote-desktop/DesktopMediaDocument.ts',
  'src/shared/remote-desktop-media/native-transport.js', 'src/web-ui/src/infrastructure/remote-desktop/RemoteDesktopController.ts',
  'src/web-ui/src/infrastructure/remote-desktop/RemoteDesktopQuality.ts',
  'src/shared/remote-desktop-media/receiver.js', 'src/shared/remote-desktop-media/control.js']
  .map(source => path.resolve(root, source));
const hashes = {};
for (const source of sources) hashes[path.relative(root, source)] = createHash('sha256').update(await readFile(source)).digest('hex');
await writeFile(path.join(output, 'sources.json'), JSON.stringify({ sources: hashes,
  fixture_sha256: createHash('sha256').update(html).digest('hex'), media_verified: false }, null, 2) + '\n');
console.log(JSON.stringify({ html: htmlPath, sources: path.join(output, 'sources.json'), media_verified: false }));
