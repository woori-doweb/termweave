import {acquireLock,BUDGET_MS,matchOwner,observeFile,type LockOptions} from './lifecycle-lock.ts';import {parseLifecycleRecord,removeState,replaceState,stateFile,type LifecycleRecord} from './lifecycle-state.ts';
import {buildChildEnv,envValue} from './lifecycle-env.ts';import {processIdentity,type ProcessIdentity} from './process-identity.ts';import {DEFAULT_PORT} from './install-lifecycle.ts';
import {existsSync,readFileSync} from 'node:fs';import {join,resolve} from 'node:path';import {randomUUID} from 'node:crypto';
const root=resolve(import.meta.dir,'..'),marker=join(root,'.termweave-owned.json');
if(!existsSync(marker))throw new Error('Owned installation required');
const metadata=JSON.parse(readFileSync(marker,'utf8'));if(metadata.product!=='termweave'||metadata.root!==root||!metadata.inventory)throw new Error('Invalid owned marker');
/** Launcher diagnostics go to stderr, which the background launch (lifecycle-launch.ts) and install.sh point at server.log. */
const say=(message:string)=>console.error(`[owned-server ${new Date().toISOString()}] ${message}`);
const brief=(identity:ProcessIdentity)=>({pid:identity.pid,state:identity.state,startedAt:identity.startedAt,exe:identity.exe});
if(process.argv[2]==='start'){
 const options:LockOptions={identity:processIdentity};
 // The owned path never leaves the port to the server's own fallback (shared/protocol.ts 7327): it binds and records this one.
 const rawPort=envValue(process.env,'PORT')||String(DEFAULT_PORT);
 if(!/^\d+$/.test(rawPort)||Number(rawPort)<1||Number(rawPort)>65535)throw new Error(`Invalid port: ${rawPort}`);
 const port=Number(rawPort),bootId=envValue(process.env,'HERDR_WEB_BOOT_ID')||randomUUID();
 const deadline=Date.now()+BUDGET_MS.start;
 // The work lock covers only the starting transition; the running server is represented by lifecycle.json alone.
 const lock=acquireLock(root,'start',options);
 let child:ReturnType<typeof Bun.spawn>|undefined,published=false,stopRequested=false;
 const forward=()=>{stopRequested=true;try{child?.kill('SIGTERM');}catch{}};process.on('SIGTERM',forward);process.on('SIGINT',forward);
 try{
  // Under the start lock: a state whose owner is gone or is another process on a reused PID is reclaimed; anything else refuses.
  const current=observeFile(stateFile(root),parseLifecycleRecord);
  if(current.kind==='record'){
   const owner=processIdentity(current.record.pid),verdict=matchOwner(current.record,owner);
   if(verdict!=='gone'&&verdict!=='mismatch')throw new Error(`Active or uncertain process state: ${current.record.status} pid ${current.record.pid} (${verdict==='match'?'owner alive':`owner identity ${owner.state}`})`);
   if(!removeState(root,{lock:lock.nonce,state:current.record.boot_id},'start',options))throw new Error('lifecycle.json changed while reclaiming stale state');
   say(`reclaimed stale lifecycle.json of pid ${current.record.pid} (${verdict})`);
  }else if(current.kind!=='absent')throw new Error(`Active or uncertain process state: lifecycle.json ${current.kind==='partial'?'is not a lifecycle record':`unreadable (${current.code})`}`);
  // The server runs on this Bun (process.execPath, no PATH lookup) with the denylist-filtered env, loopback HOST, this launch's PORT and boot id.
  child=Bun.spawn([process.execPath,join(root,'server/index.ts')],{cwd:root,env:buildChildEnv(process.env,{PORT:String(port),HOST:'127.0.0.1',TERMWEAVE_OWNED_LAUNCH:'1',HERDR_WEB_BOOT_ID:bootId}),stdout:'inherit',stderr:'inherit',stdin:'ignore',windowsHide:true});
  const server=processIdentity(child.pid);
  if(server.state==='gone')throw new Error(`Server exited (code ${await child.exited}) before it answered on port ${port}`);
  if(server.state!=='alive')throw new Error(`Server process identity unavailable (${server.state}${server.detail?`: ${server.detail}`:''})`);
  // `launcher` stays a bare number: install.sh reads it with sed.
  const record:LifecycleRecord&Record<string,unknown>={status:'starting',pid:child.pid,startedAt:server.startedAt,exe:server.exe,port,boot_id:bootId,
   launcher:process.pid,launcher_identity:brief(processIdentity(process.pid)),parent:brief(processIdentity(process.ppid))};
  if(!replaceState(root,record,{lock:lock.nonce,state:null},'start',options))throw new Error('lifecycle.json changed under the start lock');
  published=true;say(`starting server pid ${child.pid} on 127.0.0.1:${port} (boot ${bootId})`);
  // 3D-1 replaces this readiness check with the bridge probe carrying boot_id. Until then: a full health answer must name this boot
  // (another boot is a foreign server on the port, never ready); only while full health fails (herdr down) does a bridge answer count.
  const answer=async(path:string)=>{try{const response=await fetch(`http://127.0.0.1:${port}${path}`,{signal:AbortSignal.timeout(1_000)});return response.ok?await response.json() as {ok?:unknown;web_ui?:{boot_id?:unknown}}:undefined;}catch{return undefined;}};
  for(;;){
   if(child.exitCode!==null||child.signalCode!==null||stopRequested)throw new Error(`Server exited (code ${child.exitCode??child.signalCode}) before it answered on port ${port}`);
   if(Date.now()>=deadline)throw new Error(`Server did not answer on port ${port} within ${BUDGET_MS.start} ms`);
   const full=await answer('/api/health');
   const ready=full?.ok===true?full.web_ui?.boot_id===bootId:(await answer('/api/health?scope=bridge'))?.ok===true;
   if(ready&&child.exitCode===null)break;
   await Bun.sleep(100);
  }
  if(!replaceState(root,{...record,status:'running'},{lock:lock.nonce,state:bootId},'start',options))throw new Error('lifecycle.json changed before running');
  say(`running server pid ${child.pid} on 127.0.0.1:${port}`);
 }catch(error){
  // Abort path only: the child never became the running instance, so it is ended here and its own state is withdrawn.
  if(child&&child.exitCode===null){try{child.kill();}catch{}await child.exited;}
  if(published&&!removeState(root,{lock:lock.nonce,state:bootId},'start',options))say('lifecycle.json no longer carried this boot id; left unchanged');
  lock.release();throw error;
 }
 if(!lock.release())say('start work lock was no longer ours at release');
 const code=await child.exited;
 // Exit cleanup removes only this boot's state, under the guard, without retaking a work lock.
 if(!removeState(root,{state:bootId},'stop',options))say('lifecycle.json no longer carried this boot id at exit; left unchanged');
 say(`server pid ${child.pid} exited with ${code}`);process.exitCode=code;
}else throw new Error('Run foreground owned-server start; stop its owned launcher with SIGTERM and wait for exit');
