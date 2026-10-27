import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.platform !== 'darwin') throw new Error('Native display probe requires macOS');
const root = fileURLToPath(new URL('./', import.meta.url));
const app = path.join(root, 'target/native/OpenBitFun Native Display Probe.app');
const mac = path.join(app, 'Contents/MacOS');
const library = path.join(mac, 'libopenbitfun_native_media_probe.dylib');
const pin = JSON.parse(await readFile(path.join(root, 'artifact-pin.json'), 'utf8'));
const artifact = pin.artifacts[`mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}-release`];
if (!artifact) throw new Error('No reviewed prebuilt artifact pin for this architecture');
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
await run('cargo', ['build', '--locked']);
const buildRoot = path.join(root, 'target/debug/build');
let verified = false;
for (const entry of await readdir(buildRoot)) {
  if (!entry.startsWith('webrtc-sys-')) continue;
  let output;
  try { output = await readFile(path.join(buildRoot, entry, 'output'), 'utf8'); } catch { continue; }
  const match = output.match(/cargo:rustc-link-search=native=(.*livekit.*?\/lib)\r?\n/);
  if (!match) continue;
  if (!match[1].includes(pin.tag)) throw new Error('Unexpected libwebrtc artifact tag');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(match[1], artifact.library))) hash.update(chunk);
  if (hash.digest('hex') !== artifact.sha256) throw new Error('libwebrtc artifact hash mismatch');
  verified = true;
}
if (!verified) throw new Error('Cannot locate linked libwebrtc artifact for verification');
await mkdir(mac, { recursive: true });
await copyFile(path.join(root, 'target/debug/libopenbitfun_native_media_probe.dylib'), library);
await run('install_name_tool', ['-id', '@rpath/' + path.basename(library), library]);
await run('codesign', ['--force', '--sign', '-', library]);
await run('xcrun', ['swiftc', '-swift-version', '5', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, 'DisplayCapture.swift', '-L', mac,
  '-lopenbitfun_native_media_probe', '-Xlinker', '-rpath', '-Xlinker', '@executable_path',
  '-o', path.join(mac, 'native-display-probe')]);
await copyFile(path.join(root, 'Info.plist'), path.join(app, 'Contents/Info.plist'));
await run('codesign', ['--force', '--sign', '-', app]);
await run(path.join(mac, 'native-display-probe'), ['--list-displays']);
process.stdout.write('Native display probe bundle built under target/native.\n');
