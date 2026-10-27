const fs = require('node:fs');
const path = require('node:path');
function generate() {
  const source = path.resolve(__dirname, '../../../../../deploy/remote-desktop/probe/receiver.js');
  const destination = path.resolve(__dirname, '../entry/src/main/resources/rawfile/remote-desktop-probe/receiver.js');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
module.exports = { generate };
if (require.main === module) generate();
