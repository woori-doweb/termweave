import {existsSync,lstatSync,mkdirSync,statSync} from 'node:fs';import {dirname,join,posix,resolve,win32} from 'node:path';
import {judgeDestination} from './lifecycle-path.ts';import {installOwned} from './owned-install.ts';
import {MIN_BUN,MIN_HERDR,envValue,findExecutable,toolVersion,versionGe,type Env} from './lifecycle-env.ts';
/**
 * Shared lifecycle entry point behind install.ps1 (Windows) and install.sh semantics:
 *   bun scripts/install-lifecycle.ts <check|install|start|stop> [--dir PATH] [--port N] [--no-start] [--yes]
 * Exit codes: 0 ok, 2 missing prerequisite, 1 any other failure. --no-start and --yes belong to the front end (it starts the
 * server and runs official installers); they are accepted here and ignored. Tokens are never printed.
 */
export const DEFAULT_PORT=7317;
const MIN_NODE=18;
export const COMMANDS=['check','install','start','stop'] as const;
export type Command=typeof COMMANDS[number];
export type Options={command:Command;dir:string;port:number;start:boolean;yes:boolean};
export class UsageError extends Error{}
export type Context={
 env:Env;platform:NodeJS.Platform;cwd:string;
 out:(line:string)=>void;err:(line:string)=>void;
 /** `<exe> --version` as a bare version string (lifecycle-env toolVersion). */
 version:(executable:string,env:Env)=>string|undefined;
 /** `/api/health` on the loopback port answered `"ok":true`. */
 healthy:(port:number)=>Promise<boolean>;
 /** source checkout installed from */
 source:string;
};
export const USAGE=`Usage: bun scripts/install-lifecycle.ts <check|install|start|stop> [--dir PATH] [--port N] [--no-start] [--yes]
  check       verify prerequisites, install and health; change nothing
  install     install and build into --dir (an existing install is reused)
  --dir PATH  install directory (default: $TERMWEAVE_INSTALL_DIR, else %LOCALAPPDATA%\\termweave-owned on Windows, ~/.local/share/termweave-owned elsewhere)
  --port N    local port (default: $PORT, else ${DEFAULT_PORT})`;
/** Environment values set but empty count as unset, like the shell's `\${VAR:-default}`. */
const setting=(env:Env,name:string,platform:NodeJS.Platform)=>envValue(env,name,platform)||undefined;
/** Option precedence: CLI, then TERMWEAVE_INSTALL_DIR / PORT, then the platform default. Returns undefined for --help. */
export function parseArgs(argv:string[],{env,platform,cwd}:Pick<Context,'env'|'platform'|'cwd'>):Options|undefined{
 let command:Command|undefined,dir:string|undefined,port:string|undefined,start=true,yes=false;
 for(let i=0;i<argv.length;i++){
  const arg=argv[i]!;
  if(arg==='--dir'||arg==='--port'){const value=argv[++i];if(!value)throw new UsageError(`${arg} needs a value`);if(arg==='--dir')dir=value;else port=value;}
  else if(arg==='--no-start')start=false;
  else if(arg==='--yes')yes=true;
  else if(arg==='-h'||arg==='--help')return undefined;
  else if(command===undefined&&(COMMANDS as readonly string[]).includes(arg))command=arg as Command;
  else throw new UsageError(`Unknown argument: ${arg}`);
 }
 if(!command)throw new UsageError('A command is required');
 const win=platform==='win32';const path=win?win32:posix;
 dir??=setting(env,'TERMWEAVE_INSTALL_DIR',platform);
 if(dir===undefined){
  const base=setting(env,win?'LOCALAPPDATA':'HOME',platform);
  if(!base||!path.isAbsolute(base))throw new UsageError(`${win?'LOCALAPPDATA':'HOME'} must be an absolute path to choose the default --dir`);
  dir=win?path.join(base,'termweave-owned'):path.join(base,'.local','share','termweave-owned');
 }
 port??=setting(env,'PORT',platform)??String(DEFAULT_PORT);
 if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw new UsageError(`Invalid port: ${port}`);
 return {command,dir:path.resolve(cwd,dir),port:Number(port),start,yes};
}
const installed=(dir:string)=>!!statSync(join(dir,'.termweave-owned.json'),{throwIfNoEntry:false})?.isFile();
/** install.sh check_prereqs: git, bun >= MIN_BUN and herdr >= MIN_HERDR everywhere; Node >= 18 only off Windows (terminal sidecar). */
export function prerequisites({env,platform,out,err,version}:Context):boolean{
 const win=platform==='win32';let complete=true;
 const miss=(line:string)=>{err(`MISS  ${line}`);complete=false;};
 const git=findExecutable('git',{env,platform});
 if(git)out(`ok    git ${version(git,env)??''}`.trimEnd());
 else miss(`git not found. Fix: ${win?'winget install --id Git.Git -e':"macOS 'xcode-select --install', Debian/Ubuntu 'sudo apt install git'"}`);
 const tool=(name:string,minimum:string,fix:string,upgrade:string)=>{
  const executable=findExecutable(name,{env,platform});
  if(!executable)return miss(`${name} not found. Fix: ${fix}`);
  const found=version(executable,env);
  if(found&&versionGe(found,minimum))out(`ok    ${name} ${found}`);else miss(`${name} ${found??'unknown'} is older than ${minimum}. Fix: ${upgrade}`);
 };
 tool('bun',MIN_BUN,win?'powershell -c "irm bun.sh/install.ps1 | iex"   (or rerun with --yes)':'curl -fsSL https://bun.sh/install | bash   (or rerun with --yes)','bun upgrade');
 if(!win)tool('node',String(MIN_NODE),`install Node ${MIN_NODE}+ from https://nodejs.org, nvm or Homebrew ('brew install node')`,`install Node ${MIN_NODE}+ from https://nodejs.org`);
 tool('herdr',MIN_HERDR,win?'irm https://herdr.dev/install.ps1 | iex   (or rerun with --yes)':'curl -fsSL https://herdr.dev/install.sh | sh   (or rerun with --yes; docs: https://herdr.dev/docs/install/)','herdr update');
 if(!complete)err('Missing prerequisites. Run the Fix commands above, then rerun the installer.');
 return complete;
}
/** Read-only: 0 installed and our instance running, 1 not installed or not running, 2 missing prerequisite. */
export async function check(options:Options,context:Context):Promise<number>{
 if(!prerequisites(context))return 2;
 const {dir,port}=options;const url=`http://127.0.0.1:${port}`;let code=0;
 if(installed(dir))context.out(`ok    installed at ${dir}`);else{context.err(`MISS  not installed at ${dir} (run the installer)`);code=1;}
 // Same level as install.sh ours_running: lifecycle.json present and /api/health answers ok. 3C/3D에서 identity/boot_id 판정으로 교체.
 const healthy=await context.healthy(port);
 if(existsSync(join(dir,'lifecycle.json'))&&healthy)context.out(`ok    server answers ${url}/api/health`);
 else if(healthy){context.out(`note  ${url} answers, but not from this install (another server owns port ${port})`);code=1;}
 else{context.err(`MISS  no server answers ${url}/api/health`);code=1;}
 return code;
}
/** install.sh step 3: reuse an existing install, refuse an existing non-install path, otherwise installOwned into a new root. */
export function install(options:Options,context:Context):number{
 if(!prerequisites(context))return 2;
 const {dir}=options;const fail=(line:string)=>{context.err(`FAIL  ${line}`);return 1;};
 if(installed(dir)){context.out(`ok    already installed at ${dir} (reused)`);return 0;}
 if(lstatSync(dir,{throwIfNoEntry:false}))return fail(`${dir} exists but is not a TermWeave install. Remove it or pass --dir NEW_PATH`);
 const judged=judgeDestination(dir,context.source,{platform:context.platform,env:context.env});
 if('refused' in judged){
  if(judged.refused!=='missing parent')return fail(`cannot install into ${dir} (${judged.refused}). Pass --dir NEW_PATH`);
  try{mkdirSync(dirname(dir),{recursive:true});}catch{return fail(`cannot create ${dirname(dir)}`);}
 }
 context.out(`Installing dependencies and building into ${dir} (takes about a minute)...`);
 try{installOwned(context.source,dir);}
 catch(error){return fail(`install failed (${error instanceof Error?error.message:String(error)}). The source checkout must be a clean git clone (no local edits): git status`);}
 if(!installed(dir))return fail('install did not finish');
 context.out(`ok    installed and built at ${dir}`);return 0;
}
export async function main(argv:string[],context:Context):Promise<number>{
 let options:Options|undefined;
 try{options=parseArgs(argv,context);}
 catch(error){if(!(error instanceof UsageError))throw error;context.err(error.message);context.err(USAGE);return 1;}
 if(!options){context.out(USAGE);return 0;}
 if(options.command==='check')return check(options,context);
 if(options.command==='install')return install(options,context);
 context.err(`FAIL  ${options.command}: not yet: 3C/3D`);return 1;
}
async function healthy(port:number):Promise<boolean>{
 try{const response=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(3000)});return response.ok&&(await response.json() as {ok?:unknown})?.ok===true;}
 catch{return false;}
}
if(import.meta.main)process.exitCode=await main(process.argv.slice(2),{
 env:process.env,platform:process.platform,cwd:process.cwd(),out:line=>console.log(line),err:line=>console.error(line),
 version:toolVersion,healthy,source:resolve(import.meta.dir,'..'),
});
