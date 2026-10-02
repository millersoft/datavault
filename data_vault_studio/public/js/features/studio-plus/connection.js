/* Studio Plus — target connection, dialect rules, schema helpers and the business_vault schema. */
let spConn = { dialect:'postgresql', host:'localhost', port:'5432', database:'', schema:'data_vault', user:'', password:'', autoDefault:true, managedTarget:false };
const SP_BUSINESS_SCHEMA = 'business_vault';
const SP_MATERIALISE_TIMEOUT_SECONDS = 1800; // persisted Business Model / PIT / Bridge builds may run far longer than routine DDL
let spBusinessSchemaTables = []; // deployed PIT/Bridge + Business Model objects introspected from the business layer schema
let spBusinessSchemaExists = false;
let spBusinessSchemaStatus = 'unchecked'; // unchecked | ready | missing | unsupported | error
let spBusinessSchemaError = '';
let spEnsureBusinessSchema = false; // compatibility flag; schema creation is now an explicit user action after inference
function spFindManagedView(id){ return spManagedViews().find(v=>v.id===id); }
function spIsSqlServerDialect(dialect=spConn.dialect){ return /^(?:sqlserver|mssql|mssqlnative)$/i.test(String(dialect||'')); }
function spSqlDialectLabel(){
  const pack=typeof databasePackForDialect==='function' ? databasePackForDialect(spConn.dialect) : null;
  return (pack&&pack.label) || ((typeof DIALECTS!=='undefined'&&DIALECTS[spConn.dialect]&&DIALECTS[spConn.dialect].label) || (spIsSqlServerDialect()?'SQL Server':spConn.dialect==='mysql'?'MySQL':'PostgreSQL'));
}

function spSqlDialectFamily(dialect=spConn.dialect){
  const value=String(dialect||'').toLowerCase();
  if(/^(?:postgres|postgresql)$/.test(value))return 'postgresql';
  if(/^(?:sqlserver|mssql|mssqlnative)$/.test(value))return 'sqlserver';
  if(/^mysql$/.test(value))return 'mysql';
  return value||'unknown';
}
function spSqlCodeOnly(sql){
  return String(sql||'')
    .replace(/'(?:''|[^'])*'/g,"''")
    .replace(/"(?:""|[^"])*"/g,'""')
    .replace(/--[^\n\r]*/g,' ')
    .replace(/\/\*[\s\S]*?\*\//g,' ');
}
function spSqlDialectPromptRules(){
  const family=spSqlDialectFamily();
  const label=spSqlDialectLabel();
  if(family==='postgresql')return `TARGET DIALECT: ${label}. Generate PostgreSQL SQL only. Window functions such as ROW_NUMBER, RANK, LAG, LEAD and SUM(...) OVER (...) are valid PostgreSQL and may be used when analytically useful. Use LIMIT rather than TOP; CURRENT_TIMESTAMP/CURRENT_DATE rather than GETDATE(); PostgreSQL interval/date arithmetic rather than DATEADD/DATEDIFF; COALESCE rather than SQL Server ISNULL; double-quoted identifiers only when quoting is required. Do not use SQL Server TOP, DATEADD, DATEDIFF, GETDATE, SYSDATETIME, TRY_CAST, TRY_CONVERT, IIF, DATEPART, DATENAME, EOMONTH, CROSS/OUTER APPLY or bracketed identifiers. Do not use MySQL DATE_ADD, DATE_SUB, TIMESTAMPDIFF, STR_TO_DATE, IFNULL, GROUP_CONCAT or backtick identifiers. Avoid version-specific PostgreSQL helper functions unless they are explicitly present in the supplied schema/capabilities.`;
  if(family==='sqlserver')return `TARGET DIALECT: ${label}. Generate SQL Server T-SQL only. Window functions such as ROW_NUMBER, RANK, LAG, LEAD and SUM(...) OVER (...) are valid SQL Server and may be used when analytically useful. Use TOP or OFFSET/FETCH rather than LIMIT; DATEADD/DATEDIFF for date arithmetic where needed; GETDATE/CURRENT_TIMESTAMP as appropriate; SQL Server-compatible casts and identifier quoting. Do not use PostgreSQL :: casts, ILIKE, DATE_TRUNC, FILTER (WHERE ...), INTERVAL '...', NULLS FIRST/LAST, or PostgreSQL-specific functions. Do not use MySQL DATE_ADD, DATE_SUB, TIMESTAMPDIFF, STR_TO_DATE, GROUP_CONCAT or backtick identifiers.`;
  if(family==='mysql')return `TARGET DIALECT: ${label}. Generate MySQL SQL only. Use LIMIT rather than TOP; CURRENT_TIMESTAMP/NOW() for current time; DATE_ADD/DATE_SUB or other MySQL date functions for date arithmetic; backticks only when identifier quoting is required. Do not use SQL Server TOP, DATEADD, GETDATE, SYSDATETIME, TRY_CAST, TRY_CONVERT, IIF, DATEPART, DATENAME, EOMONTH, CROSS/OUTER APPLY or bracketed identifiers. Do not use PostgreSQL :: casts, ILIKE, DATE_TRUNC, FILTER (WHERE ...), or NULLS FIRST/LAST. Because the connected MySQL server version is not supplied to the model, prefer conservative broadly supported syntax and do not depend on version-specific features unless the generated query can be validated against the target.`;
  return `TARGET DIALECT: ${label}. Generate SQL only for this exact target dialect. Do not borrow functions, date arithmetic, row limiting or identifier quoting from another database product. Prefer conservative, broadly supported syntax and rely on target validation before execution.`;
}
function spSqlDialectIssue(sql){
  const family=spSqlDialectFamily();
  const text=spSqlCodeOnly(sql);
  const hit=(re,label)=>re.test(text)?`This SQL uses ${label}, which does not match the connected ${spSqlDialectLabel()} target.`:'';
  if(family==='postgresql'){
    return hit(/\bTOP\s*(?:\(\s*\d+\s*\)|\d+)/i,'SQL Server TOP')
      ||hit(/\bDATEADD\s*\(/i,'SQL Server DATEADD()')
      ||hit(/\bDATEDIFF\s*\(/i,'SQL Server DATEDIFF()')
      ||hit(/\b(?:GETDATE|SYSDATETIME|TRY_CAST|TRY_CONVERT|IIF|DATEPART|DATENAME|EOMONTH|ISNULL)\s*\(/i,'a SQL Server-specific function')
      ||hit(/\b(?:CROSS|OUTER)\s+APPLY\b/i,'SQL Server APPLY')
      ||hit(/(?:^|[\s,(.])\[[A-Za-z_][A-Za-z0-9_$ ]*\]/m,'SQL Server bracketed identifier quoting')
      ||hit(/\b(?:DATE_ADD|DATE_SUB|TIMESTAMPDIFF|STR_TO_DATE|IFNULL|GROUP_CONCAT)\s*\(/i,'a MySQL-specific function')
      ||hit(/`[A-Za-z_][^`]*`/,'MySQL backtick identifier quoting');
  }
  if(family==='sqlserver'){
    return hit(/\bLIMIT\s+\d+/i,'PostgreSQL/MySQL LIMIT')
      ||hit(/::\s*[A-Za-z_][A-Za-z0-9_\s\[\]]*/i,'a PostgreSQL-style :: cast')
      ||hit(/\bILIKE\b/i,'PostgreSQL ILIKE')
      ||hit(/\bDATE_TRUNC\s*\(/i,'PostgreSQL DATE_TRUNC()')
      ||hit(/\bFILTER\s*\(\s*WHERE\b/i,'PostgreSQL aggregate FILTER')
      ||hit(/\bINTERVAL\s+'[^']*'/i,'PostgreSQL-style INTERVAL literals')
      ||hit(/\bNULLS\s+(?:FIRST|LAST)\b/i,'PostgreSQL NULLS FIRST/LAST')
      ||hit(/\bCURRENT_DATE\b/i,'PostgreSQL/MySQL CURRENT_DATE')
      ||hit(/\b(?:DATE_ADD|DATE_SUB|TIMESTAMPDIFF|STR_TO_DATE|GROUP_CONCAT)\s*\(/i,'a MySQL-specific function')
      ||hit(/`[A-Za-z_][^`]*`/,'MySQL backtick identifier quoting');
  }
  if(family==='mysql'){
    return hit(/\bTOP\s*(?:\(\s*\d+\s*\)|\d+)/i,'SQL Server TOP')
      ||hit(/\bDATEADD\s*\(/i,'SQL Server DATEADD()')
      ||hit(/\b(?:GETDATE|SYSDATETIME|TRY_CAST|TRY_CONVERT|IIF|DATEPART|DATENAME|EOMONTH)\s*\(/i,'a SQL Server-specific function')
      ||hit(/\b(?:CROSS|OUTER)\s+APPLY\b/i,'SQL Server APPLY')
      ||hit(/(?:^|[\s,(.])\[[A-Za-z_][A-Za-z0-9_$ ]*\]/m,'SQL Server bracketed identifier quoting')
      ||hit(/::\s*[A-Za-z_][A-Za-z0-9_\s\[\]]*/i,'a PostgreSQL-style :: cast')
      ||hit(/\bILIKE\b/i,'PostgreSQL ILIKE')
      ||hit(/\bDATE_TRUNC\s*\(/i,'PostgreSQL DATE_TRUNC()')
      ||hit(/\bFILTER\s*\(\s*WHERE\b/i,'PostgreSQL aggregate FILTER')
      ||hit(/\bNULLS\s+(?:FIRST|LAST)\b/i,'PostgreSQL NULLS FIRST/LAST')
      ||hit(/\bINTERVAL\s+'[^']*'/i,'PostgreSQL-style INTERVAL literals');
  }
  return '';
}

function studioPlusDefaultConnection(){
  if(state.externalTables.enabled){
    const ext=state.externalTables;
    const dialect=ext.remoteDialect||'postgresql';
    const database=ext.studioDatabase||ext.remoteDatabase||'';
    return {
      dialect,
      host:ext.studioHost||'localhost',
      port:String(ext.studioPort||externalDefaultPort(dialect)),
      database,
      schema:ext.studioSchema||ext.remoteSchema||(dialect==='mysql'?database:'data_vault'),
      user:ext.studioUser||ext.username||'',
      password:ext.studioPassword||ext.password||'',
      credentialRef:isDemoRuntime()?'demo-fdw-physical-mysql':undefined,
      autoDefault:true,
      managedTarget:true,
    };
  }
  return {
    dialect:'postgresql',
    host:state.vault.dvHost||'localhost',
    port:String(state.vault.dvPort||'5432'),
    database:state.vault.dvDatabase||'',
    schema:'data_vault',
    user:state.vault.dvUser||'',
    password:state.vault.dvPassword||'',
    credentialRef:demoTargetActive()?'internal-postgres-target':undefined,
    autoDefault:true,
    managedTarget:false,
  };
}

function spFormIsPackagedInternal(){
  const host=String(spConn.host||'').trim().toLowerCase();
  const port=String(spConn.port||'5433').trim();
  return spConn.credentialRef==='internal-postgres-target' && ['localhost','127.0.0.1','::1'].includes(host) && port==='5433';
}
function spConnectionPayload(){
  // An unedited form follows the Designer target, including an external
  // PostgreSQL server. Editing the form uses those typed values. The packaged
  // internal credential remains only while the form still addresses that
  // container, so its server-side password is not replaced by the empty field.
  if(spConn.managedTarget && state.externalTables.enabled && typeof externalConnectionPayload==='function'){
    return externalConnectionPayload(spConn.database||state.externalTables.studioDatabase||state.externalTables.remoteDatabase);
  }
  if(spConn.autoDefault!==false && typeof targetConnectionPayload==='function'){
    const body=targetConnectionPayload(spConn.database||state.vault.dvDatabase);
    if(!body.schema && spConn.schema) body.schema=spConn.schema;
    return body;
  }
  if(spFormIsPackagedInternal()){
    return {credentialRef:'internal-postgres-target',host:spConn.host,port:spConn.port||'5433',database:spConn.database,dialect:spConn.dialect||'postgresql',schema:spConn.schema};
  }
  const v=state.vault;
  const matchesConfiguredExternal=!demoTargetActive() && !spConn.password
    && String(spConn.host||'')===String(v.dvHost||'')
    && String(spConn.port||'')===String(v.dvPort||'')
    && String(spConn.database||'')===String(v.dvDatabase||'');
  if(matchesConfiguredExternal && typeof targetConnectionPayload==='function'){
    const body=targetConnectionPayload(spConn.database||v.dvDatabase);
    if(!body.schema && spConn.schema) body.schema=spConn.schema;
    return body;
  }
  const connection={dialect:spConn.dialect,host:spConn.host,port:spConn.port,database:spConn.database,schema:spConn.schema,user:spConn.user,password:spConn.password};
  return typeof confirmImportedConnectionTarget==='function' ? confirmImportedConnectionTarget(connection) : connection;
}

function spBusinessSchemaSupported(){
  if(String(spConn.dialect||'').toLowerCase()==='mysql') return false;
  const pack=typeof databasePackForDialect==='function' ? databasePackForDialect(spConn.dialect) : null;
  if(pack) return !!(pack.namespace&&pack.namespace.usesSchema);
  return /^(?:postgres|postgresql|sqlserver|mssql|mssqlnative)$/i.test(String(spConn.dialect||''));
}
function spBusinessSchemaName(){ return spBusinessSchemaSupported()?SP_BUSINESS_SCHEMA:(spConn.schema||spConn.database); }
function spPayloadForSchema(schema){
  const body={...spConnectionPayload(),profileColumns:false};
  const pack=typeof databasePackForDialect==='function' ? databasePackForDialect(body.dialect) : null;
  if(pack&&body.packValues&&pack.namespace&&pack.namespace.usesSchema){
    body.packValues={...body.packValues};
    const field=(pack.connectionFields||[]).find(f=>f.mapsTo==='schema');
    if(field) body.packValues[field.key]=schema;
    body.schema=schema;
  }else if(!pack || (!body.packValues && !body.manualUrl && !body.jdbcUrl)){
    body.schema=schema||spConn.schema||body.schema||spConn.database||body.database;
  }else body.schema=schema||body.schema;
  return body;
}
function spIntrospectionPayload(){ return spPayloadForSchema(spConn.schema||spConn.database); }
function spBusinessIntrospectionPayload(){ return spPayloadForSchema(spBusinessSchemaName()); }

function spQuoteIdentifier(name){
  if(typeof remoteQuoteIdentifier==='function') return remoteQuoteIdentifier(String(name||''),spConn.dialect);
  const value=String(name||'');
  if(spConn.dialect==='mysql') return '`'+value.replace(/`/g,'``')+'`';
  return '"'+value.replace(/"/g,'""')+'"';
}
function spQualifiedTableInSchema(name,schema){
  if(typeof remoteQualifiedName==='function') return remoteQualifiedName(name,spConn.dialect,spConn.database,schema);
  return `${spQuoteIdentifier(schema||spConn.schema||spConn.database)}.${spQuoteIdentifier(name)}`;
}
function spQualifiedTable(name){ return spQualifiedTableInSchema(name,spConn.schema||spConn.database); }
function spBusinessQualifiedTable(name){ return spQualifiedTableInSchema(name,spBusinessSchemaName()); }
function spBusinessSchemaCreateDdl(){
  if(!spBusinessSchemaSupported()) return '';
  if(spIsSqlServerDialect()) return `IF SCHEMA_ID(N'${SP_BUSINESS_SCHEMA}') IS NULL EXEC(N'CREATE SCHEMA [${SP_BUSINESS_SCHEMA}]');`;
  const pack=typeof databasePackForDialect==='function'?databasePackForDialect(spConn.dialect):null;
  if(/^(?:postgres|postgresql)$/i.test(String(spConn.dialect||'')) || !pack) return `CREATE SCHEMA IF NOT EXISTS ${spQuoteIdentifier(SP_BUSINESS_SCHEMA)};`;
  // Most schema-capable JDBC targets accept CREATE SCHEMA. Targets that do not
  // can leave the Infer Schema option unticked and create it administratively.
  return `CREATE SCHEMA ${spQuoteIdentifier(SP_BUSINESS_SCHEMA)};`;
}
async function spTargetSchemas(){
  if(!spBusinessSchemaSupported()) return [];
  const response=await localFetch('/api/list-schemas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(spConnectionPayload())});
  const data=await response.json();if(!data.ok)throw new Error(data.error||'Could not inspect target schemas.');
  return (data.schemas||[]).map(String);
}
async function spEnsureBusinessSchemaOnInfer(){
  spBusinessSchemaTables=[];spBusinessSchemaError='';
  if(!spBusinessSchemaSupported()){
    spBusinessSchemaExists=true;spBusinessSchemaStatus='unsupported';return;
  }
  const schemas=await spTargetSchemas();
  spBusinessSchemaExists=schemas.some(n=>n.toLowerCase()===SP_BUSINESS_SCHEMA);
  spBusinessSchemaStatus=spBusinessSchemaExists?'ready':'missing';
  if(!spBusinessSchemaExists)return;
  const response=await localFetch('/api/introspect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(spBusinessIntrospectionPayload())});
  const data=await response.json();
  if(!data.ok)throw new Error(data.error||`Could not introspect ${SP_BUSINESS_SCHEMA}.`);
  spBusinessSchemaTables=(data.tables||[]).filter(t=>!/_err$/i.test(t.name)&&!spIsTechnicalViewName(t.name)).map(t=>({name:t.name,objectType:t.objectType||'table',columns:t.columns||[],rowCount:t.approxRows==null?null:Number(t.approxRows),schema:spBusinessSchemaName()}));
}
async function spCreateBusinessSchema(){
  if(!spBusinessSchemaSupported())return;
  const ddl=spBusinessSchemaCreateDdl();
  if(!ddl){toast(`Create ${SP_BUSINESS_SCHEMA} on the target, then infer again.`,'err');return;}
  try{
    await spExecuteViewDdl(ddl);
    await spEnsureBusinessSchemaOnInfer();
    if(!spBusinessSchemaExists)throw new Error(`${SP_BUSINESS_SCHEMA} was not visible after creation.`);
    toast(`${SP_BUSINESS_SCHEMA} schema created.`,'ok');
  }catch(err){
    spBusinessSchemaStatus='error';spBusinessSchemaError=err.message;toast(`Could not create ${SP_BUSINESS_SCHEMA}: ${err.message}`,'err');
  }
  renderAll();
}
function spAllIntrospectedTables(){ return [...spSchemaTables,...spBusinessSchemaTables]; }
function spBusinessSchemaTable(name){ return spBusinessSchemaTables.find(t=>String(t.name).toLowerCase()===String(name||'').toLowerCase()); }
function spRawSchemaTable(name){ return spSchemaTables.find(t=>String(t.name).toLowerCase()===String(name||'').toLowerCase()); }
function spSourceQualifiedTable(name){
  const business=spBusinessSchemaTable(name);
  if(business && ['PIT','Bridge'].includes(spBusinessObjectKind(business))) return spBusinessQualifiedTable(name);
  return spQualifiedTable(name);
}
function spBusinessSchemaDeployIssue(){
  if(!spBusinessSchemaSupported())return '';
  if(spBusinessSchemaExists)return '';
  return `The ${SP_BUSINESS_SCHEMA} schema is not ready. Infer the schema, then use “Create ${SP_BUSINESS_SCHEMA} schema” if Studio reports it missing.`;
}
function spSelectLimit(sql, limit){
  const body=String(sql||'').trim().replace(/;\s*$/,'');
  if(spIsSqlServerDialect()) return `SELECT TOP (${Number(limit)||1}) * FROM (${body}) AS _sp_limit`;
  return `SELECT * FROM (${body}) AS _sp_limit LIMIT ${Number(limit)||1}`;
}
function spSingleSelectIssue(sql){
  const text=String(sql||'').trim();
  if(!text) return 'Enter a SELECT query for the Business Model.';
  if(!/^(SELECT|WITH)\s/i.test(text)) return 'Business models must be defined by a SELECT (or WITH … SELECT) query.';
  if(/;.*\S/.test(text.replace(/;\s*$/,''))) return 'Use one SELECT statement only.';
  if(/\b(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE)\b/i.test(text.replace(/(['"])(?:\\.|(?!\1).)*\1/g,' '))) return 'Only read-only SELECT SQL is allowed in a Business Model definition.';
  if(/\bpg_input_is_valid\s*\(/i.test(text)) return 'This SQL uses pg_input_is_valid(), which is not available on every supported PostgreSQL version. Regenerate with AI or replace it with version-compatible conversion logic before loading.';
  return spSqlDialectIssue(text);
}
