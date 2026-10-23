import {describe,expect,it} from 'bun:test';
import {matchOwner} from './lifecycle-lock.ts';
import {cimScript,parseCimIdentity,parseProcStat,parsePsStart,processIdentity,queryIdentity,windowsPowerShell} from './process-identity.ts';
const CREATED='2026-10-23T10:17:43.0622910Z',EXE='C:\\Users\\u\\.bun\\bin\\bun.exe';
const row=(over:Record<string,unknown>={})=>({ProcessId:4242,ParentProcessId:17,ExecutablePath:EXE,CommandLine:'"bun.exe" owned-server.ts start',Created:CREATED,...over});
const cim=(value:unknown,code=0)=>parseCimIdentity(4242,code,JSON.stringify(value));
/** A Bun child that has exited and been reaped: its PID is free right after. */
async function exitedPid(){const child=Bun.spawn([process.execPath,'-e','0'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});await child.exited;return child.pid;}
describe('pure identity decisions (every platform)',()=>{
 it('reads a CIM row exactly and keeps parent, path and command line',()=>{
  expect(cim({rows:[row()]})).toEqual({state:'alive',pid:4242,startedAt:CREATED,parentPid:17,exe:EXE,commandLine:'"bun.exe" owned-server.ts start'});
  expect(cim({rows:[row({ExecutablePath:null,CommandLine:null})]})).toEqual({state:'alive',pid:4242,startedAt:CREATED,parentPid:17,exe:undefined,commandLine:undefined});
 });
 it('only a successful empty query is gone; failures and unreadable start times are never gone',()=>{
  expect(cim({rows:[]})).toEqual({state:'gone',pid:4242});
  expect(cim({rows:[]},1).state).toBe('error');
  expect(parseCimIdentity(4242,0,'').state).toBe('error');
  expect(parseCimIdentity(4242,null,'').state).toBe('error');
  expect(parseCimIdentity(4242,0,'not json').state).toBe('error');
  expect(cim({}).state).toBe('error');
  expect(cim({error:'PermissionDenied',message:'Access denied'},2)).toMatchObject({state:'denied',pid:4242});
  expect(cim({error:'NotSpecified',message:'RPC server unavailable'},2)).toMatchObject({state:'error',detail:'CIM NotSpecified: RPC server unavailable'});
  expect(cim({rows:[row({Created:null})]}).state).toBe('denied');
  expect(cim({rows:[row({ProcessId:4243})]}).state).toBe('error');
  expect(cim({rows:[row(),row()]}).state).toBe('error');
 });
 it('a reused PID differs in start time and is a mismatch; the same record matches only its exact identity',()=>{
  const record={pid:4242,startedAt:CREATED,exe:EXE};
  expect(matchOwner(record,cim({rows:[row()]}))).toBe('match');
  expect(matchOwner(record,cim({rows:[row({Created:'2026-10-23T10:17:43.0622900Z'})]}))).toBe('mismatch');
  expect(matchOwner(record,cim({rows:[row({ExecutablePath:'C:\\Windows\\System32\\notepad.exe'})]}))).toBe('mismatch');
  expect(matchOwner(record,cim({rows:[]}))).toBe('gone');
  expect(matchOwner(record,cim({rows:[row({Created:null})]}))).toBe('uncertain');
  expect(matchOwner(record,parseCimIdentity(4242,1,''))).toBe('uncertain');
 });
 it('parses /proc stat with a hostile comm and ps lstart output',()=>{
  const stat='4242 (a) b (c) S 17 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100';
  expect(parseProcStat(stat,'1700000000')).toEqual({startedAt:'1700000000:987654',parentPid:17});
  expect(parseProcStat('garbage','1')).toBeUndefined();
  expect(parsePsStart('   17 Thu Oct 23 19:13:00 2026\n')).toEqual({parentPid:17,startedAt:'Thu Oct 23 19:13:00 2026'});
  expect(parsePsStart('   17 Thu Oct  3 19:13:00 2026\n')).toEqual({parentPid:17,startedAt:'Thu Oct 3 19:13:00 2026'});
  expect(parsePsStart('')).toBeUndefined();
 });
 it('uses only a validated absolute SystemRoot for powershell.exe',()=>{
  for(const root of [undefined,'','Windows','\\\\server\\share\\Windows','C:\\Windows\\..\\Temp','C:/Windows','C:\\Windows\\','C:\\Win"dows','C:\\Windows\\.'])
   expect(()=>windowsPowerShell({SystemRoot:root})).toThrow('Invalid SystemRoot');
  expect(()=>windowsPowerShell({SystemRoot:'C:\\definitely-not-windows-root'})).toThrow('Windows PowerShell not found');
  const script=cimScript(4242);
  for(const part of ["-Filter 'ProcessId=4242'",'[Console]::OutputEncoding=[Text.Encoding]::UTF8',"ToUniversalTime().ToString('o')","$ErrorActionPreference='Stop'"])expect(script).toContain(part);
 });
 it('rejects invalid PIDs without querying',()=>{
  for(const pid of [0,-1,1.5,Number.NaN])expect(queryIdentity(pid).state).toBe('error');
 });
});
describe.if(process.platform==='win32')('Windows CIM adapter',()=>{
 it('self lookup through the same adapter returns the exact CreationDate twice, with path and parent',()=>{
  const first=queryIdentity(process.pid),second=queryIdentity(process.pid);
  expect(first.state).toBe('alive');expect(first.startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/);
  expect(second.startedAt).toBe(first.startedAt!);expect(first.exe?.toLowerCase()).toBe(process.execPath.toLowerCase());
  expect(first.parentPid).toBe(process.ppid);expect(first.commandLine).toContain('bun');
  expect(processIdentity(process.pid)).toEqual(first);
 },30_000);
 it('a child is alive with its own exact identity, then gone after it exits',async()=>{
  const child=Bun.spawn([process.execPath,'-e','setTimeout(()=>{},60000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});
  try{
   const a=queryIdentity(child.pid),b=queryIdentity(child.pid);
   expect(a).toMatchObject({state:'alive',parentPid:process.pid});expect(b.startedAt).toBe(a.startedAt!);
   expect(matchOwner({pid:child.pid,startedAt:a.startedAt,exe:a.exe},b)).toBe('match');
  }finally{child.kill();await child.exited;}
  expect(queryIdentity(child.pid).state).toBe('gone');
 },30_000);
 it('a gone PID is gone, but the same PID with a failed query is error, never gone',async()=>{
  const pid=await exitedPid();
  expect(queryIdentity(pid).state).toBe('gone');
  // Negative control: break the PowerShell path; the PID is still free, yet the answer must not claim it.
  expect(queryIdentity(pid,{...process.env,SystemRoot:'C:\\definitely-not-windows-root'})).toMatchObject({state:'error',detail:expect.stringContaining('Windows PowerShell not found')});
 },30_000);
});
describe.if(process.platform!=='win32')('POSIX adapter',()=>{
 it('self lookup is exact and repeatable; an exited child is gone',async()=>{
  const first=queryIdentity(process.pid),second=queryIdentity(process.pid);
  expect(first.state).toBe('alive');expect(second.startedAt).toBe(first.startedAt!);expect(first.parentPid).toBe(process.ppid);
  expect(queryIdentity(await exitedPid()).state).toBe('gone');
 },30_000);
});
