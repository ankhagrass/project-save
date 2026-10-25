// Project Save: browser-local backup engine. No dependencies or network requests.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const FORMAT = 'project-save-browser-v1';
const MAPPED_FORMAT = 'project-save-browser-v2';
export const DIR_EXCLUSIONS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.expo', '.cache', 'temp', 'tmp', 'dist', 'build', 'coverage', '.next', 'web-build', 'secrets', '.local-secrets', '.ssh', '.aws', '.gnupg', '.docker', '.kube']);
export const META = '.project-save';
export const LEASE_TTL = 5*60*1000;
const HEARTBEAT_INTERVAL = 15000;
const CHECKPOINT_BYTES = 8*1024*1024;
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rotate = (n,b) => (n >>> b) | (n << (32-b));

export class SHA256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.buffer = new Uint8Array(64); this.used = 0; this.length = 0; this.finished = false;
    this.words = new Uint32Array(64);
  }
  block(bytes) {
    const w = this.words, v = new DataView(bytes.buffer, bytes.byteOffset, 64);
    for(let i=0;i<16;i++) w[i]=v.getUint32(i*4);
    for(let i=16;i<64;i++) {const a=w[i-15], b=w[i-2];w[i]=(w[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+w[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,h]=this.h;
    for(let i=0;i<64;i++) {const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0;const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    const values=[a,b,c,d,e,f,g,h]; for(let i=0;i<8;i++)this.h[i]=(this.h[i]+values[i])>>>0;
  }
  update(bytes) {
    if(this.finished)throw Error('Hash already finalized.');
    if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);
    this.length+=bytes.length;let offset=0;
    if(this.used){const n=Math.min(64-this.used,bytes.length);this.buffer.set(bytes.subarray(0,n),this.used);this.used+=n;offset=n;if(this.used===64){this.block(this.buffer);this.used=0;}}
    while(offset+64<=bytes.length){this.block(bytes.subarray(offset,offset+64));offset+=64;}
    if(offset<bytes.length){this.buffer.set(bytes.subarray(offset),0);this.used=bytes.length-offset;}
    return this;
  }
  hex() {
    if(this.finished)throw Error('Hash already finalized.');
    const length=this.length;this.update(new Uint8Array([128]));
    while(this.used!==56)this.update(new Uint8Array([0]));
    const size=new Uint8Array(8), view=new DataView(size.buffer);
    view.setUint32(0,Math.floor(length/0x20000000));view.setUint32(4,(length*8)>>>0);
    this.update(size);this.finished=true;
    return [...this.h].map(v=>v.toString(16).padStart(8,'0')).join('');
  }
}

export function validPath(path) {
  if(typeof path!=='string'||!path||path.includes('\\')||path.includes('\0')||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':')))throw Error('Unsafe backup path.');
  return path;
}
export function excluded(name, kind) {
  if(kind==='directory')return DIR_EXCLUSIONS.has(name)||name===META;
  return name==='.env'||(name.startsWith('.env.')&&name!=='.env.example')||['credentials.json','service-account.json','id_rsa','id_dsa','id_ecdsa','id_ed25519','.npmrc','.netrc','.git-credentials','.pypirc','.envrc','.DS_Store','Thumbs.db','Icon\r'].includes(name)||/\.(pem|key|p12|pfx|keystore|jks|pyc|pyo|db|sqlite|sqlite3)(-.*)?$/i.test(name);
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hashPattern=/^[a-f0-9]{64}$/;
export function deploymentPolicy(hostname,origin,topLevel,dedicatedOrigin='',pathname='/') {
  if(!topLevel)return 'Project Save cannot run inside a frame. Open it directly in its own tab.';
  if(['localhost','127.0.0.1','[::1]'].includes(hostname))return '';
  if(hostname.endsWith('.github.io'))return 'GitHub Pages shared-origin deployments are disabled in this build. Configure an exclusive custom HTTPS origin; a project path or root page cannot establish exclusive ownership.';
  if(!dedicatedOrigin||origin!==dedicatedOrigin||!dedicatedOrigin.startsWith('https://'))return 'Public folder access is disabled. This build must be configured for an HTTPS origin dedicated exclusively to Project Save. Shared GitHub Pages origins are not safe.';
  return '';
}
export function validateHistory(index) {
  if(!object(index)||!Array.isArray(index.archives))throw Error('Damaged history index: expected an archives list. Restore the metadata from a trusted copy.');
  const names=new Set();
  for(const record of index.archives){if(!object(record)||typeof record.name!=='string'||record.name.includes('/')||!record.name.endsWith('.tar.gz')||!hashPattern.test(record.sha256)||!object(record.members)||typeof record.created!=='string')throw Error('Damaged history index: invalid archive record.');validPath(record.name);if(names.has(record.name))throw Error('Damaged history index: duplicate archive name.');names.add(record.name);for(const [path,hash]of Object.entries(record.members)){validPath(path);if((path!=='previous-manifest.json'&&!path.startsWith('previous/'))||!hashPattern.test(hash))throw Error('Damaged history index: invalid archive member.');}}
  return index;
}
async function historyIndex(target){return validateHistory(await readJSON(target,META+'/history.json',{archives:[]}));}
function sourceFailure(error){const wrapped=Error('Source could not be read consistently: '+(error.message||error.name||String(error)));wrapped.sourceFailure=true;return wrapped;}
function failure(path,error,scope='file'){return {path,scope,error:error.message||error.name||String(error)};}
const canonicalPath=path=>path.normalize('NFC').toLowerCase();
function unsupportedPath(path){return path.split('/').some(name=>/[<>:"\\|?*\x00-\x1f\x7f]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name));}
function typeConflict(error){return (error instanceof DOMException&&error.name==='TypeMismatchError')||['ENOTDIR','EISDIR'].includes(error.code);}
function destinationNameError(error){return (error instanceof DOMException&&['TypeMismatchError','InvalidModificationError','InvalidCharacterError','EncodingError'].includes(error.name))||['EINVAL','ENAMETOOLONG','ENOTDIR','EISDIR','EEXIST'].includes(error.code);}
const objectPath=()=>META+'/objects/'+crypto.randomUUID();
function storagePath(path,entry){return entry?.targetPath||'current/'+validPath(path);}
function underFailure(path,failed){return failed.some(item=>item.path===path||(item.scope==='directory'&&(!item.path||path.startsWith(item.path+'/'))));}
export function pathCollisions(paths){
  const prefixes=new Map();
  for(const path of paths){validPath(path);const parts=path.split('/');for(let i=1;i<=parts.length;i++){const prefix=parts.slice(0,i).join('/'),key=prefix.normalize('NFC').toLowerCase(),kind=i===parts.length?'file':'directory';if(!prefixes.has(key))prefixes.set(key,new Set());prefixes.get(key).add(kind+':'+prefix);}}
  const bad=new Set([...prefixes].filter(([,names])=>names.size>1&&[...names].some(name=>name.startsWith('file:'))).map(([key])=>key));
  return new Set(paths.filter(path=>{const parts=path.split('/');return parts.some((_,i)=>bad.has(parts.slice(0,i+1).join('/').normalize('NFC').toLowerCase()));}));
}
export function validateFailures(items,label='failure list'){
  if(!Array.isArray(items))throw Error('Damaged '+label+': expected a list.');
  for(const item of items){if(!object(item)||typeof item.path!=='string'||!['file','directory'].includes(item.scope)||typeof item.error!=='string')throw Error('Damaged '+label+': invalid failure record.');
    if(item.unsupportedName!==undefined&&item.unsupportedName!==true)throw Error('Damaged '+label+': invalid filename flag.');
    // These raw source names are display-only; file and archive paths still require validPath.
    if(item.unsupportedName){if(!item.path||item.path.startsWith('/')||item.path.split('/').some(p=>!p||p==='.'||p==='..')||!unsupportedPath(item.path))throw Error('Damaged '+label+': invalid unsupported source name.');}
    else if(item.path)validPath(item.path);else if(item.scope!=='directory')throw Error('Damaged '+label+': invalid empty file path.');}return items;
}
function validateLease(record){
  if(record===null)return null;
  if(!object(record)||typeof record.id!=='string'||!record.id||typeof record.released!=='boolean'||!Number.isFinite(record.heartbeat)||!Number.isFinite(record.expires)||record.expires<record.heartbeat)throw Error('Damaged backup lease. Stop all writers and follow the README lease-reset procedure.');
  if(record.heartbeat>Date.now()+LEASE_TTL||record.expires>Date.now()+2*LEASE_TTL)throw Error('Suspicious backup lease timestamp or clock skew. Stop all writers, correct clocks and follow the README lease-reset procedure.');
  return record;
}
async function leaseRecord(target){return validateLease(await readJSON(target,META+'/lease.json'));}
async function noLiveWriter(target){const record=await leaseRecord(target);if(record&&!record.released&&record.expires>Date.now())throw Error('Another writer has a live backup lease. Wait for it to finish.');}
async function operationRecord(target){const record=await readJSON(target,META+'/operation.json');if(record!==null&&(!object(record)||typeof record.complete!=='boolean'))throw Error('Damaged operation record: expected a completion flag.');return record;}
async function repairRecord(target){const record=await readJSON(target,META+'/findings.json',{repair:[]});if(!object(record)||!Array.isArray(record.repair))throw Error('Damaged verification findings: expected a repair list.');record.repair.forEach(validPath);return record;}
export async function fileHandle(root,path,create=false) {
  const parts=validPath(path).split('/');let dir=root;
  for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part,{create});
  return dir.getFileHandle(parts.at(-1),{create});
}
export async function maybeFile(root,path) {
  try{return await (await fileHandle(root,path)).getFile();}catch(e){if(e.name==='NotFoundError')return null;throw e;}
}
export async function readJSON(root,path,fallback=null) {
  const file=await maybeFile(root,path);if(!file)return fallback;
  if(file.size>32*1024*1024)throw Error('Backup metadata exceeds the 32 MB limit.');
  try{return JSON.parse(await file.text());}catch(e){if(e instanceof SyntaxError)throw Error('Damaged backup metadata: '+path+'. Expected valid JSON.');throw e;}
}
export async function writeJSON(root,path,data) {
  const handle=await fileHandle(root,path,true), writer=await handle.createWritable();
  try{await writer.write(JSON.stringify(data,null,2));await writer.close();}catch(e){await writer.abort().catch(()=>{});throw e;}
}
export async function hashFile(file,checkpoint=null) {
  const hash=new SHA256();let seen=0,since=0;
  for await(const chunk of file.stream()){hash.update(chunk);seen+=chunk.length;since+=chunk.length;if(checkpoint&&since>=CHECKPOINT_BYTES){await checkpoint();since=0;}}
  if(seen!==file.size)throw Error('File size changed while reading.');
  return hash.hex();
}
async function copyFile(file,handle,beforeCommit=null,checkpoint=null) {
  const hash=new SHA256(), writer=await handle.createWritable();let size=0;
  let checksum;
  try{let iterator,since=0;try{iterator=file.stream().getReader();}catch(e){throw sourceFailure(e);}try{while(true){let item;try{item=await iterator.read();}catch(e){throw sourceFailure(e);}if(item.done)break;hash.update(item.value);size+=item.value.length;await writer.write(item.value);since+=item.value.length;if(checkpoint&&since>=CHECKPOINT_BYTES){await checkpoint();since=0;}}}finally{iterator.releaseLock();}if(size!==file.size)throw sourceFailure(Error('Source file changed while copying.'));checksum=hash.hex();if(beforeCommit)await beforeCommit(checksum);await writer.close();}
  catch(e){await writer.abort().catch(()=>{});throw e;}
  if(await hashFile(await handle.getFile(),checkpoint)!==checksum)throw Error('Copied file failed its SHA-256 check.');
  return checksum;
}
export async function scan(root,includePaths=[]) {
  if(!Array.isArray(includePaths))throw Error('Invalid include overrides.');
  const rules=includePaths.map(validPath),files=Object.create(null),skipped=[],failed=[];
  async function visit(dir,prefix='',restricted=false) {
    try{for await(const [name,handle] of dir.entries()) {
      const path=prefix+name;
      if(handle.kind==='file'&&name==='Icon\r'){skipped.push(path);continue;}
      if(unsupportedPath(path)){failed.push({...failure(path,Error('Unsupported portable filename. Rename this source item to back it up.'),handle.kind),unsupportedName:true});continue;}
      validPath(path);
      const allow=rules.includes(path),covered=rules.some(r=>path.startsWith(r+'/')),descend=rules.some(r=>r.startsWith(path+'/'));
      const blocked=(restricted&&!covered)||excluded(name,handle.kind);
      if(name===META||(blocked&&!allow&&!(handle.kind==='directory'&&descend))){skipped.push(path+(handle.kind==='directory'?'/':''));continue;}
      if(handle.kind==='directory')await visit(handle,path+'/',blocked&&!allow);
      else {try{const file=await handle.getFile();files[path]={size:file.size,modified:file.lastModified,handle};}catch(e){failed.push(failure(path,e));}}
    }}catch(e){failed.push(failure(prefix.replace(/\/$/,''),e,'directory'));}
  }
  await visit(root);
  for(const path of pathCollisions(Object.keys(files))){failed.push(failure(path,Error('Name differs only by case or Unicode form, or conflicts with an aliased directory.')));delete files[path];}
  return {files,skipped,failed};
}
async function assertSeparate(a,b) {
  if(await a.isSameEntry(b)||await a.resolve(b)!==null||await b.resolve(a)!==null)throw Error('Choose separate folders; neither folder may contain the other.');
}
const octal=(value,length)=>value.toString(8).padStart(length-1,'0')+'\0';
function tarHeader(size,type='0',name='entry') {
  if(size>0o77777777777)throw Error('A single archived file exceeds the supported 8 GB TAR limit.');
  const data=new Uint8Array(512);const put=(offset,text)=>data.set(encoder.encode(text),offset);
  put(0,name);put(100,octal(0o600,8));put(108,octal(0,8));put(116,octal(0,8));put(124,octal(size,12));put(136,octal(Math.floor(Date.now()/1000),12));
  data.fill(32,148,156);put(156,type);put(257,'ustar\0');put(263,'00');
  const sum=data.reduce((a,b)=>a+b,0);put(148,sum.toString(8).padStart(6,'0')+'\0 ');return data;
}
function paxPath(path) {
  let body=' path='+path+'\n',len=encoder.encode(body).length+1;
  while(true){const next=String(len).length+encoder.encode(body).length;if(next===len)break;len=next;}
  return encoder.encode(String(len)+body);
}
async function* tarData(entries,checkpoint=null) {
  for(const entry of entries) {
    validPath(entry.path);const pax=paxPath(entry.path);
    yield tarHeader(pax.length,'x','PaxHeader');yield pax;yield new Uint8Array((512-pax.length%512)%512);
    yield tarHeader(entry.file.size);
    let count=0,since=0;for await(const chunk of entry.file.stream()){count+=chunk.length;since+=chunk.length;if(checkpoint&&since>=CHECKPOINT_BYTES){await checkpoint();since=0;}yield chunk;}
    if(count!==entry.file.size)throw Error('File changed while archiving.');
    yield new Uint8Array((512-entry.file.size%512)%512);
  }
  yield new Uint8Array(1024);
}
export async function archiveWrite(entries,handle,checkpoint=null) {
  const iterator=tarData(entries,checkpoint)[Symbol.asyncIterator]();
  const input=new ReadableStream({async pull(controller){try{const item=await iterator.next();if(item.done)controller.close();else controller.enqueue(item.value);}catch(e){controller.error(e);}},cancel(){return iterator.return?.();}});
  const writer=await handle.createWritable();
  try{for await(const chunk of input.pipeThrough(new CompressionStream('gzip')))await writer.write(chunk);await writer.close();}
  catch(e){await writer.abort().catch(()=>{});throw e;}
}
class ByteReader {
  constructor(stream,checkpoint=null){this.reader=stream.getReader();this.chunk=new Uint8Array();this.pos=0;this.checkpoint=checkpoint;this.since=0;}
  async take(size,consume) {
    let left=size;
    while(left){if(this.pos===this.chunk.length){const {value,done}=await this.reader.read();if(done)throw Error('Truncated archive.');this.chunk=value;this.pos=0;}
      const n=Math.min(left,this.chunk.length-this.pos),part=this.chunk.subarray(this.pos,this.pos+n);if(consume)await consume(part);this.pos+=n;left-=n;this.since+=n;if(this.checkpoint&&this.since>=CHECKPOINT_BYTES){await this.checkpoint();this.since=0;}}
  }
  async bytes(size){const result=new Uint8Array(size);let offset=0;await this.take(size,p=>{result.set(p,offset);offset+=p.length;});return result;}
}
export async function inspectArchive(file, sinks=new Map(),checkpoint=null) {
  const reader=new ByteReader(file.stream().pipeThrough(new DecompressionStream('gzip')),checkpoint), hashes=Object.create(null);let pax=null;
  while(true){const header=await reader.bytes(512);if(header.every(b=>b===0))break;
    const field=(a,b)=>decoder.decode(header.subarray(a,b)).replace(/\0.*$/s,'');
    const saved=parseInt(field(148,156).trim(),8);const calculated=header.reduce((s,b,i)=>s+(i>=148&&i<156?32:b),0);if(saved!==calculated)throw Error('Archive header checksum failed.');
    const rawSize=field(124,136).trim();if(!/^[0-7]+$/.test(rawSize))throw Error('Invalid archive member size.');
    const size=parseInt(rawSize,8),type=field(156,157);if(!Number.isSafeInteger(size)||size<0)throw Error('Invalid archive member size.');
    if(type==='x') {if(size>1024*1024)throw Error('Archive path record too large.');const record=await reader.bytes(size);let pos=0;pax=null;
      while(pos<record.length){let space=record.indexOf(32,pos);const len=Number(decoder.decode(record.subarray(pos,space)));if(space<0||!Number.isInteger(len)||len<=space-pos+1||pos+len>record.length)throw Error('Invalid archive path record.');const line=decoder.decode(record.subarray(space+1,pos+len-1));if(line.startsWith('path='))pax=line.slice(5);pos+=len;}
      await reader.take((512-size%512)%512);continue;}
    if(type!=='0'&&type!=='')throw Error('Unsupported archive member type.');
    const path=validPath(pax||field(0,100));pax=null;if(Object.hasOwn(hashes,path))throw Error('Duplicate archive member.');
    const hash=new SHA256(),sink=sinks.get(path);
    await reader.take(size,async chunk=>{hash.update(chunk);if(sink)await sink.write(chunk);});
    hashes[path]=hash.hex();if(sink?.close){await sink.close();sink.closed=true;}await reader.take((512-size%512)%512);
  }
  // Drain through the gzip trailer so truncated streams and CRC failures surface.
  if(reader.pos<reader.chunk.length&&reader.chunk.subarray(reader.pos).some(b=>b!==0))throw Error('Unexpected archive trailer.');
  while(true){const {value,done}=await reader.reader.read();if(done)break;if(value.some(b=>b!==0))throw Error('Unexpected archive trailer.');}
  return hashes;
}

export class TargetLease {
  constructor(target){this.target=target;this.id=crypto.randomUUID();this.timer=null;this.lost=null;this.queue=Promise.resolve();}
  async acquire(recoverInterrupted=false){
    const previous=await leaseRecord(this.target);
    if(previous&&!previous.released&&previous.expires>Date.now())throw Error('Another writer has a live backup lease. Wait for it to finish; do not use two browsers for this destination.');
    const operation=await operationRecord(this.target);
    if(operation?.complete===false&&!recoverInterrupted){const e=Error('The previous backup was interrupted. Restore or inspect the last completed checkpoint first. Confirm recovery before retrying writes.');e.recoveryRequired=true;throw e;}
    await writeJSON(this.target,META+'/lease.json',{id:this.id,heartbeat:Date.now(),expires:Date.now()+LEASE_TTL,released:false});
    await this.assert();
    this.timer=setInterval(()=>{this.refresh().catch(e=>{this.lost=e;});},HEARTBEAT_INTERVAL);this.timer.unref?.();return this;
  }
  assert(){this.queue=this.queue.then(async()=>{if(this.lost)throw this.lost;const record=await leaseRecord(this.target);if(!record||record.id!==this.id||record.released)throw Error('Backup writer lease was lost. Stop other writers and inspect the last committed manifest before recovery.');if(Date.now()-record.heartbeat>=HEARTBEAT_INTERVAL||record.expires<=Date.now()){await writeJSON(this.target,META+'/lease.json',{id:this.id,heartbeat:Date.now(),expires:Date.now()+LEASE_TTL,released:false});const renewed=await leaseRecord(this.target);if(!renewed||renewed.id!==this.id||renewed.released)throw Error('Backup writer lease was lost during renewal.');}}).catch(e=>{this.lost=e;throw e;});return this.queue;}
  refresh(){return this.assert();}
  async release(){clearInterval(this.timer);await this.queue.catch(()=>{});try{const record=await readJSON(this.target,META+'/lease.json');if(record?.id===this.id&&!this.lost)await writeJSON(this.target,META+'/lease.json',{...record,released:true});}catch{} }
}

export class Backup {
  constructor(profile,progress=()=>{}) {this.profile=profile;this.source=profile.source;this.target=profile.target;this.progress=progress;}
  async load() {
    await assertSeparate(this.source,this.target);
    const marker=await readJSON(this.target,META+'/identity.json');
    if(marker&&(marker.format!==FORMAT||marker.sourceId!==this.profile.id))throw Error('This backup folder belongs to another saved project. Choose its saved folder pair, or a new empty destination.');
    if(!marker){for await(const _ of this.target.entries())throw Error('Choose an empty dedicated backup folder. Existing unrelated files were left untouched.');}
    this.marker=marker;this.manifest=await readJSON(this.target,META+'/manifest.json',{format:FORMAT,files:{}});
    validateManifest(this.manifest);return this;
  }
  async preview() {
    await this.load();this.progress('Scanning the selected project…');
    const {files,skipped,failed}=await scan(this.source,this.profile.includePaths||[]),changed=[],stale=[];
    const findings=await repairRecord(this.target),repairs=new Set(findings.repair);
    for(const [path,meta] of Object.entries(files)) {
      const old=Object.hasOwn(this.manifest.files,path)?this.manifest.files[path]:null;let target;
      if(old?.targetPath)meta.targetPath=old.targetPath;
      try{target=await maybeFile(this.target,storagePath(path,old));}catch(e){if(typeConflict(e)&&!old?.targetPath){meta.targetPath=objectPath();target=null;}else{if(!destinationNameError(e))throw e;failed.push(failure(path,e));delete files[path];continue;}}
      if(repairs.has(path)||!old||!target||old.size!==meta.size||old.modified!==meta.modified||target.size!==old.size||target.lastModified!==old.targetModified)changed.push(path);
    }
    const current=await this.target.getDirectoryHandle('current').catch(e=>{if(e.name==='NotFoundError')return null;throw e;});
    const liveNames=new Set(Object.keys(files).map(canonicalPath));
    if(current){async function visit(dir,prefix=''){for await(const [name,h]of dir.entries()){const path=prefix+name;validPath(path);if(h.kind==='directory')await visit(h,path+'/');else if(!liveNames.has(canonicalPath(path))&&!underFailure(path,failed))stale.push(path);}}await visit(current);}
    const operation=await operationRecord(this.target);
    return {files,changed,stale,skipped,failed,repairs:[...repairs],interrupted:operation?.complete===false,count:Object.keys(files).length,bytes:changed.reduce((n,p)=>n+files[p].size,0)};
  }
  async archivePrevious(paths) {
    if(!this.marker||!paths.length)return null;
    const entries=[],expected=Object.create(null);
    const checkpoint=this.lease?()=>this.lease.assert():null;
    for(const path of paths){const old=Object.hasOwn(this.manifest.files,path)?this.manifest.files[path]:null;let file;try{file=await maybeFile(this.target,storagePath(path,old));}catch(e){if(!old&&typeConflict(e))continue;throw e;}if(file){entries.push({path:'previous/'+path,file});expected['previous/'+path]=await hashFile(file,checkpoint);}}
    const manifest=await maybeFile(this.target,META+'/manifest.json');
    if(manifest){entries.push({path:'previous-manifest.json',file:manifest});expected['previous-manifest.json']=await hashFile(manifest);}
    if(!entries.length)return null;
    const name=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8)+'.tar.gz';
    this.progress('Preserving and checking previous versions…');
    const handle=await fileHandle(this.target,'history/'+name,true);await archiveWrite(entries,handle,checkpoint);
    const file=await handle.getFile(),actual=await inspectArchive(file,new Map(),checkpoint);
    if(Object.keys(actual).length!==Object.keys(expected).length||Object.entries(expected).some(([p,h])=>actual[p]!==h))throw Error('History archive verification failed. No existing backup files were replaced.');
    const index=await historyIndex(this.target);if(this.lease)await this.lease.assert();
    const record={name,sha256:await hashFile(file,checkpoint),members:expected,created:new Date().toISOString()};index.archives.push(record);
    await writeJSON(this.target,META+'/history.json',index);return record;
  }
  async copy({recoverInterrupted=false}={}) {
    await this.load();
    if(!this.marker){await writeJSON(this.target,META+'/identity.json',{format:FORMAT,sourceId:this.profile.id});this.marker=true;}
    this.lease=await new TargetLease(this.target).acquire(recoverInterrupted);
    try{
    await this.target.getDirectoryHandle('current',{create:true});
    const plan=await this.preview(),failed=[...plan.failed];
    const removed=Object.keys(this.manifest.files).filter(p=>!Object.hasOwn(plan.files,p)&&!underFailure(p,failed));
    await this.lease.assert();await writeJSON(this.target,META+'/operation.json',{complete:false,leaseId:this.lease.id,started:new Date().toISOString(),changed:plan.changed});
    const history=await this.archivePrevious([...new Set([...plan.changed,...removed])]);
    const entries=Object.create(null),succeeded=new Set();let copied=0,copiedBytes=0;
    for(let i=0;i<plan.changed.length;i++) {
      const path=plan.changed[i],meta=plan.files[path];this.progress(`Copying and verifying ${i+1}/${plan.changed.length}: ${path}`);
      await this.lease.assert();let source;
      try{source=await meta.handle.getFile();if(source.size!==meta.size||source.lastModified!==meta.modified)throw Error('Source changed after the scan.');}catch(e){failed.push(failure(path,e));continue;}
      let handle;
      try{handle=await fileHandle(this.target,storagePath(path,meta),true);}catch(e){if(typeConflict(e)&&!meta.targetPath){meta.targetPath=objectPath();handle=await fileHandle(this.target,meta.targetPath,true);}else{if(!destinationNameError(e))throw e;failed.push(failure(path,e));continue;}}
      let checksum;
      try{checksum=await copyFile(source,handle,async hash=>{let after;try{after=await meta.handle.getFile();}catch(e){throw sourceFailure(e);}if(after.size!==meta.size||after.lastModified!==meta.modified)throw sourceFailure(Error('Source changed during copying.'));let actual;try{actual=await hashFile(after,()=>this.lease.assert());}catch(e){if(this.lease.lost)throw e;throw sourceFailure(e);}if(actual!==hash)throw sourceFailure(Error('Source changed during copying.'));await this.lease.assert();},()=>this.lease.assert());}catch(e){if(e.sourceFailure){failed.push(failure(path,e));continue;}throw e;}
      entries[path]={size:meta.size,modified:meta.modified,sha256:checksum,targetModified:(await handle.getFile()).lastModified,...(meta.targetPath?{targetPath:meta.targetPath}:{})};succeeded.add(path);copied++;copiedBytes+=meta.size;
    }
    for(const [path,entry]of Object.entries(this.manifest.files))if(!Object.hasOwn(entries,path)&&(Object.hasOwn(plan.files,path)||underFailure(path,failed)))entries[path]=entry;
    const pending=new Set(plan.repairs.filter(path=>!succeeded.has(path)&&(Object.hasOwn(entries,path)||Object.hasOwn(plan.files,path)||underFailure(path,failed))));
    for(const item of failed)if(item.scope==='file'&&!item.unsupportedName)pending.add(item.path);
    for(const path of Object.keys(this.manifest.files))if(underFailure(path,failed)&&!succeeded.has(path))pending.add(path);
    await this.lease.assert();
    await writeJSON(this.target,META+'/manifest.json',{format:Object.values(entries).some(entry=>entry.targetPath)?MAPPED_FORMAT:FORMAT,saved:new Date().toISOString(),complete:failed.length===0&&pending.size===0,failed,files:entries});
    await writeJSON(this.target,META+'/findings.json',{repair:[...pending]});
    const result={action:'backup',backupComplete:failed.length===0&&pending.size===0,failed,pendingRepairs:[...pending],count:Object.keys(entries).length,copied,bytes:copiedBytes,stale:plan.stale,skipped:plan.skipped,history:history?.name||null,at:new Date().toISOString(),note:(failed.length||pending.size)?'Backup incomplete. Readable files were saved; failed source paths retain their previous manifest entries where available. Review failures and retry.':'Copied files passed SHA-256 checks. Unchanged files were selected by size and modification time. Use Verify for a full content check. No destination files were deleted.'};
    await this.lease.assert();
    await writeJSON(this.target,META+'/operation.json',{complete:true,...result});
    await writeJSON(this.target,META+'/last-result.json',result);return result;
    }finally{await this.lease.release();this.lease=null;}
  }
  async verify({history=false}={}) {
    await this.load();if(!this.marker||!this.manifest.saved)throw Error('Create a backup before verifying it.');
    const interrupted=(await operationRecord(this.target))?.complete===false;
    let lease=null;if(interrupted)await noLiveWriter(this.target);else lease=await new TargetLease(this.target).acquire(false);
    const guard=()=>lease?lease.assert():noLiveWriter(this.target);
    try{
    const errors=[],sourceChanges=[],sourceFailures=[],repair=[],checkedGood=new Set(),previousRepairs=(await repairRecord(this.target)).repair;let i=0;
    for(const [path,entry]of Object.entries(this.manifest.files)) {
      this.progress(`Verifying ${++i}/${Object.keys(this.manifest.files).length}: ${path}`);
      await guard();let goodTarget=false,goodSource=false;
      try{const target=await maybeFile(this.target,storagePath(path,entry));if(!target||await hashFile(target,guard)!==entry.sha256){errors.push(path);repair.push(path);}else goodTarget=true;}catch(e){if(lease?.lost)throw e;errors.push(path);repair.push(path);}
      try{const source=await maybeFile(this.source,path);if(!source||await hashFile(source,guard)!==entry.sha256){sourceChanges.push(path);repair.push(path);}else goodSource=true;}catch(e){if(lease?.lost)throw e;sourceFailures.push(failure(path,e));}
      if(goodTarget&&goodSource)checkedGood.add(path);
    }
    const {files,failed}=await scan(this.source,this.profile.includePaths||[]),newFiles=Object.keys(files).filter(p=>!Object.hasOwn(this.manifest.files,p));
    sourceFailures.push(...failed);
    const historyResult=history?await verifyHistory(this.target,message=>this.progress(message),guard):null;
    const protectedFilesVerified=!errors.length&&(!historyResult||historyResult.verified);
    const result={action:'verify',verified:protectedFilesVerified&&this.manifest.complete!==false,protectedFilesVerified,manifestIncomplete:this.manifest.complete===false,count:Object.keys(this.manifest.files).length,errors,sourceChanges,sourceFailures,newFiles,interrupted,readOnly:interrupted,historyResult,at:new Date().toISOString(),note:interrupted?'Previous write was interrupted. Read-only verification checked the last committed manifest; no metadata or repair flags were changed. Confirm recovery before new backup writes.':'Backup hashes checked. Source changes and source-read failures are listed separately. History is checked only when requested.'};
    await guard();
    if(!interrupted){for(const path of previousRepairs)if(Object.hasOwn(this.manifest.files,path)&&!checkedGood.has(path))repair.push(path);await writeJSON(this.target,META+'/findings.json',{repair:[...new Set(repair)]});await writeJSON(this.target,META+'/last-result.json',result);if(result.verified)await writeJSON(this.target,META+'/last-verification.json',result);}return result;
    }finally{if(lease)await lease.release();}
  }
}
export function validateManifest(manifest) {
  if(![FORMAT,MAPPED_FORMAT].includes(manifest?.format)||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw Error('Unrecognized backup manifest.');
  const mapped=new Set();
  for(const [path,entry]of Object.entries(manifest.files)){validPath(path);if(!object(entry)||!hashPattern.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0||!Number.isFinite(entry.modified)||!Number.isFinite(entry.targetModified))throw Error('Damaged backup manifest: invalid file metadata for '+path+'.');
    if(entry.targetPath!==undefined){if(manifest.format!==MAPPED_FORMAT||typeof entry.targetPath!=='string'||!/^\.project-save\/objects\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.targetPath)||mapped.has(entry.targetPath))throw Error('Damaged backup manifest: invalid or duplicate mapped storage path.');mapped.add(entry.targetPath);}}
  if(manifest.failed!==undefined)validateFailures(manifest.failed,'manifest failures');
  if(manifest.complete!==undefined&&typeof manifest.complete!=='boolean')throw Error('Damaged backup manifest: invalid completion flag.');
}

export async function verifyHistory(target,progress=()=>{},checkpoint=null) {
  const index=await historyIndex(target),errors=[];
  for(let i=0;i<index.archives.length;i++){const record=index.archives[i];progress(`Verifying history ${i+1}/${index.archives.length}: ${record.name}`);if(checkpoint)await checkpoint();try{const file=await maybeFile(target,'history/'+record.name);if(!file||await hashFile(file,checkpoint)!==record.sha256)throw Error('Archive checksum failed.');const actual=await inspectArchive(file,new Map(),checkpoint);if(Object.keys(actual).length!==Object.keys(record.members).length||Object.entries(record.members).some(([p,h])=>actual[p]!==h))throw Error('Archive member checksum failed.');}catch(e){errors.push({path:record.name,error:e.message});}}
  return {verified:errors.length===0,count:index.archives.length,errors};
}

export async function restore(target,output,progress=()=>{},checkpoint=null) {
  await assertSeparate(target,output);for await(const _ of output.entries())throw Error('Restore requires a new empty folder. Existing files were left untouched.');
  await noLiveWriter(target);
  const identity=await readJSON(target,META+'/identity.json');if(identity?.format!==FORMAT)throw Error('Unrecognized backup folder.');
  const index=await historyIndex(target),checked=new Map();
  async function archive(record){
    if(!checked.has(record.name)){try{const file=await maybeFile(target,'history/'+record.name);if(!file||await hashFile(file)!==record.sha256)throw Error('History archive checksum failed.');const actual=await inspectArchive(file);if(Object.keys(actual).length!==Object.keys(record.members).length||Object.entries(record.members).some(([p,h])=>actual[p]!==h))throw Error('History member checksum failed.');checked.set(record.name,file);}catch(e){checked.set(record.name,e);}}
    const value=checked.get(record.name);if(value instanceof Error)throw value;return value;
  }
  let manifest=await readJSON(target,META+'/manifest.json');
  if(checkpoint){const record=index.archives.find(r=>r.name===checkpoint);if(!record)throw Error('Unknown historical checkpoint.');const file=await archive(record),chunks=[];let length=0;await inspectArchive(file,new Map([['previous-manifest.json',{write(chunk){length+=chunk.length;if(length>32*1024*1024)throw Error('Historical manifest exceeds the 32 MB limit.');chunks.push(chunk.slice());}}]]));try{manifest=JSON.parse(await new Blob(chunks).text());}catch(e){if(e instanceof SyntaxError)throw Error('Damaged historical manifest: expected valid JSON.');throw e;}}
  validateManifest(manifest);
  const current=[],groups=new Map(),failed=[],archiveErrors=[],collisions=pathCollisions(Object.keys(manifest.files));
  for(const [path,entry]of Object.entries(manifest.files)){
    if(collisions.has(path)){failed.push(failure(path,Error('Name differs only by case or Unicode form, or conflicts with an aliased directory.')));continue;}
    let reason='No verified copy is available for: '+path;
    try{const file=await maybeFile(target,storagePath(path,entry));if(file&&await hashFile(file)===entry.sha256){current.push({path,entry,file});continue;}}catch(e){reason=e.message;}
    let found=false;
    for(const record of [...index.archives].reverse().filter(r=>r.members['previous/'+path]===entry.sha256)){
      try{await archive(record);if(!groups.has(record.name))groups.set(record.name,[]);groups.get(record.name).push({path,entry});found=true;break;}catch(e){reason=e.message;}
    }
    if(!found)failed.push(failure(path,Error(reason)));
  }
  let restored=0;const total=Object.keys(manifest.files).length;
  for(const item of current){
    progress(`Restoring and checking ${restored+1}/${total}: ${item.path}`);
    try{await noLiveWriter(target);const handle=await fileHandle(output,item.path,true);if(await copyFile(item.file,handle)!==item.entry.sha256)throw Error('Restored file checksum failed.');restored++;}catch(e){failed.push(failure(item.path,e));}
  }
  for(const [name,items]of groups){
    progress(`Restoring ${items.length} file(s) together from ${name}…`);
    const sinks=new Map(),writers=new Set();
    for(const item of items)sinks.set('previous/'+item.path,{
      async fail(error){if(this.error)return;this.error=error;failed.push(failure(item.path,error));if(this.writer){await this.writer.abort().catch(()=>{});writers.delete(this.writer);}},
      async write(chunk){if(this.error)return;try{if(!this.writer){await noLiveWriter(target);this.handle=await fileHandle(output,item.path,true);this.writer=await this.handle.createWritable();writers.add(this.writer);}await this.writer.write(chunk);}catch(e){await this.fail(e);}},
      async close(){if(this.error)return;try{if(!this.writer){await noLiveWriter(target);this.handle=await fileHandle(output,item.path,true);this.writer=await this.handle.createWritable();writers.add(this.writer);}await this.writer.close();writers.delete(this.writer);if(await hashFile(await this.handle.getFile())!==item.entry.sha256)throw Error('Restored file checksum failed: '+item.path);restored++;}catch(e){await this.fail(e);}}
    });
    try{await inspectArchive(checked.get(name),sinks);for(const sink of sinks.values())if(!sink.closed&&!sink.error)await sink.fail(Error('Requested history member was missing.'));}
    catch(e){archiveErrors.push({path:name,error:e.message});for(const sink of sinks.values())if(!sink.closed&&!sink.error)await sink.fail(e);}
    finally{for(const writer of writers)await writer.abort().catch(()=>{});}
  }
  const protectedFilesVerified=failed.length===0&&archiveErrors.length===0,complete=protectedFilesVerified&&manifest.complete!==false;
  return {action:'restore',restored,restoreComplete:complete,verified:complete,protectedFilesVerified,manifestIncomplete:manifest.complete===false,failed,archiveErrors,sourceFailures:manifest.failed||[],at:new Date().toISOString(),note:!protectedFilesVerified?'Partial restore. Verified recoverable files were restored; failed items are listed. Output may also contain incomplete files from failed writes.':manifest.complete===false?'Restored the protected subset from an incomplete backup. Failed source items were not newly protected.':'Restored the active file set into the selected empty folder. Every restored file passed SHA-256 verification.'};
}
