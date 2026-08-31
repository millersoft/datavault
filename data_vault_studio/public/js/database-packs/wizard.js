function databaseTypeWizardHopDisplayName(entry){
  const pluginId=String(entry&&entry.pluginId||'').toUpperCase();
  if(pluginId==='MSSQL') return 'MS SQL Server (Legacy jTDS)';
  if(pluginId==='MSSQLNATIVE') return 'MS SQL Server (Microsoft JDBC)';
  return String(entry&&entry.pluginName||entry&&entry.pluginId||'');
}
function databaseTypeWizardHopEntries(){
  return (hopDatabaseCatalog?.databaseTypes||[])
    .filter(entry=>entry&&entry.pluginId&&String(entry.pluginId).toUpperCase()!=='GENERIC')
    .slice()
    .sort((a,b)=>databaseTypeWizardHopDisplayName(a).localeCompare(databaseTypeWizardHopDisplayName(b)));
}
function databaseTypeWizardHopEntry(d=databaseTypeWizardState){
  const id=String(d&&d.hopPluginId||'');
  if(!id||id===DATABASE_TYPE_WIZARD_GENERIC) return null;
  return databaseTypeWizardHopEntries().find(entry=>String(entry.pluginId).toUpperCase()===id.toUpperCase())||null;
}
function databaseTypeWizardPackIdentity(entry){
  if(!entry) return {id:'',label:''};
  const overrides=DATABASE_TYPE_WIZARD_PACK_DEFAULTS[String(entry.pluginId||'').toUpperCase()]||{};
  const label=String(entry.studioPack?.label||overrides.label||entry.pluginName||entry.pluginId||'').trim();
  const id=String(entry.studioPack?.id||overrides.id||entry.module||databaseTypeIdFromLabel(label)).trim().toLowerCase();
  return {id,label};
}
function databaseTypeWizardManifest(d=databaseTypeWizardState){
  const isGeneric=String(d&&d.hopPluginId||'')===DATABASE_TYPE_WIZARD_GENERIC;
  const hopEntry=databaseTypeWizardHopEntry(d);
  let label='',id='',hop={};
  if(isGeneric){
    label=String(d&&d.customLabel||'').trim();
    id=databaseTypeIdFromLabel(label);
    hop={forceGeneric:true};
  }else if(hopEntry){
    const identity=databaseTypeWizardPackIdentity(hopEntry);
    label=identity.label; id=identity.id;
    hop={pluginId:String(hopEntry.pluginId)};
    const defaults=DATABASE_TYPE_WIZARD_PACK_DEFAULTS[String(hopEntry.pluginId||'').toUpperCase()]||{};
    const attributes=hopEntry.studioPack?.hop?.attributes||defaults.hop?.attributes;
    if(attributes&&typeof attributes==='object') hop.attributes=Object.assign({},attributes);
  }
  const jdbc={
    driverClass:String(d&&d.driverClass||'').trim(),
    urlTemplate:String(d&&d.urlTemplate||'').trim(),
    defaultPort:String(d&&d.defaultPort||'').trim(),
    jarfile:String(d&&d.jarfile||'').trim(),
  };
  const manifest={schemaVersion:1,id,label,version:'1.0.0',jdbc,namespace:{usesSchema:true},hop};
  // SQL Server's current jdbc_fdw route resolves unqualified remote table names
  // through the JDBC account's default schema. Keep that target-only capability
  // in the Pack so source use remains unaffected and target preflight can enforce it.
  if(id==='sqlserver') manifest.fdw={remoteSchemaResolution:'connection-default'};
  return manifest;
}
function databaseTypeWizardIdentityValidationError(d=databaseTypeWizardState){
  if(!String(d&&d.hopPluginId||'')) return 'Choose an Apache Hop database type.';
  const m=databaseTypeWizardManifest(d);
  if(String(d.hopPluginId)===DATABASE_TYPE_WIZARD_GENERIC && !m.label) return 'Enter the database name for this Generic JDBC type.';
  if(!m.id) return 'The database name must contain at least one letter or number.';
  if(databasePacks.some(p=>p.id===m.id)) return `Database type ${m.label||m.id} is already installed. Use Import existing Database Pack to update it, or choose another Hop database type.`;
  return '';
}
function databaseTypeWizardValidationError(d=databaseTypeWizardState){
  const identityError=databaseTypeWizardIdentityValidationError(d);
  if(identityError) return identityError;
  const m=databaseTypeWizardManifest(d);
  if(!m.jdbc.driverClass) return 'Enter the JDBC driver class.';
  if(!m.jdbc.urlTemplate) return 'Enter the JDBC URL template.';
  if(!m.jdbc.defaultPort || !/^\d+$/.test(m.jdbc.defaultPort)) return 'Enter the normal JDBC port as a number.';
  if(!m.jdbc.jarfile || !/^[^/\\]+\.jar$/i.test(m.jdbc.jarfile)) return 'Enter the JDBC JAR filename exactly as it appears in project-root jdbc-drivers/.';
  return '';
}
function databaseTypeJarPatternRegex(pattern){
  const escaped=String(pattern||'').replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');
  return new RegExp('^'+escaped+'$','i');
}
async function databaseTypeDriverCheck(manifest){
  const jdbc=manifest&&manifest.jdbc||{};
  const requirement=String(jdbc.jarfile||jdbc.jarPattern||'').replace(/\\/g,'/').split('/').pop();
  if(!requirement) return {ok:false,exists:false,requirement:'',error:'This Database Pack does not name a JDBC driver JAR.'};
  try{
    const resp=await localFetch('/api/driver-status'); const data=await resp.json();
    if(!data.ok) throw new Error(data.error||'Could not inspect jdbc-drivers/.');
    const jars=Array.isArray(data.jars)?data.jars:[];
    const filename=jdbc.jarfile
      ? jars.find(name=>String(name).toLowerCase()===requirement.toLowerCase())||''
      : jars.find(name=>databaseTypeJarPatternRegex(requirement).test(name))||'';
    return {ok:true,exists:!!filename,filename,requirement,folder:data.folder||'jdbc-drivers/'};
  }catch(err){ return {ok:false,exists:false,requirement,error:err.message}; }
}
function databaseTypeDriverStatusHtml(status){
  if(!status) return '<div class="ai-status"><span>Driver check pending. The JDBC JAR must already be in project-root <span class="mono">jdbc-drivers/</span>.</span></div>';
  if(status.exists) return `<div class="ai-status ok"><span>JDBC driver found · <span class="mono">${escapeHtml(status.filename)}</span><br><span class="hint">Shared project driver folder: jdbc-drivers/</span></span></div>`;
  const detail=status.error?status.error:`${status.requirement||'Required JDBC driver'} was not found.`;
  return `<div class="ai-status err"><span>${escapeHtml(detail)}<br><span class="hint">Place the driver JAR in project-root jdbc-drivers/ before creating or importing this database type.</span></span></div>`;
}
function selectInstalledDatabasePack(installed){
  if(!installed) return;
  state.vault.dialect=`pack:${installed.id}`; state.vault.sourcePackValues={}; state.vault.sourceCatalog=''; state.vault.sourcePreset='';
  (installed.connectionFields||[]).forEach(f=>{state.vault.sourcePackValues[f.key]=f.default!=null?f.default:'';});
  syncPackMappedValues(installed,'source'); state.vault.sourceSchema=installed.namespace?.defaultSchema||'';
  sourceConnStatus=null; discoveredSchemas=[]; discoveredCatalogs=[]; targetJdbcDriverStatus=null;
}
async function installDatabasePackManifest(manifest,{select=true,requireDriver=true,verb='Added'}={}){
  const resp=await localFetch('/api/database-packs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pack:manifest,requireDriver})});
  const data=await resp.json(); if(!data.ok) throw new Error(data.error||'Could not save Database Pack.');
  await loadDatabasePacks();
  const installed=databasePacks.find(p=>p.id===data.pack.id)||data.pack;
  if(select) selectInstalledDatabasePack(installed);
  toast(`${verb} ${installed.label} ${installed.version}.`,'ok'); renderAll(); setActiveTabViewOnly('connections');
  return installed;
}
async function importDatabasePackFile(file,{select=false,requireDriver=true}={}){
  if(!file) return null;
  try{ return await installDatabasePackManifest(JSON.parse(await file.text()),{select,requireDriver,verb:'Imported'}); }
  catch(err){ toast(`Database type import failed: ${err.message}`,'err'); return null; }
}

let databaseTypeWizardState=null;
function closeDatabaseTypeWizard(){
  const el=document.getElementById('database-type-wizard-backdrop'); if(el) el.remove();
  databaseTypeWizardState=null;
}
function openDatabaseTypeWizard(){
  databaseTypeWizardState={screen:'choice',hopPluginId:'',customLabel:'',driverClass:'',urlTemplate:'',defaultPort:'',jarfile:'',driverStatus:null,importManifest:null,importDriverStatus:null,error:''};
  renderDatabaseTypeWizard();
}
function databaseTypeWizardShell(inner){
  return `<div class="modal-card" style="max-width:900px;max-height:88vh;overflow:auto;">
    <div class="flex-between"><div><h2 class="section-title" style="margin:0;">Add database type</h2><p class="hint mb0">Choose the Apache Hop database type first. Studio will create the Pack identity and JDBC metadata; actual server credentials are entered later on Connections.</p></div><button class="btn ghost" id="dbtype-close">Close</button></div>
    <div class="mt">${inner}</div>
  </div>`;
}
function databaseTypeWizardChoiceHtml(){
  return `<div class="grid cols-2">
    <button type="button" id="dbtype-create-new" style="text-align:left;padding:20px;border:1px solid var(--border);border-radius:10px;background:var(--panel);color:var(--text);cursor:pointer;">
      <strong>Create new database type</strong><p class="hint mb0" style="margin-top:8px;">Choose a Hop database plugin, then add the JDBC details Studio needs for the source connection.</p>
    </button>
    <button type="button" id="dbtype-import-existing" style="text-align:left;padding:20px;border:1px solid var(--border);border-radius:10px;background:var(--panel);color:var(--text);cursor:pointer;">
      <strong>Import existing Database Pack</strong><p class="hint mb0" style="margin-top:8px;">Review and install an existing JSON Database Pack.</p>
    </button>
  </div>`;
}
function databaseTypeWizardIdentityHtml(){
  const d=databaseTypeWizardState;
  const options=databaseTypeWizardHopEntries().map(entry=>`<option value="${escapeHtml(entry.pluginId)}" ${String(d.hopPluginId).toUpperCase()===String(entry.pluginId).toUpperCase()?'selected':''}>${escapeHtml(databaseTypeWizardHopDisplayName(entry))}</option>`).join('');
  const isGeneric=d.hopPluginId===DATABASE_TYPE_WIZARD_GENERIC;
  const entry=databaseTypeWizardHopEntry(d);
  const identity=entry?databaseTypeWizardPackIdentity(entry):null;
  return `<div class="panel"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>1 · Database type</h3></div>
    <div class="field"><label>Apache Hop database type <span style="color:var(--err)">*</span></label>
      <select id="dbtype-hop-plugin">
        <option value="" ${!d.hopPluginId?'selected':''} disabled>Select a Hop database type…</option>
        ${options}
        <option value="${DATABASE_TYPE_WIZARD_GENERIC}" ${isGeneric?'selected':''}>Other / Generic JDBC…</option>
      </select>
      <p class="hint">Native Hop database plugins are written directly into the Pack so Studio can generate <span class="mono">metadata/rdbms/source.json</span> without guessing from the database name.</p>
    </div>
    ${isGeneric?`<div class="field mt"><label>Database name <span style="color:var(--err)">*</span></label><input id="dbtype-custom-label" type="text" value="${escapeHtml(d.customLabel)}" placeholder="Example Analytics DB"><p class="hint">Generic JDBC databases still need a display name. Studio generates the internal Pack ID automatically.</p></div>`:''}
    ${identity?`<div class="ai-status mt"><span>Studio will create <strong>${escapeHtml(identity.label)}</strong> using Hop plugin <span class="mono">${escapeHtml(entry.pluginId)}</span>. Pack ID and version are generated internally.</span></div>`:''}
    ${d.error?`<div class="ai-status err mt">${escapeHtml(d.error)}</div>`:''}
  </div>
  <div class="flex-between mt"><button class="btn ghost" id="dbtype-back-choice">Back</button><button class="btn primary" id="dbtype-next-jdbc">Next: JDBC →</button></div>`;
}
function databaseTypeWizardJdbcHtml(){
  const d=databaseTypeWizardState;
  const m=databaseTypeWizardManifest(d);
  const hopLabel=d.hopPluginId===DATABASE_TYPE_WIZARD_GENERIC?'Generic JDBC':databaseTypeWizardHopDisplayName(databaseTypeWizardHopEntry(d))||d.hopPluginId||'';
  return `<div class="panel"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>2 · JDBC · ${escapeHtml(m.label||hopLabel)}</h3></div>
    <p class="hint">The JDBC JAR is not stored in the Database Pack. Put it in the shared project-root <span class="mono">jdbc-drivers/</span> folder first; Studio, Hop and the JDBC FDW runtime all use that location.</p>
    <div class="dbtype-grid-driver">
      <div class="field"><label>JDBC driver class <span style="color:var(--err)">*</span></label><input type="text" id="dbtype-driver-class" value="${escapeHtml(d.driverClass)}" placeholder="oracle.jdbc.OracleDriver"></div>
      <div class="field"><label>Default port <span style="color:var(--err)">*</span></label><input id="dbtype-default-port" type="number" value="${escapeHtml(d.defaultPort)}" placeholder="1521"></div>
    </div>
    <div class="field mt"><label>JDBC URL template <span style="color:var(--err)">*</span></label><input type="text" id="dbtype-url-template" value="${escapeHtml(d.urlTemplate)}" placeholder="jdbc:vendor://{host}:{port}/{database}"><p class="hint">Use placeholders such as <span class="mono">{host}</span>, <span class="mono">{port}</span> and <span class="mono">{database}</span>. Username/password are supplied separately by Studio.</p></div>
    <div class="field mt"><label>JDBC JAR filename <span style="color:var(--err)">*</span></label><input type="text" id="dbtype-jarfile" value="${escapeHtml(d.jarfile)}" placeholder="vendor-jdbc-1.0.jar"></div>
    <div id="dbtype-driver-status" class="mt">${databaseTypeDriverStatusHtml(d.driverStatus)}</div>
    ${d.error?`<div class="ai-status err mt">${escapeHtml(d.error)}</div>`:''}
  </div>
  <div class="flex-between mt"><button class="btn ghost" id="dbtype-back-identity">Back</button><div style="display:flex;gap:8px;"><button class="btn" id="dbtype-check-driver">Check driver</button><button class="btn primary" id="dbtype-review">Review →</button></div></div>`;
}
function databaseTypeWizardReviewHtml(){
  const d=databaseTypeWizardState, m=databaseTypeWizardManifest(d);
  const hop=resolveHopDatabaseType(m)||{pluginId:'GENERIC',pluginName:'Generic database',strategy:'generic'};
  return `<div class="panel"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>3 · Review & create</h3></div>
    <div class="grid cols-2">
      <div><label>Database</label><p class="mono">${escapeHtml(m.label)}</p></div><div><label>Hop connection</label><p class="mono">${escapeHtml(hop.pluginId)} · ${hop.strategy==='native'?'Native plugin':'Generic JDBC'}</p></div>
      <div><label>Driver class</label><p class="mono">${escapeHtml(m.jdbc.driverClass)}</p></div><div><label>Default port</label><p class="mono">${escapeHtml(m.jdbc.defaultPort)}</p></div>
      <div><label>JDBC JAR</label><p class="mono">${escapeHtml(m.jdbc.jarfile)}</p></div>
    </div>
    <div class="field mt"><label>JDBC URL template</label><p class="mono" style="overflow-wrap:anywhere;">${escapeHtml(m.jdbc.urlTemplate)}</p></div>
    <div id="dbtype-driver-status" class="mt">${databaseTypeDriverStatusHtml(d.driverStatus)}</div>
    <p class="hint mt">Studio will infer the normal connection fields from the JDBC URL and discover catalog/schema namespaces when the database is connected. Pack ID/version stay internal. Live connection testing happens only after this database type is selected on Connections.</p>
    ${d.error?`<div class="ai-status err mt">${escapeHtml(d.error)}</div>`:''}
  </div>
  <div class="flex-between mt"><button class="btn ghost" id="dbtype-back-jdbc">Back</button><button class="btn primary" id="dbtype-create" ${d.driverStatus&&d.driverStatus.exists?'':'disabled'}>Create database type</button></div>`;
}
function databaseTypeWizardImportFileHtml(){
  return `<div class="panel"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>Import existing Database Pack</h3></div>
    <p class="hint">Choose a Database Pack JSON file. Studio will review its identity and verify that its JDBC JAR is already present in project-root <span class="mono">jdbc-drivers/</span> before installation.</p>
    <div class="field mt"><label>Database Pack JSON</label><input type="file" id="dbtype-import-file" accept="application/json,.json"></div>
    ${databaseTypeWizardState.error?`<div class="ai-status err mt">${escapeHtml(databaseTypeWizardState.error)}</div>`:''}
  </div><div class="flex-between mt"><button class="btn ghost" id="dbtype-import-back">Back</button><span></span></div>`;
}
function databaseTypeWizardImportReviewHtml(){
  const d=databaseTypeWizardState, m=d.importManifest||{}, jdbc=m.jdbc||{};
  const existing=databasePacks.find(p=>p.id===String(m.id||'').toLowerCase());
  const action=existing?'Update existing database type':'Import database type';
  return `<div class="panel"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>Review import</h3></div>
    <div class="grid cols-2"><div><label>Database</label><p class="mono">${escapeHtml(m.label||'')}</p></div><div><label>ID / version</label><p class="mono">${escapeHtml(m.id||'')} · ${escapeHtml(m.version||'')}</p></div><div><label>Driver class</label><p class="mono">${escapeHtml(jdbc.driverClass||'')}</p></div><div><label>JDBC JAR</label><p class="mono">${escapeHtml(jdbc.jarfile||jdbc.jarPattern||'')}</p></div></div>
    <div class="mt">${databaseTypeDriverStatusHtml(d.importDriverStatus)}</div>
    ${existing?`<div class="ai-status mt"><span>${escapeHtml(existing.label)} ${escapeHtml(existing.version)} is already installed. Import will update that database type by manifest ID.</span></div>`:''}
    ${d.error?`<div class="ai-status err mt">${escapeHtml(d.error)}</div>`:''}
  </div>
  <div class="flex-between mt"><button class="btn ghost" id="dbtype-import-choose-another">Choose another</button><div style="display:flex;gap:8px;"><button class="btn" id="dbtype-import-recheck">Recheck driver</button><button class="btn primary" id="dbtype-import-confirm" ${d.importDriverStatus&&d.importDriverStatus.exists?'':'disabled'}>${action}</button></div></div>`;
}
function captureDatabaseTypeJdbcFields(){
  const d=databaseTypeWizardState;
  const get=id=>document.getElementById(id)?.value||'';
  d.driverClass=get('dbtype-driver-class'); d.urlTemplate=get('dbtype-url-template'); d.defaultPort=get('dbtype-default-port'); d.jarfile=get('dbtype-jarfile');
  d.driverStatus=null; d.error='';
}
async function refreshDatabaseTypeWizardDriver({importing=false}={}){
  const d=databaseTypeWizardState; if(!d) return null;
  if(!importing) captureDatabaseTypeJdbcFields();
  const manifest=importing?d.importManifest:databaseTypeWizardManifest(d);
  const status=await databaseTypeDriverCheck(manifest);
  if(importing)d.importDriverStatus=status;else d.driverStatus=status;
  renderDatabaseTypeWizard(); return status;
}
function renderDatabaseTypeWizard(){
  const d=databaseTypeWizardState; if(!d) return;
  let wrap=document.getElementById('database-type-wizard-backdrop');
  if(!wrap){wrap=document.createElement('div');wrap.id='database-type-wizard-backdrop';wrap.className='modal-backdrop';document.body.appendChild(wrap);}
  let inner='';
  if(d.screen==='choice') inner=databaseTypeWizardChoiceHtml();
  else if(d.screen==='identity') inner=databaseTypeWizardIdentityHtml();
  else if(d.screen==='jdbc') inner=databaseTypeWizardJdbcHtml();
  else if(d.screen==='review') inner=databaseTypeWizardReviewHtml();
  else if(d.screen==='importFile') inner=databaseTypeWizardImportFileHtml();
  else if(d.screen==='importReview') inner=databaseTypeWizardImportReviewHtml();
  wrap.innerHTML=databaseTypeWizardShell(inner);
  wrap.onclick=e=>{if(e.target===wrap)closeDatabaseTypeWizard();};
  document.getElementById('dbtype-close')?.addEventListener('click',closeDatabaseTypeWizard);
  document.getElementById('dbtype-create-new')?.addEventListener('click',()=>{d.screen='identity';d.error='';renderDatabaseTypeWizard();});
  document.getElementById('dbtype-import-existing')?.addEventListener('click',()=>{d.screen='importFile';d.error='';renderDatabaseTypeWizard();});
  document.getElementById('dbtype-back-choice')?.addEventListener('click',()=>{d.screen='choice';d.error='';renderDatabaseTypeWizard();});
  document.getElementById('dbtype-hop-plugin')?.addEventListener('change',e=>{d.hopPluginId=e.target.value;d.error='';renderDatabaseTypeWizard();});
  document.getElementById('dbtype-custom-label')?.addEventListener('input',e=>{d.customLabel=e.target.value;});
  document.getElementById('dbtype-next-jdbc')?.addEventListener('click',()=>{const custom=document.getElementById('dbtype-custom-label');if(custom)d.customLabel=custom.value;const err=databaseTypeWizardIdentityValidationError(d);if(err){d.error=err;renderDatabaseTypeWizard();return;}d.screen='jdbc';d.error='';renderDatabaseTypeWizard();});
  document.getElementById('dbtype-back-identity')?.addEventListener('click',()=>{captureDatabaseTypeJdbcFields();d.screen='identity';renderDatabaseTypeWizard();});
  document.getElementById('dbtype-check-driver')?.addEventListener('click',()=>refreshDatabaseTypeWizardDriver());
  document.getElementById('dbtype-review')?.addEventListener('click',async()=>{captureDatabaseTypeJdbcFields();const err=databaseTypeWizardValidationError(d);if(err){d.error=err;renderDatabaseTypeWizard();return;}const status=await databaseTypeDriverCheck(databaseTypeWizardManifest(d));d.driverStatus=status;if(!status.exists){d.error=status.error||`${status.requirement} was not found in jdbc-drivers/.`;renderDatabaseTypeWizard();return;}d.screen='review';d.error='';renderDatabaseTypeWizard();});
  document.getElementById('dbtype-back-jdbc')?.addEventListener('click',()=>{d.screen='jdbc';d.error='';renderDatabaseTypeWizard();});
  document.getElementById('dbtype-create')?.addEventListener('click',async()=>{try{const status=await databaseTypeDriverCheck(databaseTypeWizardManifest(d));d.driverStatus=status;if(!status.exists)throw new Error(status.error||`${status.requirement} was not found in jdbc-drivers/.`);await installDatabasePackManifest(databaseTypeWizardManifest(d),{select:true,requireDriver:true,verb:'Created'});closeDatabaseTypeWizard();}catch(err){d.error=err.message;renderDatabaseTypeWizard();}});
  document.getElementById('dbtype-import-back')?.addEventListener('click',()=>{d.screen='choice';d.error='';renderDatabaseTypeWizard();});
  document.getElementById('dbtype-import-file')?.addEventListener('change',async e=>{try{const file=e.target.files&&e.target.files[0];if(!file)return;const manifest=JSON.parse(await file.text());if(!manifest||!manifest.id||!manifest.label||!manifest.version||!manifest.jdbc||!manifest.jdbc.driverClass||!manifest.jdbc.urlTemplate||!(manifest.jdbc.jarfile||manifest.jdbc.jarPattern))throw new Error('This file is not a complete Database Pack manifest.');d.importManifest=manifest;d.importDriverStatus=await databaseTypeDriverCheck(manifest);d.screen='importReview';d.error='';renderDatabaseTypeWizard();}catch(err){d.error=err.message;renderDatabaseTypeWizard();}});
  document.getElementById('dbtype-import-choose-another')?.addEventListener('click',()=>{d.importManifest=null;d.importDriverStatus=null;d.screen='importFile';d.error='';renderDatabaseTypeWizard();});
  document.getElementById('dbtype-import-recheck')?.addEventListener('click',()=>refreshDatabaseTypeWizardDriver({importing:true}));
  document.getElementById('dbtype-import-confirm')?.addEventListener('click',async()=>{try{const status=await databaseTypeDriverCheck(d.importManifest);d.importDriverStatus=status;if(!status.exists)throw new Error(status.error||`${status.requirement} was not found in jdbc-drivers/.`);const existing=databasePacks.some(p=>p.id===String(d.importManifest.id||'').toLowerCase());await installDatabasePackManifest(d.importManifest,{select:true,requireDriver:true,verb:existing?'Updated':'Imported'});closeDatabaseTypeWizard();}catch(err){d.error=err.message;renderDatabaseTypeWizard();}});
}

