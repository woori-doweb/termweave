import {afterAll,expect,test} from 'bun:test';import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {isOwnedRootDacl} from './owned-install.ts';import {trusteeSid} from './windows-sid.ts';
const win=process.platform==='win32';
const base=mkdtempSync(join(tmpdir(),'tw-owned-acl-'));afterAll(()=>rmSync(base,{recursive:true,force:true}));
const icacls=(...args:string[])=>execFileSync(join(process.env.SystemRoot!,'System32','icacls.exe'),args,{stdio:'pipe',windowsHide:true,timeout:15_000});
const other='S-1-5-21-1-2-3-1001';
test.if(win)('win32: SDDL aliases resolve through Windows, machine-relative ones included, and an unknown one resolves to nothing',()=>{
 expect(trusteeSid('SY')).toBe('S-1-5-18');expect(trusteeSid('BA')).toBe('S-1-5-32-544');expect(trusteeSid(other)).toBe(other);
 // LA is this machine's built-in Administrator (RID 500), the account GitHub's windows runner runs the job as
 expect(trusteeSid('LA')).toMatch(/^S-1-5-21-\d+-\d+-\d+-500$/);
 for(const bad of ['QQ','sy','','SYS','S-1-','LA)'])expect([bad,trusteeSid(bad)]).toEqual([bad,undefined]);
});
test.if(!win)('off Windows no alias resolves, so an alias-bearing DACL fails closed',()=>{
 expect(trusteeSid('SY')).toBeUndefined();expect(trusteeSid('LA')).toBeUndefined();expect(trusteeSid('S-1-5-18')).toBe('S-1-5-18');
 expect(isOwnedRootDacl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${other})`,other)).toBe(false);
});
test.if(win)('win32: aliases are compared as their SIDs: LA as the user, SY as SYSTEM; BA, LA for another user and an unknown alias are refused',()=>{
 const la=trusteeSid('LA')!,ok='D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)';
 expect(isOwnedRootDacl(ok,la)).toBe(true);expect(isOwnedRootDacl(`D:PAI(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;${la})`,la)).toBe(true);
 for(const bad of [`${ok}(A;OICI;FA;;;BA)`,`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${other})(A;OICI;FA;;;LA)`,`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;QQ)`,`D:PAI(A;OICI;FA;;;QQ)(A;OICI;FA;;;LA)`,'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'])expect([bad,isOwnedRootDacl(bad,la)]).toEqual([bad,false]);
 expect(isOwnedRootDacl(ok,other)).toBe(false);
});
test('a trailing SACL of mandatory-label ACEs is accepted (an elevated creator leaves one); any other SACL ACE or a broken tail is refused',()=>{
 const user='S-1-5-21-1-2-3-500',dacl=`D:PAI(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;${user})`;
 expect(isOwnedRootDacl(dacl,user)).toBe(true);expect(isOwnedRootDacl(`${dacl}S:(ML;OICI;NW;;;S-1-16-12288)`,user)).toBe(true);expect(isOwnedRootDacl(`${dacl}S:AI(ML;OICIID;NW;;;S-1-16-12288)`,user)).toBe(true);
 for(const bad of [`${dacl}S:(AU;SA;FA;;;S-1-1-0)`,`${dacl}S:(ML;OICI;NW;;;S-1-16-12288)(AU;SA;FA;;;S-1-1-0)`,`${dacl}S:`,`${dacl}X`])expect([bad,isOwnedRootDacl(bad,user)]).toEqual([bad,false]);
});
test.if(win)('win32: a root owned by the built-in Administrator reads back through icacls as LA and passes the check (the CI runner shape)',()=>{
 const la=trusteeSid('LA')!,root=join(base,'la-root');mkdirSync(root);
 try{
  icacls(root,'/inheritance:r','/grant:r',`*${la}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F');
  const saved=join(base,'la-acl');icacls(root,'/save',saved);const sddl=readFileSync(saved).toString('utf16le').split(/\r?\n/)[1]!.trim();
  expect(sddl).toContain(';;;LA)');expect(sddl).not.toContain(la);expect({sddl,owned:isOwnedRootDacl(sddl,la)}).toEqual({sddl,owned:true});expect(isOwnedRootDacl(sddl,other)).toBe(false);
 }finally{icacls(root,'/reset');}
});
