const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { resolveHostCertificateReferences } = require('../project-file-references');
const { effectiveJdbcDestination, structuredJdbcDestination } = require('../outbound-connections');

function createDatabasePackService({ projectRoot, jdbcDriverPath, studioDir, outboundConnectionPolicy, env = process.env }){
const PROJECT_ROOT = projectRoot;
const JDBC_DRIVER_PATH = jdbcDriverPath;
const STUDIO_DIR = studioDir;
// ---------------------------------------------------------------------------
// DATABASE PACKS v0.1.4
// Declarative, versioned JDBC adapters. PostgreSQL/MySQL retain their stable
// Studio dialect ids for project compatibility and runtime topology rules, but
// their user-configurable source/physical-target connections resolve through
// the same generated Database Packs and shared JDBC bridge as other databases.
// ---------------------------------------------------------------------------
const DATABASE_PACK_FEATURE_VERSION = '0.2.2';
const DATABASE_PACK_SCHEMA_VERSION = 1;
// Database Packs are a Studio extension. Every valid top-level *.json file in
// data_vault_studio/database-packs/ is an installed pack. No registry,
// installed/ subdirectory, or history store is required. Tests/dev can
// override the directory with DVS_DATABASE_PACK_HOME.
const DATABASE_PACK_DIR = path.resolve(env.DVS_DATABASE_PACK_HOME || path.join(STUDIO_DIR, 'database-packs'));
// Compatibility only: v0.1.0 used <project-root>/database-packs and an early
// v0.1.1 preview used data_vault_studio/database-packs/installed. We copy
// missing manifests into the authoritative Studio folder without deleting the
// old copies, so rollback/manual deployment remains safe.
const LEGACY_DATABASE_PACK_DIR = path.join(PROJECT_ROOT, 'database-packs');
const PREVIEW_DATABASE_PACK_DIR = path.join(DATABASE_PACK_DIR, 'installed');
const HOP_DATABASE_TYPES_PATH = path.join(STUDIO_DIR, 'hop', 'database-types.json');
const JDBC_BRIDGE_SOURCE = path.join(STUDIO_DIR, 'jdbc-bridge', 'JdbcBridge.java');
const JDBC_BRIDGE_BUNDLED_CLASS_DIR = path.join(STUDIO_DIR, 'jdbc-bridge', 'classes');
const JDBC_BRIDGE_CLASS_DIR = path.join(os.tmpdir(), 'data-vault-studio-jdbc-bridge-v0_1_2');
let jdbcBridgeCompiledMtime = 0;

const DB_PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DB_PACK_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DB_PACK_MAP_TARGETS = new Set(['host','port','database','schema','catalog','user','password']);
const DB_PACK_FIELD_TYPES = new Set(['text','password','number','select','checkbox']);
const DB_PACK_SEMANTIC_TYPES = new Set([
  'BOOLEAN','SMALL_INTEGER','INTEGER','BIG_INTEGER','DECIMAL','FLOAT','STRING','LARGE_TEXT',
  'DATE','TIME','TIMESTAMP','TIMESTAMP_TZ','BINARY','BINARY_LARGE','UUID','JSON','XML','ARRAY','COMPLEX','UNKNOWN'
]);
const JDBC_SEMANTIC_DEFAULTS = {
  BOOLEAN:'BOOLEAN', BIT:'BOOLEAN', TINYINT:'SMALL_INTEGER', SMALLINT:'SMALL_INTEGER', INTEGER:'INTEGER', BIGINT:'BIG_INTEGER',
  NUMERIC:'DECIMAL', DECIMAL:'DECIMAL', REAL:'FLOAT', FLOAT:'FLOAT', DOUBLE:'FLOAT',
  CHAR:'STRING', NCHAR:'STRING', VARCHAR:'STRING', NVARCHAR:'STRING', LONGVARCHAR:'LARGE_TEXT', LONGNVARCHAR:'LARGE_TEXT',
  CLOB:'LARGE_TEXT', NCLOB:'LARGE_TEXT', DATE:'DATE', TIME:'TIME', TIME_WITH_TIMEZONE:'TIME',
  TIMESTAMP:'TIMESTAMP', TIMESTAMP_WITH_TIMEZONE:'TIMESTAMP_TZ', BINARY:'BINARY', VARBINARY:'BINARY', LONGVARBINARY:'BINARY_LARGE', BLOB:'BINARY_LARGE',
  SQLXML:'XML', ARRAY:'ARRAY', ROWID:'STRING', OTHER:'UNKNOWN', JAVA_OBJECT:'UNKNOWN', DISTINCT:'UNKNOWN', STRUCT:'COMPLEX', REF:'UNKNOWN', REF_CURSOR:'UNKNOWN'
};
const JDBC_TYPE_CODE_NAMES = {
  '-16':'LONGNVARCHAR','-15':'NCHAR','-9':'NVARCHAR','-8':'ROWID','-7':'BIT','-6':'TINYINT','-5':'BIGINT','-4':'LONGVARBINARY','-3':'VARBINARY','-2':'BINARY','-1':'LONGVARCHAR',
  '1':'CHAR','2':'NUMERIC','3':'DECIMAL','4':'INTEGER','5':'SMALLINT','6':'FLOAT','7':'REAL','8':'DOUBLE','12':'VARCHAR','16':'BOOLEAN',
  '91':'DATE','92':'TIME','93':'TIMESTAMP','1111':'OTHER','2000':'JAVA_OBJECT','2001':'DISTINCT','2002':'STRUCT','2003':'ARRAY','2004':'BLOB','2005':'CLOB','2006':'REF','2009':'SQLXML','2011':'NCLOB','2012':'REF_CURSOR','2013':'TIME_WITH_TIMEZONE','2014':'TIMESTAMP_WITH_TIMEZONE'
};

function isPackDialect(value){ return /^pack:[a-z0-9][a-z0-9._-]{0,63}$/.test(String(value||'').toLowerCase()); }
function packIdFromDialect(value){ return isPackDialect(value) ? String(value).toLowerCase().slice(5) : ''; }
let databasePackMigrationChecked=false;
function copyPackFilesMissing(source){
  if(!fs.existsSync(source)) return;
  for(const entry of fs.readdirSync(source,{withFileTypes:true})){
    if(!entry.isFile()||!entry.name.toLowerCase().endsWith('.json')) continue;
    const target=path.join(DATABASE_PACK_DIR,entry.name);
    if(!fs.existsSync(target)) fs.copyFileSync(path.join(source,entry.name),target);
  }
}
function migrateLegacyDatabasePacks(){
  if(databasePackMigrationChecked) return;
  databasePackMigrationChecked=true;
  // Copy only missing manifests. Existing files directly in the Studio folder
  // always win because that folder is the source of truth.
  copyPackFilesMissing(PREVIEW_DATABASE_PACK_DIR);
  if(path.resolve(LEGACY_DATABASE_PACK_DIR)!==path.resolve(DATABASE_PACK_DIR)) copyPackFilesMissing(LEGACY_DATABASE_PACK_DIR);
}
function ensureDatabasePackDir(){
  fs.mkdirSync(DATABASE_PACK_DIR,{recursive:true});
  migrateLegacyDatabasePacks();
}
function validatePackId(id){
  const key=String(id||'').toLowerCase();
  if(!DB_PACK_ID_RE.test(key)) throw new Error('Database Pack id must contain only lowercase letters, numbers, dot, dash, or underscore.');
  return key;
}
function canonicalPackPath(id){
  const key=validatePackId(id); ensureDatabasePackDir();
  return path.join(DATABASE_PACK_DIR, `${key}.json`);
}
function findDatabasePackFile(id){
  const key=validatePackId(id); ensureDatabasePackDir();
  const canonical=path.join(DATABASE_PACK_DIR, `${key}.json`);
  if(fs.existsSync(canonical)) return canonical;
  for(const entry of fs.readdirSync(DATABASE_PACK_DIR,{withFileTypes:true}).filter(e=>e.isFile()&&e.name.toLowerCase().endsWith('.json')).sort((a,b)=>a.name.localeCompare(b.name))){
    const file=path.join(DATABASE_PACK_DIR,entry.name);
    try{
      const raw=JSON.parse(fs.readFileSync(file,'utf8'));
      if(String(raw&&raw.id||'').trim().toLowerCase()===key) return file;
    }catch(_){ /* invalid files are surfaced by listDatabasePacks() */ }
  }
  return canonical;
}
function cleanPackManifest(input){
  const pack=JSON.parse(JSON.stringify(input||{}));
  pack.schemaVersion=Number(pack.schemaVersion||DATABASE_PACK_SCHEMA_VERSION);
  pack.featureVersion=String(pack.featureVersion||DATABASE_PACK_FEATURE_VERSION);
  pack.id=String(pack.id||'').trim().toLowerCase();
  pack.label=String(pack.label||pack.id||'').trim();
  pack.version=String(pack.version||'1.0.0').trim();
  pack.connectionFields=Array.isArray(pack.connectionFields)?pack.connectionFields:[];
  pack.namespace=pack.namespace&&typeof pack.namespace==='object'?pack.namespace:{};
  pack.jdbc=pack.jdbc&&typeof pack.jdbc==='object'?pack.jdbc:{};
  pack.source=pack.source&&typeof pack.source==='object'?pack.source:{};
  pack.target=pack.target&&typeof pack.target==='object'?pack.target:{};
  pack.fdw=pack.fdw&&typeof pack.fdw==='object'?pack.fdw:{};
  pack.hop=pack.hop&&typeof pack.hop==='object'?pack.hop:{};
  pack.capabilities=pack.capabilities&&typeof pack.capabilities==='object'?pack.capabilities:{};
  return pack;
}
function packUrlTokens(template){ return [...String(template||'').matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m=>m[1]); }
function titlePackField(key){
  const special={host:'Host',port:'Port',database:'Database',schema:'Schema',catalog:'Catalog',user:'Username',password:'Password',account:'Account',warehouse:'Warehouse',role:'Role',httpPath:'HTTP path',serverHostname:'Server hostname',token:'Token'};
  return special[key]||String(key).replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
}
function derivePackConnectionFields(pack){
  if(pack.connectionFields.length) return pack.connectionFields;
  const tokens=[...new Set(packUrlTokens(pack.jdbc.urlTemplate))];
  const fields=tokens.map(key=>{
    const mapsTo=DB_PACK_MAP_TARGETS.has(key)?key:undefined;
    const field={key,label:titlePackField(key),type:key==='port'?'number':'text',required:!['schema','catalog'].includes(key)};
    if(mapsTo) field.mapsTo=mapsTo;
    if(key==='port'&&pack.jdbc.defaultPort!=null) field.default=String(pack.jdbc.defaultPort);
    if(key==='schema'&&pack.namespace.defaultSchema!=null) field.default=String(pack.namespace.defaultSchema);
    if(key==='catalog'&&pack.namespace.defaultCatalog!=null) field.default=String(pack.namespace.defaultCatalog);
    return field;
  });
  const hasMapped=mapsTo=>fields.some(field=>field.mapsTo===mapsTo||field.key===mapsTo);
  // Normal databases should not have to spell out the standard connection form.
  // Schema is available by default for Pack connections because source users must
  // be able to scope metadata to a specific schema. A Pack can explicitly opt out
  // with namespace.usesSchema=false for database models without a schema namespace.
  if((pack.namespace.usesCatalog===true||pack.namespace.defaultCatalog!=null)&&!hasMapped('catalog')){
    fields.push({key:'catalog',label:String(pack.namespace.catalogLabel||'Catalog'),type:'text',required:pack.namespace.usesCatalog===true,default:pack.namespace.defaultCatalog!=null?String(pack.namespace.defaultCatalog):'',mapsTo:'catalog'});
  }
  if(pack.namespace.usesSchema!==false&&!hasMapped('schema')){
    fields.push({key:'schema',label:String(pack.namespace.schemaLabel||'Schema'),type:'text',required:false,default:pack.namespace.defaultSchema!=null?String(pack.namespace.defaultSchema):'',mapsTo:'schema'});
  }
  if(!hasMapped('user')) fields.push({key:'user',label:'Username',type:'text',required:true,mapsTo:'user'});
  if(!hasMapped('password')) fields.push({key:'password',label:'Password',type:'password',required:true,mapsTo:'password'});
  return fields;
}
function validateDatabasePackManifest(input){
  const pack=cleanPackManifest(input);
  if(pack.schemaVersion!==DATABASE_PACK_SCHEMA_VERSION) throw new Error(`Unsupported Database Pack schemaVersion ${pack.schemaVersion}; expected ${DATABASE_PACK_SCHEMA_VERSION}.`);
  if(!DB_PACK_ID_RE.test(pack.id)) throw new Error('Database Pack id is required and must use lowercase letters, numbers, dot, dash, or underscore.');
  if(!pack.label) throw new Error('Database Pack label is required.');
  if(!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pack.version)) throw new Error('Database Pack version must be semantic versioning such as 1.0.0.');
  if(!pack.jdbc.driverClass || !pack.jdbc.urlTemplate || (!pack.jdbc.jarfile&&!pack.jdbc.jarPattern)) throw new Error('jdbc.driverClass, jdbc.urlTemplate, and either jdbc.jarfile or jdbc.jarPattern are required.');
  if(pack.jdbc.jarfile){
    const jar=path.posix.basename(String(pack.jdbc.jarfile).replace(/\\/g,'/'));
    if(!jar.toLowerCase().endsWith('.jar') || jar.includes('..')) throw new Error('jdbc.jarfile must be a plain .jar filename or /opt/jdbc-drivers/<file>.jar path.');
    pack.jdbc.jarfile=jar;
  }
  if(pack.jdbc.jarPattern){
    const pattern=path.posix.basename(String(pack.jdbc.jarPattern).replace(/\\/g,'/'));
    if(pattern!==String(pack.jdbc.jarPattern).replace(/\\/g,'/') || !pattern.toLowerCase().endsWith('.jar') || pattern.includes('..') || !/^[A-Za-z0-9._+?*\-]+$/.test(pattern)) throw new Error('jdbc.jarPattern must be a plain .jar filename pattern using only * or ? wildcards.');
    pack.jdbc.jarPattern=pattern;
  }
  pack.connectionFields=derivePackConnectionFields(pack);
  const seen=new Set();
  for(const field of pack.connectionFields){
    field.key=String(field.key||'').trim(); field.label=String(field.label||field.key).trim(); field.type=String(field.type||'text').toLowerCase();
    if(!DB_PACK_FIELD_RE.test(field.key)) throw new Error(`Invalid connection field key: ${field.key}`);
    if(seen.has(field.key)) throw new Error(`Duplicate connection field key: ${field.key}`); seen.add(field.key);
    if(!DB_PACK_FIELD_TYPES.has(field.type)) throw new Error(`Unsupported connection field type for ${field.key}: ${field.type}`);
    if(field.mapsTo && !DB_PACK_MAP_TARGETS.has(String(field.mapsTo))) throw new Error(`Unsupported mapsTo value for ${field.key}: ${field.mapsTo}`);
    if(field.type==='select' && (!Array.isArray(field.options)||!field.options.length)) throw new Error(`Select field ${field.key} requires options.`);
  }
  for(const token of packUrlTokens(pack.jdbc.urlTemplate)) if(!seen.has(token)) throw new Error(`JDBC URL template references unknown field {${token}}.`);
  pack.source.enabled=pack.source.enabled!==false;
  pack.source.nativeTypeOverrides=pack.source.nativeTypeOverrides&&typeof pack.source.nativeTypeOverrides==='object'?pack.source.nativeTypeOverrides:{};
  for(const [native,semantic] of Object.entries(pack.source.nativeTypeOverrides)){
    if(!DB_PACK_SEMANTIC_TYPES.has(String(semantic).toUpperCase())) throw new Error(`Unknown semantic type ${semantic} for native type ${native}.`);
    pack.source.nativeTypeOverrides[native]=String(semantic).toUpperCase();
  }
  // Legacy target/FDW flags are still normalized for compatibility with
  // existing Packs. In the dynamic-target workflow they are advisory metadata,
  // not an allowlist: actual target capability is discovered from JDBC and
  // verified by deployment preflight against the selected server.
  pack.target.enabled=pack.target.enabled===true;
  pack.target.types=pack.target.types&&typeof pack.target.types==='object'?pack.target.types:{};
  for(const semantic of Object.keys(pack.target.types)) if(!DB_PACK_SEMANTIC_TYPES.has(String(semantic).toUpperCase())) throw new Error(`Unknown target semantic type ${semantic}.`);
  pack.fdw.enabled=pack.fdw.enabled===true;
  pack.fdw.read=pack.fdw.read===true;
  pack.fdw.insert=pack.fdw.insert===true;
  pack.fdw.update=pack.fdw.update===true;
  pack.fdw.delete=pack.fdw.delete===true;
  pack.fdw.certified=pack.fdw.certified===true;
  pack.hop.enabled=pack.hop.enabled!==false;
  if(pack.hop.pluginId) pack.hop.pluginId=String(pack.hop.pluginId);
  if(pack.hop.pluginName) pack.hop.pluginName=String(pack.hop.pluginName);
  return pack;
}
function globRegex(pattern){ return new RegExp('^'+String(pattern).replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$','i'); }
function findPackJdbcDriver(pack){
  const exact=pack.jdbc&&pack.jdbc.jarfile?path.posix.basename(pack.jdbc.jarfile):'';
  if(exact){ const file=path.join(JDBC_DRIVER_PATH,exact); return {exists:fs.existsSync(file),filename:exact,path:file}; }
  const pattern=String(pack.jdbc&&pack.jdbc.jarPattern||'');
  if(!pattern) return {exists:false,filename:'',path:''};
  if(!fs.existsSync(JDBC_DRIVER_PATH)) return {exists:false,filename:'',path:''};
  const matcher=globRegex(pattern);
  const filename=fs.readdirSync(JDBC_DRIVER_PATH).filter(name=>matcher.test(name)&&name.toLowerCase().endsWith('.jar')).sort().reverse()[0]||'';
  return {exists:!!filename,filename,path:filename?path.join(JDBC_DRIVER_PATH,filename):''};
}
function loadHopDatabaseTypes(){
  try{
    const data=JSON.parse(fs.readFileSync(HOP_DATABASE_TYPES_PATH,'utf8'));
    if(!data||!Array.isArray(data.databaseTypes)) throw new Error('databaseTypes array is missing.');
    return data;
  }catch(err){ return {catalogVersion:'1',databaseTypes:[],generic:{pluginId:'GENERIC',pluginName:'Generic database'},error:err.message}; }
}
function listDatabasePacks(){
  ensureDatabasePackDir();
  const packs=new Map(), invalid=[];
  const entries=fs.readdirSync(DATABASE_PACK_DIR,{withFileTypes:true})
    .filter(e=>e.isFile()&&e.name.toLowerCase().endsWith('.json'))
    .sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries){
    const file=path.join(DATABASE_PACK_DIR,entry.name);
    try{
      const pack=validateDatabasePackManifest(JSON.parse(fs.readFileSync(file,'utf8')));
      const canonicalName=`${pack.id}.json`;
      // One database type per manifest id. If both a versioned/manual filename
      // and canonical <id>.json exist, the canonical file is authoritative.
      if(!packs.has(pack.id)||entry.name===canonicalName) packs.set(pack.id,pack);
    }catch(err){ invalid.push({id:entry.name.replace(/\.json$/i,''),label:entry.name,error:err.message,invalid:true}); }
  }
  return [...packs.values(),...invalid].sort((a,b)=>String(a.label||a.id).localeCompare(String(b.label||b.id)));
}
function getDatabasePack(idOrDialect){
  const id=isPackDialect(idOrDialect)?packIdFromDialect(idOrDialect):String(idOrDialect||'').toLowerCase();
  const file=findDatabasePackFile(id);
  if(!fs.existsSync(file)) throw new Error(`Database Pack "${id}" is not installed.`);
  return validateDatabasePackManifest(JSON.parse(fs.readFileSync(file,'utf8')));
}
function getDatabasePackForDialect(value){
  const dialect=String(value||'').toLowerCase();
  if(isPackDialect(dialect)) return getDatabasePack(dialect);
  const bundledId=dialect==='mysql'?'mysql':((dialect==='postgresql'||dialect==='postgres')?'postgresql':'');
  if(!bundledId) return null;
  try{return getDatabasePack(bundledId);}catch(_){return null;}
}
function databasePackManifestForStorage(input,pack){
  // Keep the on-disk authoring format small. validateDatabasePackManifest()
  // expands standard connection fields and safe runtime defaults in memory,
  // but those inferred values do not belong in a hand-authored/custom Pack.
  const raw=JSON.parse(JSON.stringify(input||{}));
  raw.schemaVersion=pack.schemaVersion;
  raw.id=pack.id; raw.label=pack.label; raw.version=pack.version;
  raw.jdbc=raw.jdbc&&typeof raw.jdbc==='object'?raw.jdbc:{};
  raw.jdbc.driverClass=pack.jdbc.driverClass; raw.jdbc.urlTemplate=pack.jdbc.urlTemplate;
  if(pack.jdbc.jarfile){ raw.jdbc.jarfile=pack.jdbc.jarfile; delete raw.jdbc.jarPattern; }
  else if(pack.jdbc.jarPattern){ raw.jdbc.jarPattern=pack.jdbc.jarPattern; delete raw.jdbc.jarfile; }
  return raw;
}
function writeDatabasePack(input){
  const pack=validateDatabasePackManifest(input);
  const stored=databasePackManifestForStorage(input,pack);
  const existing=findDatabasePackFile(pack.id);
  const file=fs.existsSync(existing)?existing:canonicalPackPath(pack.id);
  fs.writeFileSync(file,JSON.stringify(stored,null,2)+'\n','utf8'); return pack;
}
function removeDatabasePack(id){
  const pack=getDatabasePack(id); const file=findDatabasePackFile(pack.id); fs.unlinkSync(file); return pack;
}
function packManualUrl(body){
  // Mirrors Hop's "Manual connection URL" field: when present it overrides the
  // assembled connection string. Credentials still come from the structured
  // user/password fields, exactly as Hop passes them as JDBC Properties.
  const raw=body&&(body.manualUrl!=null?body.manualUrl:(body.jdbcUrl!=null?body.jdbcUrl:undefined));
  const text=raw==null?'':String(raw).trim();
  return text||'';
}
function resolvePackConnectionValues(pack, body){
  const incoming=(body&&body.packValues&&typeof body.packValues==='object')?body.packValues:{};
  const manualUrl=packManualUrl(body);
  const values={};
  for(const field of pack.connectionFields){
    let value=Object.prototype.hasOwnProperty.call(incoming,field.key)?incoming[field.key]:undefined;
    if((value===undefined||value===null||value==='')&&field.mapsTo&&body&&body[field.mapsTo]!=null) value=body[field.mapsTo];
    if((value===undefined||value===null||value==='')&&field.default!=null) value=field.default;
    // With a manual URL, the connection string is user-supplied verbatim, so
    // host/port/database/etc. are not required. Credentials (user/password)
    // remain required because Hop always sends them separately.
    const isCredential=field.mapsTo==='user'||field.mapsTo==='password';
    const enforce=field.required && (!manualUrl || isCredential);
    if(enforce && (value===undefined||value===null||String(value)==='')) throw new Error(`${field.label||field.key} is required for ${pack.label}.`);
    values[field.key]=value==null?'':String(value);
    if(field.mapsTo && !Object.prototype.hasOwnProperty.call(values,field.mapsTo)) values[field.mapsTo]=values[field.key];
  }
  for(const key of ['host','port','database','schema','catalog','user']) if(values[key]==null&&body&&body[key]!=null) values[key]=String(body[key]);
  return values;
}
function renderDatabasePackJdbcUrl(pack, body){
  const manualUrl=packManualUrl(body);
  if(manualUrl) return manualUrl; // Hop: manual connection URL is used as-is.
  const values=resolvePackConnectionValues(pack,body);
  return String(pack.jdbc.urlTemplate).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(m,key)=>{
    if(values[key]==null) throw new Error(`No value supplied for JDBC URL field ${key}.`);
    return String(values[key]);
  });
}
function packJdbcOptions(body){
  // Hop's "Options" tab: a list of key/value pairs applied to the JDBC driver.
  // Hop applies these as connection Properties (its default; correct even for
  // databases like Oracle that do not accept options in the URL). Accepts either
  // an object map { key: value } or an array of { key, value } entries.
  const raw=body&&body.options;
  const out={};
  if(Array.isArray(raw)){
    for(const entry of raw){
      if(!entry) continue;
      const k=String(entry.key!=null?entry.key:'').trim();
      if(k) out[k]=entry.value==null?'':String(entry.value);
    }
  } else if(raw && typeof raw==='object'){
    for(const [k,v] of Object.entries(raw)){
      const key=String(k).trim();
      if(key) out[key]=v==null?'':String(v);
    }
  }
  return out;
}
function databasePackCredentials(pack,body){
  const values=resolvePackConnectionValues(pack,body);
  let user=String((body&&body.user)||values.user||'');
  let password=String((body&&body.password)||values.password||'');
  for(const field of pack.connectionFields){
    if(field.mapsTo==='user'&&values[field.key]!=null) user=String(values[field.key]);
    if(field.mapsTo==='password'){
      const incoming=body&&body.packValues&&body.packValues[field.key];
      if(incoming!=null) password=String(incoming);
    }
  }
  return {user,password};
}
function semanticTypeForJdbc(pack, column){
  const native=String(column.nativeType||'').toUpperCase().trim();
  const overrides=pack.source.nativeTypeOverrides||{};
  for(const [key,val] of Object.entries(overrides)) if(native===String(key).toUpperCase()) return String(val).toUpperCase();
  if(/JSON|VARIANT|SUPER/.test(native)) return 'JSON';
  if(/UUID|UNIQUEIDENTIFIER/.test(native)) return 'UUID';
  if(/XML/.test(native)) return 'XML';
  if(/GEOGRAPH|GEOMET|STRUCT|OBJECT|MAP/.test(native)) return 'COMPLEX';
  const jdbcRaw=String(column.jdbcType||'').toUpperCase();
  const jdbcName=JDBC_TYPE_CODE_NAMES[jdbcRaw]||jdbcRaw;
  return JDBC_SEMANTIC_DEFAULTS[jdbcName]||'UNKNOWN';
}
function studioTypeForSemantic(semantic,column){
  const p=Number(column&&column.precision||0), s=Number(column&&column.scale||0), len=Number(column&&column.length||0);
  switch(String(semantic||'UNKNOWN')){
    case 'BOOLEAN': return 'boolean'; case 'SMALL_INTEGER': return 'smallint'; case 'INTEGER': return 'integer'; case 'BIG_INTEGER': return 'bigint';
    case 'DECIMAL': return p?`numeric(${p}${s?','+s:''})`:'numeric'; case 'FLOAT': return 'double precision';
    case 'STRING': return len>0&&len<10485760?`varchar(${len})`:'text'; case 'LARGE_TEXT': return 'text'; case 'DATE': return 'date'; case 'TIME': return 'time';
    case 'TIMESTAMP': return 'timestamp'; case 'TIMESTAMP_TZ': return 'timestamptz'; case 'BINARY': case 'BINARY_LARGE': return 'bytea';
    case 'UUID': return 'uuid'; case 'JSON': return 'jsonb'; case 'XML': return 'text'; case 'ARRAY': case 'COMPLEX': case 'UNKNOWN': default: return 'text';
  }
}
function applyPackSemanticTypes(pack,data){
  for(const table of data.tables||[]) for(const c of table.columns||[]){
    c.semanticType=semanticTypeForJdbc(pack,c); c.type=studioTypeForSemantic(c.semanticType,c); c.typeReviewRequired=['UNKNOWN','COMPLEX','ARRAY'].includes(c.semanticType);
  }
  for(const fk of data.foreignKeys||[]) if(!fk.provenance) fk.provenance='declared';
  return data;
}

// Hop exposes "Supports the Timestamp data type" and "Supports the Boolean
// data type" as connection-level switches. Do not leave these at whichever
// plugin default happens to ship with the installed Hop version: for Database
// Packs derive them from the connected JDBC driver's standard type metadata.
// Pack hop.attributes remain the final override in the browser for genuinely
// exceptional drivers.
function sourceHopCapabilitiesFromJdbcAnalysis(pack, analysis){
  const types=(analysis&&Array.isArray(analysis.types)?analysis.types:[]).map(t=>({
    ...t,
    semanticType:String(t.semanticType||semanticTypeForJdbc(pack,t)||'UNKNOWN').toUpperCase(),
  }));
  const semanticSet=new Set(types.map(t=>t.semanticType));
  return {
    supportsTimestamp: semanticSet.has('TIMESTAMP') || semanticSet.has('TIMESTAMP_TZ'),
    supportsBoolean: semanticSet.has('BOOLEAN'),
    basis:'jdbc-type-info',
  };
}
function sourceHopCapabilitiesFromTables(tables){
  let supportsTimestamp=false, supportsBoolean=false;
  for(const table of tables||[]) for(const column of table.columns||[]){
    const semantic=String(column.semanticType||'').toUpperCase();
    const type=String(column.nativeType||column.type||'').toLowerCase();
    if(['TIMESTAMP','TIMESTAMP_TZ'].includes(semantic) || /(^|\W)(timestamp|datetime|smalldatetime)(\W|$)/.test(type)) supportsTimestamp=true;
    if(semantic==='BOOLEAN' || /(^|\W)(boolean|bool)(\W|$)/.test(type)) supportsBoolean=true;
  }
  return {supportsTimestamp,supportsBoolean,basis:'introspected-columns'};
}
function sourceHopCapabilitiesFromHopCatalog(dialect){
  const wanted=String(dialect||'').toLowerCase();
  const catalog=loadHopDatabaseTypes();
  const entry=(catalog&&catalog.databaseTypes||[]).find(e=>(e.studioDialects||[]).map(v=>String(v).toLowerCase()).includes(wanted));
  const attrs=entry&&entry.connectionDefaults&&entry.connectionDefaults.attributes||{};
  const flag=(name)=>String(attrs[name]||'').toUpperCase()==='Y';
  return {supportsTimestamp:flag('SUPPORTS_TIMESTAMP_DATA_TYPE'),supportsBoolean:flag('SUPPORTS_BOOLEAN_DATA_TYPE'),basis:'hop-catalog-default'};
}

// Target profiles are discovered from the connected JDBC driver's
// DatabaseMetaData rather than being hard-coded into Database Packs. Packs
// remain an exception layer: target.types and target.identifierQuote override
// these discovered values in the browser when present.
function analysisValue(analysis,...keys){
  for(const key of keys){
    const parts=String(key).split('.'); let value=analysis;
    for(const part of parts){ value=value&&typeof value==='object'?value[part]:undefined; }
    if(value!=null&&String(value).trim()!=='') return value;
  }
  return '';
}
function analysisRawValue(analysis,...keys){
  for(const key of keys){
    const parts=String(key).split('.'); let value=analysis;
    for(const part of parts){ value=value&&typeof value==='object'?value[part]:undefined; }
    if(value!=null) return value;
  }
  return undefined;
}
function jdbcTargetTypeName(typeInfo){
  return String(typeInfo&&(
    typeInfo.nativeType||typeInfo.typeName||typeInfo.name||typeInfo.TYPE_NAME||typeInfo.dataTypeName
  )||'').trim();
}
function jdbcTargetCreateParams(typeInfo){
  return String(typeInfo&&(
    typeInfo.createParams||typeInfo.createParameters||typeInfo.CREATE_PARAMS||''
  )||'').toLowerCase();
}
function jdbcTargetTypeTemplate(typeInfo,semantic){
  const name=jdbcTargetTypeName(typeInfo);
  if(!name) return '';
  const params=jdbcTargetCreateParams(typeInfo);
  const upper=name.toUpperCase();
  const wantsLength=['STRING','BINARY'].includes(semantic);
  const wantsPrecision=semantic==='DECIMAL';
  // JDBC getTypeInfo exposes CREATE_PARAMS where the vendor accepts type
  // parameters. Fall back to well-known variable-width families when older
  // drivers omit CREATE_PARAMS.
  const parameterisedLength=/length|size|max length/.test(params)||/(CHAR|BINARY|RAW|VARBIT|BIT VARYING)/.test(upper);
  const parameterisedPrecision=/precision|scale/.test(params)||/(DECIMAL|NUMERIC|NUMBER)/.test(upper);
  if(wantsPrecision&&parameterisedPrecision) return `${name}({precision},{scale})`;
  if(wantsLength&&parameterisedLength&&!/(TEXT|CLOB|BLOB|BYTEA|IMAGE|LONG)/.test(upper)) return `${name}({length})`;
  return name;
}
const JDBC_TARGET_NAME_PREFERENCES={
  BOOLEAN:['BOOLEAN','BOOL','BIT'],
  SMALL_INTEGER:['SMALLINT','TINYINT','INT2'],
  INTEGER:['INTEGER','INT','INT4'],
  BIG_INTEGER:['BIGINT','INT8','LONG'],
  DECIMAL:['DECIMAL','NUMERIC','NUMBER'],
  FLOAT:['DOUBLE','DOUBLE PRECISION','FLOAT','REAL'],
  STRING:['VARCHAR','NVARCHAR','VARCHAR2','CHARACTER VARYING','CHAR','NCHAR'],
  LARGE_TEXT:['TEXT','CLOB','NCLOB','LONGVARCHAR','LONGNVARCHAR','LONGTEXT','NTEXT'],
  DATE:['DATE'],
  TIME:['TIME'],
  TIMESTAMP:['TIMESTAMP','DATETIME2','DATETIME'],
  TIMESTAMP_TZ:['TIMESTAMP WITH TIME ZONE','TIMESTAMPTZ','TIMESTAMP_TZ','DATETIMEOFFSET'],
  BINARY:['VARBINARY','BINARY VARYING','RAW','BYTEA','BINARY'],
  BINARY_LARGE:['BLOB','BYTEA','LONGVARBINARY','IMAGE','LONGBLOB'],
  UUID:['UUID','UNIQUEIDENTIFIER'],
  JSON:['JSON','JSONB','VARIANT'],
  XML:['XML','SQLXML'],
};
function jdbcTargetCandidateScore(semantic,typeInfo){
  const actual=String(typeInfo&&typeInfo.semanticType||semanticTypeForJdbc({source:{nativeTypeOverrides:{}}},typeInfo)||'UNKNOWN').toUpperCase();
  if(actual!==semantic) return -10000;
  const name=jdbcTargetTypeName(typeInfo).toUpperCase();
  const prefs=JDBC_TARGET_NAME_PREFERENCES[semantic]||[];
  let score=1000;
  const exact=prefs.indexOf(name); if(exact>=0) score+=400-exact*10;
  else {
    const partial=prefs.findIndex(pref=>name.includes(pref)||pref.includes(name));
    if(partial>=0) score+=250-partial*5;
  }
  if(typeInfo&&typeInfo.autoIncrement===true) score-=100;
  if(typeInfo&&typeInfo.unsigned===true&&['SMALL_INTEGER','INTEGER','BIG_INTEGER'].includes(semantic)) score-=25;
  const precision=Number(typeInfo&&typeInfo.precision||0); if(precision>0) score+=Math.min(precision,100)/100;
  return score;
}
function resolveJdbcTargetProfile(pack,analysis){
  const discovered=(analysis&&Array.isArray(analysis.types)?analysis.types:[]).map(typeInfo=>({
    ...typeInfo,
    semanticType:String(typeInfo.semanticType||semanticTypeForJdbc(pack,typeInfo)||'UNKNOWN').toUpperCase(),
  }));
  const semantics=[...DB_PACK_SEMANTIC_TYPES].filter(s=>!['ARRAY','COMPLEX','UNKNOWN'].includes(s));
  const resolvedTypes={};
  const resolvedFrom={};
  for(const semantic of semantics){
    const ranked=discovered
      .map(typeInfo=>({typeInfo,score:jdbcTargetCandidateScore(semantic,typeInfo)}))
      .filter(x=>x.score>-10000)
      .sort((a,b)=>b.score-a.score);
    if(!ranked.length) continue;
    const template=jdbcTargetTypeTemplate(ranked[0].typeInfo,semantic);
    if(template){ resolvedTypes[semantic]=template; resolvedFrom[semantic]=jdbcTargetTypeName(ranked[0].typeInfo); }
  }
  // Prefer lossless/wider representations when the target exposes a smaller
  // semantic vocabulary. This is particularly important for databases such as
  // Oracle that commonly report NUMBER rather than separate JDBC integer types.
  const decimalInfo=discovered
    .map(typeInfo=>({typeInfo,score:jdbcTargetCandidateScore('DECIMAL',typeInfo)}))
    .filter(x=>x.score>-10000).sort((a,b)=>b.score-a.score)[0]?.typeInfo;
  if(decimalInfo){
    const name=jdbcTargetTypeName(decimalInfo); const params=jdbcTargetCreateParams(decimalInfo);
    const numeric=(precision)=>/precision|scale/.test(params)||/(DECIMAL|NUMERIC|NUMBER)/i.test(name)?`${name}(${precision},0)`:name;
    if(!resolvedTypes.SMALL_INTEGER){resolvedTypes.SMALL_INTEGER=numeric(5);resolvedFrom.SMALL_INTEGER=`${name} (numeric fallback)`;}
    if(!resolvedTypes.INTEGER){resolvedTypes.INTEGER=numeric(10);resolvedFrom.INTEGER=`${name} (numeric fallback)`;}
    if(!resolvedTypes.BIG_INTEGER){resolvedTypes.BIG_INTEGER=numeric(19);resolvedFrom.BIG_INTEGER=`${name} (numeric fallback)`;}
    if(!resolvedTypes.BOOLEAN){resolvedTypes.BOOLEAN=numeric(1);resolvedFrom.BOOLEAN=`${name} (numeric fallback)`;}
  }
  if(!resolvedTypes.BINARY&&resolvedTypes.BINARY_LARGE){resolvedTypes.BINARY=resolvedTypes.BINARY_LARGE;resolvedFrom.BINARY=`${resolvedFrom.BINARY_LARGE||resolvedTypes.BINARY_LARGE} (wide fallback)`;}
  if(!resolvedTypes.BINARY_LARGE&&resolvedTypes.BINARY){
    const binaryInfo=discovered.map(typeInfo=>({typeInfo,score:jdbcTargetCandidateScore('BINARY',typeInfo)})).filter(x=>x.score>-10000).sort((a,b)=>b.score-a.score)[0]?.typeInfo;
    const template=binaryInfo&&jdbcTargetTypeTemplate(binaryInfo,'BINARY');
    const max=Number(binaryInfo&&binaryInfo.precision||0);
    if(template){resolvedTypes.BINARY_LARGE=template.includes('{length}')&&max>0?template.replace('{length}',String(max)):template;resolvedFrom.BINARY_LARGE=`${jdbcTargetTypeName(binaryInfo)} (maximum binary fallback)`;}
  }
  if(!resolvedTypes.STRING&&resolvedTypes.LARGE_TEXT){resolvedTypes.STRING=resolvedTypes.LARGE_TEXT;resolvedFrom.STRING=`${resolvedFrom.LARGE_TEXT||resolvedTypes.LARGE_TEXT} (wide fallback)`;}
  if(!resolvedTypes.LARGE_TEXT&&resolvedTypes.STRING){
    const stringInfo=discovered.map(typeInfo=>({typeInfo,score:jdbcTargetCandidateScore('STRING',typeInfo)})).filter(x=>x.score>-10000).sort((a,b)=>b.score-a.score)[0]?.typeInfo;
    const template=stringInfo&&jdbcTargetTypeTemplate(stringInfo,'STRING');
    const max=Number(stringInfo&&stringInfo.precision||0);
    if(template){resolvedTypes.LARGE_TEXT=template.includes('{length}')&&max>0?template.replace('{length}',String(max)):template;resolvedFrom.LARGE_TEXT=`${jdbcTargetTypeName(stringInfo)} (maximum string fallback)`;}
  }
  if(!resolvedTypes.UUID&&resolvedTypes.STRING){resolvedTypes.UUID=resolvedTypes.STRING;resolvedFrom.UUID=`${resolvedFrom.STRING||resolvedTypes.STRING} (string fallback)`;}
  if(!resolvedTypes.JSON&&resolvedTypes.LARGE_TEXT){resolvedTypes.JSON=resolvedTypes.LARGE_TEXT;resolvedFrom.JSON=`${resolvedFrom.LARGE_TEXT||resolvedTypes.LARGE_TEXT} (text fallback)`;}
  if(!resolvedTypes.XML&&resolvedTypes.LARGE_TEXT){resolvedTypes.XML=resolvedTypes.LARGE_TEXT;resolvedFrom.XML=`${resolvedFrom.LARGE_TEXT||resolvedTypes.LARGE_TEXT} (text fallback)`;}
  const quoteValue=analysisRawValue(analysis,'identifierQuote','identifierQuoteString','metadata.identifierQuote','metadata.identifierQuoteString');
  const quoteRaw=quoteValue==null?'':String(quoteValue);
  // JDBC specifies a single space when the database does not support quoted
  // identifiers. Preserve that as an empty quote marker; only fall back to
  // ANSI double quotes when the bridge supplied no quote metadata at all.
  const quote=quoteRaw===' ' ? '' : (quoteRaw.trim() || '"');
  return {
    schemaVersion:1,
    packId:pack.id,
    packVersion:pack.version,
    databaseProduct:String(analysisValue(analysis,'databaseProduct','productName','databaseProductName','metadata.databaseProductName')||pack.label),
    databaseVersion:String(analysisValue(analysis,'databaseVersion','productVersion','databaseProductVersion','metadata.databaseProductVersion')||''),
    driverName:String(analysisValue(analysis,'driverName','metadata.driverName')||pack.jdbc.driverClass||''),
    driverVersion:String(analysisValue(analysis,'driverVersion','metadata.driverVersion')||''),
    currentCatalog:String(analysisValue(analysis,'currentCatalog','catalog','metadata.currentCatalog')||''),
    currentSchema:String(analysisValue(analysis,'currentSchema','schema','metadata.currentSchema')||''),
    identifierQuote:quote,
    resolvedTypes,
    resolvedFrom,
    discoveredTypeCount:discovered.length,
    discoveredAt:new Date().toISOString(),
  };
}
function spawnCapture(command,args,options={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:options.cwd||PROJECT_ROOT,stdio:['pipe','pipe','pipe'],env:{...process.env,...(options.env||{})}});
    const maxOutput=Number(options.maxOutputBytes||1048576);
    let stdout='',stderr='',settled=false,timer=null;
    const append=(current,data)=>{const next=current+data.toString();if(Buffer.byteLength(next)>maxOutput)throw new Error(`${command} produced too much output.`);return next;};
    const finish=(error,result)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);error?reject(error):resolve(result);};
    child.stdout.on('data',d=>{try{stdout=append(stdout,d);}catch(err){child.kill('SIGKILL');finish(err);}});
    child.stderr.on('data',d=>{try{stderr=append(stderr,d);}catch(err){child.kill('SIGKILL');finish(err);}});
    child.on('error',err=>finish(err));
    child.on('close',code=>code===0?finish(null,{stdout,stderr}):finish(new Error((stderr||stdout||`${command} exited ${code}`).trim())));
    child.stdin.on('error',err=>{if(err.code!=='EPIPE')finish(err);});
    const timeoutMs=Number(options.timeoutMs||0);
    timer=timeoutMs>0?setTimeout(()=>{child.kill('SIGKILL');finish(new Error(`${command} operation timed out.`));},timeoutMs):null;
    if(options.input!=null)child.stdin.end(String(options.input));else child.stdin.end();
  });
}
async function jdbcBridgeClassPath(){
  const bundled=path.join(JDBC_BRIDGE_BUNDLED_CLASS_DIR,'JdbcBridge.class');
  if(fs.existsSync(bundled)) return JDBC_BRIDGE_BUNDLED_CLASS_DIR;
  if(!fs.existsSync(JDBC_BRIDGE_SOURCE)) throw new Error(`JDBC bridge is missing. Expected ${bundled} or ${JDBC_BRIDGE_SOURCE}.`);
  // Development fallback only. Release packages ship a Java-11-compatible
  // precompiled class so normal users need java, not a JDK/javac install.
  const mtime=fs.statSync(JDBC_BRIDGE_SOURCE).mtimeMs;
  const classFile=path.join(JDBC_BRIDGE_CLASS_DIR,'JdbcBridge.class');
  if(!fs.existsSync(classFile)||jdbcBridgeCompiledMtime!==mtime){
    fs.rmSync(JDBC_BRIDGE_CLASS_DIR,{recursive:true,force:true}); fs.mkdirSync(JDBC_BRIDGE_CLASS_DIR,{recursive:true});
    await spawnCapture('javac',['--release','11','-d',JDBC_BRIDGE_CLASS_DIR,JDBC_BRIDGE_SOURCE],{cwd:STUDIO_DIR,timeoutMs:30000}); jdbcBridgeCompiledMtime=mtime;
  }
  return JDBC_BRIDGE_CLASS_DIR;
}
async function runJdbcBridge(pack,body,mode,payload=''){
  const bridgeClassPath=await jdbcBridgeClassPath();
  const driver=findPackJdbcDriver(pack);
  if(!driver.exists) throw new Error(`JDBC driver ${pack.jdbc.jarfile||pack.jdbc.jarPattern||''} is not present in ${JDBC_DRIVER_PATH}.`);
  const jar=driver.path;
  // JDBC drivers run on the Studio host for connection tests/introspection,
  // while Hop later runs inside Docker. Persist only portable dv-certs/...
  // references in project state and resolve them to host paths here. This is
  // generic: Studio does not need to know which JDBC option represents a CA,
  // key, wallet or keystore. The JDBC driver still owns existence/validity.
  const url=resolveHostCertificateReferences(renderDatabasePackJdbcUrl(pack,body),PROJECT_ROOT);
  const destination=effectiveJdbcDestination(pack,body,url);
  let validatedDestination=null;
  if(destination){
    const port=destination.port==null||destination.port===''?pack.jdbc.defaultPort:destination.port;
    validatedDestination=port==null
      ? await outboundConnectionPolicy.inspectHost(destination.host)
      : await outboundConnectionPolicy.validateNetworkDestination({host:destination.host,port,defaultPort:pack.jdbc.defaultPort});
  }
  const structuredDestination=structuredJdbcDestination(pack,body);
  if(structuredDestination){
    const port=structuredDestination.port==null||structuredDestination.port===''?pack.jdbc.defaultPort:structuredDestination.port;
    if(port==null)await outboundConnectionPolicy.inspectHost(structuredDestination.host);
    else await outboundConnectionPolicy.validateNetworkDestination({host:structuredDestination.host,port,defaultPort:pack.jdbc.defaultPort});
  }
  const creds=databasePackCredentials(pack,body);
  const jdbcOptions=packJdbcOptions(body);
  for(const key of Object.keys(jdbcOptions)) jdbcOptions[key]=resolveHostCertificateReferences(jdbcOptions[key],PROJECT_ROOT);
  const encode=value=>Buffer.from(String(value==null?'':value),'utf8').toString('base64');
  const connectTimeoutMs=Number(env.DVS_JDBC_CONNECT_TIMEOUT_MS||8000);
  if(!Number.isInteger(connectTimeoutMs)||connectTimeoutMs<1000||connectTimeoutMs>30000) throw new Error('DVS_JDBC_CONNECT_TIMEOUT_MS must be an integer from 1000 to 30000.');
  const bridgeHost=validatedDestination?validatedDestination.host:'';
  const bridgeAddresses=validatedDestination?validatedDestination.addresses.join(','):'';
  const bridgeInput=[url,creds.user,creds.password,String(payload||''),JSON.stringify(jdbcOptions),bridgeHost,bridgeAddresses].map(encode).join('\n')+'\n';
  const operationTimeoutMs=mode==='execute'?135000:(mode==='query'||mode==='batch-query')?45000:30000;
  const out=await spawnCapture('java',['-cp',bridgeClassPath,'JdbcBridge',mode,jar,String(pack.jdbc.driverClass),String(connectTimeoutMs)],{cwd:STUDIO_DIR,input:bridgeInput,timeoutMs:operationTimeoutMs});
  const line=out.stdout.trim().split(/\r?\n/).filter(Boolean).pop()||'';
  let data; try{data=JSON.parse(line);}catch(_){throw new Error(`JDBC bridge returned invalid JSON: ${line.slice(0,500)}`);}
  if(!data.ok) throw new Error(data.error||'JDBC bridge operation failed.'); return data;
}
function firstNonBlank(...values){
  for(const value of values){
    if(value==null) continue;
    const text=String(value);
    if(text.trim()!=='') return text;
  }
  return '';
}
function packNamespaceFromBody(pack,body){
  const values=resolvePackConnectionValues(pack,body);
  // An empty browser field means "not explicitly supplied", not "scan every
  // JDBC catalog/schema". The bridge resolves any remaining blank namespace
  // to Connection.getCatalog()/getSchema() after opening the selected database.
  const catalog=firstNonBlank(body&&body.catalog,values.catalog,pack.namespace.defaultCatalog);
  const schema=firstNonBlank(body&&body.schema,values.schema,pack.namespace.defaultSchema);
  return {catalog,schema};
}


return { DATABASE_PACK_FEATURE_VERSION, DATABASE_PACK_SCHEMA_VERSION, DATABASE_PACK_DIR, HOP_DATABASE_TYPES_PATH, isPackDialect, validateDatabasePackManifest, findPackJdbcDriver, loadHopDatabaseTypes, listDatabasePacks, getDatabasePack, getDatabasePackForDialect, writeDatabasePack, removeDatabasePack, semanticTypeForJdbc, applyPackSemanticTypes, sourceHopCapabilitiesFromJdbcAnalysis, sourceHopCapabilitiesFromTables, sourceHopCapabilitiesFromHopCatalog, analysisValue, resolveJdbcTargetProfile, runJdbcBridge, firstNonBlank, packNamespaceFromBody };
}

module.exports = { createDatabasePackService };
