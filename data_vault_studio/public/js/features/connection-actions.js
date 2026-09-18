let sourceConnStatus = null; // null | 'testing' | 'ok' | 'error'
let sourceConnError = '';
let discoveredSchemas = [];
let discoveredCatalogs = [];
let targetConnStatus = null; // null | 'testing' | 'ok' | 'error'
let targetConnError = '';
let targetDbExists = null; // null | true | false
let targetDbCreating = false;
let targetRoleCheck = null; // null | 'checking' | 'ok' | 'error' — can the connecting user SET ROLE staging/data_vault?
let targetRoleCheckError = '';
let externalTargetConnStatus = null; // physical output selected when external tables are enabled
let externalTargetConnError = '';
let externalTargetDbExists = null;
let externalTargetIdentity = null;
let externalTargetDbCreating = false;
let importedProjectConnectionsRequireConfirmation = false;
const confirmedImportedConnectionTargets = new Set();

function importedConnectionTargetDetails(body){
  if(!body||(!body.host&&!body.manualUrl&&!body.jdbcUrl&&!body.packValues))return null;
  const pack=databasePackForDialect(body.dialect);
  const values=body.packValues&&typeof body.packValues==='object'?body.packValues:{};
  const mapped=(name)=>{
    const field=pack&&(pack.connectionFields||[]).find(item=>item.mapsTo===name||item.key===name);
    return String((field&&values[field.key])??body[name]??'').trim();
  };
  const manualUrl=String(body.manualUrl||body.jdbcUrl||'').trim();
  const publicPackValues={};
  for(const field of (pack&&pack.connectionFields)||[]){
    if(field.type==='password'||field.mapsTo==='password'||field.mapsTo==='user')continue;
    if(values[field.key]!=null)publicPackValues[field.key]=String(values[field.key]);
  }
  let display='';
  if(manualUrl){
    const authority=manualUrl.match(/^jdbc:[A-Za-z0-9+._-]+(?::[A-Za-z0-9+._-]+)*:\/\/([^/;?\s]+)/i);
    display=authority&&!authority[1].includes('@')?authority[1]:'the imported manual JDBC URL';
  }else{
    const endpointField=pack&&(pack.connectionFields||[]).find(field=>/host|server|endpoint/i.test(field.key)&&publicPackValues[field.key]);
    const host=mapped('host')||(endpointField&&publicPackValues[endpointField.key])||'',port=mapped('port'),database=mapped('database')||mapped('catalog');
    display=`${host||'the imported host'}${port?':'+port:''}${database?'/'+database:''}`;
  }
  const signature=JSON.stringify({dialect:body.dialect||'',manualUrl,host:mapped('host'),port:mapped('port'),database:mapped('database'),catalog:mapped('catalog'),packValues:publicPackValues});
  return {display,signature};
}
function confirmImportedConnectionTarget(body){
  if(!importedProjectConnectionsRequireConfirmation)return body;
  const target=importedConnectionTargetDetails(body);
  if(!target||confirmedImportedConnectionTargets.has(target.signature))return body;
  if(!confirm(`This database destination came from an imported project file:\n\n${target.display}\n\nImported files can point Studio at loopback, private-network, or other internal services. Connect to this destination?`)) throw new Error('Connection to the imported database destination was cancelled.');
  confirmedImportedConnectionTargets.add(target.signature);
  return body;
}

function renderConnStatusHtml(){
  if (sourceConnStatus==='testing') return `<div class="ai-status busy mt"><span class="dot"></span>Connecting…</div>`;
  if (sourceConnStatus==='ok') return `<div class="ai-status ok mt">Connected — ready to detect source tables on Step 2.</div>`;
  if (sourceConnStatus==='error') return `<div class="ai-status err mt">${escapeHtml(sourceConnError)}</div>`;
  return '';
}

function sourceConnectionPayload(){
  const v=state.vault;
  if(demoSourceActive())return {credentialRef:'packaged-mysql-source',database:'sakila',dialect:'mysql'};
  return confirmImportedConnectionTarget(databasePackConnectionBody('source') || {host:v.srcHost,port:v.srcPort,database:v.srcDatabase,user:v.srcUser,password:v.srcPassword,dialect:v.dialect});
}
function targetConnectionPayload(database=state.vault.dvDatabase){
  const v=state.vault;
  if(demoTargetActive())return {credentialRef:'internal-postgres-target',database,dialect:'postgresql'};
  if(!v.dvPassword)return confirmImportedConnectionTarget({credentialRef:'external-postgres-target',host:v.dvHost,port:v.dvPort,database,dialect:'postgresql'});
  return confirmImportedConnectionTarget({host:v.dvHost,port:v.dvPort,database,user:v.dvUser,password:v.dvPassword,dialect:'postgresql'});
}

async function testSourceConnection(){
  const v = state.vault;
  sourceConnStatus = 'testing';
  document.getElementById('conn-status-wrap').innerHTML = renderConnStatusHtml();
  try {
    const health = await localFetch(`/api/health`).catch(()=>null);
    if (!health || !health.ok){
      throw new Error(`Local server not reachable at ${localServerUrl} — is it running? (cd server && npm install && npm start)`);
    }
    const sourcePayload=sourceConnectionPayload();
    const resp = await localFetch(`/api/test-connection`, {
      method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(sourcePayload),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Connection failed.');
    if (!state.sourceMeta) state.sourceMeta={foreignKeys:[],approxRows:{},relationshipSuggestions:[],hopCapabilities:null};
    if (data.sourceCapabilities && typeof data.sourceCapabilities==='object') state.sourceMeta.hopCapabilities={...data.sourceCapabilities};
    sourceConnStatus = 'ok'; sourceConnError = '';
    toast('Connected to the source database.','ok');

    if (v.dialect==='mysql'){
      // MySQL has no separate schema concept — a "schema" in
      // information_schema terms literally IS the database. Nothing to
      // discover; just keep them in lockstep.
      v.sourceSchema = v.srcDatabase; v.sourceSchemas=[v.srcDatabase];
    } else {
      // Database Pack connection testing already performs one JDBC metadata
      // pass, so reuse the namespaces returned by that request instead of
      // starting another JVM/JDBC connection solely for /api/list-schemas.
      const applyNamespaceDiscovery=(schemaData)=>{
        if(!schemaData||schemaData.ok===false)return;
        discoveredSchemas=schemaData.schemas||[]; discoveredCatalogs=schemaData.catalogs||[];
        const schemaNames=discoveredSchemas.map(x=>typeof x==='object'?x.schema:x).filter(Boolean);
        const pack=databasePackForDialect(v.dialect);
        if(pack){
          const values=packConnectionValues('source');
          const catalogField=(pack.connectionFields||[]).find(f=>f.mapsTo==='catalog');
          const schemaField=(pack.connectionFields||[]).find(f=>f.mapsTo==='schema');
          if(catalogField && !values[catalogField.key] && discoveredCatalogs.length) values[catalogField.key]=discoveredCatalogs[0];
          if(schemaField && !values[schemaField.key] && schemaNames.length) values[schemaField.key]=schemaNames[0];
          syncPackMappedValues(pack,'source');
        }else if(schemaNames.length && !schemaNames.includes(v.sourceSchema)) v.sourceSchema=schemaNames[0];
        if(!Array.isArray(v.sourceSchemas)||!v.sourceSchemas.length) v.sourceSchemas=schemaNames.includes(v.sourceSchema)?[v.sourceSchema]:(schemaNames.length?[schemaNames[0]]:[]);
        if(discoveredSchemas.length||discoveredCatalogs.length) toast(`Discovered ${discoveredCatalogs.length} catalog(s) and ${discoveredSchemas.length} schema(s).`, 'ok');
      };
      if(databasePackForDialect(v.dialect) && (Array.isArray(data.schemas)||Array.isArray(data.catalogs))){
        applyNamespaceDiscovery(data);
      }else{
        try {
          const schemaResp = await localFetch(`/api/list-schemas`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(sourcePayload),
          });
          applyNamespaceDiscovery(await schemaResp.json());
        } catch(_) { /* non-fatal — schema field just stays free text */ }
      }
    }
  } catch(err){
    sourceConnStatus = 'error'; sourceConnError = err.message;
    toast('Connection failed — see details below.','err');
  }
  if (activeTab==='connections'){ renderAll(); setActiveTabViewOnly('connections'); }
}

function renderTargetStatusHtml(){
  const isGateway = state.vault.targetPreset==='internal' && state.externalTables.enabled;
  const targetLabel = isGateway ? 'PostgreSQL gateway database' : 'PostgreSQL target database';
  if (targetConnStatus==='testing') return `<div class="ai-status busy mt"><span class="dot"></span>Connecting…</div>`;
  if (targetConnStatus==='error') return `<div class="ai-status err mt">${escapeHtml(targetConnError)}</div>`;
  if (targetConnStatus==='ok'){
    const roleLine = targetRoleCheck==='checking'
      ? `<div class="ai-status busy mt"><span class="dot"></span>Checking staging/vault role privileges…</div>`
      : targetRoleCheck==='ok'
        ? `<div class="ai-status ok mt">Can switch to both <span class="mono">staging</span> and <span class="mono">data_vault</span> roles.</div>`
        : targetRoleCheck==='error'
          ? `<div class="ai-status err mt">Cannot switch roles: ${escapeHtml(targetRoleCheckError)}<br><span class="hint">The connecting user needs <span class="mono">GRANT staging TO ${escapeHtml(state.vault.dvUser||'<user>')};</span> and the same for <span class="mono">data_vault</span> (or be a superuser) — otherwise "Execute" on the Export step will fail partway through.</span></div>`
          : '';
    if (targetDbExists===true) return `<div class="ai-status ok mt">Connected — ${targetLabel} "${escapeHtml(state.vault.dvDatabase)}" exists.</div>` + roleLine;
    if (targetDbExists===false) return `
      <div class="ai-status err mt" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <span>Connected, but ${targetLabel} "${escapeHtml(state.vault.dvDatabase)}" does not exist yet.</span>
        <button class="btn small primary" id="btn-create-db" ${targetDbCreating?'disabled':''}>${targetDbCreating?'Creating…':'Create it'}</button>
      </div>`;
  }
  return '';
}
function packUsesConnectionDefaultSchema(pack){
  return !!(pack && pack.fdw && (pack.fdw.remoteSchemaResolution==='connection-default' || pack.fdw.requiresDefaultSchema===true));
}
function fdwServiceUserSpec(pack){
  return pack && pack.fdw && pack.fdw.serviceUser && typeof pack.fdw.serviceUser==='object' ? pack.fdw.serviceUser : null;
}
function safeServiceUserToken(value){
  return String(value||'').trim().replace(/[^A-Za-z0-9_$]+/g,'_').replace(/^_+|_+$/g,'').slice(0,96);
}
let fdwServiceUserBusy=false;
let fdwServiceUserError='';
let fdwServiceUserDraft={dialect:'',schema:'',username:'',password:''};
function fdwServiceUserDraftFor(pack,schema){
  const dialect=state.externalTables.remoteDialect;
  const schemaKey=String(schema||'').trim();
  if(fdwServiceUserDraft.dialect!==dialect || fdwServiceUserDraft.schema!==schemaKey){
    const spec=fdwServiceUserSpec(pack)||{};
    const fallback=`dv_fdw_${safeServiceUserToken(schemaKey||'vault')}`;
    const templated=packTemplate(spec.defaultUsernameTemplate||fallback,{schema:safeServiceUserToken(schemaKey||'vault')});
    fdwServiceUserDraft={dialect,schema:schemaKey,username:safeServiceUserToken(templated)||fallback,password:''};
    fdwServiceUserError='';
  }
  return fdwServiceUserDraft;
}
function activeTargetProfile(dialect=state.externalTables.remoteDialect){
  const profile=state.externalTables&&state.externalTables.targetProfile;
  if(!profile||profile.dialect!==dialect) return null;
  const pack=databasePackForDialect(dialect);
  if(pack&&profile.packId&&profile.packId!==pack.id) return null;
  if(pack&&profile.packVersion&&profile.packVersion!==pack.version) return null;
  return profile;
}
function requiredExternalTargetSemanticTypes(){
  const required=new Set();
  for(const table of externalCoreTableSpecs()) for(const col of table.columns||[]) required.add(semanticTargetColumnSpec(col).semantic);
  required.delete('UNKNOWN');
  return [...required].sort();
}
function unresolvedTargetSemantics(pack,profile=activeTargetProfile()){
  const overrides=(pack&&pack.target&&pack.target.types)||{};
  return requiredExternalTargetSemanticTypes().filter(semantic=>!(overrides[semantic]||profile?.resolvedTypes?.[semantic]||overrides.UNKNOWN));
}
function renderTargetProfileSummaryHtml(pack){
  const profile=activeTargetProfile();
  if(!profile) return `<div class="ai-status busy mt" style="align-items:flex-start;"><span><b>Target type mapping:</b> not discovered yet. Test the connection to let Studio inspect JDBC metadata and build the project target profile.</span></div>`;
  const mapped=Object.keys(profile.resolvedTypes||{}).length;
  const overrides=Object.keys((pack&&pack.target&&pack.target.types)||{}).length;
  const missing=unresolvedTargetSemantics(pack,profile);
  const product=[profile.databaseProduct,profile.databaseVersion].filter(Boolean).join(' ');
  const driver=[profile.driverName,profile.driverVersion].filter(Boolean).join(' ');
  const fdwDefaultSchema=packUsesConnectionDefaultSchema(pack)&&profile.currentSchema
    ? ` · JDBC account default schema <span class="mono">${escapeHtml(profile.currentSchema)}</span>`
    : '';
  return `<div class="ai-status ${missing.length?'err':'ok'} mt" style="align-items:flex-start;"><span><b>JDBC target profile:</b> ${escapeHtml(product||pack.label)} · ${mapped} semantic type mapping(s) discovered${overrides?` · ${overrides} Pack override(s)`:''}${driver?` · driver ${escapeHtml(driver)}`:''}${fdwDefaultSchema}${missing.length?`<br>Required mappings still unresolved: <span class="mono">${escapeHtml(missing.join(', '))}</span>`:' · ready for the current Vault model'}.</span></div>`;
}

function renderExternalTargetStatusHtml(){
  const ext=state.externalTables;
  if (externalTargetConnStatus==='testing') return `<div class="ai-status busy mt"><span class="dot"></span>Connecting to the physical output database…</div>`;
  if (externalTargetConnStatus==='error') return `<div class="ai-status err mt">${escapeHtml(externalTargetConnError)}</div>`;
  if (externalTargetConnStatus==='ok'){
    const database=ext.studioDatabase||ext.remoteDatabase;
    const pack=databasePackForDialect(ext.remoteDialect);
    if (externalTargetDbExists===true){
      if(pack){
        const body=databasePackConnectionBody('target');
        const location=[externalTargetIdentity?.selectedDatabase||body?.catalog||body?.database,externalTargetIdentity?.selectedSchema||body?.schema].filter(Boolean).join(' / ');
        const selectedSchema=String(body?.schema||'').trim();
        const accountDefault=String(activeTargetProfile(ext.remoteDialect)?.currentSchema||'').trim();
        if(externalTargetIdentity?.schemaExists===false && selectedSchema){
          return `<div class="ai-status err mt" style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><span><b>Connected, but target schema is missing.</b> Database <span class="mono">${escapeHtml(externalTargetIdentity?.selectedDatabase||body?.catalog||body?.database||database)}</span> exists, but schema <span class="mono">${escapeHtml(selectedSchema)}</span> does not. Studio can create the schema using the current connection.</span><button class="btn small primary" id="btn-create-external-db" ${externalTargetDbCreating?'disabled':''}>${externalTargetDbCreating?'Creating…':'Create schema'}</button></div>`;
        }
        if(packUsesConnectionDefaultSchema(pack) && selectedSchema && accountDefault && selectedSchema.toLowerCase()!==accountDefault.toLowerCase()){
          const serviceSpec=fdwServiceUserSpec(pack);
          const draft=fdwServiceUserDraftFor(pack,selectedSchema);
          const provision=serviceSpec?`<div class="panel" style="margin:10px 0 0;padding:12px;box-shadow:none;width:100%;"><div class="grid cols-2"><div class="field"><label>FDW service username</label><input type="text" id="f-fdw-service-user" value="${escapeHtml(draft.username)}" autocomplete="username"></div><div class="field"><label>FDW service password</label><input type="password" id="f-fdw-service-password" value="${escapeHtml(draft.password)}" autocomplete="new-password"></div></div><p class="hint mt mb0">Studio will use the current connection only to create a dedicated service login/user, set that database user's default schema to <span class="mono">${escapeHtml(selectedSchema)}</span>, and grant access to that schema. The current account is not altered.</p>${fdwServiceUserError?`<div class="ai-status err mt">${escapeHtml(fdwServiceUserError)}</div>`:''}<button class="btn small primary mt" id="btn-create-fdw-service-user" ${fdwServiceUserBusy?'disabled':''}>${fdwServiceUserBusy?'Creating service account…':'Create & use FDW service account'}</button></div>`:'';
          return `<div class="ai-status err mt" style="align-items:flex-start;flex-direction:column;"><span><b>Connected — FDW service account needed.</b> The connection to ${escapeHtml(pack.label)}${location?` <span class="mono">${escapeHtml(location)}</span>`:''} succeeded. The selected physical schema is <span class="mono">${escapeHtml(selectedSchema)}</span>, while this database account currently resolves unqualified tables through <span class="mono">${escapeHtml(accountDefault)}</span>. That default comes from this database account, not from the Database Pack. The current jdbc_fdw route needs a connection account whose default schema matches the selected physical schema.</span>${provision}</div>`;
        }
        const fdwNote=packUsesConnectionDefaultSchema(pack) && accountDefault
          ? (selectedSchema?` · FDW account default schema <span class="mono">${escapeHtml(accountDefault)}</span>`:` · FDW will use account default schema <span class="mono">${escapeHtml(accountDefault)}</span>`)
          : '';
        return `<div class="ai-status ok mt">Connected — ${escapeHtml(pack.label)}${location?` <span class="mono">${escapeHtml(location)}</span>`:''} is reachable through JDBC${fdwNote}.</div>`;
      }
      const identity=externalTargetIdentity&&externalTargetIdentity.currentUser
        ? ` · server <span class="mono">${escapeHtml(externalTargetIdentity.serverHostname||ext.studioHost)}:${escapeHtml(String(externalTargetIdentity.serverPort||ext.studioPort||''))}</span> · authenticated as <span class="mono">${escapeHtml(externalTargetIdentity.currentUser)}</span>`
        : '';
      return `<div class="ai-status ok mt">Connected — ${escapeHtml((DIALECTS[ext.remoteDialect]||{}).label||ext.remoteDialect)} database/schema <span class="mono">${escapeHtml(database)}</span> exists${identity}.</div>`;
    }
    if (externalTargetDbExists===false) return `
      <div class="ai-status err mt" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <span>Connected to the server, but physical output database <span class="mono">${escapeHtml(database)}</span> does not exist yet.</span>
        <button class="btn small primary" id="btn-create-external-db" ${externalTargetDbCreating?'disabled':''}>${externalTargetDbCreating?'Creating…':'Create database'}</button>
      </div>`;
  }
  return '';
}

async function testExternalTargetConnection(){
  const ext=state.externalTables;
  externalTargetConnStatus='testing'; externalTargetDbExists=null; externalTargetConnError='';
  const status=document.getElementById('external-target-status-wrap');
  if(status) status.innerHTML=renderExternalTargetStatusHtml();
  try{
    const health=await localFetch('/api/health').catch(()=>null);
    if(!health||!health.ok) throw new Error(`Local server not reachable at ${localServerUrl} — is it running?`);
    const pack=databasePackForDialect(ext.remoteDialect);
    const payload=externalConnectionPayload();
    const resp=await localFetch('/api/external-db-status',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pack?{...payload,includeProfile:true}:payload)
    });
    const data=await resp.json();
    if(!data.ok) throw new Error(data.error||'Connection failed.');
    externalTargetConnStatus='ok'; externalTargetDbExists=!!data.exists; externalTargetIdentity=data;
    if(pack && data.exists){
      if(data.targetProfile) acceptDatabasePackTargetProfile(data.targetProfile,{acceptDrift:true});
      else await discoverDatabasePackTargetProfile({silent:true,acceptDrift:true});
    }
    const namespaceReady=data.exists && data.schemaExists!==false; toast(namespaceReady?(databasePackForDialect(ext.remoteDialect)?'Connected and mapped JDBC target types.':'Connected to the physical output database.'):(data.exists?'Connected, but the selected target schema is missing.':'Connected, but the physical output database is missing.'),namespaceReady?'ok':'err');
  }catch(err){
    externalTargetConnStatus='error'; externalTargetConnError=err.message;
    toast('External target connection failed — see details below.','err');
  }
  if(activeTab==='connections'){
    if(databasePackForDialect(ext.remoteDialect)&&ext.targetProfile){
      renderAll(); setActiveTabViewOnly('connections');
    }else{
      const node=document.getElementById('external-target-status-wrap');
      if(node) node.innerHTML=renderExternalTargetStatusHtml();
      const create=document.getElementById('btn-create-external-db');
      if(create) create.addEventListener('click',createExternalTargetDatabase);
      wireFdwServiceUserActions(document);
    }
  }
}

function wireFdwServiceUserActions(root=document){
  const userInput=root.querySelector?root.querySelector('#f-fdw-service-user'):null;
  const passwordInput=root.querySelector?root.querySelector('#f-fdw-service-password'):null;
  if(userInput) userInput.addEventListener('input',e=>{fdwServiceUserDraft.username=e.target.value;fdwServiceUserError='';});
  if(passwordInput) passwordInput.addEventListener('input',e=>{fdwServiceUserDraft.password=e.target.value;fdwServiceUserError='';});
  const button=root.querySelector?root.querySelector('#btn-create-fdw-service-user'):null;
  if(button) button.addEventListener('click',createAndUseFdwServiceUser);
}
async function createAndUseFdwServiceUser(){
  if(fdwServiceUserBusy)return;
  const ext=state.externalTables;
  const pack=databasePackForDialect(ext.remoteDialect);
  if(!pack||!fdwServiceUserSpec(pack)){toast('This Database Pack does not provide FDW service-account provisioning.','err');return;}
  let body;
  try{body=confirmImportedConnectionTarget(databasePackConnectionBody('target'));}
  catch(err){toast(err.message,'err');return;}
  const selectedSchema=String(body?.schema||'').trim();
  const draft=fdwServiceUserDraftFor(pack,selectedSchema);
  const serviceUser=safeServiceUserToken(draft.username);
  const servicePassword=String(draft.password||'');
  if(!selectedSchema){toast('Select a physical target schema first.','err');return;}
  if(!serviceUser){toast('Enter a service username.','err');return;}
  if(!servicePassword){toast('Enter a password for the new FDW service account.','err');return;}
  fdwServiceUserBusy=true; fdwServiceUserError='';
  renderAll(); setActiveTabViewOnly('connections');
  try{
    const response=await localFetch('/api/database-packs/provision-fdw-service-user',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,serviceUser,servicePassword})
    });
    const data=await response.json();
    if(!data.ok)throw new Error(data.error||'Could not provision the FDW service account.');
    const values=packConnectionValues('target');
    const userField=(pack.connectionFields||[]).find(f=>f.mapsTo==='user');
    const passwordField=(pack.connectionFields||[]).find(f=>f.mapsTo==='password');
    if(!userField||!passwordField)throw new Error('The Database Pack does not expose mapped username/password fields.');
    values[userField.key]=serviceUser; values[passwordField.key]=servicePassword;
    syncPackMappedValues(pack,'target');
    ext.targetProfile=null; ext.deploymentAcknowledged=false; externalPreflightResult=null; externalDeployResult=null;
    fdwServiceUserDraft={dialect:'',schema:'',username:'',password:''};
    toast(`Created FDW service account ${serviceUser} and switched this target connection to it.`,'ok');
    await testExternalTargetConnection();
  }catch(err){
    fdwServiceUserError=explainExternalTargetError(err.message);
    toast('Could not create the FDW service account: '+fdwServiceUserError,'err');
  }finally{
    fdwServiceUserBusy=false;
    if(activeTab==='connections'){renderAll();setActiveTabViewOnly('connections');}
  }
}

async function createExternalTargetDatabase(){
  const ext=state.externalTables;
  externalTargetDbCreating=true;
  const status=document.getElementById('external-target-status-wrap');
  if(status) status.innerHTML=renderExternalTargetStatusHtml();
  try{
    const pack=databasePackForDialect(ext.remoteDialect);
    const createPayload=externalConnectionPayload();
    if(pack){
      createPayload.knownDatabaseExists=typeof externalTargetDbExists==='boolean'?externalTargetDbExists:null;
      createPayload.knownSchemaExists=externalTargetIdentity&&typeof externalTargetIdentity.schemaExists==='boolean'?externalTargetIdentity.schemaExists:null;
    }
    const resp=await localFetch('/api/external-create-database',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(createPayload)
    });
    const data=await resp.json();
    if(!data.ok) throw new Error(data.error||'Could not create the physical output database.');
    let verify=data.verified?data:null;
    if(!verify){
      const verifyPayload=externalConnectionPayload();
      verify=await localFetch('/api/external-db-status',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pack?{...verifyPayload,includeProfile:true}:verifyPayload)
      }).then(r=>r.json());
    }
    if(!verify.ok||!verify.exists) throw new Error(verify.error||`Physical output database "${ext.studioDatabase||ext.remoteDatabase}" was not visible after creation.`);
    externalTargetConnStatus='ok'; externalTargetDbExists=true; externalTargetConnError=''; externalTargetIdentity=verify;
    if(pack){
      if(verify.targetProfile) acceptDatabasePackTargetProfile(verify.targetProfile,{acceptDrift:true});
      else await discoverDatabasePackTargetProfile({silent:true,acceptDrift:true});
    }
    const createdBits=[]; if(data.created)createdBits.push('database'); if(data.schemaCreated)createdBits.push('schema');
    toast(createdBits.length?`Created and verified target ${createdBits.join(' and ')}.`:'Physical output database/schema already exist and were verified.','ok');
  }catch(err){
    const explained=explainExternalTargetError(err.message);
    externalTargetConnStatus='error'; externalTargetConnError=explained;
    toast('Could not create the physical output database: '+explained,'err');
  }finally{
    externalTargetDbCreating=false;
    if(activeTab==='connections'){
      if(databasePackForDialect(ext.remoteDialect)){renderAll();setActiveTabViewOnly('connections');}
      else{
        const node=document.getElementById('external-target-status-wrap');
        if(node) node.innerHTML=renderExternalTargetStatusHtml();
      }
    }
  }
}

async function checkTargetRoles(){
  const v = state.vault;
  targetRoleCheck = 'checking';
  document.getElementById('target-status-wrap').innerHTML = renderTargetStatusHtml();
  try {
    const resp = await localFetch(`/api/execute-sql`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        ...targetConnectionPayload(),
        sql: 'SET ROLE staging; RESET ROLE; SET ROLE data_vault; RESET ROLE;',
      }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Role switch failed.');
    targetRoleCheck = 'ok'; targetRoleCheckError = '';
  } catch(err){
    targetRoleCheck = 'error'; targetRoleCheckError = err.message;
  }
  if (activeTab==='connections') document.getElementById('target-status-wrap').innerHTML = renderTargetStatusHtml();
}

async function testTargetConnection(){
  const v = state.vault;
  targetConnStatus = 'testing'; targetDbExists = null; targetRoleCheck = null;
  document.getElementById('target-status-wrap').innerHTML = renderTargetStatusHtml();
  try {
    const health = await localFetch(`/api/health`).catch(()=>null);
    if (!health || !health.ok){
      throw new Error(`Local server not reachable at ${localServerUrl} — is it running? (cd server && npm install && npm start)`);
    }
    const resp = await localFetch(`/api/db-status`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(targetConnectionPayload()),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Connection failed.');
    targetConnStatus = 'ok'; targetConnError = ''; targetDbExists = data.exists;
    const databaseRole=state.externalTables.enabled?'gateway':'target';
    toast(data.exists ? `Connected — PostgreSQL ${databaseRole} database exists.` : `Connected, but the PostgreSQL ${databaseRole} database is missing.`, data.exists?'ok':'err');
  } catch(err){
    targetConnStatus = 'error'; targetConnError = err.message;
    toast('Connection failed — see details below.','err');
  }
  if (activeTab==='connections'){
    document.getElementById('target-status-wrap').innerHTML = renderTargetStatusHtml();
    const createBtn = document.getElementById('btn-create-db');
    if (createBtn) createBtn.addEventListener('click', createTargetDatabase);
  }
  // Only worth checking role-switching once the database actually exists —
  // this is exactly what "Execute" needs to succeed later.
  if (targetConnStatus==='ok' && targetDbExists===true) checkTargetRoles();
}

async function createTargetDatabase(){
  const v = state.vault;
  targetDbCreating = true;
  document.getElementById('target-status-wrap').innerHTML = renderTargetStatusHtml();
  try {
    const resp = await localFetch(`/api/create-database`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(targetConnectionPayload()),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Could not create the database.');
    const verify = await localFetch(`/api/db-status`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(targetConnectionPayload()),
    }).then(r=>r.json());
    const databaseRole=state.externalTables.enabled?'gateway':'target';
    if (!verify.ok || !verify.exists) throw new Error(verify.error || `PostgreSQL ${databaseRole} database "${v.dvDatabase}" was not visible after creation.`);
    targetConnStatus = 'ok'; targetConnError = ''; targetDbExists = true;
    toast(data.created ? `PostgreSQL ${databaseRole} database "${v.dvDatabase}" created and verified.` : `PostgreSQL ${databaseRole} database already exists and was verified.`, 'ok');
    // A freshly created database won't have the staging/data_vault roles
    // from this project's own db-init yet — this check will correctly
    // fail until that's been run, which is useful signal, not a bug.
    checkTargetRoles();
  } catch(err){
    toast('Could not create the database: ' + err.message, 'err');
  } finally {
    targetDbCreating = false;
    if (activeTab==='connections') document.getElementById('target-status-wrap').innerHTML = renderTargetStatusHtml();
  }
}

/* ---- Packaged database containers (MySQL Demo / Postgres Internal) ----
   Start & connect: start the container via the local server, wait until it
   accepts connections, then run the normal Test & connect flow. */
function containerStatusEl(kind){
  return document.getElementById(kind==='source' ? 'src-container-status' : 'tgt-container-status');
}
function setContainerStatus(kind, cls, msg){
  const el = containerStatusEl(kind);
  if (el) el.innerHTML = msg ? `<div class="ai-status ${cls}" style="margin-bottom:12px;">${cls==='busy'?'<span class="dot"></span>':''}${escapeHtml(msg)}</div>` : '';
}
async function containerProbe(kind){
  const v = state.vault;
  if (kind==='source'){
    const resp = await localFetch(`/api/test-connection`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(sourceConnectionPayload()),
    });
    return (await resp.json()).ok === true;
  }
  const resp = await localFetch(`/api/db-status`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(targetConnectionPayload()),
  });
  return (await resp.json()).ok === true;
}
async function startAndConnectContainer(kind){
  const service = kind==='source' ? 'mysql' : 'postgres';
  if (!await requireLicenseAccepted(()=> startAndConnectContainer(kind))) return;
  try {
    setContainerStatus(kind, 'busy', `Starting the ${service} container…`);
    const data = await localFetch(`/api/docker/start-db`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        service,
        fdw: service==='postgres' && state.externalTables.enabled,
        ...(service==='postgres' ? { database: state.vault.dvDatabase } : {}),
      }),
    }).then(r=>r.json());
    if (!data.ok) throw new Error(data.error || data.stderr || `Could not start ${service}.`);
    // A fresh container needs a moment before it accepts connections —
    // especially first boot, when it runs its init scripts.
    setContainerStatus(kind, 'busy', `Waiting for ${service} to accept connections…`);
    const deadline = Date.now() + 90000;
    let up = false;
    while (Date.now() < deadline){
      try { if (await containerProbe(kind)){ up = true; break; } } catch(_){}
      await new Promise(r=>setTimeout(r, 3000));
    }
    if (!up) throw new Error(`${service} started but did not accept connections within 90s — first boot can take longer while init scripts run. Try again shortly.`);
    setContainerStatus(kind, 'ok', `${service} container is up — connecting…`);
    if (kind==='source') await testSourceConnection(); else await testTargetConnection();
    setContainerStatus(kind, 'ok', `${service} container is up.`);
  } catch(err){
    setContainerStatus(kind, 'err', err.message);
    toast(`Container start failed: ${err.message}`, 'err');
  }
}
async function stopContainer(kind){
  const service = kind==='source' ? 'mysql' : 'postgres';
  try {
    setContainerStatus(kind, 'busy', `Stopping the ${service} container…`);
    const data = await localFetch(`/api/docker/stop-db`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ service }),
    }).then(r=>r.json());
    if (!data.ok) throw new Error(data.error || data.stderr || `Could not stop ${service}.`);
    setContainerStatus(kind, 'ok', `${service} container stopped.`);
    toast(`${service} container stopped.`, 'ok');
  } catch(err){
    setContainerStatus(kind, 'err', err.message);
    toast(`Container stop failed: ${err.message}`, 'err');
  }
}

// Raw introspection fetch used by the Step 2 source-table detection action.
