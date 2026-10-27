const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/policy/RemoteDesktopTouchPolicy.ets'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports_ = {}; new Function('exports', compiled)(exports_);
const { RemoteDesktopTouchPolicy } = exports_;
const point = (x, y, id = 1) => ({ x, y, id });
function fixture(extra = {}) {
  const input = [], releases = [];
  const touch = new RemoteDesktopTouchPolicy({ input: m => input.push(m), release: () => releases.push(true) });
  const context = { generation: '3', rendererId: 'renderer', width: 400, height: 400, sourceWidth: 400, sourceHeight: 200, direct: false, pan: false, ...extra };
  touch.configure(context); return { touch, input, releases, context };
}
test('letterboxes never create remote coordinates; direct clicks are normalized to video content', () => {
  const f = fixture({direct:true});
  f.touch.begin([point(20,20)],0); f.touch.end(0,30); assert.equal(f.input.length,0);
  f.touch.begin([point(100,150)],1000); f.touch.end(0,1030);
  assert.equal(f.input.length,2); assert.deepEqual(f.input[0],{renderer_id:'renderer',control_generation:'3',kind:'pointer_button',body:{button:'left',down:true,x:.25,y:.25}});
  assert.equal(f.input[1].body.down,false);
});
test('relative movement, double-tap drag and cancel retain paired buttons and captured generation', () => {
  const f = fixture(); f.touch.begin([point(200,200)],0); f.touch.end(0,30);
  f.touch.begin([point(200,200)],100); f.touch.move([point(240,200)]); f.touch.cancel();
  assert.deepEqual(f.input.map(m=>m.kind),['pointer_button','pointer_button','pointer_button','pointer_move','pointer_button']);
  assert.equal(f.input[3].body.x,.6); assert.equal(f.input[4].body.down,false);
  const before=f.input.length;
  f.touch.begin([point(200,200)],1000); f.touch.configure({...f.context,generation:'5'}); f.touch.move([point(240,200)]); f.touch.end(0,1100);
  assert.equal(f.input.length,before); assert.ok(f.releases.length>0);
});
test('long press commits a right click once, while second hold becomes a left drag', () => {
  const f = fixture(); f.touch.begin([point(200,200)],0); f.touch.longPress(); f.touch.end(0,600);
  assert.deepEqual(f.input.map(m=>[m.body.button,m.body.down]),[['right',true],['right',false]]);
  f.touch.begin([point(200,200)],1000); f.touch.end(0,1030);
  f.touch.begin([point(200,200)],1100); f.touch.longPress(); f.touch.move([point(230,200)]); f.touch.end(0,1650);
  assert.equal(f.input.at(-1).body.down,false); assert.equal(f.input.at(-2).kind,'pointer_move');
});
test('two-finger gesture locks scrolling or local pinch before irreversible wheel output', () => {
  const f = fixture(); f.touch.begin([point(100,150),point(300,150,2)],0);
  f.touch.move([point(99,150),point(301,150,2)]); assert.equal(f.input.length,0);
  f.touch.move([point(50,150),point(350,150,2)]); assert.equal(f.touch.scale,1.5); assert.equal(f.input.length,0);
  f.touch.move([point(50,180),point(350,180,2)]); assert.equal(f.input.length,0);
  f.touch.end(0,50);
  const wheel = fixture(); wheel.touch.begin([point(100,150),point(300,150,2)],1000);
  wheel.touch.move([point(100,170),point(300,170,2)]); assert.equal(wheel.input[0].kind,'wheel'); assert.equal(wheel.input[0].body.dy,-40);
  wheel.touch.move([point(50,170),point(350,170,2)]); assert.equal(wheel.touch.scale,1,'A classified wheel cannot become a pinch');
});
test('view-only pinch/panning stays local, and unknown source geometry never emits input', () => {
  const f = fixture({generation:''}); f.touch.begin([point(100,150),point(300,150,2)],0);f.touch.move([point(50,150),point(350,150,2)]);f.touch.end(0,100);
  assert.equal(f.touch.scale,1.5); assert.equal(f.input.length,0);
  f.touch.configure({...f.context,pan:true}); f.touch.begin([point(200,200)],1000); f.touch.move([point(240,200)]); f.touch.end(0,1200);
  assert.equal(f.input.length,0); assert.ok(f.touch.panX>0);
  f.touch.configure({...f.context,generation:'3',sourceWidth:0});f.touch.begin([point(200,200)],2000);f.touch.end(0,2100);assert.equal(f.input.length,0);
  f.touch.configure(f.context); assert.ok(f.touch.cursor().every(Number.isFinite));
});

test('adding a second finger during a held drag releases the button before scrolling', () => {
  const f = fixture();
  f.touch.begin([point(200,200)],0); f.touch.end(0,30);
  f.touch.begin([point(200,200)],100); f.touch.move([point(240,200)]);
  assert.equal(f.input.at(-2).body.down,true);
  f.touch.begin([point(240,200),point(300,200,2)],150);
  assert.equal(f.input.at(-1).kind,'pointer_button');
  assert.equal(f.input.at(-1).body.down,false,'Second finger left the remote button held');
  f.touch.move([point(240,220),point(300,220,2)]);
  assert.equal(f.input.at(-1).kind,'wheel');
  assert.deepEqual(f.input.filter(m=>m.kind==='pointer_button').map(m=>m.body.down),[true,false,true,false]);
  f.touch.end(0,200);
  assert.equal(f.releases.length,0,'Normal finger transition should not revoke the lease');
});

test('cancelled click history cannot turn the next gesture into a held drag', () => {
  const f = fixture();
  f.touch.begin([point(200,200)],0); f.touch.end(0,30);
  f.touch.begin([point(200,200)],100); f.touch.cancel();
  const before=f.input.length;
  f.touch.begin([point(200,200)],150); f.touch.move([point(240,200)]); f.touch.end(0,180);
  assert.deepEqual(f.input.slice(before).map(m=>m.kind),['pointer_move']);
});

test('geometry change drains a held gesture under its original binding before releasing authority', () => {
  const f = fixture();
  f.touch.begin([point(200,200)],0); f.touch.end(0,30);
  f.touch.begin([point(200,200)],100); f.touch.longPress();
  f.touch.configure({...f.context,generation:'5',rendererId:'new',width:800});
  assert.deepEqual(f.input.at(-1),{renderer_id:'renderer',control_generation:'3',kind:'pointer_button',body:{button:'left',down:false,x:.5,y:.5}});
  assert.equal(f.releases.length,1);
  const before=f.input.length;
  f.touch.move([point(240,200)]);f.touch.end(0,700);f.touch.cancel();
  assert.equal(f.input.length,before,'Old fingers were rebound to the new lease');
});


test('zoomed canvas movement stays local and a following tap still controls the computer', () => {
  const f = fixture({ direct: true });
  f.touch.begin([point(100,150),point(300,150,2)],0);
  f.touch.move([point(50,150),point(350,150,2)]); f.touch.end(0,50);
  f.touch.begin([point(100,200),point(300,200,2)],1000);
  f.touch.move([point(140,200),point(340,200,2)]); f.touch.end(0,1100);
  assert.equal(f.touch.scale,1.5); assert.equal(f.touch.panX,40);
  assert.deepEqual(f.input,[]); assert.deepEqual(f.releases,[]);
  f.touch.begin([point(200,200)],2000); f.touch.end(0,2030);
  assert.deepEqual(f.input.map(m=>[m.body.button,m.body.down]),[['left',true],['left',false]]);
  assert.ok(Math.abs(f.input[0].body.x - 13/30) < 0.00001);
});

test('switching to canvas movement drains a held mouse button without surrendering control', () => {
  const f = fixture(); f.touch.scale = 2;
  f.touch.begin([point(200,200)],0); f.touch.end(0,30);
  f.touch.begin([point(200,200)],100); f.touch.longPress();
  f.touch.configure({...f.context,pan:true});
  assert.equal(f.input.at(-1).body.down,false); assert.deepEqual(f.releases,[]);
  const before=f.input.length;
  f.touch.begin([point(200,200)],1000); f.touch.move([point(240,200)]); f.touch.end(0,1100);
  assert.equal(f.touch.panX,40); assert.equal(f.input.length,before);
  f.touch.configure(f.context); f.touch.begin([point(200,200)],2000); f.touch.end(0,2030);
  assert.equal(f.input.length,before+2); assert.deepEqual(f.releases,[]);
});
