const fs = require('node:fs');
const path = require('node:path');
function generate() {
  const source = path.resolve(__dirname, '../../../../shared/remote-desktop-media');
  const destination = path.resolve(__dirname, '../entry/src/main/resources/rawfile/remote-desktop');
  fs.mkdirSync(destination, { recursive: true });
  for (const file of ['index.html', 'control.js', 'receiver.js']) fs.copyFileSync(path.join(source, file), path.join(destination, file));
}
module.exports = { generate };
if (require.main === module) generate();
