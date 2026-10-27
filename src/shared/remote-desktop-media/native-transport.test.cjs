const test = require('node:test'), assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test('native RTC adapter presents actual canvas frames, reports fresh health and retires input on close', { timeout: 30000 }, async () => {
  const { launchBrowser } = await import('../../mobile-web/tests/helpers/browser-account-harness.mjs');
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><canvas></canvas>'); return; }
    if (!['/native-transport.js','/receiver.js','/control.js'].includes(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type','text/javascript'); response.end(await readFile(path.join(__dirname,request.url.slice(1))));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); let browser;
  try {
    browser = await launchBrowser(); const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({ url: '/native-transport.js' });
    await page.evaluate(() => {
      window.events = []; window.calls = []; window.decoded = 1;
      window.OpenBitFunDesktopHost = { postMessage: raw => window.events.push(JSON.parse(raw)) };
      window.adapter = window.OpenBitFunNativeTransport.install(window,document.querySelector('canvas'),async (op,body) => {
        window.calls.push({op,...body});
        if (op === 'open') { window.nativePeer = body.renderer_id; return {sdp:'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=candidate:fixture\r\n'}; }
        if (op === 'stats') return [{id:'video',type:'inbound-rtp',kind:'video',framesDecoded:window.decoded}];
        return null;
      });
      window.nativeFrame = (sequence,rotation=0) => {
        const packet = new ArrayBuffer(32+64*32*4), header = new DataView(packet), pixels = new Uint8Array(packet,32);
        header.setUint32(0,0x52444631,false); header.setBigUint64(4,BigInt(sequence),true);
        header.setUint32(12,64,true); header.setUint32(16,32,true); header.setUint32(20,rotation,true);
        header.setBigInt64(24,BigInt(sequence*1000000),true);
        for (let i=0;i<pixels.length;i+=4) { pixels[i]=255; pixels[i+3]=255; }
        window.adapter.frame(window.nativePeer,packet);
      };
    });
    await page.addScriptTag({ url: '/control.js' }); await page.addScriptTag({ url: '/receiver.js' });
    await page.evaluate(async () => {
      await window.OpenBitFunDesktopReceiver.accept({kind:'start',renderer_id:'canvas',attach_id:'attach',connection_id:'pc',offer_sdp:'offer',ice_servers:[],force_relay:false,control_supported:true,native_focus:true,control_epoch:'1'});
      window.adapter.receive(window.nativePeer,{kind:'connection',state:'connected'});
      window.adapter.receive(window.nativePeer,{kind:'track'}); window.adapter.receive(window.nativePeer,{kind:'channel',state:'open'});
      window.nativeFrame(1);
      await window.OpenBitFunDesktopReceiver.accept({kind:'source_ready',renderer_id:'canvas',attach_id:'attach',connection_id:'pc'});
    });
    await page.waitForFunction(() => window.events.some(e=>e.kind==='first_frame_presented') && window.calls.some(c=>c.op==='frame_ack'));
    assert.deepEqual(await page.evaluate(()=>Array.from(document.querySelector('canvas').getContext('2d').getImageData(1,1,1,1).data)),[255,0,0,255]);
    await page.evaluate(()=>window.adapter.receive(window.nativePeer,{kind:'message',data:JSON.stringify({version:1,kind:'health_probe',echo:'1'})}));
    await page.waitForFunction(()=>window.calls.some(c=>c.op==='send'&&JSON.parse(c.body).kind==='health_reply'));
    const health = await page.evaluate(()=>window.calls.filter(c=>c.op==='send').map(c=>JSON.parse(c.body)).find(c=>c.kind==='health_reply'));
    assert.equal(health.first_frame,true); assert.equal(health.receiving,true); assert.equal(health.decoded,'1'); assert.equal(health.presented,'1');
    await page.evaluate(async()=>{
      await window.OpenBitFunDesktopReceiver.accept({kind:'control',renderer_id:'canvas',attach_id:'attach',connection_id:'pc',control_epoch:'1',body:{kind:'acquire_control',expected_state_revision:'boot:0'}});
    });
    await page.waitForFunction(()=>window.calls.some(c=>c.op==='send'&&JSON.parse(c.body).kind==='acquire_control'));
    await page.evaluate(()=>{
      const request=window.calls.filter(c=>c.op==='send').map(c=>JSON.parse(c.body)).find(c=>c.kind==='acquire_control');
      window.adapter.receive(window.nativePeer,{kind:'message',data:JSON.stringify({version:1,kind:'control_result',request_id:request.request_id,code:'ok',control_generation:'1'})});
    });
    await page.evaluate(async()=>{
      await window.OpenBitFunDesktopReceiver.accept({kind:'control',renderer_id:'retired',attach_id:'attach',connection_id:'pc',control_epoch:'1',body:{kind:'key',control_generation:'1',body:{usage:4,down:true}}});
    });
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.op==='send'&&JSON.parse(c.body).kind==='key').length),0);
    await page.evaluate(async()=>{
      await window.OpenBitFunDesktopReceiver.accept({kind:'control',renderer_id:'canvas',attach_id:'attach',connection_id:'pc',control_epoch:'1',body:{kind:'key',control_generation:'1',body:{usage:4,down:true}}});
    });
    await page.waitForFunction(()=>window.calls.some(c=>c.op==='send'&&JSON.parse(c.body).kind==='key'));
    // Hold presentation callbacks while decoding counters advance. No fresh
    // presentation ACK or positive progress witness may be fabricated.
    await page.evaluate(()=>{window.savedRaf=window.requestAnimationFrame;window.requestAnimationFrame=()=>123456;window.decoded=2;window.nativeFrame(2);});
    await page.evaluate(()=>window.adapter.receive(window.nativePeer,{kind:'message',data:JSON.stringify({version:1,kind:'health_probe',echo:'2'})}));
    await page.waitForFunction(()=>window.calls.some(c=>c.op==='send'&&JSON.parse(c.body).echo==='2'));
    const frozen=await page.evaluate(()=>window.calls.filter(c=>c.op==='send').map(c=>JSON.parse(c.body)).find(c=>c.echo==='2'));
    assert.equal(frozen.decoded,'2'); assert.equal(frozen.presented,'1');
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.op==='frame_ack'&&c.sequence==='2')),false);
    await page.evaluate(async()=>{window.requestAnimationFrame=window.savedRaf;await window.OpenBitFunDesktopReceiver.accept({kind:'stop'});window.nativeFrame(3);});
    assert.equal(await page.evaluate(()=>document.querySelector('canvas').width),0);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.op==='close').length),1);
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
});

test('production native receiver runs inside its opaque nonce-CSP iframe', { timeout: 30000 }, async () => {
  const { build } = await import('vite');
  const { launchBrowser } = await import('../../mobile-web/tests/helpers/browser-account-harness.mjs');
  const token = 'b'.repeat(32), entry = 'virtual:native-receiver-document';
  const source = path.resolve(__dirname, '../../web-ui/src/infrastructure/remote-desktop/DesktopMediaDocument.ts');
  const result = await build({ configFile:false,publicDir:false,logLevel:'error',
    plugins:[{ name:'native-document-fixture', resolveId:id=>id===entry?'\0'+entry:null,
      load:id=>id==='\0'+entry?`import { desktopMediaDocument } from ${JSON.stringify(source)}; window.nativeDocument=desktopMediaDocument('${token}',true);`:null }],
    build:{write:false,minify:false,rollupOptions:{input:entry,output:{format:'iife',name:'NativeDocumentFixture'}}} });
  const chunk = result.output.filter(item=>item.type==='chunk'); assert.equal(chunk.length,1);
  const html = '<!doctype html><body><script>'+chunk[0].code.replace(/<\/script/gi,'<\\/script')+'</script>';
  const server=createServer((_,response)=>{response.setHeader('content-type','text/html');response.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); let browser;
  try {
    browser=await launchBrowser(); const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(token=>{
      window.events=[];window.calls=[];window.nativePeer=null;
      const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');
      window.nativeFrameElement=frame;
      window.postNative=body=>frame.contentWindow.postMessage({token,...body},'*');
      addEventListener('message',event=>{
        if(event.source!==frame.contentWindow||event.data?.token!==token)return;
        if(event.data.event)window.events.push(event.data.event);
        const request=event.data.nativeRequest;if(!request)return;
        window.calls.push(request);
        if(request.op==='open')window.nativePeer=request.body.renderer_id;
        window.postNative({nativeReply:{id:request.id,ok:true,result:request.op==='open'?{sdp:'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=candidate:fixture\r\n'}:request.op==='stats'?[{id:'video',type:'inbound-rtp',kind:'video',framesDecoded:1}]:null}});
      });
      frame.srcdoc=window.nativeDocument;document.body.append(frame);
    },token);
    await page.waitForFunction(()=>window.events.some(event=>event.kind==='bridge_ready'));
    assert.equal(await page.evaluate(()=>window.events.find(e=>e.kind==='bridge_ready').receiver_api_available),true);
    assert.equal(await page.evaluate(()=>{try{return window.nativeFrameElement.contentWindow.document===null;}catch(_){return true;}}),true);
    await page.evaluate(()=>window.postNative({command:{kind:'start',renderer_id:'opaque',attach_id:'attach',connection_id:'pc',offer_sdp:'offer',ice_servers:[],force_relay:false}}));
    await page.waitForFunction(()=>window.events.some(event=>event.kind==='answer'));
    await page.evaluate(()=>{
      for(const event of [{kind:'connection',state:'connected'},{kind:'track'},{kind:'channel',state:'open'}])window.postNative({nativePeer:window.nativePeer,nativeEvent:event});
      const packet=new ArrayBuffer(32+4*8*4),header=new DataView(packet),pixels=new Uint8Array(packet,32);
      header.setUint32(0,0x52444631,false);header.setBigUint64(4,1n,true);header.setUint32(12,4,true);header.setUint32(16,8,true);header.setUint32(20,90,true);header.setBigInt64(24,1000000n,true);
      for(let i=0;i<pixels.length;i+=4){pixels[i+1]=255;pixels[i+3]=255;}
      window.postNative({nativePeer:window.nativePeer,nativeFrame:packet});
      window.postNative({command:{kind:'source_ready',renderer_id:'opaque',attach_id:'attach',connection_id:'pc'}});
    });
    await page.waitForFunction(()=>window.events.some(event=>event.kind==='first_frame_presented')&&window.calls.some(call=>call.op==='frame_ack'));
    const child=page.frames().find(frame=>frame!==page.mainFrame()); assert.ok(child);
    assert.deepEqual(await child.evaluate(()=>Array.from(document.querySelector('canvas').getContext('2d').getImageData(1,1,1,1).data)),[0,255,0,255]);
    assert.deepEqual(await child.evaluate(()=>[document.querySelector('canvas').width,document.querySelector('canvas').height]),[8,4]);
    assert.equal(await child.evaluate(()=>typeof window.__TAURI_INTERNALS__),'undefined');
    await page.evaluate(()=>window.postNative({command:{kind:'stop'}}));
    await page.waitForFunction(()=>window.calls.some(call=>call.op==='close'));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
