const fs = require('node:fs');
const path = require('node:path');

function verifyRuntime(entry) {
  const library = path.join(entry, 'libs/arm64-v8a/libopenbitfun_desktop_lib.so');
  if (!fs.existsSync(library)) {
    throw new Error('Current OpenBitFun Desktop OHOS library is missing. Build src/apps/desktop for aarch64-unknown-linux-ohos and stage its runtime before packaging. A framework probe or a legacy desktop library is not a product build.');
  }
  const header = Buffer.alloc(64);
  const fd = fs.openSync(library, 'r');
  let size;
  try { size = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (size < 64 || header.toString('hex', 0, 4) !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(16) !== 3 || header.readUInt16LE(18) !== 183) {
    throw new Error('Desktop library must be an ELF64 little-endian AArch64 shared library.');
  }
  for (const relative of ['frontend/dist/index.html', 'mobile-web/dist/index.html', 'mobile-web/dist/assets', 'resources/ext-host/extension-host.js', 'resources/worker_host.js']) {
    if (!fs.existsSync(path.join(entry, 'src/main/resources/resfile', relative))) {
      throw new Error(`Current Desktop runtime resource is missing: ${relative}`);
    }
  }
}
module.exports = { verifyRuntime };
