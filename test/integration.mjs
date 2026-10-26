import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { MarionetteClient } from '../src/marionette.mjs';
const binary=process.env.ZEN_BINARY || '/Applications/Zen.app/Contents/MacOS/zen';
const profile=resolve('.test-runtime',`integration-${Date.now()}`);
const env={...process.env,ZEN_TEST_PROFILE:profile};
let browser;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function available(){return new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:2839});s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});}
async function start(){
 const log=await open(resolve(profile,'..','integration-browser.log'),'a');
 browser=spawn(binary,['--headless','--no-remote','--profile',profile,'--marionette','--remote-allow-system-access','--remote-debugging-port','9339'],{stdio:['ignore',log.fd,log.fd]});await log.close();
 for(let i=0;i<80;i++){if(browser.exitCode!==null)throw Error('Isolated Zen process exited');if(await available())return;await delay(250);}throw Error('Isolated Zen did not listen');
}
async function stop(){
 if(!browser || browser.exitCode!==null)return;
 const done=once(browser,'exit');
 const c=new MarionetteClient({port:2839,profile,timeout:5000});
 try{await c.connect();await c.send('Marionette:Quit',{flags:['eAttemptQuit']});}catch{}finally{await c.disconnect();}
 let timer;await Promise.race([done,new Promise(resolve=>{timer=setTimeout(resolve,8000);})]);clearTimeout(timer);
 if(browser.exitCode===null){browser.kill('SIGTERM');await done;}
}
async function run(script,...args){
 const child=spawn(process.execPath,[script,...args],{env,stdio:'inherit'});const [code]=await once(child,'exit');if(code!==0)throw Error(`Failed: ${script} ${args.join(' ')}`);
}
if(await available())throw Error('Native test port 2839 is occupied; no existing browser was touched');
await mkdir(profile,{recursive:true});await writeFile(resolve(profile,'user.js'),[
 'user_pref("marionette.port", 2839);','user_pref("browser.shell.checkDefaultBrowser", false);',
 'user_pref("browser.aboutwelcome.enabled", false);','user_pref("zen.welcome-screen.seen", true);',
 'user_pref("zen.workspaces.enabled", true);','user_pref("datareporting.policy.dataSubmissionEnabled", false);',
 'user_pref("toolkit.telemetry.enabled", false);','user_pref("browser.sessionstore.restore_on_demand", true);',
 'user_pref("browser.sessionstore.restore_pinned_tabs_on_demand", true);',
].join('\n'));
console.log(JSON.stringify({isolatedProfile:profile,binary}));
try{
 await start();await run('test/native-smoke.mjs');await run('test/native-edges.mjs');await run('test/native-lifecycle.mjs','windows');
 await run('test/native-lifecycle.mjs','before');await stop();await start();await run('test/native-lifecycle.mjs','after');
 console.log(JSON.stringify({ok:true,isolatedProfile:profile,restartVerified:true}));
}finally{await stop();}
