'use strict';

function registerSourceRoutes(parentApp, dependencies){
  const {
    express,
    isPackDialect,
    getDatabasePackForDialect,
    runJdbcBridge,
    packNamespaceFromBody,
    firstNonBlank,
    sourceHopCapabilitiesFromJdbcAnalysis,
    sourceHopCapabilitiesFromHopCatalog,
    sourceHopCapabilitiesFromTables,
    applyPackSemanticTypes,
    openSourceConnection,
    packagedCredentialService,
    requestControls,
  } = dependencies;
  const app = express.Router();

  function hasJdbcDriverOptions(body){
    if(!body || typeof body!=='object') return false;
    if(String(body.manualUrl||body.jdbcUrl||'').trim()) return true;
    const options=body.options&&typeof body.options==='object'
      ? body.options
      : (body.jdbcOptions&&typeof body.jdbcOptions==='object'?body.jdbcOptions:null);
    if(!options) return false;
    return Object.keys(options).some(key=>String(options[key]==null?'':options[key]).trim()!=='');
  }
  // A full Raw Vault is hundreds of tables. JDBC introspection loads primary
  // keys and foreign keys once per table, then returns one JSON document
  // through a capped pipe, so Infer Schema either times out or is killed for
  // producing too much output. PostgreSQL and MySQL already have a single
  // catalog query on the native driver. Custom JDBC URLs and driver options
  // stay on the bridge, because node-pg and mysql2 do not apply those settings.
  function usesNativeCatalogIntrospection(dialect, body){
    return (dialect==='postgresql'||dialect==='postgres'||dialect==='mysql') && !hasJdbcDriverOptions(body);
  }
  function logSchemaIntrospectFailure(dialect, schema, started, err){
    console.error(JSON.stringify({
      event:'schema-introspect.failed',
      dialect:dialect||'',
      schema:schema||'',
      durationMs:Date.now()-started,
      error:String(err&&err.message||err).slice(0,500),
    }));
  }

  function packConnectionFor(body, requestedDialect){
    // The bundled demo has a fixed, server-side MySQL credential profile.
    // Keep it on the native mysql2 path, which is also the path it used before
    // MySQL became Pack-backed. Pack/JDBC remains available for configurable
    // MySQL sources, including their SSL and certificate options.
    if(requestedDialect==='mysql' && body&&body.credentialRef==='packaged-mysql-source') return null;
    const pack=getDatabasePackForDialect(requestedDialect);
    if(!pack) return null;
    if(pack.source.enabled===false) throw new Error(`Database Pack ${pack.label} is not enabled as a source.`);
    return {pack,connection:packagedCredentialService.resolveConnection(body||{})};
  }

  app.post('/api/test-connection', requestControls.guard('connection-test'), async (req, res) => {
    let conn;
    try {
      const requestedDialect=String((req.body&&req.body.dialect)||'postgresql').toLowerCase();
      const resolvedPack=packConnectionFor(req.body,requestedDialect);
      if(resolvedPack){
        const {pack,connection}=resolvedPack;
        // One JDBC metadata pass proves the connection, discovers namespaces, and
        // resolves Hop type capabilities. Previously this path started a JVM for
        // SELECT 1 and then a second JVM for the same connection's metadata.
        const analysis=await runJdbcBridge(pack,connection,'analyze','');
        const ns=packNamespaceFromBody(pack,connection);
        const requestedSchema=String((req.body&&req.body.schema)||'').trim();
        const currentCatalog=firstNonBlank(ns.catalog,analysis.currentCatalog);
        const currentSchema=firstNonBlank(ns.schema,analysis.currentSchema);
        const schemas=(analysis.schemas||[])
          .filter(x=>!currentCatalog || !x.catalog || String(x.catalog).toLowerCase()===String(currentCatalog).toLowerCase())
          .map(x=>typeof x==='string'?x:x.schema).filter(Boolean);
        const catalogs=(analysis.catalogs||[]).map(x=>typeof x==='string'?x:(x&&(x.catalog||x.name))||'').filter(Boolean);
        const sourceCapabilities=sourceHopCapabilitiesFromJdbcAnalysis(pack,analysis);
        return res.json({
          ok:true,dialect:requestedDialect,sourceCapabilities,
          pack:{id:pack.id,label:pack.label,version:pack.version},
          schemas:[...new Set(schemas)],catalogs:[...new Set(catalogs)],currentCatalog,currentSchema
        });
      }
      conn = await openSourceConnection(req.body);
      await conn.query(conn.testSql || 'SELECT 1');
      const sourceCapabilities=sourceHopCapabilitiesFromHopCatalog(conn.dialect);
      res.json({ ok: true, dialect: conn.dialect, sourceCapabilities });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      if (conn) { try { await conn.end(); } catch (_) {} }
    }
  });
  
  // Lists non-system schemas in a database that IS reachable — used right
  // after a successful source connection so the person can pick the real
  // schema name instead of guessing (a mismatched schema is the #1 reason
  // "introspect" comes back with zero tables). In MySQL, "schema" and
  // "database" are the same thing.
  app.post('/api/list-schemas', requestControls.guard('introspection'), async (req, res) => {
    let conn;
    try {
      const requestedDialect=String((req.body&&req.body.dialect)||'postgresql').toLowerCase();
      const resolvedPack=packConnectionFor(req.body,requestedDialect);
      if(resolvedPack){
        const {pack,connection}=resolvedPack;
        const analysis=await runJdbcBridge(pack,connection,'analyze','');
        const ns=packNamespaceFromBody(pack,connection);
        const effectiveCatalog=firstNonBlank(ns.catalog,analysis.currentCatalog);
        const effectiveSchema=firstNonBlank(ns.schema,analysis.currentSchema);
        const schemas=(analysis.schemas||[])
          .filter(x=>!effectiveCatalog || !x.catalog || x.catalog===effectiveCatalog)
          .map(x=>typeof x==='string'?x:x.schema).filter(Boolean);
        return res.json({ ok:true, schemas:[...new Set(schemas)], catalogs:analysis.catalogs||[], currentCatalog:effectiveCatalog, currentSchema:effectiveSchema, namespace:pack.namespace||{}, analysis });
      }
      conn = await openSourceConnection(req.body);
      let sql, params;
      if (conn.dialect === 'mysql') {
        sql = `SELECT schema_name AS schema_name FROM information_schema.schemata
           WHERE schema_name NOT IN ('information_schema','mysql','performance_schema','sys')
           ORDER BY schema_name = ? DESC, schema_name;`;
        params = [req.body.database];
      } else {
        sql = `SELECT schema_name FROM information_schema.schemata
           WHERE schema_name NOT IN ('pg_catalog','information_schema')
             AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%'
           ORDER BY schema_name = 'public' DESC, schema_name;`;
        params = [];
      }
      const result = await conn.query(sql, params);
      res.json({ ok: true, schemas: result.rows.map(r => r.schema_name) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      if (conn) { try { await conn.end(); } catch (_) {} }
    }
  });
  
  const INTROSPECT_SQL = `
    SELECT
      c.table_name,
      t.table_type,
      c.column_name,
      c.ordinal_position,
      c.data_type,
      c.udt_name,
      c.character_maximum_length,
      c.numeric_precision,
      c.numeric_scale,
      c.is_nullable,
      CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name   = c.table_name
    LEFT JOIN (
      SELECT DISTINCT kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema   = kcu.table_schema
       AND tc.table_name     = kcu.table_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = $1
    ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
    WHERE c.table_schema = $1
    ORDER BY c.table_name, c.ordinal_position;
  `;
  
  // MySQL's information_schema follows the same standard shape for the
  // columns used here — just `?` placeholders instead of `$1`, and no
  // udt_name (MySQL has no array types, so that column doesn't exist).
  // Critically, MySQL names EVERY primary key constraint literally
  // "PRIMARY" (not a per-table unique name like Postgres's customer_pkey),
  // so the join must also match on table_name explicitly — otherwise every
  // table's PK column cross-multiplies against every other table's
  // "PRIMARY"-named constraint, producing duplicate rows.
  //
  // Every selected column below is EXPLICITLY aliased in lowercase. Real
  // MySQL (unlike MariaDB) returns information_schema query results using
  // the catalog's own defined column-name case — which is uppercase
  // (TABLE_NAME, COLUMN_NAME, ...) — regardless of how you reference the
  // column in the SELECT list, unless you alias it yourself. Without this,
  // row.table_name comes back undefined on real MySQL, and every row
  // silently collapses into one table literally named "undefined".
  const MYSQL_INTROSPECT_SQL = `
    SELECT
      c.table_name AS table_name,
      t.table_type AS table_type,
      c.column_name AS column_name,
      c.ordinal_position AS ordinal_position,
      c.data_type AS data_type,
      c.character_maximum_length AS character_maximum_length,
      c.numeric_precision AS numeric_precision,
      c.numeric_scale AS numeric_scale,
      c.is_nullable AS is_nullable,
      CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name   = c.table_name
    LEFT JOIN (
      SELECT DISTINCT kcu.table_name AS table_name, kcu.column_name AS column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema   = kcu.table_schema
       AND tc.table_name     = kcu.table_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = ?
    ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
    WHERE c.table_schema = ?
    ORDER BY c.table_name, c.ordinal_position;
  `;
  
  // Every MySQL data_type value that has no direct Postgres equivalent,
  // mapped to the closest safe Postgres type. This is meant to be the
  // COMPLETE list, not a reactive patch for whatever happened to show up
  // in one dataset — MySQL has a fixed, documented set of column types, so
  // this was built by testing every one of them against real Postgres
  // directly (CREATE TABLE with each bare type name) rather than guessing.
  // Anything not in this map is passed through unchanged because it's
  // already valid Postgres syntax as-is (int, bigint, smallint, decimal,
  // float, bit, char, varchar, text, date, time, timestamp, json, boolean).
  const MYSQL_TYPE_MAP = {
    // Numeric — Postgres has no 1/3-byte integer or bare "double" keyword
    tinyint: 'smallint',
    mediumint: 'integer',
    double: 'double precision',
    // Date/time — Postgres has no "datetime"; YEAR is just a small integer
    datetime: 'timestamp',
    year: 'smallint',
    // Binary — Postgres has one variable-length binary type, not MySQL's
    // fixed/variable/size-tiered family
    binary: 'bytea',
    varbinary: 'bytea',
    tinyblob: 'bytea',
    blob: 'bytea',
    mediumblob: 'bytea',
    longblob: 'bytea',
    // Text — Postgres has one unbounded text type, not MySQL's size-tiered family
    tinytext: 'text',
    mediumtext: 'text',
    longtext: 'text',
    // MySQL's inline pseudo-types — no Postgres equivalent in this form.
    // ENUM's actual allowed values live in COLUMN_TYPE, not DATA_TYPE, so
    // preserving them as a real constraint would need a separate query;
    // this keeps the DDL valid without one.
    enum: 'varchar(255)',
    set: 'text',
    // Spatial — needs PostGIS for a real `geometry` type; text keeps the
    // raw value without requiring the extension to be installed
    geometry: 'text', point: 'text', linestring: 'text', polygon: 'text',
    multipoint: 'text', multilinestring: 'text', multipolygon: 'text', geometrycollection: 'text',
  };
  
  function formatType(row, dialect='postgresql') {
    const t = String(row.data_type || '').toLowerCase();
    if (t === 'character varying' || t === 'varchar') return `varchar(${row.character_maximum_length || 255})`;
    if (t === 'character' || t === 'char') return `char(${row.character_maximum_length || 1})`;
    if (t === 'numeric' || t === 'decimal') {
      if (row.numeric_precision != null && row.numeric_scale != null) return `numeric(${row.numeric_precision},${row.numeric_scale})`;
      return 'numeric';
    }
    if (t === 'timestamp without time zone') return 'timestamp';
    if (t === 'timestamp with time zone') return 'timestamptz';
    if (row.data_type === 'ARRAY') return `${(row.udt_name || 'text').replace(/^_/, '')}[]`;
    if (dialect === 'mysql' && Object.prototype.hasOwnProperty.call(MYSQL_TYPE_MAP, t)) return MYSQL_TYPE_MAP[t];
    return t;
  }
  
  // Foreign keys per schema. These power the GUI's deterministic "Suggest
  // from keys" modelling (hubs from referenced PKs, links from FK-bearing
  // tables) — no AI key needed. Column names are aliased lowercase for the
  // same real-MySQL reason documented on MYSQL_INTROSPECT_SQL.
  const PG_FK_SQL = `
    SELECT
      tc.constraint_name AS constraint_name,
      kcu.ordinal_position AS ordinal_position,
      tc.table_name AS table_name,
      kcu.column_name AS column_name,
      ref_kcu.table_name AS ref_table_name,
      ref_kcu.column_name AS ref_column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.constraint_schema = kcu.constraint_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
     AND rc.constraint_schema = tc.constraint_schema
    JOIN information_schema.key_column_usage ref_kcu
      ON ref_kcu.constraint_name = rc.unique_constraint_name
     AND ref_kcu.constraint_schema = rc.unique_constraint_schema
     AND ref_kcu.ordinal_position = kcu.position_in_unique_constraint
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
    ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
  `;
  const MYSQL_FK_SQL = `
    SELECT
      kcu.constraint_name AS constraint_name,
      kcu.ordinal_position AS ordinal_position,
      kcu.table_name AS table_name,
      kcu.column_name AS column_name,
      kcu.referenced_table_name AS ref_table_name,
      kcu.referenced_column_name AS ref_column_name
    FROM information_schema.key_column_usage kcu
    WHERE kcu.table_schema = ? AND kcu.referenced_table_name IS NOT NULL
    ORDER BY kcu.table_name, kcu.constraint_name, kcu.ordinal_position;
  `;
  // Approximate row counts — pg_stat_user_tables is maintained by autovacuum's
  // stats collector (cheap, no seq scans); MySQL's information_schema.tables
  // carries the same estimate. Both are approximations, which is exactly what
  // a modelling tool needs (is this table 10 rows or 10 million?).
  const PG_ROWCOUNT_SQL = `
    SELECT relname AS table_name, n_live_tup AS approx_rows
    FROM pg_stat_user_tables WHERE schemaname = $1;
  `;
  const MYSQL_ROWCOUNT_SQL = `
    SELECT table_name AS table_name, table_rows AS approx_rows
    FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE';
  `;
  
  function quoteSourceIdentifier(dialect, value){
    const text = String(value == null ? '' : value);
    if (dialect === 'mysql') return '`' + text.replace(/`/g, '``') + '`';
    return '"' + text.replace(/"/g, '""') + '"';
  }


  function jdbcSourceConnection(pack, connection, dialect){
    return {
      dialect,
      query: async sql => {
        const data=await runJdbcBridge(pack,connection,'query',String(sql||''));
        return {rows:Array.isArray(data.rows)?data.rows:[],fields:Array.isArray(data.fields)?data.fields.map(name=>({name})):[],rowCount:Number(data.rowCount||0)};
      },
      queryBatch: async sqls => {
        const data=await runJdbcBridge(pack,connection,'batch-query',(sqls||[]).map(String).join('\u001e'));
        return Array.isArray(data.results) ? data.results.map(result=>({
          ok:result&&result.ok===true,
          error:result&&result.error,
          rows:Array.isArray(result&&result.rows)?result.rows:[],
          fields:Array.isArray(result&&result.fields)?result.fields.map(name=>({name})):[],
          rowCount:Number((result&&result.rowCount)||0),
        })) : [];
      },
      end: async()=>{},
    };
  }

  function sourceSqlLiteral(value){
    return `'${String(value==null?'':value).replace(/'/g,"''")}'`;
  }

  function builtinPackRowCountSql(dialect, schema){
    return dialect==='mysql'
      ? `SELECT table_name AS table_name, table_rows AS approx_rows FROM information_schema.tables WHERE table_schema = ${sourceSqlLiteral(schema)} AND table_type = 'BASE TABLE'`
      : `SELECT relname AS table_name, n_live_tup AS approx_rows FROM pg_stat_user_tables WHERE schemaname = ${sourceSqlLiteral(schema)}`;
  }

  function applyBuiltinPackRowCountRows(rows, tables){
    const byTable={};
    for(const row of rows||[]){
      const name=row.table_name!=null?row.table_name:row.TABLE_NAME;
      const count=row.approx_rows!=null?row.approx_rows:row.APPROX_ROWS;
      if(name!=null) byTable[String(name)]=count==null?null:Number(count);
    }
    for(const table of tables||[]) table.approxRows=Object.prototype.hasOwnProperty.call(byTable,table.name)?byTable[table.name]:null;
  }

  async function applyBuiltinPackRowCounts(conn, schema, tables){
    const sql=builtinPackRowCountSql(conn.dialect,schema);
    try{
      const rows=(await conn.query(sql,[])).rows||[];
      applyBuiltinPackRowCountRows(rows,tables);
    }catch(_){
      for(const table of tables||[]) if(table.approxRows===undefined) table.approxRows=null;
    }
  }
  
  // Infer-schema profiling is deliberately narrower than the manual Profile
  // button. Only source PK / NOT NULL columns can produce a staging NOT NULL
  // constraint, so only those columns need a blank/NULL scan here. One aggregate
  // query per table avoids issuing a separate full-table scan for every column.
  function constraintProfileQueries(conn, schema, tables){
    const dialect = conn.dialect;
    const qSchema = quoteSourceIdentifier(dialect, schema);
    const queries=[];
    for (const table of tables){
      if (table.objectType !== 'table') continue;
      const columns = table.columns.filter(c => c.pk === true || c.nullable === false);
      if (!columns.length) continue;
      const expressions = ['COUNT(*) AS total_rows'];
      columns.forEach((col, index) => {
        const qCol = quoteSourceIdentifier(dialect, col.name);
        const nullAlias = quoteSourceIdentifier(dialect, `c${index}_null`);
        const blankAlias = quoteSourceIdentifier(dialect, `c${index}_blank`);
        if (dialect === 'mysql'){
          expressions.push(`SUM(${qCol} IS NULL) AS ${nullAlias}`);
          expressions.push(`SUM(CASE WHEN ${qCol} IS NOT NULL AND TRIM(CAST(${qCol} AS CHAR)) = '' THEN 1 ELSE 0 END) AS ${blankAlias}`);
        } else {
          expressions.push(`COUNT(*) FILTER (WHERE ${qCol} IS NULL) AS ${nullAlias}`);
          expressions.push(`COUNT(*) FILTER (WHERE ${qCol} IS NOT NULL AND BTRIM(CAST(${qCol} AS text)) = '') AS ${blankAlias}`);
        }
      });
      const qTable = quoteSourceIdentifier(dialect, table.name);
      queries.push({table,columns,sql:`SELECT ${expressions.join(', ')} FROM ${qSchema}.${qTable}`});
    }
    return queries;
  }

  function applyConstraintProfileResults(queries, results){
    const warnings=[];
    let profiledColumns=0;
    queries.forEach((query,index)=>{
      const result=results[index];
      if(!result||result.ok===false){
        warnings.push(`${query.table.name}: ${(result&&result.error)||'Profile query failed.'}`);
        return;
      }
      try {
        const row = result.rows[0] || {};
        const totalRows = Number(row.total_rows || 0);
        query.columns.forEach((col, columnIndex) => {
          col.profile={
            totalRows,
            distinctValues: null,
            nullValues:Number(row[`c${columnIndex}_null`]||0),
            blankValues:Number(row[`c${columnIndex}_blank`]||0),
            source: 'infer-schema',
          };
          profiledColumns++;
        });
      }catch(err){warnings.push(`${query.table.name}: ${err.message}`);}
    });
    return {attemptedColumns:queries.reduce((total,query)=>total+query.columns.length,0),profiledColumns,warnings};
  }

  async function profileConstraintSensitiveColumns(conn, schema, tables){
    const queries=constraintProfileQueries(conn,schema,tables);
    const results=typeof conn.queryBatch==='function'
      ? await conn.queryBatch(queries.map(query=>query.sql))
      : await Promise.all(queries.map(async query=>{
        try{return {...await conn.query(query.sql,[]),ok:true};}
        catch(err){return {ok:false,error:err.message};}
      }));
    return applyConstraintProfileResults(queries,results);
  }
  
  app.post('/api/introspect', requestControls.guard('introspection'), async (req, res) => {
    const requestedDialect=String((req.body&&req.body.dialect)||'postgresql').toLowerCase();
    const started=Date.now();
    const resolvedPack=usesNativeCatalogIntrospection(requestedDialect, req.body)?null:packConnectionFor(req.body,requestedDialect);
    if (resolvedPack) {
      try {
        const {pack,connection}=resolvedPack;
        const ns=packNamespaceFromBody(pack,connection);
        // A schema selected in Studio scopes this metadata request only; it
        // does not mutate the saved connection's legacy default schema.
        const requestedSchema=String((req.body&&req.body.schema)||'').trim();
        const jdbcCatalog=requestedDialect==='mysql'?String(connection.database||''):ns.catalog;
        const jdbcSchema=requestedDialect==='mysql'?'':(requestedSchema||ns.schema);
        const raw=await runJdbcBridge(pack,connection,'introspect',`${jdbcCatalog}
${jdbcSchema}`);
        const data=applyPackSemanticTypes(pack,raw);
        const builtinPack=requestedDialect==='mysql'||requestedDialect==='postgresql'||requestedDialect==='postgres';
        let profileSummary={attemptedColumns:0,profiledColumns:0,warnings:[]};
        if(builtinPack){
          const values=connection&&connection.packValues&&typeof connection.packValues==='object'?connection.packValues:{};
          const effectiveSchema=requestedDialect==='mysql'
            ? firstNonBlank(connection.database,values.database,data.catalog,data.schema)
            : firstNonBlank(requestedSchema,ns.schema,data.schema,'public');
          const conn=jdbcSourceConnection(pack,connection,requestedDialect==='postgres'?'postgresql':requestedDialect);
          if(req.body&&req.body.profileColumns===true){
            // Keep all automatic profiling on the one JDBC connection opened by
            // the bridge. The prior Pack implementation spawned a JVM for the
            // row estimate and again for every source table.
            const profileQueries=constraintProfileQueries(conn,effectiveSchema,data.tables||[]);
            try{
              const results=await conn.queryBatch([builtinPackRowCountSql(conn.dialect,effectiveSchema),...profileQueries.map(query=>query.sql)]);
              const rowCounts=results[0];
              if(rowCounts&&rowCounts.ok) applyBuiltinPackRowCountRows(rowCounts.rows,data.tables||[]);
              else for(const table of data.tables||[]) table.approxRows=null;
              profileSummary=applyConstraintProfileResults(profileQueries,results.slice(1));
            }catch(_){
              // Row estimates are helpful but must not prevent the source
              // metadata from being returned when a driver rejects one query.
              await applyBuiltinPackRowCounts(conn,effectiveSchema,data.tables||[]);
              profileSummary=await profileConstraintSensitiveColumns(conn,effectiveSchema,data.tables||[]);
            }
          }else await applyBuiltinPackRowCounts(conn,effectiveSchema,data.tables||[]);
          const sourceCapabilities=sourceHopCapabilitiesFromTables(data.tables||[]);
          return res.json({ok:true,catalog:data.catalog||ns.catalog,schema:effectiveSchema,tables:data.tables||[],foreignKeys:data.foreignKeys||[],sourceCapabilities,profileSummary,pack:{id:pack.id,label:pack.label,version:pack.version}});
        }
        // Introspection already gives enough column evidence for a fallback Hop
        // capability profile. Do not immediately start another JVM just to run
        // JDBC getTypeInfo(); a richer jdbc-type-info profile is captured by the
        // connection test and the browser preserves it when present.
        const sourceCapabilities=sourceHopCapabilitiesFromTables(data.tables||[]);
        return res.json({ ok:true, catalog:data.catalog||ns.catalog, schema:data.schema||requestedSchema||ns.schema, tables:data.tables||[], foreignKeys:data.foreignKeys||[], sourceCapabilities, profileSummary:{attemptedColumns:0,profiledColumns:0,warnings:[],infos:['JDBC metadata was used for declared keys and nullability. Where source constraints are incomplete, review the model manually or use AI Assist.']}, pack:{id:pack.id,label:pack.label,version:pack.version} });
      } catch(err){
        logSchemaIntrospectFailure(requestedDialect, String((req.body&&req.body.schema)||'').trim(), started, err);
        return res.status(400).json({ok:false,error:err.message});
      }
    }
    const schema = (req.body && req.body.schema) || ((req.body && req.body.dialect) === 'mysql' ? (req.body.database || '') : 'public');
    let conn;
    try {
      conn = await openSourceConnection(req.body);
      if(conn.dialect==='postgresql'){
        // Bound a stuck catalog read. The native driver has no JVM kill, and
        // information_schema on a just-loaded vault can still be slow.
        try{ await conn.query("SET statement_timeout = '120s'"); }catch(_){}
      }
      const result = conn.dialect === 'mysql'
        ? await conn.query(MYSQL_INTROSPECT_SQL, [schema, schema])
        : await conn.query(INTROSPECT_SQL, [schema]);
  
      let fkRows = [], countRows = [];
      try {
        const fkSql = conn.dialect === 'mysql' ? MYSQL_FK_SQL : PG_FK_SQL;
        fkRows = (await conn.query(fkSql, [schema])).rows;
      } catch (_) { fkRows = []; }
      try {
        const countSql = conn.dialect === 'mysql' ? MYSQL_ROWCOUNT_SQL : PG_ROWCOUNT_SQL;
        countRows = (await conn.query(countSql, [schema])).rows;
      } catch (_) { countRows = []; }
      const approxRowsByTable = {};
      countRows.forEach(r => { approxRowsByTable[r.table_name] = r.approx_rows == null ? null : Number(r.approx_rows); });
  
      const byTable = {};
      const objectTypeByTable = {};
      result.rows.forEach(row => {
        if (!byTable[row.table_name]) byTable[row.table_name] = [];
        objectTypeByTable[row.table_name] = String(row.table_type || '').toUpperCase().includes('VIEW') ? 'view' : 'table';
        byTable[row.table_name].push({
          name: row.column_name,
          type: formatType(row, conn.dialect),
          nullable: row.is_nullable === 'YES',
          pk: row.is_pk === true || row.is_pk === 1,
        });
      });
      const tables = Object.entries(byTable).map(([name, columns]) => ({
        name, columns,
        objectType: objectTypeByTable[name] || 'table',
        approxRows: approxRowsByTable[name] != null ? approxRowsByTable[name] : null,
      }));
      const foreignKeys = fkRows.map(r => ({
        table: r.table_name, column: r.column_name,
        refTable: r.ref_table_name, refColumn: r.ref_column_name,
        constraintName: r.constraint_name || '',
        ordinalPosition: r.ordinal_position == null ? null : Number(r.ordinal_position),
      }));
      const profileSummary = req.body && req.body.profileColumns === true
        ? await profileConstraintSensitiveColumns(conn, schema, tables)
        : { attemptedColumns: 0, profiledColumns: 0, warnings: [] };
      const sourceCapabilities=sourceHopCapabilitiesFromHopCatalog(conn.dialect);
      res.json({ ok: true, schema, tables, foreignKeys, sourceCapabilities, profileSummary });
    } catch (err) {
      logSchemaIntrospectFailure(requestedDialect, schema, started, err);
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      if (conn) { try { await conn.end(); } catch (_) {} }
    }
  });

  // Table profile used by the single Profile table button. It returns row,
  // distinct, SQL-null and blank counts for every requested column using one
  // aggregate scan. Identifiers are validated before any connection is opened.
  const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
  app.post('/api/profile-table', requestControls.guard('introspection'), async (req, res) => {
    const requestedDialect=String((req.body&&req.body.dialect)||'postgresql').toLowerCase();
    if (isPackDialect(requestedDialect)) return res.status(400).json({ok:false,error:'Live table profiling is not available for Database Pack sources; JDBC-declared nullability is retained and keys can be reviewed manually or with AI Assist.'});
    const { schema, table, columns } = req.body || {};
    for (const [label, val] of [['schema', schema], ['table', table]]){
      if (!val || !IDENT_RE.test(val)) return res.status(400).json({ ok:false, error:`Invalid ${label} identifier: ${val}` });
    }
    if (!Array.isArray(columns) || !columns.length || columns.length > 500) {
      return res.status(400).json({ ok:false, error:'Profile columns must be a non-empty array of at most 500 identifiers.' });
    }
    for (const column of columns){
      if (!column || !IDENT_RE.test(column)) return res.status(400).json({ ok:false, error:`Invalid column identifier: ${column}` });
    }
  
    let conn;
    try {
      const resolvedPack=packConnectionFor(req.body,requestedDialect);
      conn = resolvedPack
        ? jdbcSourceConnection(resolvedPack.pack,resolvedPack.connection,requestedDialect==='postgres'?'postgresql':requestedDialect)
        : await openSourceConnection(req.body);
      const dialect = conn.dialect;
      const qSchema = quoteSourceIdentifier(dialect, schema);
      const qTable = quoteSourceIdentifier(dialect, table);
      const expressions = ['COUNT(*) AS total_rows'];
      columns.forEach((column, index)=>{
        const qCol = quoteSourceIdentifier(dialect, column);
        const distinctAlias = quoteSourceIdentifier(dialect, `c${index}_distinct`);
        const nullAlias = quoteSourceIdentifier(dialect, `c${index}_null`);
        const blankAlias = quoteSourceIdentifier(dialect, `c${index}_blank`);
        if (dialect === 'mysql'){
          expressions.push(`COUNT(DISTINCT CAST(${qCol} AS CHAR)) AS ${distinctAlias}`);
          expressions.push(`SUM(${qCol} IS NULL) AS ${nullAlias}`);
          expressions.push(`SUM(CASE WHEN ${qCol} IS NOT NULL AND TRIM(CAST(${qCol} AS CHAR)) = '' THEN 1 ELSE 0 END) AS ${blankAlias}`);
        } else {
          expressions.push(`COUNT(DISTINCT CAST(${qCol} AS text)) AS ${distinctAlias}`);
          expressions.push(`COUNT(*) FILTER (WHERE ${qCol} IS NULL) AS ${nullAlias}`);
          expressions.push(`COUNT(*) FILTER (WHERE ${qCol} IS NOT NULL AND BTRIM(CAST(${qCol} AS text)) = '') AS ${blankAlias}`);
        }
      });
      const result = await conn.query(`SELECT ${expressions.join(', ')} FROM ${qSchema}.${qTable}`, []);
      const row = result.rows[0] || {};
      const totalRows = Number(row.total_rows || 0);
      const profiles = columns.map((column, index)=>({
        column,
        totalRows,
        distinctValues:Number(row[`c${index}_distinct`] || 0),
        nullValues:Number(row[`c${index}_null`] || 0),
        blankValues:Number(row[`c${index}_blank`] || 0),
      }));
      res.json({ ok:true, table, profiles });
    } catch (err) {
      res.status(400).json({ ok:false, error:err.message });
    } finally {
      if (conn) { try { await conn.end(); } catch (_) {} }
    }
  });
  
  // Per-column profile (row/null/distinct counts) to inform business-key and
  // incremental-column choices. Identifiers are strictly validated and then
  // double-quoted / backtick-quoted — never interpolated raw.
  app.post('/api/profile-column', requestControls.guard('introspection'), async (req, res) => {
    const requestedDialect=String((req.body&&req.body.dialect)||'postgresql').toLowerCase();
    if (isPackDialect(requestedDialect)) return res.status(400).json({ok:false,error:'Live column profiling is not available for Database Pack sources; JDBC-declared nullability is retained and keys can be reviewed manually or with AI Assist.'});
    const { schema, table, column } = req.body || {};
    for (const [label, val] of [['schema', schema], ['table', table], ['column', column]]){
      if (!val || !IDENT_RE.test(val)) return res.status(400).json({ ok: false, error: `Invalid ${label} identifier: ${val}` });
    }
    let conn;
    try {
      const resolvedPack=packConnectionFor(req.body,requestedDialect);
      conn = resolvedPack
        ? jdbcSourceConnection(resolvedPack.pack,resolvedPack.connection,requestedDialect==='postgres'?'postgresql':requestedDialect)
        : await openSourceConnection(req.body);
      const dialect = conn.dialect;
      const qSchema = quoteSourceIdentifier(dialect, schema);
      const qTable = quoteSourceIdentifier(dialect, table);
      const qColumn = quoteSourceIdentifier(dialect, column);
      let q;
      if (dialect === 'mysql') {
        q = `SELECT COUNT(*) AS total_rows,
                    COUNT(DISTINCT CAST(${qColumn} AS CHAR)) AS distinct_values,
                    SUM(${qColumn} IS NULL) AS null_values,
                    SUM(CASE WHEN ${qColumn} IS NOT NULL AND TRIM(CAST(${qColumn} AS CHAR)) = '' THEN 1 ELSE 0 END) AS blank_values
               FROM ${qSchema}.${qTable}`;
      } else {
        q = `SELECT COUNT(*) AS total_rows,
                    COUNT(DISTINCT ${qColumn}) AS distinct_values,
                    COUNT(*) FILTER (WHERE ${qColumn} IS NULL) AS null_values,
                    COUNT(*) FILTER (WHERE BTRIM(CAST(${qColumn} AS text)) = '') AS blank_values
               FROM ${qSchema}.${qTable}`;
      }
      const result = await conn.query(q, []);
      const row = result.rows[0] || {};
      res.json({
        ok: true,
        totalRows: Number(row.total_rows || 0),
        distinctValues: Number(row.distinct_values || 0),
        nullValues: Number(row.null_values || 0),
        blankValues: Number(row.blank_values || 0),
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      if (conn) { try { await conn.end(); } catch (_) {} }
    }
  });
  
  // Writes a set of generated files to a folder on this machine — e.g. a
  // path your Docker container has bind-mounted, so the generated DDL/
  // workbook land exactly where the Hop container expects them without a
  // manual browser-download-then-drag-into-folder step.
  //
  // File names are restricted to simple filenames (no path separators or
  // ".."), so this can only ever write inside the folder you specify —
  // never elsewhere on disk.
  //
  // `encoding` is optional and applies to every file in this call: 'utf8'
  // (default, for .sql text) or 'base64' (for binary files like the .xls
  // mapping workbook, which would otherwise get corrupted if written as
  // text).
  // Folder arguments from the browser are confined to the project root —
  // even with token auth in place, a design tool has no business writing
  // outside its own project tree. Symlinks are resolved before comparing so
  // a link inside the project can't smuggle writes elsewhere.
  parentApp.use(app);
}

module.exports = { registerSourceRoutes };
