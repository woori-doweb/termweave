import {existsSync,readFileSync,readlinkSync} from 'node:fs';import {win32} from 'node:path';
import type {Identity} from './lifecycle-lock.ts';import {envValue,type Env} from './lifecycle-env.ts';
import {parseProcessTable} from '../server/windows-processes.ts';
/**
 * One identity adapter for every lifecycle record and comparison (A-5). `startedAt` is an exact, adapter-specific token compared
 * only for equality with a value recorded by the same adapter: Windows CIM CreationDate in UTC ISO (100 ns ticks), Linux
 * `<btime>:<starttime ticks>` from /proc, other POSIX the `ps` lstart text. A failed query is `error` (or `denied`), never `gone`:
 * only a successful query that finds no such process proves the PID is free.
 */
export type ProcessIdentity=Identity&{pid:number;commandLine?:string;parentPid?:number;detail?:string};
/** A CIM query that stalls is killed here and reported as `error`. */
export const QUERY_TIMEOUT_MS=15_000;
const SELF=new Map<number,ProcessIdentity>();
/** Default identity probe for lifecycle-lock/state callers. The own process never changes identity, so its first live answer is reused. */
export function processIdentity(pid:number):ProcessIdentity{
 const cached=pid===process.pid?SELF.get(pid):undefined;if(cached)return cached;
 const identity=queryIdentity(pid);
 if(pid===process.pid&&identity.state==='alive')SELF.set(pid,identity);
 return identity;
}
/** One uncached OS query. `env` only selects SystemRoot for the Windows PowerShell path. */
export function queryIdentity(pid:number,env:Env=process.env):ProcessIdentity{
 if(!Number.isSafeInteger(pid)||pid<=0)return {state:'error',pid,detail:`invalid pid ${pid}`};
 return process.platform==='win32'?windowsIdentity(pid,env):process.platform==='linux'?linuxIdentity(pid):psIdentity(pid);
}
/** `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe` only for a plain absolute drive path; no PATH lookup, no relative or `..` root. */
export function windowsPowerShell(env:Env=process.env):string{
 const root=envValue(env,'SystemRoot','win32');
 if(!root||!/^[A-Za-z]:\\[^\\/:*?"<>|]+(?:\\[^\\/:*?"<>|]+)*$/.test(root)||win32.normalize(root)!==root||root.split('\\').some(part=>part==='.'||part==='..'))throw new Error(`Invalid SystemRoot: ${JSON.stringify(root??null)}`);
 const exe=win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
 if(!existsSync(exe))throw new Error(`Windows PowerShell not found at ${exe}`);
 return exe;
}
/** Same Select-Object columns as server/windows-processes.ts, plus CreationDate kept exact instead of rounded to milliseconds. */
export const cimScript=(pid:number)=>[
 "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8",
 `try{$rows=@(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='Created';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}}})`,
 " [Console]::Out.Write((ConvertTo-Json -Compress -Depth 3 -InputObject @{rows=$rows}))}",
 "catch{[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{error=[string]$_.CategoryInfo.Category;message=[string]$_.Exception.Message}));exit 2}",
].join('\n');
/** Pure: the PowerShell answer for one PID as an identity. Anything unparseable or a non-zero exit is `error`, never `gone`. */
export function parseCimIdentity(pid:number,exitCode:number|null,stdout:string):ProcessIdentity{
 let value:unknown;try{value=JSON.parse(stdout);}catch{return {state:'error',pid,detail:`CIM query exit ${exitCode} without JSON`};}
 const v=value as {rows?:unknown;error?:unknown;message?:unknown}|null;
 if(v&&typeof v==='object'&&typeof v.error==='string')return {state:v.error==='PermissionDenied'?'denied':'error',pid,detail:`CIM ${v.error}: ${String(v.message??'')}`.trim()};
 if(exitCode!==0||!v||typeof v!=='object'||!Array.isArray(v.rows))return {state:'error',pid,detail:`CIM query exit ${exitCode} with unexpected output`};
 const rows=parseProcessTable(JSON.stringify(v.rows)).filter(row=>row.pid===pid);
 if(rows.length!==v.rows.length||rows.length>1)return {state:'error',pid,detail:'CIM returned malformed rows'};
 if(rows.length===0)return {state:'gone',pid};
 const row=rows[0]!,created=(v.rows[0] as {Created?:unknown}).Created;
 const base={pid,parentPid:row.parent,exe:row.path??undefined,commandLine:row.commandLine??undefined};
 // A row without CreationDate cannot be told apart from a reused PID: uncertain, never alive-and-matching.
 return typeof created==='string'&&created?{state:'alive',startedAt:created,...base}:{state:'denied',...base,detail:'CreationDate unreadable'};
}
function windowsIdentity(pid:number,env:Env):ProcessIdentity{
 let exe:string;try{exe=windowsPowerShell(env);}catch(error){return {state:'error',pid,detail:String((error as Error).message)};}
 try{
  const result=Bun.spawnSync([exe,'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(cimScript(pid),'utf16le').toString('base64')],{stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true,timeout:QUERY_TIMEOUT_MS,killSignal:'SIGKILL'});
  const identity=parseCimIdentity(pid,result.exitCode,new TextDecoder('utf-8').decode(result.stdout));
  if(identity.state==='error'){const stderr=new TextDecoder('utf-8').decode(result.stderr).trim();if(stderr)identity.detail=`${identity.detail}; ${stderr.slice(0,500)}`;}
  return identity;
 }catch(error){return {state:'error',pid,detail:String((error as Error).message)};}
}
const fsCode=(error:unknown)=>String((error as {code?:unknown})?.code??'unknown');
/** Pure: `/proc/<pid>/stat` (comm may contain spaces and parentheses) with the boot time, as `<btime>:<starttime>` and the parent PID. */
export function parseProcStat(stat:string,btime:string):{startedAt:string;parentPid:number}|undefined{
 const close=stat.lastIndexOf(')');if(close<0)return undefined;
 const fields=stat.slice(close+2).trim().split(/\s+/);const parentPid=Number(fields[1]),start=fields[19];
 if(!Number.isSafeInteger(parentPid)||!start||!/^\d+$/.test(start))return undefined;
 return {startedAt:`${btime}:${start}`,parentPid};
}
function linuxIdentity(pid:number):ProcessIdentity{
 let stat:string,btime:string|undefined;
 try{stat=readFileSync(`/proc/${pid}/stat`,'utf8');btime=/^btime (\d+)$/m.exec(readFileSync('/proc/stat','utf8'))?.[1];}
 catch(error){const code=fsCode(error);return {state:code==='ENOENT'||code==='ESRCH'?'gone':code==='EACCES'||code==='EPERM'?'denied':'error',pid,detail:code};}
 const parsed=btime?parseProcStat(stat,btime):undefined;if(!parsed)return {state:'error',pid,detail:'unparseable /proc stat'};
 const optional=<T>(read:()=>T)=>{try{return read();}catch{return undefined;}};
 const exe=optional(()=>readlinkSync(`/proc/${pid}/exe`));
 const commandLine=optional(()=>readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').filter(Boolean).join(' '));
 return {state:'alive',pid,startedAt:parsed.startedAt,parentPid:parsed.parentPid,exe,commandLine};
}
/** Pure: `ps -o ppid=,lstart=` output (parent PID then the fixed five-word start time). Empty output means no such process. */
export function parsePsStart(text:string):{startedAt:string;parentPid:number}|undefined{
 const match=/^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s*$/.exec(text);if(!match)return undefined;
 return {parentPid:Number(match[1]),startedAt:match[2]!.replace(/\s+/g,' ')};
}
function psIdentity(pid:number):ProcessIdentity{
 const ps=(field:string)=>{const result=Bun.spawnSync(['/bin/ps','-o',field,'-p',String(pid)],{stdin:'ignore',stdout:'pipe',stderr:'pipe',timeout:QUERY_TIMEOUT_MS});return {code:result.exitCode,out:result.stdout.toString(),err:result.stderr.toString()};};
 try{
  const start=ps('ppid=,lstart=');
  // ps exits 1 with no rows (and no diagnostic) for a missing PID; anything else is a failed query.
  if(start.code===1&&!start.out.trim()&&!start.err.trim())return {state:'gone',pid};
  const parsed=start.code===0?parsePsStart(start.out):undefined;if(!parsed)return {state:'error',pid,detail:`ps exit ${start.code}: ${start.err.trim()}`};
  const comm=ps('comm='),args=ps('args=');
  return {state:'alive',pid,startedAt:parsed.startedAt,parentPid:parsed.parentPid,exe:comm.code===0&&comm.out.trim()?comm.out.trim():undefined,commandLine:args.code===0&&args.out.trim()?args.out.trim():undefined};
 }catch(error){return {state:'error',pid,detail:String((error as Error).message)};}
}
