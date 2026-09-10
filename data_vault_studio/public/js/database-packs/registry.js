const DIALECTS = {
  // Built-in source support is intentionally small. New source databases are
  // installed through Database Packs instead of adding vendor SQL here.
  postgresql: { label: 'PostgreSQL', defaultPort: '5432',
    boolTypes: ['boolean','bool'], jsonTypes: ['jsonb','json','text'] },
  mysql: { label: 'MySQL', defaultPort: '3306',
    boolTypes: ['tinyint(1)','boolean','bool'], jsonTypes: ['json','text','longtext','mediumtext'] },

  // Legacy identifier retained only so old project files can be migrated to
  // pack:sqlserver after the bundled SQL Server Database Pack is loaded.
  sqlserver: { label: 'SQL Server (legacy)', defaultPort: '1433',
    boolTypes: ['bit'], jsonTypes: ['text','ntext','varchar(max)','nvarchar(max)'] },
};


// Database Packs v0.2.0 — source adapters are declarative JDBC packs.
// Source-side Data Vault hashing is deliberately absent: Studio lands only source
// columns and PostgreSQL staging views own BK/hash/tenant derivation centrally.
const DATABASE_PACK_FEATURE_VERSION = '0.2.2';
let databasePacks = [];
let hopDatabaseCatalog = { databaseTypes:[], generic:{pluginId:'GENERIC',pluginName:'Generic database'} };
let databasePackLoadError = '';
function isDatabasePackDialect(value){ return /^pack:[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(value||'')); }
function databasePackId(value){ return isDatabasePackDialect(value) ? String(value).slice(5).toLowerCase() : ''; }
function bundledPackIdForDialect(value){
  const dialect=String(value||'').toLowerCase();
  if(dialect==='mysql') return 'mysql';
  if(dialect==='postgresql'||dialect==='postgres') return 'postgresql';
  return '';
}
function databasePackForDialect(value){
  const id=databasePackId(value)||bundledPackIdForDialect(value);
  return id ? databasePacks.find(p=>p.id===id) || null : null;
}
function databasePackDialectValue(pack){
  const id=String(pack&&pack.id||'').toLowerCase();
  if(id==='mysql') return 'mysql';
  if(id==='postgresql'||id==='postgres') return 'postgresql';
  return id?`pack:${id}`:'';
}
const PREFERRED_DATABASE_PACK_IDS=['postgresql','mysql','mssqlnative','oracle'];
function orderedDatabasePacks(packs=databasePacks){
  const rank=new Map(PREFERRED_DATABASE_PACK_IDS.map((id,index)=>[id,index]));
  return [...(packs||[])].sort((a,b)=>{
    const ai=rank.has(a.id)?rank.get(a.id):999;
    const bi=rank.has(b.id)?rank.get(b.id):999;
    return ai-bi || String(a.label||a.id).localeCompare(String(b.label||b.id));
  });
}
function packTemplate(template, values){
  return String(template||'').replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(m,k)=>values&&values[k]!=null?String(values[k]):m);
}

const PROJECT_CERTS_REFERENCE_PREFIX='dv-certs/';
const HOP_CERTS_ROOT='/app/dv-certs';
const PROJECT_CERT_REFERENCE_BOUNDARIES=new Set(['=',';','?','&',':',',','(',' ','\t','\r','\n','\"',"'"]);
const PROJECT_CERT_REFERENCE_TERMINATORS=new Set(['&',';','?','#',',','\"',"'",'<','>',')','}',']','\r','\n','\t']);
const MANAGED_JDBC_FILE_MASK='__DVS_MANAGED_JDBC_FILE__';
const JDBC_FILE_URI_RE=/(^|[=;&?,(:\s"'])file:/i;
const JDBC_WINDOWS_ABSOLUTE_RE=/(^|[=;&?,(\s"'])(?:[A-Za-z]:[\\/]|\\\\)/;
const JDBC_POSIX_ABSOLUTE_RE=/(^|[=;&?,(\s"'])\/(?!\/)/;
const JDBC_RELATIVE_ESCAPE_RE=/(^|[=;&?,(\s"'])(?:~[\\/]|\.{1,2}[\\/])/;
function validateProjectCertificateRelativeReference(relative){
  const value=String(relative||'');
  if(!value || !/^[A-Za-z0-9._/-]+$/.test(value)) throw new Error('Project certificate references must use a simple relative path beneath dv-certs/.');
  const parts=value.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..')) throw new Error('Project certificate references cannot contain empty, current-directory, or parent-directory path segments.');
  return value;
}
function jdbcProjectFilePropertyText(value){
  const text=String(value==null?'':value);
  if(!/^jdbc:/i.test(text)) return text;
  const propertyParts=[];
  const queryIndex=text.indexOf('?');
  if(queryIndex>=0) propertyParts.push(text.slice(queryIndex+1));
  for(const part of text.split(';').slice(1)) if(part.includes('=')) propertyParts.push(part);
  return propertyParts.join('&');
}
function assertManagedJdbcLocalFileReferences(value){
  const text=String(value==null?'':value);
  let masked=resolveProjectCertificateReferencesRaw(text,MANAGED_JDBC_FILE_MASK);
  masked=masked.replace(new RegExp(`file:${MANAGED_JDBC_FILE_MASK}`,'gi'),MANAGED_JDBC_FILE_MASK);
  const inspect=jdbcProjectFilePropertyText(masked);
  if(JDBC_FILE_URI_RE.test(inspect)||JDBC_WINDOWS_ABSOLUTE_RE.test(inspect)||JDBC_POSIX_ABSOLUTE_RE.test(inspect)||JDBC_RELATIVE_ESCAPE_RE.test(inspect)){
    throw new Error('Local JDBC file references must use the project dv-certs/ directory.');
  }
  return text;
}
function resolveProjectCertificateReferencesRaw(value,runtimeRoot=HOP_CERTS_ROOT){
  const text=String(value==null?'':value);
  let output=''; let cursor=0; let offset=0; let found=false;
  while(true){
    const index=text.indexOf(PROJECT_CERTS_REFERENCE_PREFIX,offset);
    if(index<0) break;
    const previous=index===0?'':text[index-1];
    if(index>0&&!PROJECT_CERT_REFERENCE_BOUNDARIES.has(previous)) throw new Error('Project certificate references must start with dv-certs/ as a standalone JDBC value or option value.');
    let end=index+PROJECT_CERTS_REFERENCE_PREFIX.length;
    while(end<text.length&&!PROJECT_CERT_REFERENCE_TERMINATORS.has(text[end])) end+=1;
    const relative=validateProjectCertificateRelativeReference(text.slice(index+PROJECT_CERTS_REFERENCE_PREFIX.length,end));
    output+=text.slice(cursor,index)+String(runtimeRoot||HOP_CERTS_ROOT).replace(/\/+$/,'')+'/'+relative;
    cursor=end; offset=end; found=true;
  }
  return found?output+text.slice(cursor):text;
}
function resolveProjectCertificateReferences(value,runtimeRoot=HOP_CERTS_ROOT){
  assertManagedJdbcLocalFileReferences(value);
  return resolveProjectCertificateReferencesRaw(value,runtimeRoot);
}
function deriveStandardPackConnectionFields(pack){
  if(Array.isArray(pack&&pack.connectionFields)&&pack.connectionFields.length) return pack.connectionFields;
  const tokens=[...new Set([...String(pack?.jdbc?.urlTemplate||'').matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m=>m[1]))];
  const labels={host:'Host',port:'Port',database:'Database',schema:'Schema',catalog:'Catalog',user:'Username',password:'Password'};
  const mapped=new Set(['host','port','database','schema','catalog','user','password']);
  const fields=tokens.map(key=>{
    const field={key,label:labels[key]||key.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase()),type:key==='port'?'number':'text',required:!['schema','catalog'].includes(key)};
    if(mapped.has(key))field.mapsTo=key;
    if(key==='port'&&pack?.jdbc?.defaultPort!=null)field.default=String(pack.jdbc.defaultPort);
    if(key==='schema'&&pack?.namespace?.defaultSchema!=null)field.default=String(pack.namespace.defaultSchema);
    if(key==='catalog'&&pack?.namespace?.defaultCatalog!=null)field.default=String(pack.namespace.defaultCatalog);
    return field;
  });
  const has=key=>fields.some(f=>f.key===key||f.mapsTo===key);
  if((pack?.namespace?.usesCatalog===true||pack?.namespace?.defaultCatalog!=null)&&!has('catalog'))fields.push({key:'catalog',label:pack.namespace.catalogLabel||'Catalog',type:'text',required:pack.namespace.usesCatalog===true,default:pack.namespace.defaultCatalog!=null?String(pack.namespace.defaultCatalog):'',mapsTo:'catalog'});
  if(pack?.namespace?.usesSchema!==false&&!has('schema'))fields.push({key:'schema',label:pack?.namespace?.schemaLabel||'Schema',type:'text',required:false,default:pack?.namespace?.defaultSchema!=null?String(pack.namespace.defaultSchema):'',mapsTo:'schema'});
  if(!has('user'))fields.push({key:'user',label:'Username',type:'text',required:true,mapsTo:'user'});
  if(!has('password'))fields.push({key:'password',label:'Password',type:'password',required:true,mapsTo:'password'});
  pack.connectionFields=fields;
  return fields;
}
function registerDatabasePack(pack){
  if(!pack || !pack.id || pack.invalid) return;
  deriveStandardPackConnectionFields(pack);
  const dialect=`pack:${pack.id}`;
  DIALECTS[dialect]={
    label:`${pack.label} · Pack ${pack.version}`,
    defaultPort:String(pack.jdbc?.defaultPort||(pack.connectionFields||[]).find(f=>f.mapsTo==='port')?.default||''),
    boolTypes:['boolean','bool','bit'], jsonTypes:['json','jsonb','variant','object','map','struct'], pack,
  };
}
function clearRegisteredDatabasePacks(){ Object.keys(DIALECTS).filter(k=>k.startsWith('pack:')).forEach(k=>delete DIALECTS[k]); }
function normalizeHopMatch(value){ return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
function hopCatalogEntryResult(entry,strategy='native'){
  if(!entry) return null;
  return {
    pluginId:entry.pluginId, pluginName:entry.pluginName||entry.pluginId, module:entry.module,
    connectionDefaults:entry.connectionDefaults||{}, strategy
  };
}
function resolveHopDatabaseType(pack,dialect=''){
  const genericEntry=hopDatabaseCatalog?.generic||{pluginId:'GENERIC',pluginName:'Generic database',connectionDefaults:{accessType:0,attributes:{}}};
  const generic={...hopCatalogEntryResult(genericEntry,'generic'),strategy:'generic'};
  if(!pack){
    const wantedDialect=String(dialect||'').toLowerCase();
    const match=(hopDatabaseCatalog?.databaseTypes||[]).find(entry=>(entry.studioDialects||[]).map(v=>String(v).toLowerCase()).includes(wantedDialect));
    return match ? hopCatalogEntryResult(match,'native') : null;
  }
  if(pack.hop?.enabled===false || pack.hop?.forceGeneric===true) return generic;
  if(pack.hop?.pluginId && String(pack.hop.pluginId).toUpperCase()!=='GENERIC'){
    const id=String(pack.hop.pluginId);
    const entry=(hopDatabaseCatalog?.databaseTypes||[]).find(e=>String(e.pluginId||'').toUpperCase()===id.toUpperCase());
    return entry ? hopCatalogEntryResult(entry,'native') : {pluginId:id,pluginName:pack.hop.pluginName||id,connectionDefaults:{},strategy:'native'};
  }
  // v0.1.0 normalized every pack to GENERIC. Treat that legacy value as a
  // fallback hint, not a force flag, so an upgraded Studio can prefer a
  // native Hop database type from the bundled catalogue automatically.
  const wanted=new Set([pack.id,pack.label,state?.vault?.sourceProductName].map(normalizeHopMatch).filter(Boolean));
  const match=(hopDatabaseCatalog?.databaseTypes||[]).find(entry=>{
    const names=[entry.module,entry.pluginId,entry.pluginName,...(entry.aliases||[]),...(entry.products||[])].map(normalizeHopMatch);
    return names.some(n=>wanted.has(n));
  });
  return match&&String(match.pluginId||'').toUpperCase()!=='GENERIC'
    ? hopCatalogEntryResult(match,'native')
    : generic;
}
function sourceHopCapabilityAttributes(hop){
  const defaults=hop?.connectionDefaults?.attributes||{};
  const captured=state?.sourceMeta?.hopCapabilities;
  let supportsTimestamp=captured&&typeof captured.supportsTimestamp==='boolean' ? captured.supportsTimestamp : null;
  let supportsBoolean=captured&&typeof captured.supportsBoolean==='boolean' ? captured.supportsBoolean : null;

  // Older projects do not have a captured capability profile. Derive enough
  // from their existing source model to avoid regressing timestamp/boolean
  // handling, then fall back to the bundled Hop catalogue defaults.
  if(supportsTimestamp==null || supportsBoolean==null){
    let modelTimestamp=false, modelBoolean=false, sawColumns=false;
    for(const table of state?.tables||[]) for(const column of table.columns||[]){
      sawColumns=true;
      const semantic=String(column.semanticType||'').toUpperCase();
      const type=String(column.nativeType||column.type||'').toLowerCase();
      if(['TIMESTAMP','TIMESTAMP_TZ'].includes(semantic) || /(^|\W)(timestamp|datetime|smalldatetime)(\W|$)/.test(type)) modelTimestamp=true;
      if(semantic==='BOOLEAN' || isBooleanType(column.nativeType||column.type||'')) modelBoolean=true;
    }
    if(sawColumns){
      if(supportsTimestamp==null) supportsTimestamp=modelTimestamp;
      if(supportsBoolean==null) supportsBoolean=modelBoolean;
    }
  }
  const defaultFlag=(name)=>String(defaults[name]||'').toUpperCase()==='Y';
  if(supportsTimestamp==null) supportsTimestamp=defaultFlag('SUPPORTS_TIMESTAMP_DATA_TYPE');
  if(supportsBoolean==null) supportsBoolean=defaultFlag('SUPPORTS_BOOLEAN_DATA_TYPE');
  return {
    SUPPORTS_TIMESTAMP_DATA_TYPE:supportsTimestamp?'Y':'N',
    SUPPORTS_BOOLEAN_DATA_TYPE:supportsBoolean?'Y':'N',
  };
}
function hopConnectionAttributes(hop,pack=null){
  // Connection defaults first, JDBC/model-derived capabilities second, and
  // explicit Pack attributes last so a Pack author can override a broken or
  // unusual driver without changing Studio core.
  return Object.assign({},hop?.connectionDefaults?.attributes||{},sourceHopCapabilityAttributes(hop),pack?.hop?.attributes||{});
}
function packDriverDisplay(pack){ return String(pack?.driverFile||pack?.jdbc?.jarfile||pack?.jdbc?.jarPattern||''); }
function migrateLegacySqlServerSourceToPack(){
  // v0.1.x saved SQL Server as a built-in source dialect. v0.2.0 deliberately
  // proves the extension path by making SQL Server a normal source Pack. Once
  // that Pack is installed, preserve the user's connection values and migrate
  // the saved project in-place without exposing a second SQL Server code path.
  if(state.vault.dialect!=='sqlserver') return false;
  const pack=databasePacks.find(p=>p.id==='sqlserver' && (!p.source || p.source.enabled!==false));
  if(!pack) return false;
  const v=state.vault;
  const prior={host:v.srcHost,port:v.srcPort,database:v.srcDatabase,schema:(v.sourceSchema&&v.sourceSchema!=='public')?v.sourceSchema:'dbo',user:v.srcUser,password:v.srcPassword};
  const values={};
  (pack.connectionFields||[]).forEach(field=>{
    let value=field.mapsTo ? prior[field.mapsTo] : undefined;
    if((value==null||value==='') && field.default!=null) value=field.default;
    values[field.key]=value==null?'':String(value);
  });
  v.dialect='pack:sqlserver'; v.sourcePackValues=values; v.sourceCatalog=''; v.sourcePreset='';
  syncPackMappedValues(pack,'source');
  v.sourceSchema=packValueMappedTo(pack,values,'schema') || String(pack.namespace?.defaultSchema||'');
  return true;
}
function migrateLegacySqlServerTargetToPack(){
  // Older projects stored SQL Server as a built-in physical target. New
  // projects use the bundled SQL Server Database Pack, exactly like any other
  // Pack target. Preserve the old connection values and migrate in-place once
  // that Pack is available.
  const ext=state.externalTables;
  if(!ext || !ext.enabled || ext.remoteDialect!=='sqlserver') return false;
  const pack=databasePacks.find(p=>p.id==='sqlserver');
  if(!pack) return false;
  deriveStandardPackConnectionFields(pack);
  const prior={
    host:ext.studioHost,
    port:ext.studioPort||'1433',
    database:ext.studioDatabase||ext.remoteDatabase,
    catalog:ext.studioDatabase||ext.remoteDatabase,
    schema:ext.studioSchema||ext.remoteSchema||pack.namespace?.defaultSchema||'',
    user:ext.studioUser||ext.username,
    password:ext.studioPassword||ext.password,
  };
  const values={};
  (pack.connectionFields||[]).forEach(field=>{
    let value=field.mapsTo ? prior[field.mapsTo] : undefined;
    if((value==null||value==='') && field.default!=null) value=field.default;
    values[field.key]=value==null?'':String(value);
  });
  ext.remoteDialect='pack:sqlserver';
  ext.packValues=values;
  ext.targetProfile=null;
  ext.deploymentAcknowledged=false;
  syncPackMappedValues(pack,'target');
  return true;
}

async function loadDatabasePacks(){
  try{
    const r=await localFetch('/api/database-packs'); const data=await r.json();
    if(!data.ok) throw new Error(data.error||'Could not load Database Packs.');
    clearRegisteredDatabasePacks();
    hopDatabaseCatalog=data.hopCatalog||hopDatabaseCatalog;
    databasePacks=(data.packs||[]).filter(p=>!p.invalid);
    databasePacks.forEach(registerDatabasePack);
    migrateLegacySqlServerSourceToPack();
    migrateLegacySqlServerTargetToPack();
    if(isDatabasePackDialect(state.vault.dialect)&&!databasePackForDialect(state.vault.dialect)){ state.vault.dialect='postgresql'; state.vault.sourcePackValues={}; }
    if(isDatabasePackDialect(state.externalTables.remoteDialect)&&!databasePackForDialect(state.externalTables.remoteDialect)){ state.externalTables.enabled=false; state.externalTables.remoteDialect='postgresql'; state.externalTables.packValues={}; }
    databasePackLoadError='';
    return databasePacks;
  }catch(err){ clearRegisteredDatabasePacks(); databasePackLoadError=err.message; databasePacks=[]; return []; }
}
function runtimeVariableForPackField(field){
  const mapped={host:'source_host_name',port:'source_port_number',database:'source_database_name',schema:'source_schema_name',user:'source_user_name',password:'source_password'};
  if(field&&field.mapsTo&&mapped[field.mapsTo]) return mapped[field.mapsTo];
  return `source_pack_${String(field?.key||'value').replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/[^A-Za-z0-9_]/g,'_').toLowerCase()}`;
}
function packConnectionValues(scope='source'){
  if(scope==='source'){
    if(!state.vault.sourcePackValues) state.vault.sourcePackValues={};
    return state.vault.sourcePackValues;
  }
  if(!state.externalTables.packValues) state.externalTables.packValues={};
  return state.externalTables.packValues;
}
function seedPackConnectionValues(pack,scope='source',{reset=false}={}){
  if(!pack) return {};
  const values=packConnectionValues(scope);
  if(reset) Object.keys(values).forEach(key=>delete values[key]);
  const mappedValue=(mapsTo)=>{
    if(scope==='source'){
      const v=state.vault;
      return ({host:v.srcHost,port:v.srcPort,database:v.srcDatabase,schema:v.sourceSchema,catalog:v.sourceCatalog,user:v.srcUser,password:v.srcPassword})[mapsTo];
    }
    const ext=state.externalTables;
    return ({host:ext.studioHost,port:ext.studioPort,database:ext.studioDatabase||ext.remoteDatabase,schema:ext.studioSchema||ext.remoteSchema,catalog:ext.studioDatabase||ext.remoteDatabase,user:ext.studioUser||ext.username,password:ext.studioPassword||ext.password})[mapsTo];
  };
  (pack.connectionFields||[]).forEach(field=>{
    if(!reset && values[field.key]!=null && String(values[field.key])!=='') return;
    let value=field.mapsTo?mappedValue(field.mapsTo):undefined;
    if((value==null||value==='')&&field.default!=null)value=field.default;
    values[field.key]=value==null?'':String(value);
  });
  syncPackMappedValues(pack,scope);
  return values;
}
// Hop "Options" tab: a list of {key,value} pairs applied to the JDBC driver.
// Stored per-scope alongside packValues so they persist across re-renders.
function packJdbcOptionsList(scope='source'){
  if(scope==='source'){
    if(!Array.isArray(state.vault.sourcePackOptions)) state.vault.sourcePackOptions=[];
    return state.vault.sourcePackOptions;
  }
  if(!Array.isArray(state.externalTables.packOptions)) state.externalTables.packOptions=[];
  return state.externalTables.packOptions;
}
// Hop "Manual connection URL" field. When non-empty it overrides the assembled
// connection string on the server; credentials still come from the fields.
function packManualUrlValue(scope='source'){
  if(scope==='source') return String(state.vault.sourceManualUrl||'');
  return String(state.externalTables.manualUrl||'');
}
function setPackManualUrlValue(scope,value){
  if(scope==='source') state.vault.sourceManualUrl=String(value||'');
  else state.externalTables.manualUrl=String(value||'');
}
// Normalise the options list into the shape the server expects (array of
// {key,value}), dropping blank keys.
function packJdbcOptionsPayload(scope='source'){
  return packJdbcOptionsList(scope)
    .filter(row=>row&&String(row.key||'').trim()!=='')
    .map(row=>({key:String(row.key).trim(),value:row.value==null?'':String(row.value)}));
}
function syncPackMappedValues(pack,scope='source'){
  if(!pack) return;
  const values=packConnectionValues(scope);
  (pack.connectionFields||[]).forEach(field=>{
    const val=values[field.key]; if(val==null) return;
    if(scope==='source'){
      if(field.mapsTo==='host') state.vault.srcHost=String(val);
      if(field.mapsTo==='port') state.vault.srcPort=String(val);
      if(field.mapsTo==='database') state.vault.srcDatabase=String(val);
      if(field.mapsTo==='schema') state.vault.sourceSchema=String(val);
      if(field.mapsTo==='catalog') state.vault.sourceCatalog=String(val);
      if(field.mapsTo==='user') state.vault.srcUser=String(val);
      if(field.mapsTo==='password') state.vault.srcPassword=String(val);
    } else {
      const ext=state.externalTables;
      if(field.mapsTo==='host') ext.studioHost=String(val);
      if(field.mapsTo==='port') ext.studioPort=String(val);
      if(field.mapsTo==='database'||field.mapsTo==='catalog'){ext.studioDatabase=String(val);ext.remoteDatabase=String(val);}
      if(field.mapsTo==='schema'){ext.studioSchema=String(val);ext.remoteSchema=String(val);}
      if(field.mapsTo==='user'){ext.studioUser=String(val);ext.username=String(val);}
      if(field.mapsTo==='password'){ext.studioPassword=String(val);ext.password=String(val);}
    }
  });
  if(String(pack.id||'').toLowerCase()==='mysql'){
    const databaseField=(pack.connectionFields||[]).find(field=>field.mapsTo==='database'||field.mapsTo==='catalog');
    const schemaField=(pack.connectionFields||[]).find(field=>field.mapsTo==='schema');
    const databaseValue=databaseField&&values[databaseField.key]!=null?String(values[databaseField.key]):'';
    if(schemaField) values[schemaField.key]=databaseValue;
    if(scope==='source') state.vault.sourceSchema=databaseValue;
    else { state.externalTables.studioSchema=databaseValue; state.externalTables.remoteSchema=databaseValue; }
  }
}
function packValueMappedTo(pack,values,mapsTo){
  const field=(pack?.connectionFields||[]).find(f=>f.mapsTo===mapsTo);
  if(!field) return '';
  return values[field.key]!=null?String(values[field.key]):'';
}
function databasePackConnectionBody(scope='source'){
  const dialect=scope==='source'?state.vault.dialect:state.externalTables.remoteDialect;
  const pack=databasePackForDialect(dialect); if(!pack) return null;
  seedPackConnectionValues(pack,scope);
  syncPackMappedValues(pack,scope);
  const values={...packConnectionValues(scope)};
  const catalog=packValueMappedTo(pack,values,'catalog') || String(pack.namespace?.defaultCatalog||'');
  const schema=packValueMappedTo(pack,values,'schema') || String(pack.namespace?.defaultSchema||'');
  const options=packJdbcOptionsPayload(scope);
  const manualUrl=packManualUrlValue(scope);
  if(scope==='source') return {dialect,packValues:values,host:state.vault.srcHost,port:state.vault.srcPort,database:state.vault.srcDatabase,catalog,schema,user:state.vault.srcUser,password:state.vault.srcPassword,options,manualUrl};
  const ext=state.externalTables;
  return {dialect,packValues:values,host:ext.studioHost,port:ext.studioPort,database:ext.studioDatabase||ext.remoteDatabase,catalog,schema,user:ext.studioUser||ext.username,password:ext.studioPassword||ext.password,options,manualUrl};
}
function stripDatabasePackPasswordsFromState(stateCopy){
  if(!stateCopy||typeof stateCopy!=='object') return stateCopy;
  const sourcePack=databasePackForDialect(stateCopy.vault&&stateCopy.vault.dialect);
  if(sourcePack&&stateCopy.vault&&stateCopy.vault.sourcePackValues){
    for(const field of sourcePack.connectionFields||[]){
      if(field.mapsTo==='password') stateCopy.vault.sourcePackValues[field.key]='';
    }
  }
  const targetPack=databasePackForDialect(stateCopy.externalTables&&stateCopy.externalTables.remoteDialect);
  if(targetPack&&stateCopy.externalTables&&stateCopy.externalTables.packValues){
    for(const field of targetPack.connectionFields||[]){
      if(field.mapsTo==='password') stateCopy.externalTables.packValues[field.key]='';
    }
  }
  return stateCopy;
}

function missingDatabasePackConnectionFields(pack,scope='target'){
  if(!pack) return [];
  const values=packConnectionValues(scope);
  return (pack.connectionFields||[]).filter(field=>{
    if(!field.required) return false;
    const value=values[field.key]!=null?values[field.key]:field.default;
    return String(value==null?'':value).trim()==='';
  }).map(field=>field.label||field.key);
}
function databasePackFdwCredentialIssue(pack){
  if(!pack) return '';
  const fields=pack.connectionFields||[];
  const userField=fields.find(field=>field.mapsTo==='user');
  const passwordField=fields.find(field=>field.mapsTo==='password');
  if(!userField||!passwordField) return 'This Database Pack must expose connection fields mapped to user and password before it can be used through jdbc_fdw.';
  const values=packConnectionValues('target');
  if(!String(values[userField.key]??'').trim() || !String(values[passwordField.key]??'').trim()) return 'Target username and password are required because jdbc_fdw user mappings use those credentials.';
  return '';
}
function packConnectionFieldsHtml(pack,scope='source'){
  seedPackConnectionValues(pack,scope);
  const values=packConnectionValues(scope); const prefix=scope==='source'?'src':'tgt';
  // Keep the common connection concepts visually grouped even when Hop emits
  // fields in a different order. Vendor-specific fields stay between namespace
  // fields and credentials, and Username always begins a fresh row so Password
  // sits directly beside it in the 3-column connection grid.
  const priority={host:10,port:20,database:30,catalog:40,schema:50,user:90,password:100};
  const fields=(pack.connectionFields||[]).map((field,index)=>({field,index})).sort((a,b)=>{
    const ak=a.field.mapsTo||a.field.key, bk=b.field.mapsTo||b.field.key;
    const ap=priority[ak]??(60+a.index/1000), bp=priority[bk]??(60+b.index/1000);
    return ap-bp || a.index-b.index;
  }).map(item=>item.field);
  return fields.map(field=>{
    const value=values[field.key]!=null?values[field.key]:(field.default!=null?field.default:'');
    const required=field.required?' <span style="color:var(--err)">*</span>':'';
    const optional=field.mapsTo==='schema'&&!field.required?' <span style="color:var(--muted-2);font-family:var(--font-body);font-size:10px;">(optional)</span>':'';
    const rowStart=field.mapsTo==='user'?' style="grid-column:1;"':'';
    if(field.type==='select'){
      const options=(field.options||[]).map(o=>{const ov=typeof o==='object'?o.value:o, ol=typeof o==='object'?(o.label||o.value):o;return `<option value="${escapeHtml(String(ov))}" ${String(value)===String(ov)?'selected':''}>${escapeHtml(String(ol))}</option>`;}).join('');
      return `<div class="field"${rowStart}><label>${escapeHtml(field.label||field.key)}${required}${optional}</label><select data-pack-field="${escapeHtml(field.key)}" data-pack-scope="${scope}" id="f-pack-${prefix}-${escapeHtml(field.key)}">${options}</select>${field.help?`<p class="hint mt">${escapeHtml(field.help)}</p>`:''}</div>`;
    }
    if(field.type==='checkbox'){
      const checked=value===true||String(value).toLowerCase()==='true'||String(value).toUpperCase()==='Y';
      return `<div class="field"${rowStart}><label>${escapeHtml(field.label||field.key)}${required}${optional}</label><label style="display:flex;align-items:center;gap:8px;min-height:38px;"><input type="checkbox" data-pack-field="${escapeHtml(field.key)}" data-pack-scope="${scope}" id="f-pack-${prefix}-${escapeHtml(field.key)}" ${checked?'checked':''} style="width:auto;"> <span class="hint mb0">${escapeHtml(field.help||'Enabled')}</span></label></div>`;
    }
    const type=field.type==='password'?'password':field.type==='number'?'number':'text';
    const mysqlSchema=String(pack.id||'').toLowerCase()==='mysql'&&field.mapsTo==='schema';
    const pdiLimitKey=scope==='source' ? ({host:'connectionHost',database:'connectionDatabase',user:'connectionUser'}[field.mapsTo] || '') : '';
    const pdiMaxLength=pdiLimitKey && typeof pdiMetaMaxLength==='function' ? pdiMetaMaxLength(pdiLimitKey) : null;
    const maxLengthAttr=pdiMaxLength ? `maxlength="${pdiMaxLength}"` : '';
    const isSourceSchema=scope==='source'&&field.mapsTo==='schema'&&type==='text';
    const listId=isSourceSchema?'pack-source-schema-options':'';
    const schemaSuggestions=isSourceSchema&&discoveredSchemas.length
      ? `<datalist id="${listId}">${discoveredSchemas.map(schema=>`<option value="${escapeHtml(String(schema))}"></option>`).join('')}</datalist>`
      : '';
    // Schema discovery remains available through its datalist after a successful
    // connection test; it no longer needs a permanent helper paragraph that
    // makes only the middle grid cell taller than its neighbours.
    const help=field.help&&!isSourceSchema?`<p class="hint mt">${escapeHtml(field.help)}</p>`:'';
    return `<div class="field"${rowStart}><label>${escapeHtml(field.label||field.key)}${required}${optional}</label><input type="${type}" ${mysqlSchema?'readonly aria-readonly="true"':''} data-pack-field="${escapeHtml(field.key)}" data-pack-scope="${scope}" id="f-pack-${prefix}-${escapeHtml(field.key)}" value="${escapeHtml(String(value))}" ${maxLengthAttr} ${listId?`list="${listId}"`:''} ${type==='password'?'autocomplete="off"':''}>${mysqlSchema?'<p class="hint mt">MySQL uses the database as its schema.</p>':''}${schemaSuggestions}${help}</div>`;
  }).join('');
}
// Hop-style "Options" key/value table. Rendered under the connection fields on
// both source and target pack forms. Applied server-side as JDBC Properties.
function packJdbcOptionsHtml(pack,scope='source'){
  const prefix=scope==='source'?'src':'tgt';
  const rows=packJdbcOptionsList(scope);
  const rowHtml=rows.map((row,i)=>`
    <div class="grid cols-2 mt" data-pack-option-row="${i}" data-pack-option-scope="${scope}" style="align-items:end;gap:8px;">
      <div class="field mb0"><input type="text" placeholder="Option" data-pack-option-key="${i}" data-pack-option-scope="${scope}" id="f-pack-${prefix}-opt-key-${i}" value="${escapeHtml(String(row.key||''))}"></div>
      <div class="field mb0" style="display:flex;gap:8px;align-items:center;">
        <input type="text" placeholder="Value" data-pack-option-value="${i}" data-pack-option-scope="${scope}" id="f-pack-${prefix}-opt-val-${i}" value="${escapeHtml(String(row.value||''))}" style="flex:1;">
        <button type="button" class="btn ghost" data-pack-option-remove="${i}" data-pack-option-scope="${scope}" title="Remove option">&times;</button>
      </div>
    </div>`).join('');
  return `
    <div class="pack-options" style="margin-top:16px;">
      <label class="mb0">Options</label>
      <p class="hint mb0">JDBC driver properties (optional). Project certificate/key files can be referenced as <span class="mono">dv-certs/filename</span>; Studio resolves that reference locally and container-side JDBC connections use <span class="mono">/app/dv-certs/filename</span>.</p>
      ${rowHtml}
      <button type="button" class="btn ghost mt" data-pack-option-add="1" data-pack-option-scope="${scope}">+ Add option</button>
    </div>`;
}
// Hop-style "Manual connection URL" field, placed at the bottom of the form.
function packManualUrlHtml(pack,scope='source'){
  const prefix=scope==='source'?'src':'tgt';
  const value=packManualUrlValue(scope);
  return `
    <div class="field" style="margin-top:16px;">
      <label>Manual connection URL <span style="color:var(--muted-2);font-family:var(--font-body);font-size:10px;">(optional)</span></label>
      <input type="text" data-pack-manual-url="1" data-pack-manual-scope="${scope}" id="f-pack-${prefix}-manual-url" value="${escapeHtml(String(value))}" placeholder="Leave blank to build the URL from the fields above" autocomplete="off">
      <p class="hint mt">When set, this JDBC URL is used as-is and overrides the fields above. Username and password are still taken from the fields.</p>
    </div>`;
}
function packConnectionExtrasHtml(pack,scope='source'){
  return packJdbcOptionsHtml(pack,scope)+packManualUrlHtml(pack,scope);
}
function invalidateScopeConnState(scope){
  if(scope==='source'){sourceConnStatus=null;discoveredSchemas=[];discoveredCatalogs=[];if(state.sourceMeta)state.sourceMeta.hopCapabilities=null;}
  else{state.externalTables.deploymentAcknowledged=false;state.externalTables.targetProfile=null;externalTargetConnStatus=null;externalPreflightResult=null;externalDeployResult=null;fdwServiceUserDraft={dialect:'',schema:'',username:'',password:''};fdwServiceUserError='';}
}
function wirePackConnectionFields(root,pack,scope='source'){
  if(!root||!pack) return;
  root.querySelectorAll(`[data-pack-scope="${scope}"]`).forEach(node=>{
    const handler=e=>{
      packConnectionValues(scope)[node.dataset.packField]=e.target.type==='checkbox'?e.target.checked:e.target.value;
      syncPackMappedValues(pack,scope);
      invalidateScopeConnState(scope);
    };
    node.addEventListener('input',handler); node.addEventListener('change',handler);
  });
  wirePackConnectionExtras(root,pack,scope);
}
// Wires the Options table and Manual URL field. Option add/remove re-renders the
// owning form via the shared renderConnections() path (rerender=true style),
// matching how other structural connection changes refresh the panel.
function wirePackConnectionExtras(root,pack,scope='source'){
  if(!root) return;
  root.querySelectorAll(`[data-pack-option-key][data-pack-option-scope="${scope}"]`).forEach(node=>{
    node.addEventListener('input',e=>{
      const i=Number(node.dataset.packOptionKey); const list=packJdbcOptionsList(scope);
      if(list[i]){ list[i].key=e.target.value; invalidateScopeConnState(scope); }
    });
  });
  root.querySelectorAll(`[data-pack-option-value][data-pack-option-scope="${scope}"]`).forEach(node=>{
    node.addEventListener('input',e=>{
      const i=Number(node.dataset.packOptionValue); const list=packJdbcOptionsList(scope);
      if(list[i]){ list[i].value=e.target.value; invalidateScopeConnState(scope); }
    });
  });
  root.querySelectorAll(`[data-pack-option-remove][data-pack-option-scope="${scope}"]`).forEach(node=>{
    node.addEventListener('click',()=>{
      const i=Number(node.dataset.packOptionRemove); const list=packJdbcOptionsList(scope);
      if(i>=0&&i<list.length){ list.splice(i,1); invalidateScopeConnState(scope); rerenderConnections(); }
    });
  });
  root.querySelectorAll(`[data-pack-option-add][data-pack-option-scope="${scope}"]`).forEach(node=>{
    node.addEventListener('click',()=>{
      packJdbcOptionsList(scope).push({key:'',value:''}); invalidateScopeConnState(scope); rerenderConnections();
    });
  });
  const manual=root.querySelector(`[data-pack-manual-url][data-pack-manual-scope="${scope}"]`);
  if(manual) manual.addEventListener('input',e=>{ setPackManualUrlValue(scope,e.target.value); invalidateScopeConnState(scope); });
}
// Re-render the connections screen after a structural change (option add/remove).
// Falls back gracefully if the app exposes a different rerender entry point.
function rerenderConnections(){
  // Re-render the Connections *view*, never the navigation tab button. The
  // previous fallback matched [data-tab="connections"], which is the tab
  // control itself; injecting renderConnections() there caused the entire form
  // to appear inside the top navigation when an Option row was added/removed.
  const host=document.getElementById('view-connections');
  if(host&&typeof renderConnections==='function') return renderConnections(host);
  // If the view is not mounted, let the normal application shell recreate it.
  if(typeof renderAll==='function') return renderAll();
}
function databasePackTargetOptionsHtml(){
  // Any installed Database Pack can be selected as a physical target. JDBC
  // discovery determines the usable target type profile at connection/preflight
  // time; source/target/fdw flags are not a physical-target allowlist.
  // The selector groups Pack targets separately, so each option only needs the
  // database label rather than repeating "Database Pack" on every row.
  return orderedDatabasePacks(databasePacks)
    .filter(p=>String(p.id||'').toLowerCase()!=='postgresql')
    .map(p=>{
      const value=databasePackDialectValue(p);
      return `<option value="${escapeHtml(value)}" ${selectedDeploymentTarget()===value?'selected':''}>${escapeHtml(p.label)}</option>`;
    }).join('');
}
function databasePackTargetOptionsGroupedHtml(){
  const packs=orderedDatabasePacks(databasePacks).filter(p=>String(p.id||'').toLowerCase()!=='postgresql');
  const commonIds=new Set(PREFERRED_DATABASE_PACK_IDS.filter(id=>id!=='postgresql'));
  const optionFor=pack=>{
    const value=databasePackDialectValue(pack);
    return `<option value="${escapeHtml(value)}" ${selectedDeploymentTarget()===value?'selected':''}>${escapeHtml(pack.label)}</option>`;
  };
  const common=packs.filter(pack=>commonIds.has(pack.id)).map(optionFor).join('');
  const others=packs.filter(pack=>!commonIds.has(pack.id)).map(optionFor).join('');
  return `${common?`<optgroup label="Common physical targets">${common}</optgroup>`:''}${others?`<optgroup label="Other physical targets">${others}</optgroup>`:''}`;
}
function deploymentTargetGatewayNoticeHtml(target){
  if(!target || target==='internal-postgres' || target==='postgres') return '';
  const pack=databasePackForDialect(target);
  const label=pack?pack.label:((DIALECTS[target]||{}).label||target);
  return `<div class="ai-status busy mt" style="align-items:flex-start;"><span><b>External physical target:</b> ${escapeHtml(label)} stores the core Hub, Link and Satellite tables. Studio's packaged PostgreSQL remains the execution and metadata layer and reaches this target through <span class="mono">jdbc_fdw</span>.${pack?' Target SQL types are resolved from the connected JDBC driver; Pack target settings only override exceptions.':''}</span></div>`;
}

