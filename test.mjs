import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,stat,readdir,rename,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,basename,dirname} from 'node:path';
import {Backup,SHA256,FORMAT,META,restore,inspectArchive,hashFile,readJSON,writeJSON,validPath,scan,TargetLease,verifyHistory,deploymentPolicy,pathCollisions,LEASE_TTL} from './backup.mjs';

const unreadablePaths=new Set();
function missing(){return new DOMException('Not found','NotFoundError');}
class Dir {
  constructor(path){this.path=path;this.kind='directory';this.name=basename(path);}
  async *entries(){for(const entry of await readdir(this.path,{withFileTypes:true})){yield [entry.name,entry.isDirectory()?new Dir(join(this.path,entry.name)):new Handle(join(this.path,entry.name))];}}
  async getDirectoryHandle(name,{create=false}={}){const path=join(this.path,name);try{if(!(await stat(path)).isDirectory())throw new DOMException('Not a directory','TypeMismatchError');}catch(e){if(e.code!=='ENOENT')throw e;if(!create)throw missing();await mkdir(path);}return new Dir(path);}
  async getFileHandle(name,{create=false}={}){const path=join(this.path,name);try{const info=await stat(path);if(!info.isFile())throw new DOMException('Not a file','TypeMismatchError');}catch(e){if(e.code!=='ENOENT')throw e;if(!create)throw missing();await writeFile(path,'');}return new Handle(path);}
  async isSameEntry(other){return this.path===other.path;}
  async resolve(other){if(!other.path)return null;const rel=relative(this.path,other.path);return rel.startsWith('..')||isAbsolute(rel)?null:rel?rel.split(/[\\/]/):[];}
}
class Handle {
  constructor(path){this.path=path;this.kind='file';this.name=basename(path);}
  async getFile(){if(unreadablePaths.has(this.path))throw new DOMException("Synthetic locked file","NotReadableError");const info=await stat(this.path);return new File([await readFile(this.path)],this.name,{lastModified:Math.trunc(info.mtimeMs)});}
  async createWritable(){const path=this.path;let chunks=[];return {async write(value){chunks.push(typeof value==='string'?Buffer.from(value):Buffer.from(value));},async close(){await writeFile(path+'.fixture-temp',Buffer.concat(chunks));await rename(path+'.fixture-temp',path);},async abort(){chunks=[];}};}
}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'project-save-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const sourcePath=join(root,'source'),targetPath=join(root,'backup');await mkdir(sourcePath);await mkdir(targetPath);const profile={id:'test-project-id',source:new Dir(sourcePath),target:new Dir(targetPath)};const engine=()=>new Backup(profile);return {root,sourcePath,targetPath,profile,engine};}
const text=(path,value)=>writeFile(path,value,'utf8');

test('streaming SHA-256 matches independent Node crypto vectors and chunk boundaries',()=>{for(const size of [0,1,3,55,56,63,64,65,127,128,1000,1048576]){const data=Buffer.alloc(size);for(let i=0;i<size;i++)data[i]=(i*31)%256;for(const chunkSize of [1,63,65,65536]){const hash=new SHA256();for(let i=0;i<size;i+=chunkSize)hash.update(data.subarray(i,i+chunkSize));assert.equal(hash.hex(),createHash('sha256').update(data).digest('hex'));}}});
test('preview is read-only; first copy and full verify pass; unchanged repeat transfers zero',async t=>{const f=await fixture(t);await text(join(f.sourcePath,'first.txt'),'hello');const preview=await f.engine().preview();assert.deepEqual(preview.changed,['first.txt']);assert.deepEqual(await readdir(f.targetPath),[]);assert.equal((await f.engine().copy()).copied,1);assert.equal((await f.engine().verify()).verified,true);assert.equal((await f.engine().copy()).copied,0);});
test('new and modified files copy; prior Unicode long path archived and historical restore succeeds',async t=>{const f=await fixture(t);const nested='संस्कृत-'+('long-'.repeat(25));await mkdir(join(f.sourcePath,nested));await text(join(f.sourcePath,nested,'मन्त्र.txt'),'original text');await f.engine().copy();await text(join(f.sourcePath,nested,'मन्त्र.txt'),'changed text');await text(join(f.sourcePath,'new.txt'),'new');const result=await f.engine().copy();assert.equal(result.copied,2);const output=new Dir(join(f.root,'historical'));await mkdir(output.path);const restored=await restore(f.profile.target,output,()=>{},result.history);assert.equal(restored.restored,1);assert.equal(await readFile(join(output.path,nested,'मन्त्र.txt'),'utf8'),'original text');assert.deepEqual(await readdir(output.path),[nested]);});
test('deleted source files stay on backup but are excluded from active restore set',async t=>{const f=await fixture(t);await text(join(f.sourcePath,'delete.txt'),'keep old');await f.engine().copy();await rm(join(f.sourcePath,'delete.txt'));const result=await f.engine().copy();assert.deepEqual(result.stale,['delete.txt']);assert.equal(await readFile(join(f.targetPath,'current','delete.txt'),'utf8'),'keep old');const output=new Dir(join(f.root,'restored'));await mkdir(output.path);assert.equal((await restore(f.profile.target,output)).restored,0);const historyOutput=new Dir(join(f.root,'historical'));await mkdir(historyOutput.path);await restore(f.profile.target,historyOutput,()=>{},result.history);assert.equal(await readFile(join(historyOutput.path,'delete.txt'),'utf8'),'keep old');});
test('excludes secrets, databases and caches while preserving required assets and example configuration',async t=>{const f=await fixture(t);for(const name of ['.env','.env.local','credentials.json','private.pem','data.db','data.db-wal','.env.example','asset.pdf','icon.png','lock.json'])await text(join(f.sourcePath,name),'x');await mkdir(join(f.sourcePath,'node_modules'));await text(join(f.sourcePath,'node_modules','dependency'),'x');const plan=await f.engine().preview();assert.deepEqual(Object.keys(plan.files).sort(),['.env.example','asset.pdf','icon.png','lock.json']);assert.equal(plan.skipped.length,7);});
test('nested folders, same folders, unrelated destination and another project identity are refused',async t=>{const f=await fixture(t);await assert.rejects(new Backup({...f.profile,target:f.profile.source}).preview(),/separate folders/);const child=await f.profile.source.getDirectoryHandle('nested',{create:true});await assert.rejects(new Backup({...f.profile,target:child}).preview(),/separate folders/);await text(join(f.targetPath,'existing'),'do not touch');await assert.rejects(f.engine().preview(),/empty dedicated/);await rm(join(f.targetPath,'existing'));await f.engine().copy();await assert.rejects(new Backup({...f.profile,id:'other-project'}).preview(),/another saved project/);});
test('full verify detects corruption with preserved size and time and next backup repairs it',async t=>{const f=await fixture(t);await text(join(f.sourcePath,'file'),'first');await f.engine().copy();const path=join(f.targetPath,'current','file'),info=await stat(path);await text(path,'wrong');await utimes(path,info.atime,info.mtime);const verified=await f.engine().verify();assert.equal(verified.verified,false);assert.deepEqual(verified.errors,['file']);assert.equal((await f.engine().copy()).copied,1);assert.equal((await f.engine().verify()).verified,true);});
test('full verify detects source drift and new files separately from valid saved backup',async t=>{const f=await fixture(t);await text(join(f.sourcePath,'file'),'first');await f.engine().copy();const info=await stat(join(f.sourcePath,'file'));await text(join(f.sourcePath,'file'),'other');await utimes(join(f.sourcePath,'file'),info.atime,info.mtime);await text(join(f.sourcePath,'added'),'new');const result=await f.engine().verify();assert.equal(result.verified,true);assert.deepEqual(result.sourceChanges,['file']);assert.deepEqual(result.newFiles,['added']);assert.equal((await f.engine().copy()).copied,2);});
test('interruption during a multi-file copy preserves old manifest and supports verified restore and retry',async t=>{const f=await fixture(t);await text(join(f.sourcePath,'a'),'old a');await text(join(f.sourcePath,'b'),'old b');await f.engine().copy();await text(join(f.sourcePath,'a'),'new a');await text(join(f.sourcePath,'b'),'new b');let copies=0;const broken=new Backup(f.profile,message=>{if(message.startsWith('Copying')&&++copies===2)throw Error('Simulated drive disconnect');});await assert.rejects(broken.copy(),/Simulated drive/);const operation=await readJSON(f.profile.target,META+'/operation.json');assert.equal(operation.complete,false);const output=new Dir(join(f.root,'recovered'));await mkdir(output.path);await restore(f.profile.target,output);assert.equal(await readFile(join(output.path,'a'),'utf8'),'old a');assert.equal(await readFile(join(output.path,'b'),'utf8'),'old b');await assert.rejects(f.engine().copy(),/previous backup was interrupted/);await f.engine().copy({recoverInterrupted:true});assert.equal((await f.engine().verify()).verified,true);});
test('restore refuses nonempty output and does not require source folder',async t=>{const f=await fixture(t);await text(join(f.sourcePath,'file'),'original');await f.engine().copy();await rm(f.sourcePath,{recursive:true});const output=new Dir(join(f.root,'restored'));await mkdir(output.path);await text(join(output.path,'existing'),'keep');await assert.rejects(restore(f.profile.target,output),/empty folder/);assert.equal(await readFile(join(output.path,'existing'),'utf8'),'keep');await rm(join(output.path,'existing'));assert.equal((await restore(f.profile.target,output)).verified,true);assert.equal(await readFile(join(output.path,'file'),'utf8'),'original');});
test('corrupt archive is refused before historical restore writes files',async t=>{const f=await fixture(t);await text(join(f.sourcePath,'file'),'original');await f.engine().copy();await text(join(f.sourcePath,'file'),'updated');const saved=await f.engine().copy();await text(join(f.targetPath,'history',saved.history),'corrupt');const output=new Dir(join(f.root,'restore'));await mkdir(output.path);await assert.rejects(restore(f.profile.target,output,()=>{},saved.history),/checksum failed/);assert.deepEqual(await readdir(output.path),[]);});
test('malicious manifest paths are refused and cannot escape restore folder',async t=>{for(const path of ['../escape','/absolute','a\\b','C:drive','a/../b','a//b'])assert.throws(()=>validPath(path),/Unsafe/);const f=await fixture(t);await f.engine().copy();await writeJSON(f.profile.target,META+'/manifest.json',{format:FORMAT,files:{'../escape':{size:0,sha256:'0'.repeat(64)}}});await assert.rejects(f.engine().preview(),/Unsafe/);});
test('truncated gzip archives are rejected',async t=>{const f=await fixture(t);await text(join(f.sourcePath,'file'),'old');await f.engine().copy();await text(join(f.sourcePath,'file'),'new');const result=await f.engine().copy();const file=await (await f.profile.target.getDirectoryHandle('history')).getFileHandle(result.history);const bytes=await readFile(file.path);await assert.rejects(inspectArchive(new File([bytes.subarray(0,bytes.length-5)],'truncated.gz')));});
test('addition-only checkpoint restores exact previous file set across multiple later versions',async t=>{const f=await fixture(t);await text(join(f.sourcePath,'one'),'v1');await f.engine().copy();await text(join(f.sourcePath,'two'),'added');const added=await f.engine().copy();await text(join(f.sourcePath,'one'),'v3');await f.engine().copy();await text(join(f.sourcePath,'one'),'v4');await f.engine().copy();const output=new Dir(join(f.root,'old'));await mkdir(output.path);await restore(f.profile.target,output,()=>{},added.history);assert.deepEqual(await readdir(output.path),['one']);assert.equal(await readFile(join(output.path,'one'),'utf8'),'v1');});

test('deployment gate refuses frames and unconfigured shared origins before file access',()=>{
  assert.equal(deploymentPolicy('127.0.0.1','http://127.0.0.1:8766',true),'');
  assert.match(deploymentPolicy('localhost','http://localhost:8766',false),/inside a frame/);
  assert.match(deploymentPolicy('account.github.io','https://account.github.io',true),/exclusive custom HTTPS origin/);
  assert.match(deploymentPolicy('wrong.example','https://wrong.example',true,'https://dedicated.example'),/disabled/);
  assert.equal(deploymentPolicy('dedicated.example','https://dedicated.example',true,'https://dedicated.example'),'');
});
test('expanded credential exclusions and explicit overrides preserve intentional work',async t=>{
  const f=await fixture(t);
  for(const name of ['id_rsa','id_ed25519','.npmrc','.netrc','.git-credentials','.pypirc','.envrc','cert.p12','cert.pfx','app.keystore','store.jks','service-account.json','talk.key','notes.db'])await text(join(f.sourcePath,name),'x');
  for(const name of ['.ssh','.aws','.gnupg','.docker','.kube','build']){await mkdir(join(f.sourcePath,name));await text(join(f.sourcePath,name,'content'),'x');}
  await text(join(f.sourcePath,'.ssh','id_ed25519.pub'),'public');
  assert.deepEqual(Object.keys((await f.engine().preview()).files),[]);
  const p={...f.profile,includePaths:['talk.key','notes.db','build/content','.ssh/id_ed25519.pub']};
  const preview=await new Backup(p).preview();assert.deepEqual(Object.keys(preview.files).sort(),['.ssh/id_ed25519.pub','build/content','notes.db','talk.key']);
  assert.equal((await new Backup(p).copy()).copied,4);assert.equal((await new Backup(p).verify()).verified,true);
});
test('locked source records a partial first backup and protects readable files',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'readable'),'saved');await text(join(f.sourcePath,'locked'),'not readable');const path=join(f.sourcePath,'locked');unreadablePaths.add(path);t.after(()=>unreadablePaths.delete(path));
  const result=await f.engine().copy();assert.equal(result.backupComplete,false);assert.equal(result.copied,1);assert.equal(result.failed[0].path,'locked');
  const manifest=await readJSON(f.profile.target,META+'/manifest.json');assert.equal(manifest.complete,false);assert.deepEqual(Object.keys(manifest.files),['readable']);
  const last=await readJSON(f.profile.target,META+'/last-result.json');assert.equal(last.backupComplete,false);
  const output=new Dir(join(f.root,'partial-restore'));await mkdir(output.path);const restored=await restore(f.profile.target,output);assert.equal(restored.manifestIncomplete,true);assert.equal(restored.restored,1);assert.equal(restored.verified,false);assert.equal(restored.protectedFilesVerified,true);
  unreadablePaths.delete(path);assert.equal((await f.engine().copy()).backupComplete,true);
});
test('locked existing source keeps its previous entry while other changed files commit',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'locked'),'old value');await text(join(f.sourcePath,'other'),'old other');await f.engine().copy();
  const previous=(await readJSON(f.profile.target,META+'/manifest.json')).files.locked;await text(join(f.sourcePath,'other'),'new other');
  const path=join(f.sourcePath,'locked');unreadablePaths.add(path);t.after(()=>unreadablePaths.delete(path));const result=await f.engine().copy();assert.equal(result.backupComplete,false);assert.equal(result.copied,1);assert.deepEqual((await readJSON(f.profile.target,META+'/manifest.json')).files.locked,previous);
  assert.equal(await readFile(join(f.targetPath,'current','other'),'utf8'),'new other');
});
test('live on-drive lease blocks a second writer and is not overwritten',async t=>{
  const f=await fixture(t);await f.engine().copy();const first=await new TargetLease(f.profile.target).acquire();
  try{await assert.rejects(f.engine().copy(),/live backup lease/);await assert.rejects(new TargetLease(f.profile.target).acquire(),/live backup lease/);assert.equal((await readJSON(f.profile.target,META+'/lease.json')).id,first.id);}finally{await first.release();}
  assert.equal((await f.engine().copy()).backupComplete,true);
});
test('interrupted record requires explicit recovery even when its old lease is expired',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'file'),'old');await f.engine().copy();await writeJSON(f.profile.target,META+'/operation.json',{complete:false});await writeJSON(f.profile.target,META+'/lease.json',{id:'stale',heartbeat:Date.now()-LEASE_TTL-1,expires:Date.now()-1,released:false});
  assert.equal((await f.engine().preview()).interrupted,true);await assert.rejects(f.engine().copy(),e=>e.recoveryRequired===true);assert.equal((await f.engine().copy({recoverInterrupted:true})).backupComplete,true);
});
test('lost lease is detected before changed files and new manifest are committed',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'file'),'old');await f.engine().copy();const old=await readFile(join(f.targetPath,META,'manifest.json'),'utf8');await text(join(f.sourcePath,'file'),'new value');
  const engine=f.engine(),original=engine.archivePrevious.bind(engine);engine.archivePrevious=async paths=>{const result=await original(paths);await writeJSON(f.profile.target,META+'/lease.json',{id:'other-writer',heartbeat:Date.now(),expires:Date.now()+LEASE_TTL,released:false});return result;};
  await assert.rejects(engine.copy(),/lease was lost/);assert.equal(await readFile(join(f.targetPath,META,'manifest.json'),'utf8'),old);assert.equal(await readFile(join(f.targetPath,'current','file'),'utf8'),'old');
});
test('historical restore groups forty archived members into three decompressions total',async t=>{
  const f=await fixture(t);for(let i=0;i<40;i++)await text(join(f.sourcePath,'f'+i),'v1-'+i);await f.engine().copy();for(let i=0;i<40;i++)await text(join(f.sourcePath,'f'+i),'v2-'+i+'-longer');const copied=await f.engine().copy();
  const output=new Dir(join(f.root,'restore40'));await mkdir(output.path);const Original=globalThis.DecompressionStream;let count=0;globalThis.DecompressionStream=class extends Original{constructor(...args){super(...args);count++;}};
  try{assert.equal((await restore(f.profile.target,output,()=>{},copied.history)).restored,40);}finally{globalThis.DecompressionStream=Original;}
  assert.equal(count,3);
});
test('empty archived members restore and corrupted metadata has clear validation errors',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'empty'),'');await f.engine().copy();await text(join(f.sourcePath,'empty'),'not empty');const copied=await f.engine().copy();const output=new Dir(join(f.root,'zero'));await mkdir(output.path);await restore(f.profile.target,output,()=>{},copied.history);assert.equal((await stat(join(output.path,'empty'))).size,0);
  await writeJSON(f.profile.target,META+'/history.json',{archives:[{name:'bad.tar.gz'}]});await assert.rejects(verifyHistory(f.profile.target),e=>!(e instanceof TypeError)&&/Damaged history index/.test(e.message));
  await writeJSON(f.profile.target,META+'/manifest.json',{format:FORMAT,files:{file:null}});await assert.rejects(f.engine().preview(),e=>!(e instanceof TypeError)&&/Damaged backup manifest/.test(e.message));
});
test('optional history verification detects archive corruption without modifying current files',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'file'),'old');await f.engine().copy();await text(join(f.sourcePath,'file'),'new value');const copied=await f.engine().copy();assert.equal((await f.engine().verify({history:true})).verified,true);await text(join(f.targetPath,'history',copied.history),'corrupt');
  assert.equal((await f.engine().verify()).verified,true);const result=await f.engine().verify({history:true});assert.equal(result.verified,false);assert.equal(result.historyResult.errors[0].path,copied.history);assert.equal(await readFile(join(f.targetPath,'current','file'),'utf8'),'new value');
});
test('verification does not silently take over an interrupted write',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'file'),'saved');await f.engine().copy();await writeJSON(f.profile.target,META+'/operation.json',{complete:false});
  const before=await readFile(join(f.targetPath,META,'lease.json'),'utf8');
  const result=await f.engine().verify();assert.equal(result.interrupted,true);assert.equal(result.readOnly,true);assert.equal(result.verified,true);
  assert.equal((await readJSON(f.profile.target,META+'/operation.json')).complete,false);assert.equal(await readFile(join(f.targetPath,META,'lease.json'),'utf8'),before);
});
test('source stream read failures abort the swap and retain the old protected bytes',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'file'),'old bytes');await f.engine().copy();await text(join(f.sourcePath,'file'),'new source bytes');
  const original=Handle.prototype.getFile;
  Handle.prototype.getFile=async function(){const file=await original.call(this);if(this.path===join(f.sourcePath,'file')){file.stream=()=>new ReadableStream({start(controller){controller.error(new DOMException('Synthetic stream lock','NotReadableError'));}});}return file;};
  try{const result=await f.engine().copy();assert.equal(result.backupComplete,false);assert.equal(result.failed[0].path,'file');assert.equal(await readFile(join(f.targetPath,'current','file'),'utf8'),'old bytes');}finally{Handle.prototype.getFile=original;}
});
test('an unreadable directory retains previous descendant entries and labels the run partial',async t=>{
  const f=await fixture(t);await mkdir(join(f.sourcePath,'nested'));await text(join(f.sourcePath,'nested','file'),'old');await text(join(f.sourcePath,'other'),'old');await f.engine().copy();await text(join(f.sourcePath,'other'),'new other');
  const original=Dir.prototype.entries;
  Dir.prototype.entries=async function*(){if(this.path===join(f.sourcePath,'nested'))throw new DOMException('Synthetic directory lock','NotReadableError');yield* original.call(this);};
  try{const result=await f.engine().copy();assert.equal(result.backupComplete,false);assert.equal(result.copied,1);assert.equal(result.failed[0].scope,'directory');assert.ok((await readJSON(f.profile.target,META+'/manifest.json')).files['nested/file']);}finally{Dir.prototype.entries=original;}
});
test('source stream construction errors are recorded rather than aborting readable files',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'locked'),'failed source');await text(join(f.sourcePath,'other'),'readable');const original=Handle.prototype.getFile;
  Handle.prototype.getFile=async function(){const file=await original.call(this);if(this.path===join(f.sourcePath,'locked'))file.stream=()=>{throw new DOMException('Synthetic stream creation failure','NotReadableError');};return file;};
  try{const result=await f.engine().copy();assert.equal(result.backupComplete,false);assert.equal(result.copied,1);assert.equal(result.failed[0].path,'locked');}finally{Handle.prototype.getFile=original;}
});

class MemoryFile{constructor(name,value){this.kind='file';this.name=name;this.value=new File([value],name,{lastModified:1700000000000});}async getFile(){return this.value;}}
class MemoryDir{constructor(name,children){this.kind='directory';this.name=name;this.children=children;}async *entries(){for(const child of this.children)yield [child.name,child];}async isSameEntry(){return false;}async resolve(){return null;}}
test('case and Unicode name collisions are excluded before writing, including directory aliases',async t=>{
  assert.deepEqual([...pathCollisions(['Notes.txt','notes.txt','safe'])].sort(),['Notes.txt','notes.txt']);
  assert.equal(pathCollisions(['café.txt','cafe\u0301.txt']).size,2);
  assert.equal(pathCollisions(['A/one','a/two']).size,0);
  assert.equal(pathCollisions(['A/one','a/ONE','a/two']).size,2);
  assert.equal(pathCollisions(['A','a/two']).size,2);
  assert.equal(pathCollisions(['file','file/nested']).size,2);
  const f=await fixture(t),source=new MemoryDir('source',[new MemoryFile('Notes.txt','UPPER'),new MemoryFile('notes.txt','lower'),new MemoryFile('safe.txt','safe')]);
  const result=await new Backup({...f.profile,source}).copy();assert.equal(result.backupComplete,false);assert.equal(result.copied,1);assert.equal(result.failed.length,2);assert.deepEqual(await readdir(join(f.targetPath,'current')),['safe.txt']);
});
test('restore recovers healthy files despite missing, corrupt or colliding members',async t=>{
  const f=await fixture(t);for(const name of ['good','bad','missing'])await text(join(f.sourcePath,name),'value-'+name);await f.engine().copy();await text(join(f.targetPath,'current','bad'),'damaged');await rm(join(f.targetPath,'current','missing'));
  const manifest=await readJSON(f.profile.target,META+'/manifest.json');manifest.files['Notes.txt']={...manifest.files.good};manifest.files['notes.txt']={...manifest.files.good};await writeJSON(f.profile.target,META+'/manifest.json',manifest);
  const output=new Dir(join(f.root,'partial'));await mkdir(output.path);const result=await restore(f.profile.target,output);assert.equal(result.verified,false);assert.equal(result.restoreComplete,false);assert.equal(result.restored,1);assert.equal(result.failed.length,4);assert.equal(await readFile(join(output.path,'good'),'utf8'),'value-good');
});
test('failed repair keeps its damage flag until a successful recopy',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'x'),'good');await f.engine().copy();const target=join(f.targetPath,'current','x'),info=await stat(target);await text(target,'BAD!');await utimes(target,info.atime,info.mtime);assert.deepEqual((await f.engine().verify()).errors,['x']);
  const source=join(f.sourcePath,'x');unreadablePaths.add(source);t.after(()=>unreadablePaths.delete(source));const partial=await f.engine().copy();assert.equal(partial.backupComplete,false);assert.deepEqual((await readJSON(f.profile.target,META+'/findings.json')).repair,['x']);
  unreadablePaths.delete(source);const repaired=await f.engine().copy();assert.equal(repaired.copied,1);assert.equal(repaired.backupComplete,true);assert.equal(await readFile(target,'utf8'),'good');assert.deepEqual((await readJSON(f.profile.target,META+'/findings.json')).repair,[]);
});
test('inline lease renews without timers, even after its own expiry, and refuses a different owner',async t=>{
  const f=await fixture(t);await f.engine().copy();const originalNow=Date.now,originalInterval=globalThis.setInterval,baseNow=Date.now();let offset=0;Date.now=()=>baseNow+offset;globalThis.setInterval=()=>0;
  let lease;
  try{lease=await new TargetLease(f.profile.target).acquire();offset=61000;await lease.assert();const first=await readJSON(f.profile.target,META+'/lease.json');assert.equal(first.heartbeat,Date.now());assert.ok(first.expires>Date.now());offset=2*LEASE_TTL+1000;await lease.assert();assert.equal((await readJSON(f.profile.target,META+'/lease.json')).heartbeat,Date.now());await writeJSON(f.profile.target,META+'/lease.json',{id:'new-owner',heartbeat:Date.now(),expires:Date.now()+LEASE_TTL,released:false});await assert.rejects(lease.assert(),/lease was lost/);}finally{if(lease)await lease.release();Date.now=originalNow;globalThis.setInterval=originalInterval;}
});
test('long streamed hashing invokes inline checkpoints before file end',async()=>{
  const file=new File([new Uint8Array(9*1024*1024)],'synthetic-large');let checkpoints=0;await hashFile(file,async()=>{checkpoints++;});assert.ok(checkpoints>=1);
});
test('folder include overrides still exclude nested credentials and caches unless explicitly named',async t=>{
  const f=await fixture(t);await mkdir(join(f.sourcePath,'build','keep','node_modules'),{recursive:true});for(const name of ['.env','id_rsa','report.docx'])await text(join(f.sourcePath,'build','keep',name),'value');await text(join(f.sourcePath,'build','keep','node_modules','dependency'),'dep');
  const p={...f.profile,includePaths:['build/keep']};assert.deepEqual(Object.keys((await new Backup(p).preview()).files),['build/keep/report.docx']);
  p.includePaths.push('build/keep/.env');assert.deepEqual(Object.keys((await new Backup(p).preview()).files).sort(),['build/keep/.env','build/keep/report.docx']);
});
test('invalid failure lists and suspicious leases produce actionable refusals',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'file'),'value');await f.engine().copy();const manifest=await readJSON(f.profile.target,META+'/manifest.json');manifest.failed='not a list';await writeJSON(f.profile.target,META+'/manifest.json',manifest);const output=new Dir(join(f.root,'refused'));await mkdir(output.path);await assert.rejects(restore(f.profile.target,output),/Damaged manifest failures/);assert.deepEqual(await readdir(output.path),[]);
  delete manifest.failed;await writeJSON(f.profile.target,META+'/manifest.json',manifest);await writeJSON(f.profile.target,META+'/lease.json',{id:'future',heartbeat:Date.now(),expires:Date.now()+10*LEASE_TTL,released:false});await assert.rejects(f.engine().copy(),/Suspicious backup lease timestamp/);
});
test('interrupted verification is read-only and retains repair flags and incomplete operation state',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'file'),'value');await f.engine().copy();await writeJSON(f.profile.target,META+'/operation.json',{complete:false});await writeJSON(f.profile.target,META+'/findings.json',{repair:['file']});
  const snapshot=async()=>{const values={};for(const name of await readdir(join(f.targetPath,META)))values[name]=await readFile(join(f.targetPath,META,name),'utf8');return values;};const before=await snapshot();const result=await f.engine().verify({history:true});assert.equal(result.readOnly,true);assert.equal(result.interrupted,true);assert.deepEqual(await snapshot(),before);
});
test('configured github.io hosts are refused at both root and project paths',()=>{
  for(const path of ['/','/project-save/'])assert.match(deploymentPolicy('user.github.io','https://user.github.io',true,'https://user.github.io',path),/disabled/);
  assert.equal(deploymentPolicy('exclusive.example','https://exclusive.example',true,'https://exclusive.example','/'),'');
});

test('unsupported portable source names fail individually, persist safely and do not stop siblings',async t=>{
  const f=await fixture(t),bad=['meeting 10:30.txt','why?.txt','star*.txt','trailing.','space ','CON','aux.txt','COM1.log','quote".txt','less<.txt','pipe|.txt','slash\\.txt'];
  const source=new MemoryDir('source',[new MemoryFile('a.txt','a'),...bad.map(n=>new MemoryFile(n,'bad')),new MemoryDir('bad:dir',[new MemoryFile('child','bad')]),new MemoryDir('docs',[new MemoryFile('z.txt','z')])]);
  const engine=()=>new Backup({...f.profile,source});
  for(let i=0;i<2;i++){const result=await engine().copy();assert.equal(result.backupComplete,false);assert.equal(result.failed.length,bad.length+1);assert.equal(result.copied,i===0?2:0);assert.deepEqual(result.pendingRepairs,[]);assert.equal((await readJSON(f.profile.target,META+'/operation.json')).complete,true);}
  const output=new Dir(join(f.root,'restore-names'));await mkdir(output.path);const restored=await restore(f.profile.target,output);assert.equal(restored.restored,2);assert.equal(restored.verified,false);assert.equal(await readFile(join(output.path,'docs','z.txt'),'utf8'),'z');
});

test('a destination entry creation error is partial but quota failures still interrupt',async t=>{
  const f=await fixture(t);for(const name of ['a','bad','z'])await text(join(f.sourcePath,name),name);
  const original=Dir.prototype.getFileHandle;
  Dir.prototype.getFileHandle=async function(name,options={}){if(this.path===join(f.targetPath,'current')&&name==='bad'&&options.create)throw new DOMException('Name refused by target','InvalidModificationError');return original.call(this,name,options);};
  try{const result=await f.engine().copy();assert.equal(result.backupComplete,false);assert.equal(result.copied,2);assert.deepEqual(result.pendingRepairs,['bad']);assert.equal((await readJSON(f.profile.target,META+'/operation.json')).complete,true);}finally{Dir.prototype.getFileHandle=original;}
  Dir.prototype.getFileHandle=async function(name,options={}){if(this.path===join(f.targetPath,'current')&&name==='bad'&&options.create)throw new DOMException('Disk full','QuotaExceededError');return original.call(this,name,options);};
  try{await assert.rejects(f.engine().copy(),{name:'QuotaExceededError'});assert.equal((await readJSON(f.profile.target,META+'/operation.json')).complete,false);}finally{Dir.prototype.getFileHandle=original;}
});

test('a target file-directory conflict uses alternate storage and protects unrelated files',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'file'),'old');await f.engine().copy();await rm(join(f.sourcePath,'file'));await mkdir(join(f.sourcePath,'file'));await text(join(f.sourcePath,'file','child'),'nested');await text(join(f.sourcePath,'safe'),'safe');
  const original=Dir.prototype.getDirectoryHandle;
  Dir.prototype.getDirectoryHandle=async function(name,options={}){if(this.path===join(f.targetPath,'current')&&name==='file')throw new DOMException('Existing file blocks folder','TypeMismatchError');return original.call(this,name,options);};
  try{const result=await f.engine().copy();assert.equal(result.backupComplete,true);assert.equal(result.copied,2);assert.equal(await readFile(join(f.targetPath,'current','safe'),'utf8'),'safe');assert.equal(await readFile(join(f.targetPath,'current','file'),'utf8'),'old');}finally{Dir.prototype.getDirectoryHandle=original;}
});

test('deleted or excluded failed paths retire repair flags without deleting saved bytes',async t=>{
  const f=await fixture(t);for(const name of ['gone','excluded'])await text(join(f.sourcePath,name),'old');await f.engine().copy();
  for(const name of ['gone','excluded'])unreadablePaths.add(join(f.sourcePath,name));
  try{assert.equal((await f.engine().copy()).backupComplete,false);}finally{for(const name of ['gone','excluded'])unreadablePaths.delete(join(f.sourcePath,name));}
  await rm(join(f.sourcePath,'gone'));await rename(join(f.sourcePath,'excluded'),join(f.sourcePath,'.env'));
  for(let i=0;i<2;i++){const result=await f.engine().copy();assert.equal(result.backupComplete,true);assert.deepEqual(result.pendingRepairs,[]);assert.equal(result.count,0);}
  assert.equal(await readFile(join(f.targetPath,'current','gone'),'utf8'),'old');assert.equal(await readFile(join(f.targetPath,'current','excluded'),'utf8'),'old');
});

test('directory aliases with distinct leaves copy and restore while genuine clashes remain refused',async t=>{
  const f=await fixture(t),source=new MemoryDir('source',[new MemoryDir('Docs',[new MemoryFile('a.txt','a')]),new MemoryDir('docs',[new MemoryFile('b.txt','b')])]);
  const result=await new Backup({...f.profile,source}).copy();assert.equal(result.backupComplete,true);assert.equal(result.copied,2);
  const output=new Dir(join(f.root,'merged-restore'));await mkdir(output.path);assert.equal((await restore(f.profile.target,output)).verified,true);assert.equal(await readFile(join(output.path,'Docs','a.txt'),'utf8'),'a');assert.equal(await readFile(join(output.path,'docs','b.txt'),'utf8'),'b');
  assert.deepEqual([...pathCollisions(['Docs/a.txt','docs/A.txt','docs/b.txt'])].sort(),['Docs/a.txt','docs/A.txt']);assert.equal(pathCollisions(['Docs/a.txt','docs/a.txt/child']).size,2);
});

test('case-only renames do not label the live backup alias stale',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'Notes.txt'),'note');await f.engine().copy();await rename(join(f.sourcePath,'Notes.txt'),join(f.sourcePath,'notes.txt'));const result=await f.engine().copy();assert.equal(result.backupComplete,true);assert.deepEqual(result.stale,[]);assert.deepEqual(Object.keys((await readJSON(f.profile.target,META+'/manifest.json')).files),['notes.txt']);
});

test('file-folder replacements use mapped storage, preserve blockers, and restore every checkpoint',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'notes'),'original');await f.engine().copy();
  await rm(join(f.sourcePath,'notes'));await mkdir(join(f.sourcePath,'notes'));await text(join(f.sourcePath,'notes','today'),'nested');
  const folder=await f.engine().copy();assert.equal(folder.backupComplete,true);assert.equal('storageMappings' in folder,false);assert.equal('storageMappings' in await f.engine().preview(),false);assert.equal(await readFile(join(f.targetPath,'current','notes'),'utf8'),'original');
  let manifest=await readJSON(f.profile.target,META+'/manifest.json');assert.equal(manifest.format,'project-save-browser-v2');const mapped=manifest.files['notes/today'].targetPath;assert.match(mapped,/^\.project-save\/objects\//);assert.equal((await f.engine().copy()).copied,0);assert.equal((await f.engine().verify({history:true})).verified,true);
  await text(join(f.sourcePath,'notes','today'),'nested v2');const update=await f.engine().copy();assert.equal(update.backupComplete,true);assert.equal((await readJSON(f.profile.target,META+'/manifest.json')).files['notes/today'].targetPath,mapped);
  await rm(join(f.sourcePath,'notes'),{recursive:true});await text(join(f.sourcePath,'notes'),'new file');const file=await f.engine().copy();assert.equal(file.backupComplete,true);assert.equal((await f.engine().copy()).copied,0);assert.equal((await f.engine().verify({history:true})).verified,true);
  for(const [name,checkpoint,path,value]of [['old',folder.history,'notes','original'],['mapped',update.history,'notes/today','nested'],['updated',file.history,'notes/today','nested v2'],['current',null,'notes','new file']]){const output=new Dir(join(f.root,name));await mkdir(output.path);assert.equal((await restore(f.profile.target,output,()=>{},checkpoint)).verified,true);assert.equal(await readFile(join(output.path,path),'utf8'),value);}
});

test('folder-file replacement preserves the old directory and mapped corruption can be repaired',async t=>{
  const f=await fixture(t);await mkdir(join(f.sourcePath,'docs'));await text(join(f.sourcePath,'docs','old'),'old');await f.engine().copy();await rm(join(f.sourcePath,'docs'),{recursive:true});await text(join(f.sourcePath,'docs'),'replacement');
  const result=await f.engine().copy();assert.equal(result.backupComplete,true);assert.equal(await readFile(join(f.targetPath,'current','docs','old'),'utf8'),'old');
  const mapped=(await readJSON(f.profile.target,META+'/manifest.json')).files.docs.targetPath;assert.ok(mapped);assert.equal((await f.engine().copy()).copied,0);assert.equal((await f.engine().verify()).verified,true);
  await text(join(f.targetPath,mapped),'damaged');assert.deepEqual((await f.engine().verify()).errors,['docs']);assert.equal((await f.engine().copy()).copied,1);assert.equal((await f.engine().verify()).verified,true);
  await rm(f.sourcePath,{recursive:true});const output=new Dir(join(f.root,'without-source'));await mkdir(output.path);assert.equal((await restore(f.profile.target,output)).verified,true);assert.equal(await readFile(join(output.path,'docs'),'utf8'),'replacement');
});

test('mapped storage paths are tightly validated before any restore writes',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'a'),'a');await f.engine().copy();const baseline=await readJSON(f.profile.target,META+'/manifest.json');
  for(const targetPath of ['../escape','current/a',META+'/manifest.json',META+'/objects/../lease.json',META+'/objects/not-a-uuid',null]){const manifest=structuredClone(baseline);manifest.format='project-save-browser-v2';manifest.files.a.targetPath=targetPath;await writeJSON(f.profile.target,META+'/manifest.json',manifest);await assert.rejects(f.engine().preview(),/mapped storage/);const output=new Dir(join(f.root,'refused-'+crypto.randomUUID()));await mkdir(output.path);await assert.rejects(restore(f.profile.target,output),/mapped storage/);assert.deepEqual(await readdir(output.path),[]);}
  const manifest=structuredClone(baseline);manifest.format='project-save-browser-v2';manifest.files.a.targetPath=META+'/objects/'+crypto.randomUUID();manifest.files.b={...manifest.files.a};await writeJSON(f.profile.target,META+'/manifest.json',manifest);await assert.rejects(f.engine().preview(),/duplicate mapped/);
  delete manifest.files.b;manifest.format=FORMAT;await writeJSON(f.profile.target,META+'/manifest.json',manifest);await assert.rejects(f.engine().preview(),/mapped storage/);
});

test('macOS Icon carriage-return metadata is skipped before portable name checking',async t=>{
  const f=await fixture(t),source=new MemoryDir('source',[new MemoryFile('Icon\r','metadata'),new MemoryDir('Design',[new MemoryFile('Icon\r','metadata'),new MemoryFile('logo.svg','asset')]),new MemoryFile('Icon','real work')]);
  const result=await new Backup({...f.profile,source}).copy();assert.equal(result.backupComplete,true);assert.equal(result.copied,2);assert.deepEqual(result.skipped,['Icon\r','Design/Icon\r']);assert.deepEqual(result.failed,[]);
});

test('unexpected programming errors in target lookup and creation abort instead of becoming partial',async t=>{
  const f=await fixture(t);await text(join(f.sourcePath,'file'),'work');await f.engine().copy();await text(join(f.sourcePath,'file'),'new work');const original=Dir.prototype.getFileHandle;
  for(const phase of ['lookup','creation'])for(const ErrorType of [TypeError,SyntaxError]){
    Dir.prototype.getFileHandle=async function(name,options={}){if(this.path===join(f.targetPath,'current')&&name==='file'&&(phase==='lookup'||options.create))throw new ErrorType('Synthetic programming bug');return original.call(this,name,options);};
    try{await assert.rejects(f.engine().copy({recoverInterrupted:true}),{name:ErrorType.name,message:'Synthetic programming bug'});assert.equal(await readFile(join(f.targetPath,'current','file'),'utf8'),'work');}finally{Dir.prototype.getFileHandle=original;}
  }
});

test('interrupted mapped overwrites recover the last committed bytes from history and retry safely',async t=>{
  const f=await fixture(t);await mkdir(join(f.sourcePath,'docs'));await text(join(f.sourcePath,'docs','old'),'old');await f.engine().copy();await rm(join(f.sourcePath,'docs'),{recursive:true});await text(join(f.sourcePath,'docs'),'mapped original');await f.engine().copy();
  const mapped=(await readJSON(f.profile.target,META+'/manifest.json')).files.docs.targetPath;await text(join(f.sourcePath,'docs'),'mapped updated');await text(join(f.sourcePath,'zzz'),'second file');let copies=0;
  const interrupted=new Backup(f.profile,message=>{if(message.startsWith('Copying')&&++copies===2)throw Error('Synthetic interruption');});await assert.rejects(interrupted.copy(),/Synthetic interruption/);assert.equal(await readFile(join(f.targetPath,mapped),'utf8'),'mapped updated');
  const output=new Dir(join(f.root,'committed'));await mkdir(output.path);assert.equal((await restore(f.profile.target,output)).verified,true);assert.deepEqual(await readdir(output.path),['docs']);assert.equal(await readFile(join(output.path,'docs'),'utf8'),'mapped original');
  assert.equal((await f.engine().copy({recoverInterrupted:true})).backupComplete,true);assert.equal((await f.engine().verify({history:true})).verified,true);
  await rm(join(f.sourcePath,'docs'));assert.equal((await f.engine().copy()).backupComplete,true);assert.equal(await readFile(join(f.targetPath,mapped),'utf8'),'mapped updated');
});
