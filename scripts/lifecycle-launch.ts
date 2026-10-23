import {spawn} from 'node:child_process';import {closeSync,openSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {buildChildEnv,type Env} from './lifecycle-env.ts';import {BUDGET_MS,observeFile} from './lifecycle-lock.ts';import {parseLifecycleRecord,stateFile} from './lifecycle-state.ts';
export type Launched={launcher:number;pid:number;port:number;boot_id:string;log:string};
export type LaunchOptions={port:number;env?:Env;budgetMs?:number};
/** web_ui.boot_id from the full `/api/health` on loopback, or undefined while it does not answer ok. */
async function fullHealthBootId(port:number):Promise<string|undefined>{
 try{
  const response=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(2_000)});if(!response.ok)return undefined;
  const body=await response.json() as {ok?:unknown;web_ui?:{boot_id?:unknown}};
  return body.ok===true&&typeof body.web_ui?.boot_id==='string'?body.web_ui.boot_id:undefined;
 }catch{return undefined;}
}
/**
 * Starts `<root>/scripts/owned-server.ts start` in the background so it outlives this process and its console: detached, hidden,
 * stdin ignored, stdout and stderr on one append descriptor of `<root>/server.log`, unref'd. The port is always explicit and the
 * launch gets a fresh HERDR_WEB_BOOT_ID. Resolves only once lifecycle.json records this boot as running and the server answers;
 * a launcher exit or the start budget running out rejects with the server.log path. Nothing is killed on failure.
 */
export async function launchOwned(root:string,{port,env=process.env,budgetMs=BUDGET_MS.start}:LaunchOptions):Promise<Launched>{
 if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error(`Invalid port: ${port}`);
 const bootId=randomUUID(),log=join(root,'server.log');
 const fd=openSync(log,'a',0o600);let child;
 try{child=spawn(process.execPath,[join(root,'scripts','owned-server.ts'),'start'],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',fd,fd],env:buildChildEnv(env,{PORT:String(port),HOST:'127.0.0.1',HERDR_WEB_BOOT_ID:bootId})});}
 finally{closeSync(fd);}
 let exited:string|undefined;
 child.once('exit',(code,signal)=>{exited=signal?`signal ${signal}`:`code ${code}`;});child.once('error',error=>{exited=`spawn failed: ${error.message}`;});
 child.unref();
 const deadline=Date.now()+budgetMs;
 while(Date.now()<deadline){
  const state=observeFile(stateFile(root),parseLifecycleRecord);
  if(state.kind==='record'&&state.record.boot_id===bootId&&state.record.status==='running'){
   // 3D-1 replaces this with the bridge-only probe and its boot_id match; until then the full health must report this boot.
   if(await fullHealthBootId(port)===bootId)return {launcher:child.pid!,pid:state.record.pid,port,boot_id:bootId,log};
  }
  if(exited!==undefined)throw new Error(`Owned server launcher exited (${exited}) before it was ready on port ${port}; see ${log}`);
  await Bun.sleep(100);
 }
 throw new Error(`Owned server did not become ready on port ${port} within ${budgetMs} ms (launcher pid ${child.pid??'unknown'}); see ${log}`);
}
