import test from 'node:test';
import assert from 'node:assert/strict';
import { MarionetteClient } from '../src/marionette.mjs';
import { validateNativeArgs, NativeTools, NATIVE_TOOLS } from '../src/native-tools.mjs';

test('native input schemas reject unsafe shapes before connection', async () => {
 for (const args of [null, [], 'x', {spaceIds:['x','x']}, {spaceIds:[]}, {spaceIds:['x'],unexpected:true}]) assert.throws(()=>validateNativeArgs('zen_spaces_reorder',args));
 assert.throws(()=>validateNativeArgs('zen_split_create',{tabIds:['a','b','c','d','e']}));
 assert.throws(()=>validateNativeArgs('zen_tab_pin',{tabId:'a',pinned:'false'}));
 assert.throws(()=>validateNativeArgs('zen_split_layout',{splitId:'a',layout:'bad'}));
 assert.throws(()=>new NativeTools({ZEN_NATIVE_PORT:'2839'}));
 await assert.rejects(()=>new NativeTools({}).call('zen_spaces_list',{}),/disabled/);
 assert.equal(new Set(NATIVE_TOOLS.map(t=>t.name)).size,NATIVE_TOOLS.length);
});
test('UTF-8 frames can arrive split or concatenated', async () => {
 const client=new MarionetteClient({port:1234,profile:'/tmp'});client.buffer=Buffer.alloc(0);client.socket={destroy(){}};
 const result=new Promise((resolve,reject)=>client.pending.set(7,{resolve,reject,timer:null}));
 const bytes=Buffer.from(JSON.stringify([1,7,null,{value:'🧪 français'}]));const frame=Buffer.concat([Buffer.from(`${bytes.length}:`),bytes]);
 for(const byte of frame)client.receive(Buffer.from([byte]));
 assert.deepEqual(await result,{value:'🧪 français'});assert.equal(client.pending.size,0);
});
test('invalid framing rejects pending work and closes transport', async () => {
 const client=new MarionetteClient({port:1234,profile:'/tmp'});client.buffer=Buffer.alloc(0);let closed=false;client.socket={destroy(){closed=true;}};
 const result=new Promise((resolve,reject)=>client.pending.set(7,{resolve,reject,timer:null}));client.receive(Buffer.from('bad:123'));
 await assert.rejects(()=>result,/Invalid native frame length/);assert(closed);
});
test('native calls are serialized even after an operation fails', async () => {
 const client=new MarionetteClient({port:1234,profile:'/tmp'});client.connect=async()=>{};const order=[];
 const a=client.run(async()=>{order.push('start');await new Promise(r=>setTimeout(r,10));order.push('fail');throw Error('expected');});
 const b=client.run(async()=>{order.push('next');return 42;});await assert.rejects(()=>a,/expected/);assert.equal(await b,42);assert.deepEqual(order,['start','fail','next']);
});
