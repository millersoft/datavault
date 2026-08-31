'use strict';

function registerTargetRoutes(parentApp, dependencies){
  const {
    express,
    connectPgWithFallback,
    openSourceConnection,
    isPackDialect,
  } = dependencies;
  const app = express.Router();

  app.post('/api/db-status', async (req, res) => {
    const { database, maintenanceDatabase } = req.body || {};
    let client;
    try {
      client = await connectPgWithFallback({ ...req.body, database: maintenanceDatabase || 'postgres' });
      const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
      res.json({ ok: true, connected: true, exists: result.rowCount > 0 });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      if (client) { try { await client.end(); } catch (_) {} }
    }
  });

  app.post('/api/create-database', async (req, res) => {
    const { database, maintenanceDatabase } = req.body || {};
    if (!database || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) {
      return res.status(400).json({ ok: false, error: 'Database name must be a plain identifier (letters, numbers, underscores, not starting with a number).' });
    }
    let client;
    try {
      client = await connectPgWithFallback({ ...req.body, database: maintenanceDatabase || 'postgres' });
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
      if (existing.rowCount > 0) {
        return res.json({ ok: true, created: false, exists: true, message: `Database "${database}" already exists.` });
      }
      await client.query(`CREATE DATABASE "${database}"`);
      const verify = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
      if (!verify.rowCount) throw new Error(`Database "${database}" was not visible after CREATE DATABASE.`);
      res.json({ ok: true, created: true, exists: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      if (client) { try { await client.end(); } catch (_) {} }
    }
  });

  app.post('/api/execute-sql', async (req, res) => {
    const { sql } = req.body || {};
    if (!sql || typeof sql !== 'string' || !sql.trim()) {
      return res.status(400).json({ ok: false, error: 'No SQL provided.' });
    }
    let client;
    try {
      client = await connectPgWithFallback(req.body);
      await client.query('BEGIN');
      try {
        // DDL should apply in seconds. Without these, a lock held by anything
        // else (a running hop load, an abandoned idle-in-transaction session)
        // makes the apply hang FOREVER with no feedback in the GUI. Fail fast
        // with a recognisable error instead; scoped to this transaction only.
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '120s'");
        await client.query(sql);
        await client.query('COMMIT');
        res.json({ ok: true });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      if (client) { try { await client.end(); } catch (_) {} }
    }
  });
  
  // Read-only — for pulling dashboard metrics (run history, record counts,
  // etc). Two layers of protection: a shape check (single SELECT or
  // WITH…SELECT statement), and — the one that actually matters — the query
  // runs inside a READ ONLY transaction that is always rolled back. The old
  // regex-only guard let mutating function calls through (SELECT setval(…),
  // SELECT pg_terminate_backend(…) are syntactically SELECTs) and wrongly
  // rejected legitimate WITH…SELECT CTEs; the read-only transaction closes
  // the former for real, and WITH is now explicitly allowed.
  function isReadOnlyQueryShape(sql){
    if (!sql || typeof sql !== 'string' || !sql.trim()) return false;
    const trimmed = sql.trim();
    const startsRight = /^(SELECT|WITH)\s/i.test(trimmed);
    const singleStatement = !/;.*\S/.test(trimmed.replace(/;\s*$/, ''));
    return startsRight && singleStatement;
  }
  
  // Read-only probes may need to execute as the same PostgreSQL service role
  // that Hop uses. Keep this deliberately narrow: the browser cannot request an
  // arbitrary role, and PostgreSQL still enforces whether the login may SET ROLE.
  const READ_ONLY_QUERY_ROLES = new Set(['data_vault', 'pdi_meta']);
  
  function pgProbeIdentifier(value,label){
    const text=String(value||'').trim();
    if(!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(text)) throw new Error(`Invalid ${label}: ${text||'(blank)'}`);
    return text;
  }
  
  function pgErrorDiagnostic(err, extra={}){
    return {
      error:String((err&&err.message)||'PostgreSQL operation failed.'),
      code:String((err&&err.code)||''),
      severity:String((err&&err.severity)||''),
      detail:String((err&&err.detail)||''),
      hint:String((err&&err.hint)||''),
      where:String((err&&err.where)||''),
      schema:String((err&&err.schema)||''),
      table:String((err&&err.table)||''),
      column:String((err&&err.column)||''),
      routine:String((err&&err.routine)||''),
      ...extra,
    };
  }
  
  // jdbc_fdw + SQL Server can reject a pushed-down LIMIT even when the same
  // foreign table is otherwise readable. The Studio health check therefore uses
  // a PostgreSQL cursor: the foreign SELECT itself has no LIMIT, while FETCH 1
  // keeps the browser response bounded for populated Vaults. The statement is
  // fixed apart from validated identifiers; the browser cannot submit SQL here.
  app.post('/api/fdw-smoke', async (req,res)=>{
    const requestedRole=String((req.body&&req.body.role)||'').trim();
    if(!READ_ONLY_QUERY_ROLES.has(requestedRole)){
      return res.status(400).json({ok:false,error:`Unsupported FDW smoke-test role: ${requestedRole||'(blank)'}`});
    }
    let schema,table;
    try{
      schema=pgProbeIdentifier(req.body&&req.body.schema,'schema identifier');
      table=pgProbeIdentifier(req.body&&req.body.table,'table identifier');
    }catch(err){
      return res.status(400).json({ok:false,error:err.message});
    }
    const qIdent=s=>`"${String(s).replace(/"/g,'""')}"`;
    const statement=`SELECT * FROM ${qIdent(schema)}.${qIdent(table)}`;
    const cursor='studio_fdw_smoke';
    let conn;
    let phase='connect';
    try{
      conn=await connectPgWithFallback(req.body||{});
      phase='begin-read-only';
      await conn.query('BEGIN TRANSACTION READ ONLY');
      phase='statement-timeout';
      await conn.query("SET LOCAL statement_timeout = '10s'");
      phase='set-role';
      await conn.query(`SET LOCAL ROLE ${qIdent(requestedRole)}`);
      phase='declare-cursor';
      await conn.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${statement}`);
      phase='fetch-first-row';
      const result=await conn.query(`FETCH FORWARD 1 FROM ${cursor}`);
      phase='close-cursor';
      await conn.query(`CLOSE ${cursor}`);
      await conn.query('ROLLBACK');
      return res.json({
        ok:true,role:requestedRole,schema,table,phase:'verified',statement,
        rowCount:Number(result.rowCount||0),fields:(result.fields||[]).map(f=>f.name),
      });
    }catch(err){
      if(conn) await conn.query('ROLLBACK').catch(()=>{});
      return res.status(400).json({ok:false,...pgErrorDiagnostic(err,{role:requestedRole,schema,table,phase,statement})});
    }finally{
      if(conn){try{await conn.end();}catch(_){}}
    }
  });
  
  app.post('/api/query', async (req, res) => {
    const { sql, role } = req.body || {};
    if (!isReadOnlyQueryShape(sql)) {
      return res.status(400).json({ ok: false, error: 'Only a single SELECT (or WITH … SELECT) statement is allowed on this endpoint.' });
    }
    const requestedRole = String(role || '').trim();
    if (requestedRole && !READ_ONLY_QUERY_ROLES.has(requestedRole)) {
      return res.status(400).json({ ok: false, error: `Unsupported read-only query role: ${requestedRole}` });
    }
    const trimmed = sql.trim();
    let conn;
    try {
      conn = await openSourceConnection(req.body);
      if (isPackDialect(conn.dialect)) {
        if (requestedRole) throw new Error('PostgreSQL SET ROLE is not available for a Database Pack JDBC query connection.');
        const result=await conn.query(trimmed);
        res.json({ok:true,rows:result.rows,fields:(result.fields||[]).map(f=>f.name)});
      } else if (conn.dialect === 'mysql') {
        if (requestedRole) throw new Error('PostgreSQL SET ROLE is not available for a MySQL query connection.');
        await conn.query('SET SESSION MAX_EXECUTION_TIME = 10000');
        const result = await conn.query(trimmed);
        res.json({ ok: true, rows: result.rows, fields: (result.fields || []).map(f => f.name) });
      } else {
        await conn.query('SET statement_timeout = 10000');
        await conn.query('BEGIN TRANSACTION READ ONLY');
        try {
          if (requestedRole) await conn.query(`SET LOCAL ROLE "${requestedRole}"`);
          const requestedSchema=String((req.body&&req.body.schema)||'').trim();
          if(requestedSchema){
            if(!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(requestedSchema)) throw new Error(`Invalid schema identifier: ${requestedSchema}`);
            await conn.query(`SET LOCAL search_path TO "${requestedSchema.replace(/"/g,'""')}", pg_catalog`);
          }
          const result = await conn.query(trimmed);
          res.json({ ok: true, rows: result.rows, fields: (result.fields || []).map(f => f.name) });
        } finally {
          await conn.query('ROLLBACK').catch(() => {});
        }
      }
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      if (conn) { try { await conn.end(); } catch (_) {} }
    }
  });
  parentApp.use(app);
}

module.exports = { registerTargetRoutes };
