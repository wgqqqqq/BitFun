const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname,'../../entry/src/main/ets/services/RemoteDesktopScreenshotService.ets'),'utf8');
function fixture() {
  const writes=[],removed=[],closed=[]; let saving;
  const platform = { OpenMode:{ CREATE:1, WRITE_ONLY:2 },
    async open() { return {fd:7}; }, async close(file) { closed.push(file.fd); },
    async write(fd,bytes) { writes.push(Buffer.from(bytes)); return bytes.byteLength; },
    async unlink(file) { removed.push(file); } };
  const exports={};
  new Function('require','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(name=>{
    if(name==='@ohos.file.fs')return {default:platform};
    if(name==='./Encoding')return {Encoding:{randomId:()=> 'rd-capture-test',base64ToBytes:s=>Uint8Array.from(Buffer.from(s,'base64'))}};
    if(name==='@ohos.file.fileuri')return {default:{getUriFromPath:p=>'file://'+p}};
    if(name==='@ohos.file.photoAccessHelper')return {default:{
      MediaAssetChangeRequest:{createImageAssetRequest:(_c,p)=>p},
      getPhotoAccessHelper:()=>({applyChanges:async request=>{saving=request;},release:async()=>{}})
    }};
    return {};
  },exports);
  return {Service:exports.RemoteDesktopScreenshotService,writes,removed,closed,get saving(){return saving;}};
}
const png = 'data:image/png;base64,'+Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
test('local screenshot writes PNG without a relay operation and saves only through explicit photo export', async()=>{
  const f=fixture(), context={cacheDir:'/cache'};
  const file=await f.Service.capture(context,async()=>JSON.stringify(png),()=>true);
  assert.equal(file,'/cache/rd-capture-test.png');assert.equal(f.writes.length,1);assert.deepEqual(f.closed,[7]);
  assert.equal(f.saving,undefined);await f.Service.save(context,file);assert.equal(f.saving,'file://'+file);
  await f.Service.discard(file);assert.deepEqual(f.removed,[file]);
});
test('retired capture cannot create a file, and a write retired in flight is discarded', async()=>{
  const f=fixture();await assert.rejects(f.Service.capture({cacheDir:'/cache'},async()=>png,()=>false));
  assert.equal(f.writes.length,0);
  let checks=0;await assert.rejects(f.Service.capture({cacheDir:'/cache'},async()=>png,()=>++checks===1));
  assert.deepEqual(f.removed,['/cache/rd-capture-test.png']);assert.deepEqual(f.closed,[7]);
});
