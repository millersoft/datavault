/* =========================================================================
   DATA VAULT STUDIO — state
   ========================================================================= */
let uidCounter = 1;
const uid = (p) => `${p}_${(uidCounter++).toString(36)}`;

// External storage is a shipped feature. Only the four primary Data Vault
// relation families (hub/link/sat/lsat) can be external; error tables, views,
// staging and metadata remain local PostgreSQL objects.
const FEATURE_EXTERNAL_STORAGE = true;
// The Node server replaces this marker when it serves the page. Opening the
// HTML directly keeps the backward-compatible demo profile.
function isDemoRuntime(){ return STUDIO_RUNTIME_MODE === 'demo'; }
function isProductionRuntime(){ return STUDIO_RUNTIME_MODE === 'production'; }
// Incremental staging loads are enabled in the Studio. The incremental column
// is source-table metadata; whether it is used is an explicit Hub toggle. Prior
// staging history is displayed as guidance only and never gates activation.
const FEATURE_INCREMENTAL = true;
const FEATURE_LINK_SATELLITES = true;
function applyFeatureGates(){
  if (!Number.isFinite(Number(state.vault.stagingDaysToLoadDefault)) || Number(state.vault.stagingDaysToLoadDefault) < 0){
    state.vault.stagingDaysToLoadDefault = 30;
  } else {
    state.vault.stagingDaysToLoadDefault = Math.floor(Number(state.vault.stagingDaysToLoadDefault));
  }
  if (typeof state.vault.incrementalSettingsDeploymentPending !== 'boolean') state.vault.incrementalSettingsDeploymentPending = false;
  const existingExternalTables = Object.assign({}, state.externalTables || {});
  state.externalTables = Object.assign({
    enabled:false, serverName:'', drivername:'', url:'', jarfile:'', querytimeout:'30', maxheapsize:'',
    username:'', password:'', remoteDialect:'postgresql', remoteDatabase:'', remoteSchema:'',
    studioHost:'', studioPort:'', studioDatabase:'', studioSchema:'', studioUser:'', studioPassword:'',
    studioConnectionOverridden:false, fdwUrlOverridden:false, deploymentAcknowledged:false, targetProfile:null,
  }, existingExternalTables);
  state.externalTables.deploymentAcknowledged = false;
  if (state.externalTables.targetProfile && state.externalTables.targetProfile.dialect !== state.externalTables.remoteDialect) state.externalTables.targetProfile=null;
  if (state.externalTables.enabled) applyExternalTargetDefaults(false);
  let normalizedColumnFlags = 0;
  (state.tables||[]).forEach(t=> (t.columns||[]).forEach(c=>{
    if (typeof c.staged !== 'boolean'){ c.staged = true; normalizedColumnFlags++; }
  }));
  let normalizedTargetNames = 0;
  (state.tables||[]).forEach(t=>{
    (t.columns||[]).forEach(c=>{
      if (!c.targetName){ c.targetNameAuto = true; normalizedTargetNames++; }
    });
    ensureTableTargetNames(t);
  });
  let normalizedHubKeys = 0;
  (state.hubs||[]).forEach(h=>{
    if (!Array.isArray(h.keyColIds) || !h.keyColIds.length){
      h.keyColIds = h.pkColId ? [h.pkColId] : [];
      normalizedHubKeys++;
    }
    if (!h.pkColId && h.keyColIds.length) h.pkColId = h.keyColIds[0];
  });
  let normalizedLinkKeys = 0;
  (state.links||[]).forEach(l=>(l.hubs||[]).forEach(h=>{
    if(!Array.isArray(h.colIds)||!h.colIds.length){ h.colIds=h.colId?[h.colId]:[]; normalizedLinkKeys++; }
    if(!h.colId&&h.colIds.length) h.colId=h.colIds[0];
    if(h.role) h.role=sqlNamePart(h.role);
  }));
  let normalizedSatelliteTargets = 0;
  (state.hubSats||[]).concat(state.linkSats||[]).forEach(s=>{
    if(s.concern){ const cleanConcern=sqlNamePart(s.concern); if(cleanConcern!==s.concern){s.concern=cleanConcern;normalizedSatelliteTargets++;} }
    const t=(state.tables||[]).find(x=>x.id===s.tableId);
    (s.attrs||[]).forEach(a=>{
      const col=t&&(t.columns||[]).find(c=>c.id===a.colId);
      if(!col) return;
      const clean=targetIdentifierBase(!a.target||a.target===col.name?targetColumnName(col):a.target);
      if(clean!==a.target){a.target=clean;normalizedSatelliteTargets++;}
    });
  });
  let normalizedLoadGroups = 0;
  (state.tables||[]).forEach(t=>{
    if (t.loadGroup !== 2000){ t.loadGroup = 2000; normalizedLoadGroups++; }
  });
  (state.tables||[]).forEach(t=>{
    if (!FEATURE_INCREMENTAL){
      t.incremental = false;
      t.incrementCol = '';
      t.incrementalReady = false;
      t.incrementalReadyRunId = null;
      t.incrementalReadyAfterRunId = 0;
      t.incrementalReadyAt = '';
      t.incrementalConfiguredAt = '';
      t.incrementalConfigPending = false;
      t.incrementalDeploymentPending = false;
      return;
    }

    // Projects from older incremental implementations may only have
    // `incremental` + `incrementCol`. Preserve that explicit user choice while
    // normalising the newer informational/deployment fields.
    const hadReadinessState = typeof t.incrementalReady === 'boolean';
    if (!hadReadinessState){
      t.incrementalReady = false;
      t.incrementalReadyRunId = null;
      t.incrementalReadyAfterRunId = 0;
      t.incrementalReadyAt = '';
      t.incrementalConfiguredAt = '';
      t.incrementalConfigPending = !!t.incrementCol;
      t.incrementalDeploymentPending = !!t.incrementCol;
    }
    if (typeof t.incremental !== 'boolean') t.incremental = false;
    if (typeof t.incrementCol !== 'string') t.incrementCol = '';
    if (typeof t.incrementalAutoDetectDismissed !== 'boolean') t.incrementalAutoDetectDismissed = false;
    if (typeof t.incrementalConfiguredAt !== 'string') t.incrementalConfiguredAt = t.incrementCol ? new Date().toISOString() : '';
    if (typeof t.incrementalReadyAt !== 'string') t.incrementalReadyAt = '';
    if (typeof t.incrementalConfigPending !== 'boolean') t.incrementalConfigPending = !!(t.incrementCol && !t.incrementalReady && !t.incrementalConfiguredAt);
    if (typeof t.incrementalDeploymentPending !== 'boolean') t.incrementalDeploymentPending = !!t.incrementalConfigPending;
    if (t.incrementalReadyRunId == null) t.incrementalReadyRunId = null;
    if (!Number.isFinite(Number(t.incrementalReadyAfterRunId))) t.incrementalReadyAfterRunId = 0;
    else t.incrementalReadyAfterRunId = Math.max(0, Number(t.incrementalReadyAfterRunId) || 0);
    if (!t.incrementCol){
      t.incremental = false;
      t.incrementalReady = false;
      t.incrementalReadyRunId = null;
      t.incrementalReadyAfterRunId = 0;
      t.incrementalReadyAt = '';
      t.incrementalConfiguredAt = '';
      t.incrementalConfigPending = false;
    }
  });
  if (!FEATURE_LINK_SATELLITES && state.linkSats && state.linkSats.length) state.linkSats = [];
  // Older/AI-generated projects may contain one business-key derivation per
  // column of a composite junction key (for example film_actor.actor_id and
  // film_actor.film_id both targeting film_actor_bk). Normalise those saved
  // projects on load/restore as soon as FK metadata is available.
  const repairedJunctionDerivations = typeof repairAllJunctionDerivations === 'function'
    ? repairAllJunctionDerivations()
    : 0;
  const repairedForeignKeyDerivations = typeof repairAllForeignKeyDerivations === 'function'
    ? repairAllForeignKeyDerivations()
    : 0;
  const repairedSatelliteDerivations = typeof repairAllSatelliteParentDerivations === 'function'
    ? repairAllSatelliteParentDerivations()
    : 0;
  return { repairedJunctionDerivations, repairedForeignKeyDerivations, repairedSatelliteDerivations, normalizedColumnFlags, normalizedTargetNames, normalizedHubKeys, normalizedLinkKeys, normalizedSatelliteTargets, normalizedLoadGroups };
}

// Packaged containers, selectable from the connection dropdowns.
// GUI/local server reach them via the HOST-mapped ports (localhost:3306 /
// 127.0.0.1:5433). The hop engine runs INSIDE the compose network, so the
// generated postgres-environment.json uses the service hostnames instead
// (mysql:3306 / postgres:5432) — see buildHopEnvironmentJson.
// Fallbacks only — runtime credentials live in <project-root>/.env. Studio
// reads them for packaged presets and Apply All synchronises the selected
// source password plus native external-PostgreSQL credentials through a
// narrow allowlisted server endpoint. Internal DB_* values remain untouched.
const DEMO_SOURCE = { dialect:'mysql', srcHost:'localhost', srcPort:'3306', srcDatabase:'sakila', srcUser:'sakila', srcPassword:'' };
const DEMO_TARGET = { dvHost:'127.0.0.1', dvPort:'5433', dvUser:'dvuser', dvPassword:'' };
let envDefaults = null; // Non-secret users and passwordConfigured flags only.
let envFileStatus = null; // null = server unavailable/not checked | { ok, found, error? }
async function refreshEnvDefaults(){
  try {
    const response = await localFetch('/api/env-defaults');
    const r = await response.json();
    envFileStatus = r;
    envDefaults = (r.ok && r.found) ? r : null;
    // Demo connections are locked to the packaged services. Refresh their
    // credentials from .env, then refresh untouched FDW demo defaults too.
    if (envDefaults && typeof state !== 'undefined'){
      if (demoSourceActive()) applyDemoSource(true);
      if (demoTargetActive()) applyDemoTarget(true);
      if (state.externalTables && state.externalTables.enabled) applyExternalTargetDefaults(false);
    }
  } catch(_){ envDefaults = null; envFileStatus = null; }
  return envDefaults;
}
function runtimeCredentialPayload(){
  const externalPostgres = state.vault.targetPreset !== 'internal';
  return {
    sourceCredentialMode: demoSourceActive() ? 'preserve' : 'replace',
    sourcePassword: demoSourceActive() ? '' : String(state.vault.srcPassword || ''),
    targetPassword: externalPostgres ? String(state.vault.dvPassword || '') : '',
    targetUser: externalPostgres ? String(state.vault.dvUser || '') : '',
    externalPostgres,
  };
}
function runtimeCredentialValidationMessage(){
  const missing = [];
  if (demoSourceActive()){
    if (!(envDefaults && envDefaults.mysql && envDefaults.mysql.passwordConfigured)) missing.push('SOURCE_PASSWORD in .env');
  } else if (!String(state.vault.srcPassword || '')) missing.push('source password');
  if (state.vault.targetPreset !== 'internal'){
    if (!String(state.vault.dvUser || '')) missing.push('external PostgreSQL username');
    if (!String(state.vault.dvPassword || '')) missing.push('external PostgreSQL password');
  }
  return missing.length ? `Enter the ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} on Connections before deployment.` : '';
}
async function deployRuntimeCredentials(options = {}){
  const message = runtimeCredentialValidationMessage();
  if (message){
    if (!options.silent) toast(message, 'err');
    throw new Error(message);
  }
  const response = await localFetch('/api/env-credentials', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify(runtimeCredentialPayload()),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Could not update the root .env credentials.');
  if (!options.silent) toast(`Updated ${data.updated.join(', ')} in the root .env.`, 'ok');
  return data;
}
function demoSourceActive(){ return state.vault.sourcePreset === 'demo'; }
function demoTargetActive(){ return state.vault.targetPreset === 'internal'; }
function selectedDeploymentTarget(){
  if (state.vault.targetPreset !== 'internal') return 'postgres';
  if (state.externalTables.enabled && (state.externalTables.remoteDialect === 'mysql' || isDatabasePackDialect(state.externalTables.remoteDialect))) return state.externalTables.remoteDialect;
  return 'internal-postgres';
}
function applyDeploymentTarget(target){
  const previous = selectedDeploymentTarget();
  if (target === 'postgres'){
    if (state.vault.targetPreset === 'internal'){
      Object.assign(state.vault, { dvHost:'', dvPort:'5432', dvDatabase:state.vault.dvDatabase||'datavault', dvUser:'', dvPassword:'', vaultPassword:'' });
    }
    state.vault.targetPreset = '';
    state.externalTables.enabled = false;
  } else {
    const database = state.vault.dvDatabase || 'datavault';
    applyDemoTarget(true);
    state.vault.dvDatabase = database;
    if (target === 'mysql' || isDatabasePackDialect(target)){
      const dialectChanged = state.externalTables.remoteDialect !== target || !state.externalTables.enabled;
      state.externalTables.enabled = true;
      applyExternalTargetDefaults(previous !== target);
      state.externalTables.remoteDialect = target;
      if (dialectChanged){
        const d = externalDialectDefaults(target);
        Object.assign(state.externalTables, {
          studioPort:d.port, remoteSchema:d.schema, studioSchema:d.schema,
          drivername:d.drivername, jarfile:d.jarfile,
          url:defaultExternalJdbcUrl(target, state.externalTables.studioHost||'external-db', d.port,
            state.externalTables.studioDatabase||state.externalTables.remoteDatabase||'datavault'),
          packValues:databasePackForDialect(target)?{}:state.externalTables.packValues,
          packOptions:databasePackForDialect(target)?[]:state.externalTables.packOptions,
          manualUrl:databasePackForDialect(target)?'':state.externalTables.manualUrl,
          fdwUrlOverridden:false,
        });
        const pack=databasePackForDialect(target);
        if(pack){
          seedPackConnectionValues(pack,'target',{reset:true});
          // Rebuild after Pack defaults have been applied so vendor-specific
          // URL tokens (account, warehouse, service, etc.) are immediately
          // reflected in the FDW configuration rather than waiting for edit.
          state.externalTables.url=defaultExternalJdbcUrl(target,
            state.externalTables.studioHost||'', state.externalTables.studioPort||d.port,
            state.externalTables.studioDatabase||state.externalTables.remoteDatabase||'');
        }
      }
    } else {
      state.externalTables.enabled = false;
    }
  }
  targetConnStatus=null; targetDbExists=null; targetRoleCheck=null;
  externalPreflightResult=null; externalDeployResult=null;
  externalTargetConnStatus=null; externalTargetDbExists=null; externalTargetIdentity=null;
  state.externalTables.targetProfile=null;
  targetJdbcDriverStatus=null;
}
// Engine run mode — maps straight onto start.sh's flags:
//   demo     -> ./start.sh up --demo -d hop        (sakila + internal Postgres)
//   internal -> ./start.sh up -d hop               (internal Postgres)
//   external -> ./start.sh up --external-postgres -d hop
// start.sh rejects --demo together with --external-postgres, so the demo
// source is only valid with the internal Postgres target.
function engineMode(){
  if (state.vault.sourcePreset === 'demo' && state.vault.targetPreset === 'internal') return 'demo';
  if (state.vault.targetPreset === 'internal') return 'internal';
  return 'external';
}
function engineModeLabel(){
  return { demo: 'Demo — sakila source + internal Postgres',
           internal: 'Internal Postgres',
           external: 'External Postgres' }[engineMode()];
}
function engineModeInvalid(){
  return state.vault.sourcePreset === 'demo' && state.vault.targetPreset !== 'internal';
}
// Studio/JDBC runs outside the Hop container, so a source address that is
// local to the workstation must be translated for the Hop runtime. Keep the
// design-time connection untouched and derive a Docker-safe runtime address.
function isLoopbackHost(host){
  const h=String(host||'').trim();
  return /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(h);
}
function hopRuntimeSourceHost(){
  const v=state.vault;
  if(v.sourcePreset==='demo') return 'mysql';
  const source=String(v.srcHost||'').trim();
  return isLoopbackHost(source) ? 'host.docker.internal' : source;
}
function hopRuntimeSourcePort(){
  const v=state.vault;
  if(v.sourcePreset==='demo') return '3306';
  return String(v.srcPort||'').trim();
}
// External target bootstrap also runs in a container, but unlike source Hop
// connectivity it does not yet have a separate runtime-address override.
function externalLocalhostIssues(){
  const out = [];
  if (state.vault.targetPreset !== 'internal' && isLoopbackHost(state.vault.dvHost)) out.push('target');
  return out;
}
function externalLocalhostWarningHtml(){
  const issues = externalLocalhostIssues();
  if (!issues.length) return '';
  return `<div class="ai-status err mt" style="align-items:flex-start;border-color:var(--hub);color:var(--hub);"><span>The target host is local to this machine, but target setup runs inside Docker where localhost is the container itself. Use a real hostname/IP (or <span class="mono">host.docker.internal</span>) for the target.</span></div>`;
}

function applyDemoSource(on){
  if (on){
    Object.assign(state.vault, DEMO_SOURCE);
    if (envDefaults && envDefaults.mysql){
      if (envDefaults.mysql.user) state.vault.srcUser = envDefaults.mysql.user;
      state.vault.srcPassword = '';
    }
    // Demo credentials are resolved server-side. Clear any Pack-backed source
    // connection details left in memory by a previously loaded production
    // project so the demo path cannot retain or submit a user-entered secret.
    state.vault.sourcePackValues = {};
    state.vault.sourcePackOptions = [];
    state.vault.sourceManualUrl = '';
    state.vault.sourceCatalog = '';
    state.vault.sourcePreset = 'demo';
    state.vault.sourceSchema = 'sakila'; // MySQL: schema = database
    // The bundled demo only runs with the internal Postgres (start.sh
    // rejects --demo with --external-postgres) — pair them automatically.
    if (state.vault.targetPreset !== 'internal') applyDemoTarget(true);
    // Fill naming only where blank — never overwrite the user's own values
    if (!state.vault.name) state.vault.name = 'sak';
    if (!state.vault.prefix) state.vault.prefix = 'sak';
    if (!state.vault.tenantId) state.vault.tenantId = 'SAK';
    if (!state.vault.srcCod) state.vault.srcCod = 'SAK';
    if (!state.vault.srcDescription) state.vault.srcDescription = 'sakila';
  } else {
    Object.assign(state.vault, { srcHost:'', srcPort:'', srcDatabase:'', srcUser:'', srcPassword:'' });
    state.vault.sourcePreset = '';
    state.vault.sourceSchema = state.vault.dialect==='mysql' ? '' : 'public';
  }
}
function applyDemoTarget(on){
  if (on){
    Object.assign(state.vault, DEMO_TARGET);
    const targetDefaults = envDefaults && envDefaults.target;
    if (targetDefaults){
      if (targetDefaults.user) state.vault.dvUser = targetDefaults.user;
      state.vault.dvPassword = '';
    }
    state.vault.vaultPassword = '';
    state.vault.targetPreset = 'internal';
    if (!state.vault.dvDatabase) state.vault.dvDatabase = 'datavault';
  } else {
    Object.assign(state.vault, { dvHost:'localhost', dvPort:'5432', dvUser:'', dvPassword:'', vaultPassword:'' });
    state.vault.targetPreset = '';
  }
}


// When the internal PostgreSQL target uses FDW, the physical core-table
// destination is configured separately below. PostgreSQL remains the Hop
// engine/gateway, while the physical target credentials are stored in
// state.externalTables and also become the Studio Plus defaults.
const JDBC_DRIVER_SPECS = {
  mysql: {
    label:'MySQL Connector/J',
    version:'9.7.0',
    filename:'mysql-connector-j-9.7.0.jar',
    url:'https://repo1.maven.org/maven2/com/mysql/mysql-connector-j/9.7.0/mysql-connector-j-9.7.0.jar',
    otherUrl:'https://dev.mysql.com/downloads/connector/j/',
    statusField:'mysqlDriver',
    drivername:'com.mysql.cj.jdbc.Driver',
  },
  postgresql: {
    label:'PostgreSQL JDBC driver',
    version:'42.7.7',
    filename:'postgresql-42.7.7.jar',
    url:'https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.7/postgresql-42.7.7.jar',
    otherUrl:'https://jdbc.postgresql.org/download/',
    statusField:'postgresDriver',
    drivername:'org.postgresql.Driver',
  },
};
function jdbcDriverSpec(dialect){
  if(JDBC_DRIVER_SPECS[dialect]) return JDBC_DRIVER_SPECS[dialect];
  const pack=databasePackForDialect(dialect);
  if(pack) return {label:`${pack.label} JDBC driver`,version:pack.version,filename:packDriverDisplay(pack),statusField:'packDriver',drivername:pack.jdbc.driverClass,otherUrl:pack.jdbc.driverDownloadUrl||''};
  return null;
}
function defaultExternalJdbcUrl(dialect, host, port, database){
  const pack=databasePackForDialect(dialect);
  if(pack){
    const values={...(state.externalTables.packValues||{}),host:host||'',port:port||'',database:database||'',catalog:database||'',schema:state.externalTables.studioSchema||state.externalTables.remoteSchema||''};
    return packTemplate(pack.jdbc.urlTemplate,values);
  }
  const h=host||'external-db';
  const p=port||externalDefaultPort(dialect);
  const db=database||'datavault';
  if(dialect==='mysql') return `jdbc:mysql://${h}:${p}/${db}`;
  return `jdbc:postgresql://${h}:${p}/${db}`;
}
function externalDialectDefaults(dialect){
  const spec=jdbcDriverSpec(dialect);
  const pack=databasePackForDialect(dialect);
  if(pack){
    const port=(pack.connectionFields||[]).find(f=>f.mapsTo==='port')?.default||'';
    const schema=pack.namespace&&pack.namespace.defaultSchema||'';
    return {port:String(port||''),schema,drivername:pack.jdbc.driverClass,jarfile:pack.driverFile?`/opt/jdbc-drivers/${pack.driverFile}`:''};
  }
  if(dialect==='mysql') return {port:'3306',schema:'',drivername:spec.drivername,jarfile:`/opt/jdbc-drivers/${spec.filename}`};
  return {port:'5432',schema:'data_vault',drivername:'org.postgresql.Driver',jarfile:'/opt/jdbc-drivers/postgresql-42.7.5.jar'};
}

function externalTargetDefaults(){
  const v = state.vault;
  const demoPhysicalTarget = isDemoRuntime();
  const name = sqlNamePart(v.name || 'vault') || 'vault';
  if (demoPhysicalTarget){
    return {
      serverName: `${name}_external_srv`,
      drivername: 'com.mysql.cj.jdbc.Driver',
      url: 'jdbc:mysql://mysql:3306/datavault',
      jarfile: '/opt/jdbc-drivers/mysql-connector-j-9.7.0.jar',
      querytimeout: '30',
      maxheapsize: '512m',
      username: v.srcUser || 'sakila',
      password: '',
      remoteDialect: 'mysql',
      remoteDatabase: 'datavault',
      remoteSchema: '',
      studioHost: v.srcHost || 'localhost',
      studioPort: v.srcPort || '3306',
      studioDatabase: 'datavault',
      studioSchema: '',
      studioUser: v.srcUser || 'sakila',
      studioPassword: '',
    };
  }
  return {
    serverName: `${name}_external_srv`,
    drivername: '', url: '', jarfile:'', querytimeout:'30', maxheapsize:'512m',
    username:'', password:'', remoteDialect:'postgresql', remoteDatabase:'datavault', remoteSchema:'data_vault',
    studioHost:'', studioPort:'5432', studioDatabase:'datavault', studioSchema:'data_vault', studioUser:'', studioPassword:'',
  };
}

function applyExternalTargetDefaults(force=false){
  const ext = state.externalTables;
  if (!ext || !ext.enabled) return;
  const defaults = externalTargetDefaults();
  const connectionAlreadyConfigured = !!(
    ext.studioConnectionOverridden || ext.url || ext.studioHost || ext.studioUser ||
    ext.remoteDatabase || ext.username || ext.drivername || ext.jarfile
  );
  if (force || !connectionAlreadyConfigured){
    Object.assign(ext, defaults, { studioConnectionOverridden:false });
    return;
  }
  for (const [key,value] of Object.entries(defaults)){
    if (ext[key] === undefined || ext[key] === null || ext[key] === '') ext[key] = value;
  }
  if (isDemoRuntime()){
    const sharedUser = String(state.vault.srcUser || defaults.studioUser || '');
    ext.studioUser = sharedUser;
    ext.studioPassword = '';
    ext.username = sharedUser;
    ext.password = '';
  } else {
    ext.studioUser = String(ext.studioUser || ext.username || '');
    ext.studioPassword = String(ext.studioPassword || ext.password || '');
    ext.username = ext.studioUser;
    ext.password = ext.studioPassword;
  }
}

function externalPhysicalSchemaLabel(){
  const ext=state.externalTables;
  return ext.remoteDialect==='mysql'
    ? (ext.studioDatabase||ext.remoteDatabase||'datavault')
    : (ext.studioSchema||ext.remoteSchema||'data_vault');
}

function enforceDemoConnections(){
  applyDemoSource(true);
  applyDemoTarget(true);
}

function enforceRuntimeConnections(preferInternal=false){
  if (isDemoRuntime()){
    enforceDemoConnections();
    return;
  }

  // A project created in demo mode can be opened in production mode. Keep
  // its values, but turn the packaged Sakila preset into an ordinary editable
  // MySQL connection rather than exposing a demo-only selector.
  if (state.vault.sourcePreset === 'demo') state.vault.sourcePreset = '';

  if (state.externalTables && state.externalTables.enabled && state.externalTables.remoteDialect!=='mysql' && !isDatabasePackDialect(state.externalTables.remoteDialect)) state.externalTables.enabled = false;

  if (preferInternal && state.vault.targetPreset !== 'internal'){
    applyDemoTarget(true);
  } else if (state.vault.targetPreset === 'internal'){
    const database = state.vault.dvDatabase || 'datavault';
    applyDemoTarget(true);
    state.vault.dvDatabase = database;
  } else {
    state.vault.targetPreset = '';
    if (state.externalTables && state.externalTables.enabled) state.externalTables.enabled = false;
  }
}

