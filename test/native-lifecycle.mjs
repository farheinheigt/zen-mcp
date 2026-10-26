import assert from 'node:assert/strict';
import {MarionetteClient} from '../src/marionette.mjs';
import {NativeTools} from '../src/native-tools.mjs';
import {writeFile,readFile} from 'node:fs/promises';
const profile=process.env.ZEN_TEST_PROFILE || process.cwd()+'/.test-runtime/profile';
const native=new NativeTools({ZEN_NATIVE_PORT:'2839',ZEN_NATIVE_PROFILE:profile});
const command=process.argv[2];
const raw=async script=>{const c=new MarionetteClient({port:2839,profile});try{await c.connect();return (await c.send('WebDriver:ExecuteAsyncScript',{script,args:[],newSandbox:false,scriptTimeout:10000})).value;}finally{await c.disconnect();}};
const normalized=s=>({spaces:s.spaces.map(({active,...s})=>s),tabs:s.tabs.map(({title,...t})=>t).sort((a,b)=>a.id.localeCompare(b.id)),folders:s.folders.sort((a,b)=>a.id.localeCompare(b.id)),splits:s.splits.sort((a,b)=>a.id.localeCompare(b.id))});
try{
 if(command==='before') {
  const snapshot=await native.call('zen_native_snapshot',{});await writeFile('.test-runtime/persistence-before.json',JSON.stringify(normalized(snapshot)));console.log('Persistence baseline saved');
 } else if(command==='after') {
  const snapshot=await native.call('zen_native_snapshot',{});assert.deepEqual(normalized(snapshot),JSON.parse(await readFile('.test-runtime/persistence-before.json','utf8')));console.log(JSON.stringify({persistenceVerified:true,tabs:snapshot.tabs.length,folders:snapshot.folders.length,splits:snapshot.splits.length}));
 } else if(command==='windows') {
  await native.disconnect();
  await raw('const done=arguments[arguments.length-1]; const opened=OpenBrowserWindow(); opened.addEventListener("load",()=>setTimeout(()=>done(true),1500),{once:true});');
  const spaces=await native.call('zen_spaces_list',{});
  await assert.rejects(()=>native.call('zen_space_merge',{sourceId:spaces[0].id,targetId:spaces[1].id}),/exactly one browser window/);
  await assert.rejects(()=>native.call('zen_space_delete',{spaceId:spaces[0].id}),/exactly one browser window/);
  await native.disconnect();
  await raw('const done=arguments[arguments.length-1];const windows=Array.from(Services.wm.getEnumerator("navigator:browser"));if(windows.length!==2)throw Error("Expected 2 test windows");windows.at(-1).close();setTimeout(()=>done(true),500);').catch(error=>{if(!/Document was unloaded/.test(error.message))throw error;});
  assert.equal((await native.call('zen_native_snapshot',{})).windowCount,1);
  console.log('Multiple-window merge/delete refusals verified');
 } else throw Error('Unknown lifecycle test');
}finally{await native.disconnect();}
