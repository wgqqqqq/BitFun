const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const main = path.join(__dirname, '../../entry/src/main');

// RemoteI18n.t reads native resources at runtime, not the ETS message arrays.
// A catalog-only edit must not ship a dotted key as user-visible text.
for (const [locale, catalog, exported] of [
  ['en_US', 'EnUsMessages', 'EN_US_MESSAGES'],
  ['zh_CN', 'ZhCnMessages', 'ZH_CN_MESSAGES'],
  ['base', 'EnUsMessages', 'EN_US_MESSAGES'],
]) {
  test(`remote desktop ${locale} labels exist in the resources consumed by the native app`, () => {
    const code = ts.transpileModule(fs.readFileSync(path.join(main, `ets/i18n/${catalog}.ets`), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    const exports = {}; new Function('exports', code)(exports);
    const resources = JSON.parse(fs.readFileSync(path.join(main, `resources/${locale}/element/string.json`), 'utf8')).string;
    const values = new Map(resources.map(value => [value.name, value.value]));
    const labels = exports[exported].filter(([key]) => key.startsWith('remoteDesktop.'));
    assert.ok(labels.length > 0);
    for (const [key, value] of labels) assert.equal(values.get(key.replaceAll('.', '_')), value, key);
  });
}
