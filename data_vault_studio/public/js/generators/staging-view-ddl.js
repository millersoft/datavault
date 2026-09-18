function stagingDerivationTargetColumns(table,d){
  return derivationSourceColumns(d).map(sourceName=>{
    const col=(table.columns||[]).find(c=>c.name===sourceName);
    return col ? targetColumnName(col) : targetIdentifierBase(sourceName,'staging_column');
  });
}
function postgresStagingColumnRef(name){ return `b.${name}`; }
function postgresKeyTextSql(columnNames){
  const cols=(columnNames||[]).filter(Boolean);
  if(cols.length<=1) return cols.length ? `${postgresStagingColumnRef(cols[0])}::text` : `''::text`;
  const parts=cols.map(name=>{
    const col=postgresStagingColumnRef(name);
    return `CASE WHEN ${col} IS NULL THEN '-1:' ELSE (length(${col}::text)::text || ':' || ${col}::text) END`;
  });
  return `(${parts.join(" || '|' || ")})`;
}
function postgresSha256Sql(textSql){
  // One hashing implementation for every source: UTF-8 text -> PostgreSQL SHA-256 bytea.
  return `sha256(convert_to((${textSql}), 'UTF8'))`;
}
function buildStagingViewColumns(table){
  const cols=buildStagingBaseColumns(table).map(c=>({...c}));
  const hubDerivs = table.derivations.filter(d=>d.kind==='both');
  const bkOnly = table.derivations.filter(d=>d.kind==='bk');
  const fkDerivs = table.derivations.filter(d=>d.kind==='hash');
  hubDerivs.forEach(d=> cols.push({ name:hashColumnNameForDerivation(table, d), type:hashSqlType(), notNull:false, derived:true, hashed:true }));
  hubDerivs.concat(bkOnly).forEach(d=> cols.push({ name:businessKeyColumnName(derivationCanonicalSpec(table,d).entity), type:'TEXT', notNull:false, derived:true }));
  fkDerivs.forEach(d=> cols.push({ name:hashColumnNameForDerivation(table, d), type:hashSqlType(), notNull:false, derived:true, hashed:true }));
  cols.push({ name:'tenant_id', type:'VARCHAR(20)', notNull:false, derived:true });
  const seen=new Set();
  return cols.filter(c=>!seen.has(c.name)&&seen.add(c.name));
}
// Backward-facing helper used by Vault modelling/validation: this is what the engine
// sees when it reads staging, i.e. the enriched view columns.
function buildStagingColumns(table){ return buildStagingViewColumns(table); }

function buildStagingViewSql(table){
  // Keep the complete table identity here. Passing only table.name loses the
  // selected source schema and makes a generated view point at the legacy
  // unqualified staging table.
  const base=`staging.${stagingTableName(table)}`;
  const view=`staging.${stagingViewName(table)}`;
  const selectItems=buildStagingBaseColumns(table).map(c=>`b.${c.name} AS ${c.name}`);
  const emitted=new Set(selectItems.map(x=>x.split(/\s+AS\s+/i).pop()));
  table.derivations.filter(d=>d.kind==='hash'||d.kind==='both').forEach(d=>{
    const alias=hashColumnNameForDerivation(table,d); if(emitted.has(alias)) return; emitted.add(alias);
    const keyText=postgresKeyTextSql(stagingDerivationTargetColumns(table,d));
    selectItems.push(`${postgresSha256Sql(keyText)} AS ${alias}`);
  });
  table.derivations.filter(d=>d.kind==='bk'||d.kind==='both').forEach(d=>{
    const alias=businessKeyColumnName(derivationCanonicalSpec(table,d).entity); if(emitted.has(alias)) return; emitted.add(alias);
    selectItems.push(`${postgresKeyTextSql(stagingDerivationTargetColumns(table,d))} AS ${alias}`);
  });
  if(!emitted.has('tenant_id')) selectItems.push(`'${sqlLiteral(state.vault.tenantId || 'TENANT')}'::varchar(20) AS tenant_id`);
  return `CREATE OR REPLACE VIEW ${view} AS\nSELECT\n  ${selectItems.join(',\n  ')}\nFROM ${base} b;`;
}
