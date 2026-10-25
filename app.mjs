import {Backup,restore,readJSON,validPath,validateHistory,deploymentPolicy,META,FORMAT} from './backup.mjs';
// Set ONLY after confirming that no other app is served anywhere on this origin.
// Default is deliberately local-review-only, not a shared github.io project URL.
const DEDICATED_PUBLIC_ORIGIN = '';
const $=id=>document.getElementById(id);
let source=null,target=null,selected=null,profiles=[],busy=false,db=null,riskAccepted=false;
const policyError=deploymentPolicy(location.hostname,location.origin,window.top===window.self,DEDICATED_PUBLIC_ORIGIN,location.pathname);
const supported=!policyError&&isSecureContext&&'showDirectoryPicker' in window&&'CompressionStream' in window&&'DecompressionStream' in window&&'indexedDB' in window&&!!navigator.locks;
const controls=()=>document.querySelectorAll('button,select,textarea,input');
function updateControls(){for(const node of controls())node.disabled=!supported||busy||(node.id!=='risk-ack'&&(!riskAccepted||!db));}
$('risk-ack').addEventListener('change',()=>{riskAccepted=$('risk-ack').checked;updateControls();status(riskAccepted?'Risk acknowledgement noted for this tab. Choose folders to begin.':'Read and acknowledge the risk notice before granting folder access.');});
function status(message,error=false){$('status').textContent=message;$('status').parentElement.classList.toggle('error',error);}
function element(tag,text,cls){const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;}
function bytes(n){return n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':n<1073741824?(n/1048576).toFixed(1)+' MB':(n/1073741824).toFixed(2)+' GB';}
function render(result){
  const root=$('result');root.replaceChildren();if(!result)return;
  if(typeof result!=='object'||Array.isArray(result))throw Error('Damaged saved result: expected a record.');
  for(const key of ['changed','skipped','stale','failed','errors','sourceChanges','sourceFailures','newFiles','pendingRepairs','archiveErrors'])if(result[key]!==undefined&&!Array.isArray(result[key]))throw Error('Damaged saved result: invalid '+key+' list.');
  const metrics=element('div','','metrics');
  for(const[label,value]of [['Included files',result.count],['Files to copy',result.changed?.length??result.copied],['Transfer size',result.bytes===undefined?undefined:bytes(result.bytes)],['Skipped paths',result.skipped?.length],['Failed items',(result.failed?.length||0)+(result.sourceFailures?.length||0)],['Files restored',result.restored]])if(value!==undefined){const item=element('div','','metric');item.append(element('strong',String(value)),element('span',label));metrics.append(item);}
  root.append(metrics);
  if(result.backupComplete===false)root.append(element('p','Backup incomplete. Review failed paths; these files are not newly protected.','warning-note'));
  if(result.interrupted)root.append(element('p','The previous write was interrupted. Restore or inspect its last checkpoint before confirming recovery.','warning-note'));
  if(result.restoreComplete===false)root.append(element('p','Partial restore: recoverable files were saved; review the failed items below.','warning-note'));
  if(result.manifestIncomplete)root.append(element('p','The saved snapshot is incomplete. Some source items were never protected.','warning-note'));
  if(result.verified!==undefined)root.append(element('p',result.verified?'File verification passed for the checked file set.':result.protectedFilesVerified?'Protected files passed checks, but the saved set or operation is incomplete.':'Verification found files needing attention.','result-note'));
  if(result.note)root.append(element('p',result.note,'result-note'));
  for(const key of ['changed','skipped','stale','failed','errors','sourceChanges','sourceFailures','newFiles','pendingRepairs','archiveErrors'])if(result[key]?.length){const details=element('details','','result-list');const lines=result[key].slice(0,250).map(item=>typeof item==='string'?item:`${item.path||'(source root)'}: ${item.error}`);details.append(element('summary',`${key.replace(/([A-Z])/g,' $1')} (${result[key].length})`),element('pre',lines.join('\n')+(result[key].length>250?'\n…first 250 shown':'')));root.append(details);}
  if(result.historyResult){root.append(element('p',`${result.historyResult.count} history archive(s) checked; ${result.historyResult.errors.length} error(s).`,'result-note'));if(result.historyResult.errors.length)root.append(element('pre',result.historyResult.errors.map(e=>e.path+': '+e.error).join('\n'),'result-note'));}
  if(result.history)root.append(element('p','Previous versions: '+result.history,'result-note'));
  if(result.at)root.append(element('p',new Date(result.at).toLocaleString(),'small'));
}
function includePaths(){return $('include-paths').value.split(/\r?\n/).map(p=>p.trim().replace(/\/+$/,'')).filter(Boolean).map(validPath);}
function resetCheckpoint(){const option=element('option','Current backup');option.value='';$('checkpoint').replaceChildren(option);}
function displayPair(){ $('source-label').value=selected?.sourceLabel||'';$('target-label').value=selected?.targetLabel||''; $('source-name').textContent=source?.name||'Where your work lives';$('target-name').textContent=target?.name||'An empty folder on your backup drive';$('projects').value=selected?.id||'';$('include-paths').value=(selected?.includePaths||[]).join('\n');}
function refreshProfiles(){const menu=$('projects');menu.replaceChildren(element('option','Choose a saved project…'));menu.firstChild.value='';for(const profile of profiles){const option=element('option',(profile.sourceLabel||profile.sourceName)+' → '+(profile.targetLabel||profile.targetName));option.value=profile.id;menu.append(option);}displayPair();}
function openDB(){return new Promise((resolve,reject)=>{const request=indexedDB.open('project-save',1);request.onupgradeneeded=()=>request.result.createObjectStore('pairs',{keyPath:'id'});request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);});}
function store(action,value){return new Promise((resolve,reject)=>{const transaction=db.transaction('pairs',action==='getAll'?'readonly':'readwrite'),table=transaction.objectStore('pairs');const request=action==='getAll'?table.getAll():table[action](value);let result;request.onsuccess=()=>{result=request.result;};transaction.oncomplete=()=>resolve(result);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error||Error('Browser storage transaction cancelled.'));});}
async function permission(handle,mode){if(!handle)throw Error('Choose both folders first.');if(await handle.queryPermission({mode})!=='granted')throw Error('Folder access needs reconnecting. Use the matching Reconnect button first; choose read/write backup access for copying or normal verification.');}
async function profile(){if(!source||!target)throw Error('Choose a project and a backup folder first.');if(!selected)throw Error('Click Remember this pair before previewing or backing up.');return {...selected,source,target,includePaths:includePaths()};}
async function run(task,{lock=true}={}){
  if(busy||!supported||!riskAccepted||!db)return;busy=true;for(const node of controls())node.disabled=true;$('status').parentElement.classList.add('busy');
  try{if(lock)await navigator.locks.request('project-save-file-operation',{ifAvailable:true},async lock=>{if(!lock)throw Error('Another Project Save tab is working. Wait for it to finish.');await task();});else await task();}
  catch(e){status(e.name==='AbortError'?'Selection cancelled. No new operation started.':e.message||String(e),true);}
  finally{busy=false;updateControls();$('status').parentElement.classList.remove('busy');}
}
async function history(){await permission(target,'read');const index=validateHistory(await readJSON(target,META+'/history.json',{archives:[]}));resetCheckpoint();for(const record of [...index.archives].reverse().filter(r=>r.members['previous-manifest.json'])){const option=element('option','Before '+new Date(record.created).toLocaleString());option.value=record.name;$('checkpoint').append(option);}status(`${index.archives.length} previous-version archive(s). History is never deleted automatically.`);}
$('choose-source').addEventListener('click',()=>run(async()=>{source=await showDirectoryPicker({id:'project-save-source',mode:'read'});selected=null;displayPair();render(null);status('Project selected. Choose its backup folder, then remember the pair.');},{lock:false}));
$('choose-target').addEventListener('click',()=>run(async()=>{target=await showDirectoryPicker({id:'project-save-target',mode:$('target-access').value});selected=null;displayPair();render(null);status('Backup folder selected. Remember the pair before creating a backup.');},{lock:false}));
for(const [button,which]of [['connect-source','source'],['connect-target','target']])$(button).addEventListener('click',()=>{
  if(busy||!supported||!riskAccepted||!db)return;
  const handle=which==='source'?source:target;if(!handle){status('Choose that folder first.',true);return;}
  // Exactly one permission request, invoked synchronously from this click.
  let requested;try{requested=handle.requestPermission({mode:which==='source'?'read':$('target-access').value});}catch(e){status(e.message,true);return;}
  run(async()=>{if(await requested!=='granted')throw Error('Folder access was not granted.');status('Folder access reconnected. Start the desired action now.');},{lock:false});
});
$('new-pair').addEventListener('click',()=>{source=null;target=null;selected=null;displayPair();render(null);resetCheckpoint();status('Choose a project and a dedicated backup folder.');});
$('projects').addEventListener('change',()=>{const p=profiles.find(p=>p.id===$('projects').value);if(p){selected=p;source=p.source;target=p.target;displayPair();render(null);resetCheckpoint();status('Saved pair selected. The browser may ask you to reconnect its folders.');}});
$('save-pair').addEventListener('click',()=>run(async()=>{
  await permission(source,'read');await permission(target,'read');
  if(await source.isSameEntry(target)||await source.resolve(target)!==null||await target.resolve(source)!==null)throw Error('Choose separate folders; neither may contain the other.');
  let existing=null;for(const p of profiles)if(await p.source.isSameEntry(source)&&await p.target.isSameEntry(target)){existing=p;break;}
  if(!existing&&profiles.length>=20)throw Error('Twenty pairs are saved. Forget an unused pair before adding another.');
  const marker=await readJSON(target,META+'/identity.json'),p=existing||{id:crypto.randomUUID(),source,target};
  if(marker&&(marker.format!==FORMAT||marker.sourceId!==p.id))throw Error('This is an existing backup belonging to another saved pair. Select that pair, choose a new empty destination, or use Restore without remembering it.');
  const record={...p,source,target,includePaths:includePaths(),sourceName:source.name,targetName:target.name,sourceLabel:$('source-label').value.trim().slice(0,1000),targetLabel:$('target-label').value.trim().slice(0,1000),used:Date.now()};await store('put',record);selected=record;profiles=await store('getAll');profiles.sort((a,b)=>b.used-a.used);refreshProfiles();status('Folder pair remembered in this browser. No files copied.');
}));
for(const action of ['preview','backup','verify'])$(action).addEventListener('click',()=>run(async()=>{
  const p=await profile();await permission(source,'read');await permission(target,'read');const priorOperation=action==='verify'?await readJSON(target,META+'/operation.json'):null;if(action==='backup'||(action==='verify'&&priorOperation?.complete!==false))await permission(target,'readwrite');const engine=new Backup(p,message=>status(message));let result;
  if(action==='preview'){result=await engine.preview();}
  else if(action==='backup'){
    const preview=await engine.preview();render(preview);
    if(((!engine.manifest.saved&&preview.skipped.length)||p.includePaths.length)&&!confirm(`This run skips ${preview.skipped.length} path(s) and has ${p.includePaths.length} explicit include override(s): ${p.includePaths.slice(0,20).join(', ')||'(none)'}. Exact overrides may copy secrets; nested exclusions still apply. Review the preview and continue only if these settings protect all work you intend to save. Continue?`)){status('Backup cancelled. Review exclusions and overrides before starting.');return;}
    try{result=await engine.copy();}catch(e){if(!e.recoveryRequired)throw e;if(!confirm(e.message+'\n\nConfirm that all other writers are stopped and continue recovery?')){status('Recovery was not confirmed. No further write was started.');return;}result=await engine.copy({recoverInterrupted:true});}
  }else result=await engine.verify({history:$('verify-history').checked});
  render(result);
  const incomplete=result.restoreComplete===false||result.backupComplete===false||result.failed?.length||result.sourceFailures?.length||result.interrupted;
  status(action==='preview'?`Preview ready: ${result.skipped.length} skipped path(s), ${result.failed.length} unreadable item(s). Nothing was copied.`:incomplete?'Operation needs attention. Review unreadable paths or interruption details below.':action==='backup'?'Backup completed. Copied files passed their checks.':result.verified?'Verification completed. Review any source changes below.':'Verification found files needing attention.',Boolean(incomplete)||(action==='verify'&&!result.verified));
}));
$('last-result').addEventListener('click',()=>run(async()=>{await permission(target,'read');let result=await readJSON(target,META+'/last-result.json');const operation=await readJSON(target,META+'/operation.json');if(operation?.complete===false)result={...(result||{}),interrupted:true};render(result);status(result?.interrupted?'The latest write was interrupted; any completed result shown below is older.':result?'Last completed operation loaded.':'No completed operation has been saved yet.',Boolean(result?.interrupted));}));
$('load-history').addEventListener('click',()=>run(history));
$('restore').addEventListener('click',()=>{
  // Invoke the native picker directly from the click, before acquiring a Web Lock.
  if(busy||!supported||!riskAccepted||!db)return;
  if(!target){status('Choose the backup folder first. A source project is not needed for restore.',true);return;}
  const picked=showDirectoryPicker({id:'project-save-restore',mode:'readwrite'});
  run(async()=>{const output=await picked;await permission(target,'read');const result=await restore(target,output,message=>status(message),$('checkpoint').value||null);render(result);status(result.restoreComplete===false?'Partial restore: review failed files. Other verified files were restored.':result.manifestIncomplete?'Restored a partial backup. Review which source items were not protected.':'Restore completed. Every restored file passed its SHA-256 check.',Boolean(result.manifestIncomplete)||result.restoreComplete===false);});
});
$('forget').addEventListener('click',()=>run(async()=>{if(!selected)throw Error('Select a saved pair first.');if(!confirm('Forget this pair in this browser? No backup files will be deleted. Reusing its existing backup for new writes requires this saved identity; it can still be restored.'))return;await store('delete',selected.id);profiles=profiles.filter(p=>p.id!==selected.id);selected=null;source=null;target=null;refreshProfiles();status('Pair forgotten. Backup files were not deleted.');}));
if(!supported){$('support').hidden=false;$('support').textContent=policyError||'This preview needs a current desktop Chrome or Edge browser over HTTPS (or localhost for development). Folder access, browser storage, compression, and Web Locks must be available. Your files have not been accessed.';for(const node of controls())node.disabled=true;}
else{try{db=await openDB();profiles=await store('getAll');profiles.sort((a,b)=>b.used-a.used);if(profiles.length){selected=profiles[0];source=selected.source;target=selected.target;}refreshProfiles();updateControls();}catch(e){for(const node of controls())node.disabled=true;status('Browser storage is unavailable. Allow site storage and reopen this page; no files have been accessed.',true);}}
