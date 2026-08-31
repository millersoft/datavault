/* =========================================================================
   Remote table DDL — jdbc_fdw connects to ANY JDBC source, which may be a
   completely different SQL dialect than the local Postgres. This generates
   the CREATE TABLE statements to run on THAT remote database, with table
   names matching exactly what the local CREATE FOREIGN TABLE expects
   (jdbc_fdw has no per-table name remapping).
   ========================================================================= */
function semanticTypeFromStudioType(type){
  const upper=String(type||'').trim().toUpperCase();
  if(upper==='BOOLEAN'||upper==='BOOL') return 'BOOLEAN';
  if(upper==='SMALLINT') return 'SMALL_INTEGER';
  if(upper==='INT'||upper==='INTEGER') return 'INTEGER';
  if(upper==='BIGINT') return 'BIG_INTEGER';
  if(/^NUMERIC(?:\(|$)|^DECIMAL(?:\(|$)/.test(upper)) return 'DECIMAL';
  if(/^(REAL|FLOAT|DOUBLE)/.test(upper)) return 'FLOAT';
  if(/^(VARCHAR|CHAR|NVARCHAR|NCHAR)(?:\(|$)/.test(upper)) return 'STRING';
  if(upper==='TEXT') return 'LARGE_TEXT';
  if(upper==='DATE') return 'DATE';
  if(upper==='TIME') return 'TIME';
  if(upper==='TIMESTAMP') return 'TIMESTAMP';
  if(upper==='TIMESTAMPTZ'||upper==='TIMESTAMP WITH TIME ZONE') return 'TIMESTAMP_TZ';
  if(upper==='BYTEA') return 'BINARY';
  if(upper==='UUID') return 'UUID';
  if(upper==='JSON'||upper==='JSONB') return 'JSON';
  return 'UNKNOWN';
}
function semanticTargetColumnSpec(column){
  const col=column&&typeof column==='object'?column:{type:column};
  const type=String(col.type||'');
  const upper=type.trim().toUpperCase();
  let semantic=semanticTypeFromStudioType(type);
  const size=type.match(/\((\d+)(?:\s*,\s*(\d+))?\)/)||[];
  let length=size[1]?Number(size[1]):null;
  let precision=size[1]?Number(size[1]):null;
  let scale=size[2]?Number(size[2]):null;
  // PostgreSQL BYTEA carries no declared length. Hash columns are fixed-width
  // SHA-256 bytes; descriptive binary attributes are potentially large and
  // must not be narrowed to the same 32-byte physical type.
  if(semantic==='BINARY'&&upper==='BYTEA'){
    if(col.hashed){ length=32; }
    else { semantic='BINARY_LARGE'; length=null; }
  }
  return {semantic,length,precision,scale,sourceType:type};
}
function remoteType(type, dialect, column){
  const upper=String(type||'').toUpperCase();
  const spec=semanticTargetColumnSpec(column||{type});
  const pack=databasePackForDialect(dialect);
  if(pack){
    const semantic=spec.semantic;
    const map=(pack.target&&pack.target.types)||{};
    const profile=activeTargetProfile(dialect);
    // Explicit Pack overrides win. Otherwise use the profile discovered from
    // the connected JDBC driver's DatabaseMetaData. UNKNOWN remains a legacy
    // Pack fallback for deliberately broad adapters.
    const template=map[semantic]||profile?.resolvedTypes?.[semantic]||map.UNKNOWN;
    if(!template) throw new Error(`${pack.label} target type ${semantic} (${type}) is unresolved. Test the target connection so Studio can inspect JDBC metadata, or add a target.types override to the Pack.`);
    return packTemplate(template,{length:String(spec.length||256),precision:String(spec.precision||38),scale:String(spec.scale==null?10:spec.scale),sourceType:type,semantic});
  }
  if (dialect === 'oracle'){
    if (/^VARCHAR\(/i.test(type)) return type.replace(/^VARCHAR/i, 'VARCHAR2');
    if (upper === 'INT') return 'NUMBER(10)';
    if (upper === 'BYTEA') return spec.semantic==='BINARY_LARGE'?'BLOB':'RAW(32)';
    return type;
  }
  if (dialect === 'mysql'){
    if (upper === 'TIMESTAMP') return 'DATETIME(6)';
    if (upper === 'BYTEA') return spec.semantic==='BINARY_LARGE'?'LONGBLOB':'VARBINARY(32)';
    // MySQL TEXT is limited to 64 KiB; LONGTEXT avoids narrowing large
    // XML/JSON/NTEXT values represented as PostgreSQL TEXT.
    if (upper === 'TEXT') return 'LONGTEXT';
    return type;
  }
  return type;
}
function remoteQuoteIdentifier(value,dialect){
  const text=String(value||'');
  const pack=databasePackForDialect(dialect);
  if(pack){
    const profile=activeTargetProfile(dialect);
    const packQuote=pack.target&&Object.prototype.hasOwnProperty.call(pack.target,'identifierQuote')?pack.target.identifierQuote:undefined;
    const capabilityQuote=pack.capabilities&&Object.prototype.hasOwnProperty.call(pack.capabilities,'identifierQuote')?pack.capabilities.identifierQuote:undefined;
    const q=String(packQuote!==undefined?packQuote:(profile&&Object.prototype.hasOwnProperty.call(profile,'identifierQuote')?profile.identifierQuote:(capabilityQuote!==undefined?capabilityQuote:'"')));
    if(!q){
      if(!externalIdentifierIsSafe(text)) throw new Error(`${pack.label} JDBC metadata reports no quoted-identifier support, and identifier "${text}" is not a safe unquoted SQL name.`);
      return text;
    }
    return q+text.split(q).join(q+q)+q;
  }
  if(dialect==='mysql') return '`'+text.replace(/`/g,'``')+'`';
  return '"'+text.replace(/"/g,'""')+'"';
}
function remoteQualifiedName(tableName, dialect, database, schema){
  const table=remoteQuoteIdentifier(tableName,dialect);
  if (dialect === 'mysql') return database ? `${remoteQuoteIdentifier(database,dialect)}.${table}` : table;
  const pack=databasePackForDialect(dialect);
  if(pack){
    const parts=[];
    if(pack.namespace?.usesCatalog&&database) parts.push(remoteQuoteIdentifier(database,dialect));
    if(pack.namespace?.usesSchema&&schema) parts.push(remoteQuoteIdentifier(schema,dialect));
    parts.push(table);
    return parts.join('.');
  }
  return schema ? `${remoteQuoteIdentifier(schema,dialect)}.${table}` : table;
}
function remoteCreateTable(tableName, cols, dialect, database, schema){
  const qname = remoteQualifiedName(tableName, dialect, database, schema);
  const body = cols.map(c=>`  ${remoteQuoteIdentifier(c.name,dialect)} ${remoteType(c.type, dialect, c)}${c.notNull?' NOT NULL':''}`).join(',\n');
  const pack=databasePackForDialect(dialect);
  if(pack){
    if(pack.target&&pack.target.createTableSql) return packTemplate(pack.target.createTableSql,{qualifiedName:qname,table:remoteQuoteIdentifier(tableName,dialect),schema:remoteQuoteIdentifier(schema||'',dialect),database:remoteQuoteIdentifier(database||'',dialect),columns:body});
    // Generic Pack deployment checks table existence through JDBC before DDL.
    // Only emit vendor-specific IF NOT EXISTS when the Pack explicitly opts in.
    const ifNotExists=pack.target&&pack.target.createTableIfNotExists===true?' IF NOT EXISTS':'';
    return `CREATE TABLE${ifNotExists} ${qname} (\n${body}\n);`;
  }
  if (dialect==='postgresql' || dialect==='mysql') return `CREATE TABLE IF NOT EXISTS ${qname} (\n${body}\n);`;
  return `CREATE TABLE ${qname} (\n${body}\n);`;
}

function buildExternalTablesDdl(onlyTableNames=null){
  const ext = state.externalTables;
  const dialect = ext.remoteDialect || 'postgresql';
  const database = ext.studioDatabase || ext.remoteDatabase;
  const schema = ext.studioSchema || ext.remoteSchema;
  const wanted=onlyTableNames?new Set(onlyTableNames.map(String)):null;
  const parts = [
    `-- =========================================================`,
    `-- REMOTE CORE DATA VAULT TABLE DDL`,
    `-- Run against ${database||'(database)'}${schema?'.'+schema:''}.`,
    `-- Only hub/link/sat/lsat physical tables belong here.`,
    `-- Views and *_err tables deliberately remain local PostgreSQL objects.`,
    `-- =========================================================`,
    '',
  ];
  externalCoreTableSpecs().filter(spec=>!wanted||wanted.has(spec.name)).forEach(spec=>{
    parts.push(`-- ${spec.family.toUpperCase()}: ${spec.name}`);
    parts.push(remoteCreateTable(spec.name, spec.columns, dialect, database, schema));
    parts.push('');
  });
  return parts.join('\n');
}
// Regenerates hop/postgres-environment.json using whatever this vault's
// connection/tenant/mapping-name fields are set to in the Designer, while
// leaving every framework-level constant (syntax strings, commit sizes,
// insert-copy parallelism, CDC sentinels) exactly as they are in a real
// deployment — those never come from anything the person configures here.
// Passwords are deliberately kept as ${VAULT_PASSWORD}/${SOURCE_PASSWORD}
// references rather than real values, matching this project's own .env
// convention — this file should never contain a literal secret.
/* ---- Hop source connection metadata (metadata/rdbms/source.json) ----
   The engine ships with a MySQL source connection by default; this
   generates the right one for the selected source dialect so it can be
   deployed into <project-root>/metadata/rdbms/, overriding the default.
   Connection details stay as ${source_*} environment-variable references
   (resolved from postgres-environment.json at runtime) — never real values. */
