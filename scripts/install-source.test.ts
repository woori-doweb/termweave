import {it,expect} from 'bun:test';import {mkdtempSync,realpathSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';import {installationSources} from './install-source.ts';
it('committed inventory excludes synthetic env/state/log/backups and untracked personal files',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'tw-source-')));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 try{git('init');writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'bun.lock'),'synthetic');git('add','package.json','bun.lock');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic source');for(const name of ['.env','state.json','session.log','backup.txt','personal.txt'])writeFileSync(join(root,name),'synthetic private fixture');expect(installationSources(root).sort()).toEqual(['bun.lock','package.json']);writeFileSync(join(root,'bun.lock'),'modified');expect(()=>installationSources(root)).toThrow('Modified');}
 finally{rmSync(root,{recursive:true,force:true});}
});
it('repository .gitattributes keeps committed LF bytes under core.autocrlf=true checkouts',()=>{
 const attributes=readFileSync(join(import.meta.dir,'..','.gitattributes'));
 const root=realpathSync(mkdtempSync(join(tmpdir(),'tw-source-eol-')));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 const commit=(message:string)=>git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m',message);
 const recheckout=()=>{rmSync(join(root,'package.json'));rmSync(join(root,'bun.lock'));git('checkout','--','package.json','bun.lock');};
 try{
  git('init');git('config','core.autocrlf','true');
  writeFileSync(join(root,'package.json'),'{\n  "name": "fixture"\n}\n');writeFileSync(join(root,'bun.lock'),'line one\nline two\n');
  git('add','package.json','bun.lock');commit('LF source');
  recheckout();
  expect(readFileSync(join(root,'package.json'),'utf8')).toContain('\r\n');
  expect(()=>installationSources(root)).toThrow('Modified committed installation source');
  writeFileSync(join(root,'.gitattributes'),attributes);git('add','.gitattributes');commit('Pin LF');
  recheckout();
  expect(readFileSync(join(root,'package.json'),'utf8')).not.toContain('\r\n');
  expect(installationSources(root).sort()).toEqual(['.gitattributes','bun.lock','package.json']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
