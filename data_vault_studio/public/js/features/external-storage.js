/* ---------------- EXTERNAL STORAGE (jdbc_fdw) — configured at the end of Connections ---------------- */
let externalPreflightResult = null;
let externalDeployResult = null;
let externalStorageBusy = false;

function externalCoreTableSpecs(){
  const out = [];
  (state.hubs||[]).forEach(h=>out.push({ family:'hub', name:hubName(h.entity), columns:hubColumns(h), keyColumn:hubKey(h.entity) }));
  (state.links||[]).forEach(l=>out.push({ family:'link', name:linkNameOf(l.entity), columns:linkColumns(l), keyColumn:linkKeyOf(l.entity) }));
  (state.hubSats||[]).forEach(s=>out.push({ family:'sat', name:satName(s.entity,s.concern), columns:hubSatColumns(s), keyColumn:'sat_key' }));
  (state.linkSats||[]).forEach(s=>out.push({ family:'lsat', name:lsatName(s.entity,s.concern), columns:linkSatColumns(s), keyColumn:'sat_key' }));
  return out;
}
function externalCoreTableNames(){ return externalCoreTableSpecs().map(x=>x.name); }
function externalCoreTableCount(){ return externalCoreTableSpecs().length; }
function externalDefaultPort(dialect){
  const pack=databasePackForDialect(dialect);
  if(pack) return String((pack.connectionFields||[]).find(f=>f.mapsTo==='port')?.default||'');
  return ({postgresql:'5432',mysql:'3306'})[dialect] || '';
}
function externalIdentifierIsSafe(value){ return /^[a-z_][a-z0-9_$]*$/i.test(String(value||'')); }

function parseJdbcUrlDefaults(url){
  const raw = String(url||'').trim();
  let m;
  if ((m=raw.match(/^jdbc:(postgresql|mysql):\/\/([^\/:;?]+)(?::(\d+))?\/([^?;]+)(?:[?;].*)?$/i))){
    const dialect=m[1].toLowerCase()==='postgresql'?'postgresql':'mysql';
    let schema='';
    const q=raw.split('?')[1]||'';
    const params={};
    q.split('&').filter(Boolean).forEach(pair=>{ const i=pair.indexOf('='); const k=decodeURIComponent(i<0?pair:pair.slice(0,i)); const v=decodeURIComponent(i<0?'':pair.slice(i+1)); params[k]=v; });
    schema=params.currentSchema||params.current_schema||'';
    return { dialect, host:m[2], port:m[3]||externalDefaultPort(dialect), database:decodeURIComponent(m[4]), schema };
  }
  if ((m=raw.match(/^jdbc:sqlserver:\/\/([^:;]+)(?::(\d+))?(?:;.*?databaseName=([^;]+))?/i))){
    return { dialect:'sqlserver', host:m[1], port:m[2]||'1433', database:m[3]||'', schema:'dbo' };
  }
  if ((m=raw.match(/^jdbc:oracle:thin:@\/?\/?([^:;\/]+)(?::(\d+))?[\/:]([^?;]+)$/i))){
    return { dialect:'oracle', host:m[1], port:m[2]||'1521', database:m[3]||'', schema:'' };
  }
  return null;
}

function syncExternalStudioConnection(force=false){
  const ext=state.externalTables;
  if (!force && ext.studioConnectionOverridden) return;
  const parsed=parseJdbcUrlDefaults(ext.url);
  if (parsed){
    // JDBC URL parsing may infer host/port/database/schema, but it must not
    // replace an installed Database Pack identity with a legacy vendor name
    // such as "sqlserver". The Pack owns the target dialect.
    if(!databasePackForDialect(ext.remoteDialect)) ext.remoteDialect=parsed.dialect||ext.remoteDialect;
    ext.studioHost=ext.studioHost||parsed.host||'';
    ext.studioPort=ext.studioPort||parsed.port||'';
    ext.studioDatabase=ext.studioDatabase||parsed.database||'';
    ext.studioSchema=ext.studioSchema||parsed.schema||ext.remoteSchema||'';
    ext.remoteDatabase=ext.remoteDatabase||parsed.database||'';
    ext.remoteSchema=ext.remoteSchema||parsed.schema||'';
  }
  if (isDemoRuntime()){
    ext.studioUser=String(state.vault.srcUser||'');
    ext.studioPassword='';
  } else {
    ext.studioUser=String(ext.studioUser||ext.username||'');
    ext.studioPassword=String(ext.studioPassword||ext.password||'');
  }
  ext.username=ext.studioUser;
  ext.password=ext.studioPassword;
}

function targetProfileComparable(profile){
  if(!profile) return '';
  return JSON.stringify({
    dialect:profile.dialect||'',packId:profile.packId||'',packVersion:profile.packVersion||'',
    databaseProduct:profile.databaseProduct||'',databaseVersion:profile.databaseVersion||'',
    driverName:profile.driverName||'',driverVersion:profile.driverVersion||'',
    identifierQuote:profile.identifierQuote||'',resolvedTypes:profile.resolvedTypes||{},
  });
}
function acceptDatabasePackTargetProfile(rawProfile,options={}){
  const ext=state.externalTables;
  const pack=databasePackForDialect(ext.remoteDialect);
  if(!pack||!rawProfile)return null;
  const profile={...rawProfile,dialect:ext.remoteDialect,packId:pack.id,packVersion:pack.version};
  const stored=ext.targetProfile&&ext.targetProfile.dialect===ext.remoteDialect?ext.targetProfile:null;
  const identityChanged=stored&&(stored.packId&&stored.packId!==pack.id || stored.packVersion&&stored.packVersion!==pack.version);
  const changed=stored&&(identityChanged||targetProfileComparable(stored)!==targetProfileComparable(profile));
  if(changed&&options.acceptDrift===false){
    throw new Error(`${pack.label} JDBC target metadata or Pack version changed since this project profile was saved. Return to Connections and use "Test connection & map types" to review and accept the refreshed mapping before deployment.`);
  }
  if(!stored||!changed||options.acceptDrift!==false) ext.targetProfile=profile;
  return changed&&options.acceptDrift===false?stored:profile;
}
async function discoverDatabasePackTargetProfile(options={}){
  const ext=state.externalTables;
  const pack=databasePackForDialect(ext.remoteDialect);
  if(!pack) return null;
  const payload=externalConnectionPayload(ext.studioDatabase||ext.remoteDatabase);
  const response=await localFetch('/api/database-packs/analyze',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
  });
  const data=await response.json();
  if(!data.ok) throw new Error(data.error||`Could not inspect ${pack.label} JDBC metadata.`);
  const profile=acceptDatabasePackTargetProfile(data.targetProfile||{},options);
  if(!options.silent && activeTab==='connections'){
    const panel=document.getElementById('main');
    if(panel){ renderAll(); setActiveTabViewOnly('connections'); }
  }
  return profile;
}

function externalConnectionPayload(databaseOverride){
  const ext=state.externalTables;
  if(isDemoRuntime())return {credentialRef:'demo-fdw-physical-mysql',dialect:'mysql',database:databaseOverride===undefined?ext.studioDatabase:databaseOverride,schema:''};
  const packPayload=databasePackConnectionBody('target');
  if(packPayload){ if(databaseOverride!==undefined){packPayload.database=databaseOverride;packPayload.catalog=databaseOverride;} return confirmImportedConnectionTarget(packPayload); }
  const targetUser=String(ext.studioUser||ext.username||'');
  const targetPassword=String(ext.studioPassword||ext.password||'');
  ext.studioUser=targetUser; ext.username=targetUser;
  ext.studioPassword=targetPassword; ext.password=targetPassword;
  return confirmImportedConnectionTarget({
    dialect:ext.remoteDialect,
    host:ext.studioHost,
    port:ext.studioPort||externalDefaultPort(ext.remoteDialect),
    database:databaseOverride===undefined?ext.studioDatabase:databaseOverride,
    schema:ext.studioSchema||ext.remoteSchema,
    user:targetUser,
    password:targetPassword,
  });
}

async function verifyExternalTargetUserAccess(checks){
  const ext=state.externalTables;
  const result=await externalApi('/api/external-verify-user-access',externalConnectionPayload(ext.studioDatabase||ext.remoteDatabase));
  const pack=databasePackForDialect(ext.remoteDialect);
  if(pack){
    const values=packConnectionValues('target');
    const user=packValueMappedTo(pack,values,'user')||ext.studioUser||ext.username||'configured JDBC user';
    const location=[result.catalog||'',result.schema||''].filter(Boolean).join(' / ');
    if(packUsesConnectionDefaultSchema(pack)){
      const selected=String(packValueMappedTo(pack,values,'schema')||pack.namespace?.defaultSchema||'').trim();
      const actual=String(activeTargetProfile(ext.remoteDialect)?.currentSchema||'').trim();
      if(selected && actual && selected.toLowerCase()!==actual.toLowerCase()){
        checks.push({
          level:'fatal',
          label:'3a · FDW remote schema resolution',
          detail:`Selected physical schema ${selected} does not match the JDBC account default schema ${actual}. This jdbc_fdw route resolves remote table names through the account default schema. Studio will not ALTER the account automatically because the same credential may be shared by other projects. Use a dedicated account whose default schema is ${selected}, or deliberately choose ${actual} as this target schema.`
        });
        throw new Error(`The selected physical schema ${selected} is incompatible with this JDBC FDW account default schema ${actual}.`);
      }
      if(actual){
        checks.push({level:'ok',label:'3a · FDW remote schema resolution',detail:selected?`selected schema ${selected} matches the JDBC account default schema`:`no explicit physical schema was selected; jdbc_fdw will use the account default schema ${actual}`});
      }
    }
    checks.push({level:'ok',label:'3b · Physical target account',detail:`${user} opened ${pack.label}${location?` (${location})`:''}; this credential will be stored in both PostgreSQL jdbc_fdw user mappings`});
    return;
  }
  checks.push({level:'ok',label:'3 · Physical target account',detail:`${result.currentUser||ext.studioUser||ext.username} opened ${ext.studioDatabase||ext.remoteDatabase}${result.defaultSchema?` with default schema ${result.defaultSchema}`:''}; this target credential will be stored in both PostgreSQL user mappings`});
}
function externalStatusHtml(result){
  if (!result) return '';
  const rows=(result.checks||[]).map(c=>`<div class="ai-status ${c.level==='ok'?'ok':c.level==='fatal'?'err':''} mt" style="align-items:flex-start;"><span><b>${escapeHtml(c.label)}:</b> ${escapeHtml(c.detail)}</span></div>`).join('');
  return rows + (result.message?`<div class="ai-status ${result.ok?'ok':'err'} mt"><span>${escapeHtml(result.message)}</span></div>`:'');
}

function renderExternalSub(el){
  if(!el) return;
  const ext=state.externalTables;
  if (!ext.enabled){ el.innerHTML=''; return; }
  applyExternalTargetDefaults(false);
  syncExternalStudioConnection(false);
  const demo=isDemoRuntime();
  const configLock=demo?'readonly aria-readonly="true"':'';
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>④ PostgreSQL FDW gateway <span class="badge-count">&nbsp;·&nbsp;internal PostgreSQL</span></h3></div>
      <div class="flex-between" style="gap:12px;align-items:flex-start;">
        <div>
          <label class="mb0">Foreign server configuration</label>
          <p class="hint mb0">The internal PostgreSQL container exposes the physical core tables as foreign tables. Staging, metadata, views and every <span class="mono">*_err</span> table remain local.</p>
        </div>
        <span class="tag sat">FDW enabled</span>
      </div>
      <p class="hint mt">${demo?'Demo mode fixes these values to the packaged MySQL service.':'These values describe the JDBC connection seen from inside the internal PostgreSQL container. The container-side hostname may differ from the hostname Studio uses above. Project certificate references such as dv-certs/ca.pem resolve to /app/dv-certs/ca.pem in this container.'}</p>
      <div class="grid cols-2">
        <div class="field"><label>Foreign server name</label><input type="text" id="ext-servername" value="${escapeHtml(ext.serverName)}" placeholder="${escapeHtml((state.vault.name||'vault')+'_external_srv')}" ${configLock}></div>
        <div class="field"><label>JDBC driver class</label><input type="text" id="ext-drivername" value="${escapeHtml(ext.drivername)}" placeholder="${escapeHtml(externalDialectDefaults(ext.remoteDialect).drivername)}" ${configLock}></div>
      </div>
      <div class="field mt"><label>JDBC URL seen inside PostgreSQL</label><input type="text" id="ext-url" value="${escapeHtml(ext.url)}" placeholder="${escapeHtml(defaultExternalJdbcUrl(ext.remoteDialect,'external-db',externalDefaultPort(ext.remoteDialect),ext.studioDatabase||ext.remoteDatabase||'datavault'))}" ${configLock}></div>
      <div class="grid cols-2 mt">
        <div class="field"><label>Driver jar path inside PostgreSQL</label><input type="text" id="ext-jarfile" value="${escapeHtml(ext.jarfile)}" placeholder="${escapeHtml(externalDialectDefaults(ext.remoteDialect).jarfile)}" ${configLock}></div>
        <div class="field"><label>Query timeout (seconds)</label><input type="text" id="ext-querytimeout" value="${escapeHtml(ext.querytimeout)}" ${configLock}></div>
      </div>
      <div class="field mt"><label>Maximum JVM heap, optional</label><input type="text" id="ext-maxheapsize" value="${escapeHtml(ext.maxheapsize)}" placeholder="512m" ${configLock}></div>

      <div class="panel" style="margin:16px 0 0;padding:14px;box-shadow:none;">
        <label class="mb0">Role mappings</label>
        <p class="hint">The physical target credential entered above is mapped to both PostgreSQL runtime roles.</p>
        <div class="grid cols-2">
          <div class="field"><label>Mapped target username</label><input type="text" value="${escapeHtml(ext.username)}" readonly></div>
          <div class="field"><label>Mapped target password</label><input type="password" value="${escapeHtml(ext.password)}" readonly autocomplete="off"></div>
        </div>
        <p class="hint mb0"><span class="mono">data_vault</span> and <span class="mono">pdi_meta</span> both use this mapping. No public user mapping is created.</p>
      </div>
    </div>

    <div class="ai-status busy mt" style="align-items:flex-start;"><span><b>Deployment remains on Export.</b> <span class="mono">Check status</span> and <span class="mono">Apply all updates</span> create the physical target first, then configure the FDW server, role mappings and foreign-table bindings.</span></div>

    <details class="panel panel-flush mt">
      <summary class="panel-head" style="cursor:pointer;"><h3 style="display:inline;">Technical preview</h3></summary>
      <div class="grid cols-2" style="padding:16px;"><div><label>Local foreign table</label><pre class="code mt" id="ext-preview"></pre></div><div><label>Remote physical table</label><pre class="code mt" id="ext-preview-remote"></pre></div></div>
    </details>
  `;

  if(!demo){
    const bind=(id,key)=>{
      const node=el.querySelector('#'+id); if(!node)return;
      node.addEventListener('input',e=>{
        ext[key]=e.target.value;
        ext.deploymentAcknowledged=false;
        externalPreflightResult=null;
        externalDeployResult=null;
        if(id==='ext-url'){
          ext.fdwUrlOverridden=true;
          const parsed=parseJdbcUrlDefaults(ext.url);
          if(parsed){
            // Preserve pack:<id> when editing the JDBC URL. URL parsing only
            // supplies connection defaults; it does not choose the target adapter.
            if(!databasePackForDialect(ext.remoteDialect)) ext.remoteDialect=parsed.dialect||ext.remoteDialect;
            ext.remoteDatabase=parsed.database||ext.remoteDatabase;
            ext.remoteSchema=parsed.schema||ext.remoteSchema;
          }
        }
        refreshExtPreview(el);
      });
    };
    bind('ext-servername','serverName'); bind('ext-drivername','drivername');
    bind('ext-url','url'); bind('ext-jarfile','jarfile'); bind('ext-querytimeout','querytimeout'); bind('ext-maxheapsize','maxheapsize');
  }
  refreshExtPreview(el);
}
function refreshExtPreview(el){
  const pre=el.querySelector('#ext-preview'), preRemote=el.querySelector('#ext-preview-remote');
  if(!pre)return;
  const ext=state.externalTables, sample=externalCoreTableSpecs()[0]||{name:'hub_example_entity',columns:[{name:'hub_example_entity_id',type:hashSqlType(),notNull:true}],keyColumn:'hub_example_entity_id'};
  pre.textContent=buildFdwPreamble()+'\n'+ddlForeignTable(`data_vault.${sample.name}`,sample.columns,sample.keyColumn);
  if(preRemote){
    try{ preRemote.textContent=remoteCreateTable(sample.name,sample.columns,ext.remoteDialect||'postgresql',ext.studioDatabase||ext.remoteDatabase,ext.studioSchema||ext.remoteSchema); }
    catch(err){ preRemote.textContent=`-- ${err.message}\n-- Test the physical target connection to discover its JDBC target profile.`; }
  }
}

function externalPreflightFatal(result){ return (result.checks||[]).some(c=>c.level==='fatal'); }

async function localGatewayDatabaseStatus(){
  const v=state.vault;
  const r=await localFetch('/api/db-status',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(targetConnectionPayload())
  });
  const data=await r.json();
  if(!data.ok)throw new Error(data.error||'Could not reach the packaged PostgreSQL gateway.');
  return data;
}

async function ensureLocalGatewayDatabase(checks){
  const v=state.vault;
  let status=await localGatewayDatabaseStatus();
  let created=false;
  if(!status.exists){
    const r=await localFetch('/api/create-database',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(targetConnectionPayload())
    });
    const data=await r.json();
    if(!data.ok)throw new Error(data.error||`Could not create PostgreSQL gateway database ${v.dvDatabase}.`);
    created=!!data.created;
    status=await localGatewayDatabaseStatus();
  }
  if(!status.exists)throw new Error(`PostgreSQL gateway database "${v.dvDatabase}" was not visible after creation.`);
  targetConnStatus='ok'; targetDbExists=true; targetConnError='';
  checks.push({level:'ok',label:'1 · PostgreSQL gateway database',detail:created?`created and verified ${v.dvDatabase}`:`verified existing ${v.dvDatabase}`});
  return status;
}


async function verifyPostgresRoleAssumption(role, checks, database=state.vault.dvDatabase, label=`PostgreSQL ${role} role`){
  const rows=await queryPostgresDatabase(database,
    `SELECT session_user AS login_user, current_user AS effective_user`,
    {role});
  const row=rows[0]||{};
  if(String(row.effective_user||'')!==role){
    throw new Error(`The PostgreSQL deployment login ${row.login_user||state.vault.dvUser||'(unknown)'} could not assume role ${role}.`);
  }
  if(checks)checks.push({level:'ok',label,detail:`${row.login_user||state.vault.dvUser} can SET ROLE ${role}`});
  return row;
}

async function verifyDataVaultRoleAssumption(checks, database=state.vault.dvDatabase, label='PostgreSQL data_vault role'){
  return verifyPostgresRoleAssumption('data_vault',checks,database,label);
}

async function verifyPdiMetaRoleAssumption(checks, database=state.vault.dvDatabase, label='PostgreSQL pdi_meta role'){
  return verifyPostgresRoleAssumption('pdi_meta',checks,database,label);
}

async function externalTargetDatabaseStatus(options={}){
  const payload=externalConnectionPayload();
  return externalApi('/api/external-db-status',options.includeProfile?{...payload,includeProfile:true}:payload);
}

async function ensureExternalTargetDatabase(checks){
  const ext=state.externalTables;
  const database=ext.studioDatabase||ext.remoteDatabase;
  let status=await externalTargetDatabaseStatus();
  let created=false, schemaCreated=false;
  if(!status.exists || status.schemaExists===false){
    const pack=databasePackForDialect(ext.remoteDialect);
    const payload=externalConnectionPayload();
    if(pack){
      payload.knownDatabaseExists=!!status.exists;
      payload.knownSchemaExists=typeof status.schemaExists==='boolean'?status.schemaExists:null;
    }
    const result=await externalApi('/api/external-create-database',payload);
    created=!!result.created; schemaCreated=!!result.schemaCreated;
    status=result.verified?result:await externalTargetDatabaseStatus();
  }
  if(!status.exists)throw new Error(`Physical output database "${database}" was not visible after creation.`);
  if(status.schemaExists===false)throw new Error(`Physical output schema "${status.selectedSchema||ext.studioSchema||ext.remoteSchema}" was not visible after creation.`);
  externalTargetConnStatus='ok'; externalTargetDbExists=true; externalTargetConnError=''; externalTargetIdentity=status;
  const detail=[]; if(created)detail.push(`created database ${database}`); else detail.push(`verified database ${database}`);
  if(schemaCreated)detail.push(`created schema ${status.selectedSchema||ext.studioSchema||ext.remoteSchema}`); else if(status.selectedSchema)detail.push(`verified schema ${status.selectedSchema}`);
  checks.push({level:'ok',label:'2 · Physical output database',detail:detail.join(' · ')});
  return status;
}

async function verifyLocalForeignTables(){
  const names=externalCoreTableNames();
  if(!names.length)return;
  const literals=names.map(n=>`'${sqlLiteral(n)}'`).join(',');
  const rows=await queryTarget(`SELECT c.relname AS table_name, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='data_vault' AND c.relname IN (${literals})`);
  const byName=new Map(rows.map(r=>[String(r.table_name).toLowerCase(),String(r.relkind)]));
  const missing=names.filter(n=>!byName.has(n.toLowerCase()));
  const wrong=names.filter(n=>byName.has(n.toLowerCase())&&byName.get(n.toLowerCase())!=='f');
  if(missing.length||wrong.length){
    const detail=[];
    if(missing.length)detail.push(`missing: ${missing.join(', ')}`);
    if(wrong.length)detail.push(`not foreign tables: ${wrong.join(', ')}`);
    throw new Error(`Local foreign-table verification failed (${detail.join('; ')}).`);
  }
}

async function localFdwInfrastructureStatus(){
  const ext=state.externalTables;
  if(!ext.serverName) return {
    extensionExists:false,
    serverExists:false,
    dataVaultMappingExists:false,
    pdiMetaMappingExists:false,
    dataVaultUsageGranted:false,
    pdiMetaUsageGranted:false,
  };
  const server=sqlLiteral(ext.serverName);
  const rows=await queryTarget(`SELECT
    EXISTS (SELECT 1 FROM pg_extension WHERE extname='jdbc_fdw') AS extension_exists,
    EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname='${server}') AS server_exists,
    EXISTS (SELECT 1 FROM pg_user_mappings WHERE srvname='${server}' AND usename='data_vault') AS data_vault_mapping_exists,
    EXISTS (SELECT 1 FROM pg_user_mappings WHERE srvname='${server}' AND usename='pdi_meta') AS pdi_meta_mapping_exists,
    COALESCE((SELECT has_server_privilege('data_vault', oid, 'USAGE') FROM pg_foreign_server WHERE srvname='${server}'), false) AS data_vault_usage_granted,
    COALESCE((SELECT has_server_privilege('pdi_meta', oid, 'USAGE') FROM pg_foreign_server WHERE srvname='${server}'), false) AS pdi_meta_usage_granted`);
  const row=rows[0]||{};
  return {
    extensionExists:row.extension_exists===true,
    serverExists:row.server_exists===true,
    dataVaultMappingExists:row.data_vault_mapping_exists===true,
    pdiMetaMappingExists:row.pdi_meta_mapping_exists===true,
    dataVaultUsageGranted:row.data_vault_usage_granted===true,
    pdiMetaUsageGranted:row.pdi_meta_usage_granted===true,
  };
}

function fdwInfrastructureMissing(status){
  const missing=[];
  if(!status.extensionExists)missing.push('jdbc_fdw extension');
  if(!status.serverExists)missing.push('foreign server');
  if(!status.dataVaultMappingExists)missing.push('data_vault user mapping');
  if(!status.pdiMetaMappingExists)missing.push('pdi_meta user mapping');
  if(!status.dataVaultUsageGranted)missing.push('data_vault server USAGE grant');
  if(!status.pdiMetaUsageGranted)missing.push('pdi_meta server USAGE grant');
  return missing;
}

async function runExternalStoragePreflight(options={}){
  const ext=state.externalTables;
  const manageBusy=!options.nested;
  if(manageBusy)externalStorageBusy=true;
  externalPreflightResult={checks:[],message:'Running preflight…'};
  if(!options.silent){renderAll();setActiveTabViewOnly('export');}
  const checks=[];
  const targetPack=databasePackForDialect(ext.remoteDialect);
  try{
    if(targetPack){
      syncPackMappedValues(targetPack,'target');
      ext.drivername=targetPack.jdbc.driverClass;
      ext.jarfile=targetPack.driverFile?`/opt/jdbc-drivers/${targetPack.driverFile}`:'';
      if(!ext.fdwUrlOverridden) ext.url=defaultExternalJdbcUrl(ext.remoteDialect,ext.studioHost||'',ext.studioPort||'',ext.studioDatabase||ext.remoteDatabase||'');
      // Validate/translate only for the runtime check; keep the saved FDW URL
      // portable (dv-certs/...) rather than persisting a container path.
      resolveProjectCertificateReferences(ext.url);
    }
    if(!ext.enabled)checks.push({level:'fatal',label:'Feature',detail:'External storage is not enabled.'});
    if(!externalCoreTableCount())checks.push({level:'fatal',label:'Core table set',detail:'No hubs, links, satellites or link satellites exist in the model.'});
    if(!state.vault.dvHost||!state.vault.dvDatabase||!state.vault.dvUser)checks.push({level:'fatal',label:'PostgreSQL gateway',detail:'Packaged PostgreSQL host, database and login are required.'});
    if(!ext.serverName||!ext.drivername||!ext.url||!ext.jarfile)checks.push({level:'fatal',label:'FDW settings',detail:'Server name, JDBC driver class, JDBC URL and driver jar path are required.'});
    if(targetPack){
      const missingFields=missingDatabasePackConnectionFields(targetPack,'target');
      if(missingFields.length)checks.push({level:'fatal',label:'Physical output target',detail:`Complete the required ${targetPack.label} field(s): ${missingFields.join(', ')}.`});
      const fdwCredentialIssue=databasePackFdwCredentialIssue(targetPack);
      if(fdwCredentialIssue)checks.push({level:'fatal',label:'FDW credentials',detail:fdwCredentialIssue});
      const ns=databasePackConnectionBody('target');
      const location=[ns?.catalog||ns?.database,ns?.schema].filter(Boolean).join(' / ');
      checks.push({level:'warn',label:'Target permissions',detail:`The ${targetPack.label} account used by the JDBC Pack must be able to create/alter the physical Vault tables${location?` in ${location}`:''} and SELECT/INSERT/UPDATE/DELETE them. Database/catalog and schema provisioning are checked through the Pack when provisioning rules are available; otherwise they remain administrator-managed.`});
    }else{
      if(!ext.studioHost||!(ext.studioDatabase||ext.remoteDatabase)||!(ext.studioUser||ext.username)||!(ext.studioPassword||ext.password))checks.push({level:'fatal',label:'Physical output target',detail:'Studio host, database and the physical target username/password are required.'});
      checks.push({level:'warn',label:'Target permissions',detail:`Target account ${ext.studioUser||ext.username||'(missing)'} must have CREATE for ${ext.studioDatabase||ext.remoteDatabase||'datavault'}, table CREATE/ALTER/INDEX, and SELECT/INSERT/UPDATE/DELETE. The packaged MySQL demo bootstraps this grant when FDW mode starts; production targets remain administrator-managed.`});
    }
    if(ext.serverName&&!externalIdentifierIsSafe(ext.serverName))checks.push({level:'fatal',label:'Foreign server name',detail:'Use a plain SQL identifier containing letters, numbers and underscores.'});
    if(!targetPack&&(ext.studioDatabase||ext.remoteDatabase)&&!externalIdentifierIsSafe(ext.studioDatabase||ext.remoteDatabase))checks.push({level:'fatal',label:'External database name',detail:'Use a plain identifier containing letters, numbers, underscores or dollar signs.'});
    if(!targetPack&&(ext.studioSchema||ext.remoteSchema)&&!externalIdentifierIsSafe(ext.studioSchema||ext.remoteSchema))checks.push({level:'fatal',label:'External schema name',detail:'Use a plain identifier containing letters, numbers, underscores or dollar signs.'});
    if(checks.some(c=>c.level==='fatal'))throw new Error('Configuration is incomplete.');
    await ensureLocalServerReachable();

    const localStatus=await localGatewayDatabaseStatus();
    checks.push({level:'ok',label:'PostgreSQL gateway connectivity',detail:`reached ${state.vault.dvHost}:${state.vault.dvPort}`});
    checks.push({level:localStatus.exists?'ok':'warn',label:'PostgreSQL gateway database',detail:localStatus.exists?`${state.vault.dvDatabase} exists`:`${state.vault.dvDatabase} does not exist yet and will be created during deployment`});

    const inspectionDatabase=localStatus.exists?state.vault.dvDatabase:'postgres';
    const local=await queryPostgresDatabase(inspectionDatabase,`SELECT current_user,
      COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) AS is_superuser,
      EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='jdbc_fdw') AS extension_available,
      (SELECT COUNT(*) FROM pg_roles WHERE rolname IN ('data_vault','staging','pdi_meta')) AS service_roles`);
    const info=local[0]||{};
    checks.push({level:info.extension_available?'ok':'fatal',label:'jdbc_fdw extension',detail:info.extension_available?'available in the packaged image':'not present in pg_available_extensions; start/rebuild the FDW PostgreSQL gateway'});
    checks.push({level:info.is_superuser?'ok':'fatal',label:'Local deployment privilege',detail:info.is_superuser?`${info.current_user} is a superuser`:`${info.current_user||'current user'} is not a superuser`});
    checks.push({level:Number(info.service_roles)===3?'ok':'fatal',label:'Service roles',detail:Number(info.service_roles)===3?'data_vault, staging and pdi_meta roles exist':'one or more of data_vault, staging and pdi_meta roles are missing'});
    try{
      const role=await verifyDataVaultRoleAssumption(null,inspectionDatabase);
      checks.push({level:'ok',label:'PostgreSQL data_vault runtime role',detail:`${role.login_user||state.vault.dvUser} can SET ROLE data_vault`});
    }catch(err){
      checks.push({level:'fatal',label:'PostgreSQL data_vault runtime role',detail:`Cannot assume data_vault: ${err.message}`});
    }
    try{
      const role=await verifyPdiMetaRoleAssumption(null,inspectionDatabase);
      checks.push({level:'ok',label:'PostgreSQL pdi_meta runtime role',detail:`${role.login_user||state.vault.dvUser} can SET ROLE pdi_meta`});
    }catch(err){
      checks.push({level:'fatal',label:'PostgreSQL pdi_meta runtime role',detail:`Cannot assume pdi_meta: ${err.message}`});
    }

    const names=externalCoreTableNames();
    if(localStatus.exists&&names.length){
      const literals=names.map(n=>`'${sqlLiteral(n)}'`).join(',');
      const relations=await queryTarget(`SELECT c.relname AS table_name, c.relkind
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='data_vault' AND c.relname IN (${literals})`);
      const collisions=relations.filter(r=>r.relkind!=='f');
      checks.push({level:collisions.length?'fatal':'ok',label:'Local relation collisions',detail:collisions.length?`${collisions.length} core name(s) already exist as local relations: ${collisions.map(x=>x.table_name).join(', ')}`:'no core table name is occupied by a local table or view'});
    }else{
      checks.push({level:'warn',label:'Local relation collisions',detail:'skipped until the PostgreSQL gateway database exists'});
    }

    const jar=await localFetch('/api/driver-path-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jarfile:ext.jarfile})}).then(r=>r.json());
    checks.push({level:jar.ok&&jar.exists?'ok':'fatal',label:'JDBC driver jar',detail:jar.ok&&jar.exists?`${jar.filename} is present in jdbc-drivers/`:(jar.error||`not found for ${ext.jarfile}`)});

    const remote=await externalTargetDatabaseStatus({includeProfile:!!targetPack});
    checks.push({level:'ok',label:'Physical output connectivity',detail:targetPack?`${targetPack.label} connected through its JDBC Database Pack`:`reached ${ext.studioHost}:${ext.studioPort||externalDefaultPort(ext.remoteDialect)}`});
    checks.push({level:remote.exists?'ok':'warn',label:'Physical output database',detail:targetPack?(remote.exists?'configured database/catalog is reachable':'configured database/catalog is not reachable'):(remote.exists?'database exists':'database does not exist yet and will be created during deployment')});
    if(targetPack){
      if(remote.exists){
        const profile=remote.targetProfile
          ? acceptDatabasePackTargetProfile(remote.targetProfile,{acceptDrift:false})
          : await discoverDatabasePackTargetProfile({silent:true,acceptDrift:false});
        const missing=unresolvedTargetSemantics(targetPack,profile);
        const mapped=Object.keys(profile?.resolvedTypes||{}).length;
        checks.push({level:missing.length?'fatal':'ok',label:'JDBC semantic target profile',detail:missing.length?`unresolved required type(s): ${missing.join(', ')}`:`${mapped} JDBC type mapping(s) discovered; all types required by the current Vault model resolve safely`});
        const effectiveQuote=targetPack.target&&Object.prototype.hasOwnProperty.call(targetPack.target,'identifierQuote')?targetPack.target.identifierQuote:profile?.identifierQuote;
        checks.push({level:'ok',label:'Identifier quoting',detail:`${targetPack.target&&Object.prototype.hasOwnProperty.call(targetPack.target,'identifierQuote')?'Pack override':'JDBC metadata'} reports ${effectiveQuote?`quote character ${effectiveQuote}`:'unquoted safe identifiers only'}`});
        if(remote.schemaExists===false&&targetPack.provisioning?.createSchemaSql){
          checks.push({level:'warn',label:'Target schema',detail:`Configured schema ${remote.selectedSchema||ext.studioSchema||ext.remoteSchema} does not exist yet; the Database Pack provisioning rule will create it during deployment.`});
        }else if((ext.studioSchema||ext.remoteSchema)&&!targetPack.target?.createSchemaSql&&!targetPack.provisioning?.createSchemaSql){
          checks.push({level:'warn',label:'Target schema',detail:`Studio will use the configured schema ${ext.studioSchema||ext.remoteSchema}; generic JDBC discovery does not guess CREATE SCHEMA syntax and this Pack has no provisioning override. Create it beforehand.`});
        }
        if(missing.length) throw new Error(`The JDBC driver could not resolve required target semantic types: ${missing.join(', ')}.`);
      }else{
        checks.push({level:'warn',label:'JDBC semantic target profile',detail:'Target database does not exist yet; JDBC target type mapping will be verified after the Pack provisioning step creates it.'});
      }
    }
    externalPreflightResult={checks,ok:!checks.some(c=>c.level==='fatal'),localExists:!!localStatus.exists,remoteExists:!!remote.exists,message:checks.some(c=>c.level==='fatal')?'Preflight found fatal issues. Nothing was changed.':'Preflight passed. No changes were made.'};
  }catch(err){
    if(!checks.length||!checks.some(c=>c.level==='fatal'))checks.push({level:'fatal',label:'Preflight',detail:err.message});
    externalPreflightResult={checks,ok:false,message:'Preflight failed. Nothing was changed.'};
  }finally{
    if(manageBusy)externalStorageBusy=false;
    if(!options.silent){renderAll();setActiveTabViewOnly('export');}
  }
  return externalPreflightResult;
}

async function externalApi(path,payload){
  const r=await localFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await r.json(); if(!data.ok)throw new Error(data.error||`Request failed: ${path}`); return data;
}
function explainExternalTargetError(message){
  const text=String(message||'External target operation failed.');
  if(!/access denied|command denied|permission|not allowed|denied/i.test(text)) return text;
  const ext=state.externalTables;
  const user=ext.studioUser||ext.username||'<target user>';
  const database=ext.studioDatabase||ext.remoteDatabase||'datavault';
  if(ext.remoteDialect==='mysql') return `${text} The physical target account ${user} is also used by the JDBC FDW mappings. Ask a database administrator to create ${database} if necessary and grant this account CREATE, ALTER, INDEX, SELECT, INSERT, UPDATE and DELETE on ${database}.*.`;
  return `${text} The physical target account ${user} is also used by both JDBC FDW mappings. Ask a database administrator to create ${database} if necessary and grant it schema/table creation plus read/write access.`;
}
function remoteSchemaDdl(){
  const ext=state.externalTables, schema=ext.studioSchema||ext.remoteSchema;
  if(!schema||ext.remoteDialect==='mysql')return '';
  if(ext.remoteDialect==='postgresql')return `CREATE SCHEMA IF NOT EXISTS ${remoteQuoteIdentifier(schema,'postgresql')};`;
  const pack=databasePackForDialect(ext.remoteDialect);
  if(pack){
    if(pack.target&&pack.target.createSchemaSql){
      const qSchema=remoteQuoteIdentifier(schema,ext.remoteDialect);
      const database=ext.studioDatabase||ext.remoteDatabase||'';
      return packTemplate(pack.target.createSchemaSql,{schema:qSchema,database:database?remoteQuoteIdentifier(database,ext.remoteDialect):'',catalog:database?remoteQuoteIdentifier(database,ext.remoteDialect):''});
    }
    // JDBC metadata can tell Studio how the database represents types and
    // identifiers, but not a universally safe CREATE SCHEMA dialect. Without
    // an explicit Pack override, use the configured existing/default schema.
    return '';
  }
  return `CREATE SCHEMA ${remoteQuoteIdentifier(schema,ext.remoteDialect)};`;
}

function waitFor(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }

function fdwSmokeDiagnosticMessage(data){
  const parts=[];
  if(data&&data.schema&&data.table)parts.push(`table ${data.schema}.${data.table}`);
  if(data&&data.role)parts.push(`role ${data.role}`);
  if(data&&data.phase)parts.push(`phase ${data.phase}`);
  if(data&&data.code)parts.push(`SQLSTATE ${data.code}`);
  const message=String((data&&data.error)||'FDW live-route verification failed.');
  parts.push(message);
  if(data&&data.detail&&String(data.detail).trim()&&String(data.detail).trim()!==message.trim())parts.push(`detail: ${data.detail}`);
  if(data&&data.hint)parts.push(`hint: ${data.hint}`);
  if(data&&data.where)parts.push(`context: ${data.where}`);
  if(data&&data.statement)parts.push(`SQL ${data.statement}`);
  return parts.join(' · ');
}

async function smokeTestFdwForeignTable(role,smoke){
  const v=state.vault;
  const response=await localFetch('/api/fdw-smoke',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...targetConnectionPayload(),role,schema:'data_vault',table:smoke})
  });
  const data=await response.json();
  if(!data.ok){
    const err=new Error(fdwSmokeDiagnosticMessage(data));
    err.fdwDiagnostic=data;
    throw err;
  }
  return data;
}

async function verifyFdwLiveRouteAfterDeployment(smoke,{attempts=3,delayMs=700}={}){
  if(!smoke) return 0;
  let lastError=null;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{
      await smokeTestFdwForeignTable('data_vault',smoke);
      await smokeTestFdwForeignTable('pdi_meta',smoke);
      return attempt;
    }catch(err){
      lastError=err;
      if(attempt<attempts) await waitFor(delayMs*attempt);
    }
  }
  throw lastError||new Error(`Could not verify the live FDW route through data_vault.${smoke}.`);
}

function reconcileExternalDeploymentBoard(result){
  if(!result||!result.ok||!deployStatus||!Array.isArray(deployStatus.rows)) return;
  const ext=state.externalTables;
  const total=externalCoreTableCount();
  const smoke=externalCoreTableNames()[0]||'';
  const setCurrent=(key,detail)=>{
    const row=deployStatus.rows.find(r=>r.key===key);
    if(!row)return;
    row.state='current'; row.error=null; row.detail=detail; row.apply=null;
  };
  setCurrent('database',`exists · verified during the external-route deployment`);
  const physical=[ext.studioDatabase||ext.remoteDatabase,ext.studioSchema||ext.remoteSchema].filter(Boolean).join(' / ');
  setCurrent('external-database',`${physical||'physical target'} exists · verified during the external-route deployment`);
  if(total>0)setCurrent('external-core',`${total} of ${total} tables · verified during the external-route deployment`);
  setCurrent('fdw-infrastructure',`${ext.serverName||'jdbc_fdw server'}; data_vault and pdi_meta mappings are ready · verified during the external-route deployment`);
  const supportCount=parseGeneratedDdlObjects(buildDataVaultLocalSupportDdl()).length;
  setCurrent('vault-support',`${supportCount} of ${supportCount} local relation(s) · verification view present · verified during the external-route deployment`);
  if(total>0)setCurrent('fdw-foreign-tables',`${total} of ${total} relations · cursor route verified as data_vault and pdi_meta${smoke?` through ${smoke}`:''}`);
  deployStatus.appliedAt=new Date();
  // The deployment itself may refresh Pack/JDBC runtime metadata. Rebase the
  // stale-design guard after those directly verified changes without running a
  // second full status probe.
  deployStatus.fingerprint=designFingerprint();
}

async function deployExternalStorage(options={}){
  const ext=state.externalTables;
  const interactive=options.interactive!==false;
  const requireAck=options.requireAck!==false;
  const throwOnError=options.throwOnError===true;
  if(externalStorageBusy){
    const err=new Error('An external-storage deployment is already running.');
    if(throwOnError)throw err;
    return {ok:false,error:err.message};
  }
  if(requireAck&&!ext.deploymentAcknowledged){
    const err=new Error('Review and tick the external-storage deployment warning first.');
    if(throwOnError)throw err;
    toast(err.message,'err'); return {ok:false,error:err.message};
  }
  const deployPack=databasePackForDialect(ext.remoteDialect);
  const packBody=deployPack?databasePackConnectionBody('target'):null;
  const packLocation=packBody?[packBody.catalog||packBody.database,packBody.schema].filter(Boolean).join(' / '):'';
  const physicalLabel=deployPack?`${deployPack.label}${packLocation?` (${packLocation})`:''}`:`${ext.studioHost}:${ext.studioPort||externalDefaultPort(ext.remoteDialect)}/${ext.studioDatabase||ext.remoteDatabase}`;
  if(interactive&&!confirm(`Deploy ${externalCoreTableCount()} external core table(s) in verified order?\n\nPhysical target: ${physicalLabel}\nPostgreSQL gateway: ${state.vault.dvHost}:${state.vault.dvPort}/${state.vault.dvDatabase}\n\nBoth databases will be verified or created where Studio can do so safely. Foreign tables are created last. The operation stops at the first failed step.`))return {ok:false,cancelled:true};

  externalStorageBusy=true;
  externalDeployResult={checks:[],message:'Deployment started…'};
  if(interactive){renderAll();setActiveTabViewOnly('export');}
  const checks=[];
  let failure=null;
  try{
    const pre=await runExternalStoragePreflight({silent:true,nested:true});
    checks.push({level:pre.ok?'ok':'fatal',label:'Preflight',detail:pre.ok?'passed again immediately before deployment':'fatal issue found; deployment refused'});
    if(externalPreflightFatal(pre))throw new Error('Preflight contains fatal issues.');
    if(!['postgresql','mysql'].includes(ext.remoteDialect) && !isDatabasePackDialect(ext.remoteDialect))throw new Error(`Automatic ordered deployment is not available for ${(DIALECTS[ext.remoteDialect]||{}).label||ext.remoteDialect}; run the remote DDL manually.`);
    const targetPack=databasePackForDialect(ext.remoteDialect);
    // Database Packs are not pre-certified target allowlists. Preflight has
    // already resolved the current server's JDBC target profile; the live FDW
    // route is verified later in this ordered deployment.

    await ensureLocalGatewayDatabase(checks);
    await verifyDataVaultRoleAssumption(checks,state.vault.dvDatabase,'1b · PostgreSQL data_vault role');
    await verifyPdiMetaRoleAssumption(checks,state.vault.dvDatabase,'1c · PostgreSQL pdi_meta role');
    await ensureExternalTargetDatabase(checks);
    await verifyExternalTargetUserAccess(checks);

    const payload=externalConnectionPayload(ext.studioDatabase||ext.remoteDatabase);
    const schemaSql=remoteSchemaDdl();
    if(schemaSql)await externalApi('/api/external-execute-sql',{...payload,sql:schemaSql});
    checks.push({level:'ok',label:'4 · Physical output schema',detail:ext.remoteDialect==='mysql'?`MySQL database ${ext.studioDatabase||ext.remoteDatabase} is the schema`:((ext.studioSchema||ext.remoteSchema)?(schemaSql?`ready/created as needed: ${ext.studioSchema||ext.remoteSchema}`:`using existing/default schema: ${ext.studioSchema||ext.remoteSchema}`):'default database schema selected')});

    const before=await externalApi('/api/external-table-status',{...payload,schema:ext.studioSchema||ext.remoteSchema,tables:externalCoreTableNames()});
    const missingBefore=before.missing||[];
    if(missingBefore.length){
      await externalApi('/api/external-execute-sql',{...payload,sql:buildExternalTablesDdl(missingBefore)});
    }
    checks.push({level:'ok',label:'5 · Physical core tables',detail:missingBefore.length?`created ${missingBefore.length}; retained ${externalCoreTableCount()-missingBefore.length}`:`retained all ${externalCoreTableCount()} existing Hub/Link/Sat/LSat table(s)`});

    const verify=await externalApi('/api/external-table-status',{...payload,schema:ext.studioSchema||ext.remoteSchema,tables:externalCoreTableNames()});
    if((verify.missing||[]).length)throw new Error(`Physical target verification failed; missing: ${verify.missing.join(', ')}`);
    checks.push({level:'ok',label:'6 · Physical target verification',detail:`all ${externalCoreTableCount()} core tables exist`});

    await executeSqlAgainstTarget(buildDataVaultLocalSupportDdl(),{allowExternalLocalDdl:true});
    checks.push({level:'ok',label:'7 · Local support objects',detail:'data_vault schema, *_err tables and verification view applied in PostgreSQL'});

    if(isDemoRuntime()){
      const fdwResponse=await localFetch('/api/demo-fdw/infrastructure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        gatewayCredentialRef:'internal-postgres-target',physicalCredentialRef:'demo-fdw-physical-mysql',gatewayDatabase:state.vault.dvDatabase,serverName:ext.serverName,
      })});
      const fdwResult=await fdwResponse.json();
      if(!fdwResult.ok)throw new Error(fdwResult.error||'Demo FDW infrastructure deployment failed.');
    } else await executeSqlAgainstTarget(buildFdwInfrastructureDdl(),{allowExternalLocalDdl:true});
    const infrastructure=await localFdwInfrastructureStatus();
    const infrastructureMissing=fdwInfrastructureMissing(infrastructure);
    if(infrastructureMissing.length)throw new Error(`FDW infrastructure verification failed; missing: ${infrastructureMissing.join(', ')}`);
    checks.push({level:'ok',label:'8 · FDW gateway objects',detail:'jdbc_fdw extension, foreign server, data_vault and pdi_meta user mappings, and both server USAGE grants applied and verified'});

    await executeSqlAgainstTarget(buildFdwForeignTablesDdl(),{allowExternalLocalDdl:true});
    checks.push({level:'ok',label:'9 · Local foreign tables (last)',detail:`created or retained ${externalCoreTableCount()} foreign table(s) in data_vault`});

    await verifyLocalForeignTables();
    const smoke=externalCoreTableNames()[0];
    const smokeAttempts=smoke?await verifyFdwLiveRouteAfterDeployment(smoke):0;
    checks.push({level:'ok',label:'10 · Live FDW route verification',detail:smoke?`data_vault and pdi_meta both opened data_vault.${smoke} through a bounded cursor read${smokeAttempts>1?` after ${smokeAttempts} attempts`:''}`:'no table selected'});

    externalDeployResult={checks,ok:true,message:'Both databases and the complete FDW route were created and verified successfully.'};
    if(interactive)toast('External Data Vault route deployed and smoke-tested.','ok');
  }catch(err){
    const explained=explainExternalTargetError(err.message);
    failure=new Error(explained);
    checks.push({level:'fatal',label:'Stopped',detail:explained});
    externalDeployResult={checks,ok:false,message:'Deployment stopped at the first failed step. Later steps were not run.'};
    if(interactive)toast(`External storage deployment stopped: ${err.message}`,'err');
  }finally{
    externalStorageBusy=false;
    if(interactive){renderAll();setActiveTabViewOnly('export');}
  }
  if(failure&&throwOnError)throw failure;
  return externalDeployResult;
}

async function applyExternalStorageWorkflow(){
  return deployExternalStorage({interactive:false,requireAck:false,throwOnError:true});
}

