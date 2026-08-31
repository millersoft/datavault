function hashIndexName(tableName, columnName){
  const unqualifiedTable = String(tableName||'').split('.').pop();
  return targetIdentifierBase(`idx_${unqualifiedTable}_${columnName}`, 'hash_index');
}

function hashedColumnIndexStatements(tableName, cols){
  const seen = new Set();
  return (cols||[])
    .filter(c=>c.hashed && !seen.has(c.name) && seen.add(c.name))
    .map(c=>`CREATE INDEX IF NOT EXISTS ${hashIndexName(tableName, c.name)} ON ${tableName} (${c.name});`);
}

function ddlWithHashIndexes(tableName, cols){
  return [
    ddlFromColumns(tableName, cols),
    ...hashedColumnIndexStatements(tableName, cols),
  ].join('\n');
}

function ddlForeignTable(tableName, cols, keyColumnName){
  // jdbc_fdw supports no table-level OPTIONS at all — only a column-level
  // OPTIONS(key 'true') flag on the primary/hash key column. The foreign
  // table's name must match the remote table's name exactly; jdbc_fdw has
  // no schema_name/table_name remapping option like postgres_fdw does.
  const keyCol = keyColumnName || (cols[0] && cols[0].name);
  const body = cols.map(c=>{
    const opts = (c.name === keyCol) ? ` OPTIONS (key 'true')` : '';
    // PostgreSQL's CREATE FOREIGN TABLE grammar places column OPTIONS
    // immediately after the data type and before column constraints such as
    // NOT NULL. Emitting NOT NULL before OPTIONS produces a syntax error.
    return `  ${c.name} ${c.type}${opts}${c.notNull?' NOT NULL':''}`;
  }).join(',\n');
  const server = state.externalTables.serverName || '<server_name>';
  return `CREATE FOREIGN TABLE IF NOT EXISTS ${tableName} (\n${body}\n) SERVER ${server};`;
}

function buildFdwPreamble(){
  const ext = state.externalTables;
  const pack=databasePackForDialect(ext.remoteDialect);
  if(pack){ syncPackMappedValues(pack,'target'); ext.drivername=pack.jdbc.driverClass; ext.jarfile=pack.driverFile?`/opt/jdbc-drivers/${pack.driverFile}`:''; ext.url=defaultExternalJdbcUrl(ext.remoteDialect,ext.studioHost,ext.studioPort,ext.studioDatabase||ext.remoteDatabase); }
  const server = ext.serverName || '<server_name>';
  const sharedUser = String(ext.studioUser || ext.username || '');
  const sharedPassword = String(ext.studioPassword || ext.password || '');
  // The local data_vault and pdi_meta roles both map to the same account
  // used by the physical-target deployment. data_vault
  // reads and writes the core foreign tables; pdi_meta reads them from the
  // engine's logging procedures when it records row counts.
  ext.studioUser = sharedUser; ext.username = sharedUser;
  ext.studioPassword = sharedPassword; ext.password = sharedPassword;
  return [
    `-- jdbc_fdw setup — hub/link/satellite tables below are foreign tables via`,
    `-- this server. _err and pdi_meta tables stay native. jdbc_fdw is not a`,
    `-- packaged Postgres extension — it's built from source, needs Java and a`,
    `-- libjvm.so symlink on the server, plus the JDBC driver .jar referenced`,
    `-- below. The remote database needs a table with the exact same name as`,
    `-- each foreign table here — jdbc_fdw has no per-table name remapping.`,
    `CREATE EXTENSION IF NOT EXISTS jdbc_fdw;`,
    ``,
    `CREATE SERVER IF NOT EXISTS ${server} FOREIGN DATA WRAPPER jdbc_fdw`,
    `  OPTIONS (`,
    `    drivername '${sqlLiteral(ext.drivername || '<jdbc_driver_class>')}',`,
    `    url '${sqlLiteral(ext.url || '<jdbc_url>')}',`,
    `    querytimeout '${sqlLiteral(ext.querytimeout || '30')}',`,
    `    jarfile '${sqlLiteral(ext.jarfile || '<path_to_driver_jar>')}'${ext.maxheapsize ? `,\n    maxheapsize '${sqlLiteral(ext.maxheapsize)}'` : ''}`,
    `  );`,
    ``,
    `DROP USER MAPPING IF EXISTS FOR data_vault SERVER ${server};`,
    `CREATE USER MAPPING FOR data_vault SERVER ${server}`,
    `  OPTIONS (username '${sqlLiteral(sharedUser)}', password '${sqlLiteral(sharedPassword)}');`,
    ``,
    `DROP USER MAPPING IF EXISTS FOR pdi_meta SERVER ${server};`,
    `CREATE USER MAPPING FOR pdi_meta SERVER ${server}`,
    `  OPTIONS (username '${sqlLiteral(sharedUser)}', password '${sqlLiteral(sharedPassword)}');`,
    ``,
    `GRANT USAGE ON FOREIGN SERVER ${server} TO data_vault, pdi_meta;`,
  ].join('\n');
}

function mainTableDdl(tableName, cols, keyColumnName){
  return state.externalTables.enabled ? ddlForeignTable(tableName, cols, keyColumnName) : ddlFromColumns(tableName, cols);
}

function buildErrColumns(cols){
  return cols.map((c,i)=>{
    let type = 'TEXT';
    if (c.name==='load_dts') type='TIMESTAMP';
    else if (c.name==='record_source_id') type='INT';
    return { name:c.name, type, notNull:false };
  }).concat([
    { name:'etl_err_date', type:'TIMESTAMP', notNull:false },
    { name:'etl_id_run', type:'INT', notNull:false },
    { name:'etl_err_noe', type:'INT', notNull:false },
    { name:'etl_err_desc', type:'VARCHAR(512)', notNull:false },
    { name:'etl_err_col', type:'VARCHAR(256)', notNull:false },
    { name:'etl_err_cod', type:'VARCHAR(256)', notNull:false },
  ]);
}

// When the GUI created the target database, CREATE SCHEMA IF NOT EXISTS runs
// as the connecting user (e.g. dvuser) — so the schema starts out owned by
// them, and the database user the tables are created under (SET ROLE
// staging / data_vault) has NO rights on it: "permission denied for schema".
// This block hands the schema to its database user, but ONLY when the
// current user owns it — a no-op on databases prepared by the target setup, and it
// never errors on admin-owned schemas.
function schemaOwnershipFixSql(schema, role){
  return `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
             WHERE n.nspname = '${schema}' AND r.rolname = current_user) THEN
    EXECUTE 'ALTER SCHEMA ${schema} OWNER TO ${role}';
  END IF;
END $$;`;
}

function buildStagingDdl(){
  const parts = [`-- =========================================================\n-- STAGING DDL — schema: staging\n-- Physical tables mirror source columns; *_vw relations add Vault metadata\n-- Generated by Data Vault Studio\n-- =========================================================\n`];
  parts.push('CREATE SCHEMA IF NOT EXISTS staging;');
  parts.push(schemaOwnershipFixSql('staging', 'staging'));
  parts.push('');
  parts.push('SET ROLE staging;');
  parts.push('');
  includedTables().forEach(t=>{
    const baseName=`staging.${stagingTableName(t.name)}`;
    const viewName=`staging.${stagingViewName(t.name)}`;
    const baseCols=buildStagingBaseColumns(t);
    parts.push(`-- ${t.name} -> ${viewName} (engine relation); base table ${baseName}`);
    parts.push(ddlFromColumns(baseName, baseCols));
    parts.push(`ALTER TABLE ${baseName} OWNER TO staging;`);
    parts.push(buildStagingViewSql(t));
    parts.push(`ALTER VIEW ${viewName} OWNER TO staging;`);
    parts.push('');
  });
  parts.push(crossRoleGrantsSql('staging', 'staging', ['pdi_meta', 'data_vault']));
  parts.push('RESET ROLE;');
  return parts.join('\n');
}

function expectedStagingObjects(){
  const objects=[];
  includedTables().forEach(t=>{
    const base=stagingTableName(t.name), view=stagingViewName(t.name);
    objects.push({schema:'staging',name:base.toLowerCase(),columns:buildStagingBaseColumns(t).map(c=>({name:c.name.toLowerCase(),type:c.type})),createSql:ddlFromColumns(`staging.${base}`,buildStagingBaseColumns(t)),foreign:false,relationKind:'r',indexes:[],obsoleteColumns:[]});
    objects.push({schema:'staging',name:view.toLowerCase(),columns:buildStagingViewColumns(t).map(c=>({name:c.name.toLowerCase(),type:c.type})),createSql:buildStagingViewSql(t),foreign:false,relationKind:'v',indexes:[],obsoleteColumns:[]});
  });
  return objects;
}

// The engine uses several logins (source/staging/datavault connections) and
// its instrumentation reads across schemas (e.g. row counts on vault tables
// over the staging/pdi_meta connection). The target setup process's ALTER DEFAULT
// PRIVILEGES only covers objects the ADMIN creates — these tables are
// created under SET ROLE, so the generated DDL must cross-grant its own
// objects and register defaults FOR the creating role. Without this,
// everything works internally (dvuser is superuser) and fails on the first
// real external target with "permission denied for table ...".
function crossRoleGrantsSql(schema, ownerRole, peers){
  const to = peers.join(', ');
  return [
    `-- Cross-role access — engine connections other than ${ownerRole} must read these`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${to};`,
    `GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ${to};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA ${schema} GRANT ALL ON TABLES TO ${to};`,
    '',
  ].join('\n');
}

function buildCombinedDdl(){
  // Matches the project's own db-init convention, where staging + data
  // vault DDL ship as a single combined file (their 03-ddls.sql). Uses
  // getExportSql() rather than the raw builders so an edited preview on
  // the Export step is reflected here too, not just in the individual
  // downloads.
  return [
    `-- =========================================================`,
    `-- COMBINED STAGING + DATA VAULT DDL`,
    `-- Generated by Data Vault Studio`,
    `-- =========================================================`,
    '',
    getExportSql('staging'),
    '',
    getExportSql('datavault'),
  ].join('\n');
}
