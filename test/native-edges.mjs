import assert from 'node:assert/strict';
import { NativeTools } from '../src/native-tools.mjs';
const n=new NativeTools({ZEN_NATIVE_PORT:'2839',ZEN_NATIVE_PROFILE:process.env.ZEN_TEST_PROFILE || process.cwd()+'/.test-runtime/profile'});
let count=0;
const call=async(name,args={})=>{let r=await n.call(name,args);count++;return r;};
try{
 const wrong=new NativeTools({ZEN_NATIVE_PORT:'2839',ZEN_NATIVE_PROFILE:process.cwd()});
 await assert.rejects(()=>wrong.call('zen_spaces_list',{}),/profile mismatch/);await wrong.disconnect();count++;
 await assert.rejects(()=>new NativeTools({}).call('zen_spaces_list',{}),/disabled/);count++;
 const space=await call('zen_space_create',{name:'Edges '+Date.now()});
 const tabs=[];for(let i=0;i<4;i++)tabs.push(await call('zen_tab_create',{spaceId:space.id,url:'about:blank',pinned:true}));
 const folder=await call('zen_folder_create',{spaceId:space.id,name:'Pinned folder'});await call('zen_tab_move',{tabId:tabs[0].id,folderId:folder.id});
 await assert.rejects(()=>call('zen_tab_pin',{tabId:tabs[0].id,pinned:false}),/Move out/);count++;
 await call('zen_tab_move',{tabId:tabs[0].id,spaceId:space.id});
 for(const size of [3,4]) {
  const s=await call('zen_split_create',{tabIds:tabs.slice(0,size).map(t=>t.id),layout:'grid'});assert.equal(s.tabIds.length,size);
  const changed=await call('zen_split_layout',{splitId:s.id,layout:'hsep'});assert.equal(changed.layout,'hsep');assert.equal(changed.tabIds.length,size);
  await call('zen_split_separate',{splitId:s.id});
 }
 const empty=await call('zen_folder_create',{spaceId:space.id,name:'Empty'});await call('zen_folder_remove',{folderId:empty.id});
 await call('zen_folder_remove',{folderId:folder.id});
 const nested=await call('zen_folder_create',{spaceId:space.id,name:'Outer'});
 const inner=await call('zen_folder_create',{spaceId:space.id,parentId:nested.id,name:'Inner'});
 await call('zen_tab_move',{tabId:tabs[0].id,folderId:inner.id});
 const nestedSplit=await call('zen_split_create',{tabIds:[tabs[1].id,tabs[2].id],layout:'vsep'});
 await call('zen_tab_move',{tabId:tabs[1].id,folderId:inner.id});
 await call('zen_folder_remove',{folderId:nested.id,keepTabs:true});
 const snapshot=await call('zen_native_snapshot');
 assert.equal(snapshot.folders.find(f=>f.id===inner.id).parentId,null);
 assert(snapshot.splits.some(s=>s.id===nestedSplit.id));assert(tabs.every(t=>snapshot.tabs.some(x=>x.id===t.id)));
 console.log(JSON.stringify({ok:true,checks:count}));
}finally{await n.disconnect();}
