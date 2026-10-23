import {cpSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync,lstatSync,readlinkSync,rmdirSync,rmSync} from 'node:fs';import {resolve,join,isAbsolute} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {installationSources} from './install-source.ts';import {canonicalPath,judgeDestination} from './lifecycle-path.ts';
const SYSTEM_SID='S-1-5-18';
const system32=(exe:string)=>{const root=process.env.SystemRoot;if(!root||!isAbsolute(root))throw new Error('SystemRoot is required for the owned root ACL');return join(root,'System32',exe);};
const run=(argv:string[],cwd?:string)=>Bun.spawnSync(argv,{cwd,stdout:'pipe',stderr:'pipe'});
/** SID of the installing account from the locale-independent SID column of `whoami /user`. */
export function currentUserSid():string{const result=run([system32('whoami.exe'),'/user','/fo','csv','/nh']);const sid=result.exitCode===0?/"(S-1-\d+(?:-\d+)+)"\s*$/.exec(result.stdout.toString())?.[1]:undefined;if(!sid)throw new Error('Current user SID unavailable');return sid;}
/** SDDL DACL that is protected (no inherited ACEs) and grants exactly the user and SYSTEM (OI)(CI) full control. */
export function isOwnedRootDacl(sddl:string,userSid:string):boolean{
 const match=/^D:([A-Z]*)((?:\([^()]*\))+)$/.exec(sddl.trim());if(!match||!match[1].includes('P'))return false;
 const expected=new Set([userSid,SYSTEM_SID]);const seen=new Set<string>();
 for(const ace of match[2].slice(1,-1).split(')(')){const [type,flags,rights,object,inherited,trustee,...rest]=ace.split(';');const sid=trustee==='SY'?SYSTEM_SID:trustee;if(rest.length||type!=='A'||flags!=='OICI'||rights!=='FA'||object||inherited||!sid||!expected.has(sid))return false;seen.add(sid);}
 return seen.size===expected.size;
}
/** Windows: one icacls pass right after root creation, before any file is written. Removes inheritance, grants (OI)(CI)F to the current user SID and SYSTEM only, then reads the DACL back with `icacls /save`. Any failure fails the install. */
export function restrictOwnedRoot(root:string){
 const icacls=system32('icacls.exe');const sid=currentUserSid();
 if(run([icacls,root,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,`*${SYSTEM_SID}:(OI)(CI)F`]).exitCode!==0)throw new Error('Owned root ACL apply failed');
 const scratch=mkdtempSync(join(tmpdir(),'tw-acl-'));
 try{const saved=join(scratch,'acl');const sddl=run([icacls,root,'/save',saved]).exitCode===0?readFileSync(saved).toString('utf16le').split(/\r?\n/)[1]??'':'';if(!isOwnedRootDacl(sddl,sid))throw new Error('Owned root ACL verification failed');}
 finally{rmSync(scratch,{recursive:true,force:true});}
}
export function installOwned(source:string,destination:string){
 const sources=installationSources(source);const sourceRoot=canonicalPath(source);
 const source_sha=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim();if(!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(source_sha))throw new Error('Source commit unavailable');
 const judged=judgeDestination(destination,sourceRoot);if('refused' in judged)throw new Error(judged.refused==='symlink ancestor'?'Symlink ancestor refused':`Install requires a new independent destination (${judged.refused})`);
 const root=judged.root;mkdirSync(root,{recursive:false});
 if(process.platform==='win32'){try{restrictOwnedRoot(root);}catch(error){try{rmdirSync(root);}catch{}throw error;}}
 for(const name of sources){mkdirSync(resolve(root,name,'..'),{recursive:true});cpSync(join(sourceRoot,name),join(root,name));}
 if(run([process.execPath,'install','--frozen-lockfile','--ignore-scripts'],root).exitCode!==0)throw new Error('Locked install failed');
 if(run([process.execPath,'run','build'],root).exitCode!==0)throw new Error('Build failed');
 const inventory:Record<string,string>={};const visit=(dir:string)=>{for(const name of readdirSync(dir)){const p=join(dir,name);const stat=lstatSync(p);if(stat.isSymbolicLink()){inventory[p.slice(root.length+1)]='symlink:'+readlinkSync(p);continue;}if(stat.isDirectory()){inventory[p.slice(root.length+1)]='directory';visit(p);}else inventory[p.slice(root.length+1)]=createHash('sha256').update(readFileSync(p)).digest('hex');}};visit(root);
 writeFileSync(join(root,'.termweave-owned.json'),JSON.stringify({product:'termweave',root,source_sha,inventory}),{mode:0o600,flag:'wx'});
 return root;
}
if(import.meta.main)installOwned(resolve(import.meta.dir,'..'),process.argv[2]??'');
