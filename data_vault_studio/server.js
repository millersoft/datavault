/**
 * Data Vault Studio — local companion server
 * =========================================
 * Purpose: give the Data Vault Studio HTML app a way to touch a real database
 * and filesystem, since a browser cannot open a raw database socket or
 * write files itself.
 *
 *   GET  /api/health           -> confirms the server is up
 *   POST /api/test-connection  -> validates credentials with SELECT 1
 *   POST /api/list-schemas     -> lists real schema names in a database
 *   POST /api/introspect       -> returns table/column/PK metadata
 *   POST /api/profile-table     -> profiles every requested column in one table scan
 *   POST /api/db-status        -> checks whether a database exists
 *   POST /api/create-database  -> creates a database if missing
 *   POST /api/deploy-files     -> writes generated files to a local folder
 *   POST /api/env-credentials/status -> compares GUI passwords with the root .env
 *   POST /api/env-credentials        -> patches the allowlisted runtime secrets in root .env
 *                                  (defaults to <project-root>/db-init,
 *                                  derived from this file's own location;
 *                                  pass encoding:'base64' for binary files)
 *   POST /api/execute-sql      -> runs a SQL script against a real database
 *   POST /api/query            -> runs a single read-only SELECT, returns rows
 *   POST /api/docker/run-hop      -> runs `start.sh up -d hop`
 *   POST /api/docker/status       -> runs `docker compose ps` (read-only)
 *
 * It is STATELESS: every request carries its own connection details,
 * a fresh client is opened, the query runs, the client closes. Nothing
 * is written to disk except the generated artifacts requested through
 * explicit deployment endpoints. The project-root .env is never a generic
 * artifact deployment target; only the dedicated credential endpoint can
 * patch its small allowlist of existing runtime variables. It only ever binds
 * to 127.0.0.1, so nothing outside your own machine can reach it.
 *
 * Run it with:
 *   npm install
 *   npm start
 */
const express = require('express');
const cors = require('cors');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
let mssqlModule = null;
function getMssql(){
  if (mssqlModule) return mssqlModule;
  try {
    mssqlModule = require('mssql');
    return mssqlModule;
  } catch (_) {
    throw new Error('SQL Server support requires the mssql package. Run npm install in data_vault_studio before connecting.');
  }
}
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function resolveStudioMode(argv = process.argv.slice(2)) {
  let requested = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if (arg.startsWith('--mode=')) requested = arg.slice('--mode='.length);
    else if (arg === '--mode' && argv[i + 1]) requested = String(argv[++i]);
  }
  const mode = (requested || process.env.STUDIO_MODE || 'production').trim().toLowerCase();
  if (!['demo', 'production'].includes(mode)) {
    throw new Error(`Invalid Studio mode "${mode}". Use --mode=demo or --mode=production.`);
  }
  return mode;
}

const STUDIO_MODE = resolveStudioMode();
const PORT = process.env.PORT || 8420;
const app = express();

// ---------------------------------------------------------------------------
// PROJECT ROOT — resolved up-front because the auth token, scheduler state,
// and every folder default hang off it. Walks up from likely start points
// looking for start.sh + a compose file (the packaged layout is
// <project-root>/data_vault_studio/server.js).
// ---------------------------------------------------------------------------
function existingDirectory(candidate){
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch (_) {
    return null;
  }
}

function findProjectRoot(){
  const starts = [
    process.env.DVS_PROJECT_ROOT,
    process.env.PROJECT_ROOT,
    process.cwd(),
    __dirname,
  ].map(existingDirectory).filter(Boolean);

  const seen = new Set();
  for (const start of starts){
    let dir = start;
    while (!seen.has(dir)){
      seen.add(dir);
      const hasStartScript = fs.existsSync(path.join(dir, 'start.sh'));
      const hasComposeFile = fs.existsSync(path.join(dir, 'docker-compose.yaml'))
        || fs.existsSync(path.join(dir, 'docker-compose.yml'))
        || fs.existsSync(path.join(dir, 'compose.yaml'))
        || fs.existsSync(path.join(dir, 'compose.yml'));
      if (hasStartScript && hasComposeFile) return dir;

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Fallback for partial/unit-test checkouts where only data_vault_studio
  // exists. Runtime actions will return a clear error if start.sh is absent.
  return path.resolve(__dirname, '..');
}

const PROJECT_ROOT = findProjectRoot();
const DB_INIT_PATH = path.join(PROJECT_ROOT, 'db-init');
// mappings/ is another sibling of data_vault_studio at the project root —
// where the mapping workbook needs to land per the project's own layout.
const MAPPINGS_PATH = path.join(PROJECT_ROOT, 'mappings');
const HOP_CONFIG_PATH = path.join(PROJECT_ROOT, 'hop');
const JDBC_DRIVER_PATH = path.join(PROJECT_ROOT, 'jdbc-drivers');
const ENV_FILE_PATH = path.join(PROJECT_ROOT, '.env');
// Hop connection metadata (source.json etc.) lives under metadata/rdbms —
// the engine ships a MySQL default there; the GUI deploys a dialect-correct
// override for the selected source.
const METADATA_RDBMS_PATH = path.join(PROJECT_ROOT, 'metadata', 'rdbms');

app.use(cors({ origin: '*' })); // allow the file:// / http:// front end to call this
// Default express.json() limit is 100kb — too small once a mapping
// workbook (with rows for every hub/link/satellite across a real vault)
// gets base64-encoded, which inflates size by ~33%, and wrapped in JSON.
// 25mb comfortably covers any realistic spreadsheet without inviting abuse.
app.use(express.json({ limit: '25mb' }));

// Serve the GUI itself — opening http://127.0.0.1:8420/ works out of the box
// (the HTML can still be opened directly as a file:// page instead).
app.get('/', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'millersoft_vault_studio.html'), 'utf8')
      .replace(/__STUDIO_RUNTIME_MODE__/g, STUDIO_MODE);
    // The Studio is a single-file local app under active development. Never
    // let a browser reload reuse an older generator from its HTTP cache.
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch (err) {
    res.status(500).send('Could not load millersoft_vault_studio.html: ' + err.message);
  }
});

function makeClient(body) {
  const { host, port, database, user, password } = body || {};
  if (!host || !database || !user) {
    throw new Error('host, database, and user are required.');
  }
  return new Client({
    host,
    port: port ? Number(port) : 5432,
    database,
    user,
    password: password || undefined,
    connectionTimeoutMillis: 6000,
    // Most managed Postgres instances need SSL; relax verification for
    // local/dev boxes that use self-signed certs. Adjust if your source
    // requires strict verification.
    ssl: body.ssl === false ? false : { rejectUnauthorized: false },
  });
}

// Connects with SSL by default (matching most managed Postgres), but
// transparently retries once with SSL turned off if the server says it
// doesn't support SSL at all — which is the common case for local/Docker
// Postgres, including this project's own target database. This means
// neither local dev boxes nor SSL-requiring managed instances need any
// manual configuration.
async function connectPgWithFallback(body) {
  const client = makeClient(body);
  try {
    await client.connect();
    return client;
  } catch (err) {
    if (/does not support SSL/i.test(err.message) && body.ssl !== false) {
      try { await client.end(); } catch (_) {}
      const plainClient = makeClient({ ...body, ssl: false });
      await plainClient.connect();
      return plainClient;
    }
    throw err;
  }
}

// Source connections can be PostgreSQL, MySQL, or an external SQL Server.
// SQL Server is never packaged by this project; it always points at a
// user-managed server. A common interface keeps introspection/reporting code
// independent of the selected database client.
function sqlServerConnectionConfig(body, databaseOverride){
  const input = body || {};
  const hostText = String(input.host || '').trim();
  const database = databaseOverride === undefined ? input.database : databaseOverride;
  if (!hostText || !input.user || !database) throw new Error('host, database, and user are required.');
  const hostParts = hostText.split('\\');
  const server = hostParts.shift();
  const instanceName = hostParts.length ? hostParts.join('\\') : '';
  const config = {
    server,
    database,
    user: input.user,
    password: input.password || undefined,
    connectionTimeout: 6000,
    requestTimeout: 120000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: input.encrypt !== false,
      trustServerCertificate: input.trustServerCertificate !== false,
      enableArithAbort: true,
    },
  };
  if (instanceName && !input.port) config.options.instanceName = instanceName;
  else config.port = input.port ? Number(input.port) : 1433;
  return config;
}

function sqlServerBindParams(request, sqlText, params){
  let index = 0;
  const values = Array.isArray(params) ? params : [];
  const text = String(sqlText).replace(/\?/g, () => {
    if (index >= values.length) throw new Error('SQL Server query has more placeholders than parameters.');
    const name = `p${index}`;
    request.input(name, values[index]);
    index += 1;
    return `@${name}`;
  });
  if (index !== values.length) throw new Error('SQL Server query has more parameters than placeholders.');
  return text;
}

async function openSqlServerConnection(body, databaseOverride){
  const mssql = getMssql();
  const pool = new mssql.ConnectionPool(sqlServerConnectionConfig(body, databaseOverride));
  await pool.connect();
  return {
    dialect: 'sqlserver',
    query: async (sqlText, params=[]) => {
      const request = pool.request();
      const text = sqlServerBindParams(request, sqlText, params);
      const result = await request.query(text);
      const rows = result.recordset || [];
      const columns = result.recordset && result.recordset.columns
        ? Object.keys(result.recordset.columns)
        : (rows[0] ? Object.keys(rows[0]) : []);
      return {
        rows,
        fields: columns.map(name => ({ name })),
        rowCount: rows.length,
        rowsAffected: result.rowsAffected || [],
      };
    },
    batch: async (sqlText) => {
      const result = await pool.request().batch(String(sqlText));
      const rows = result.recordset || [];
      return { rows, rowCount: rows.length, rowsAffected: result.rowsAffected || [] };
    },
    end: async () => pool.close(),
  };
}

async function openSourceConnection(body) {
  const dialect = String((body && body.dialect) || 'postgresql').toLowerCase();
  if (dialect === 'mysql') {
    const { host, port, database, user, password } = body || {};
    if (!host || !database || !user) throw new Error('host, database, and user are required.');
    const conn = await mysql.createConnection({
      host, port: port ? Number(port) : 3306, database, user,
      password: password || undefined, connectTimeout: 6000,
    });
    return {
      dialect: 'mysql',
      query: async (sql, params) => {
        const [rows, fields] = await conn.query(sql, params);
        return {
          rows,
          fields: (fields || []).map(f => ({ name: f.name })),
          rowCount: Array.isArray(rows) ? rows.length : 0,
        };
      },
      end: async () => conn.end(),
    };
  }
  if (dialect === 'sqlserver') return openSqlServerConnection(body);
  if (dialect !== 'postgresql') throw new Error(`Unsupported source dialect "${dialect}".`);
  const client = await connectPgWithFallback(body);
  return {
    dialect: 'postgresql',
    query: async (sql, params) => {
      const result = await client.query(sql, params);
      return {
        rows: result.rows,
        fields: (result.fields || []).map(f => ({ name: f.name })),
        rowCount: result.rowCount,
      };
    },
    end: async () => client.end(),
  };
}

app.get('/api/runtime-profile', (req, res) => {
  res.json({ ok: true, mode: STUDIO_MODE, isDemo: STUDIO_MODE === 'demo', isProduction: STUDIO_MODE === 'production' });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'vault-bench-introspect-server', version: '1.2.0', studioMode: STUDIO_MODE, projectRoot: PROJECT_ROOT, dbInitPath: DB_INIT_PATH, mappingsPath: MAPPINGS_PATH, hopConfigPath: HOP_CONFIG_PATH, jdbcDriverPath: JDBC_DRIVER_PATH, metadataRdbmsPath: METADATA_RDBMS_PATH });
});

app.post('/api/test-connection', async (req, res) => {
  let conn;
  try {
    conn = await openSourceConnection(req.body);
    await conn.query('SELECT 1');
    res.json({ ok: true });
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
app.post('/api/list-schemas', async (req, res) => {
  let conn;
  try {
    conn = await openSourceConnection(req.body);
    let sql, params;
    if (conn.dialect === 'mysql') {
      sql = `SELECT schema_name AS schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('information_schema','mysql','performance_schema','sys')
         ORDER BY schema_name = ? DESC, schema_name;`;
      params = [req.body.database];
    } else if (conn.dialect === 'sqlserver') {
      sql = `SELECT name AS schema_name
         FROM sys.schemas
         WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin','db_securityadmin','db_ddladmin','db_backupoperator','db_datareader','db_datawriter','db_denydatareader','db_denydatawriter')
         ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name;`;
      params = [];
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

// Checks whether a target database exists, WITHOUT requiring it to exist —
// connects to a maintenance database (default "postgres") using the same
// host/user/password, then looks the target name up in pg_database.
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

// Creates the target database if it's missing. Connects to a maintenance
// database (default "postgres") and issues CREATE DATABASE — the
// connecting user needs CREATEDB privilege for this to succeed.
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

const SQLSERVER_INTROSPECT_SQL = `
  SELECT
    c.TABLE_NAME AS table_name,
    t.TABLE_TYPE AS table_type,
    c.COLUMN_NAME AS column_name,
    c.ORDINAL_POSITION AS ordinal_position,
    LOWER(c.DATA_TYPE) AS data_type,
    c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
    c.NUMERIC_PRECISION AS numeric_precision,
    c.NUMERIC_SCALE AS numeric_scale,
    c.IS_NULLABLE AS is_nullable,
    CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS is_pk
  FROM INFORMATION_SCHEMA.COLUMNS c
  JOIN INFORMATION_SCHEMA.TABLES t
    ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
   AND t.TABLE_NAME = c.TABLE_NAME
  LEFT JOIN (
    SELECT DISTINCT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
      ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
     AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
     AND tc.TABLE_NAME = kcu.TABLE_NAME
    WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      AND tc.TABLE_SCHEMA = ?
  ) pk
    ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA
   AND pk.TABLE_NAME = c.TABLE_NAME
   AND pk.COLUMN_NAME = c.COLUMN_NAME
  WHERE c.TABLE_SCHEMA = ?
  ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION;
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

const SQLSERVER_TYPE_MAP = {
  tinyint: 'smallint',
  bit: 'boolean',
  datetime: 'timestamp',
  datetime2: 'timestamp',
  smalldatetime: 'timestamp',
  datetimeoffset: 'timestamptz',
  money: 'numeric(19,4)',
  smallmoney: 'numeric(10,4)',
  binary: 'bytea',
  varbinary: 'bytea',
  image: 'bytea',
  timestamp: 'bytea',
  rowversion: 'bytea',
  ntext: 'text',
  text: 'text',
  xml: 'text',
  uniqueidentifier: 'uuid',
  sql_variant: 'text',
  hierarchyid: 'text',
  geography: 'text',
  geometry: 'text',
  real: 'real',
  float: 'double precision',
};

function formatType(row, dialect='postgresql') {
  const t = String(row.data_type || '').toLowerCase();
  if (dialect === 'sqlserver') {
    if (t === 'varchar' || t === 'nvarchar') {
      const length = Number(row.character_maximum_length);
      return length === -1 ? 'text' : `varchar(${length > 0 ? length : 255})`;
    }
    if (t === 'char' || t === 'nchar') {
      const length = Number(row.character_maximum_length);
      return `char(${length > 0 ? length : 1})`;
    }
    if (t === 'decimal' || t === 'numeric') {
      if (row.numeric_precision != null && row.numeric_scale != null) return `numeric(${row.numeric_precision},${row.numeric_scale})`;
      return 'numeric';
    }
    if (Object.prototype.hasOwnProperty.call(SQLSERVER_TYPE_MAP, t)) return SQLSERVER_TYPE_MAP[t];
    return t;
  }
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
const SQLSERVER_FK_SQL = `
  SELECT
    fk.name AS constraint_name,
    fkc.constraint_column_id AS ordinal_position,
    parent_table.name AS table_name,
    parent_column.name AS column_name,
    referenced_table.name AS ref_table_name,
    referenced_column.name AS ref_column_name
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
  JOIN sys.tables parent_table ON parent_table.object_id = fkc.parent_object_id
  JOIN sys.schemas parent_schema ON parent_schema.schema_id = parent_table.schema_id
  JOIN sys.columns parent_column ON parent_column.object_id = fkc.parent_object_id AND parent_column.column_id = fkc.parent_column_id
  JOIN sys.tables referenced_table ON referenced_table.object_id = fkc.referenced_object_id
  JOIN sys.columns referenced_column ON referenced_column.object_id = fkc.referenced_object_id AND referenced_column.column_id = fkc.referenced_column_id
  WHERE parent_schema.name = ?
  ORDER BY parent_table.name, fk.name, fkc.constraint_column_id;
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

const SQLSERVER_ROWCOUNT_SQL = `
  SELECT t.name AS table_name, SUM(ps.row_count) AS approx_rows
  FROM sys.tables t
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  JOIN sys.dm_db_partition_stats ps ON ps.object_id = t.object_id AND ps.index_id IN (0,1)
  WHERE s.name = ?
  GROUP BY t.name;
`;

function quoteSourceIdentifier(dialect, value){
  const text = String(value == null ? '' : value);
  if (dialect === 'mysql') return '`' + text.replace(/`/g, '``') + '`';
  if (dialect === 'sqlserver') return '[' + text.replace(/]/g, ']]') + ']';
  return '"' + text.replace(/"/g, '""') + '"';
}

// Infer-schema profiling is deliberately narrower than the manual Profile
// button. Only source PK / NOT NULL columns can produce a staging NOT NULL
// constraint, so only those columns need a blank/NULL scan here. One aggregate
// query per table avoids issuing a separate full-table scan for every column.
async function profileConstraintSensitiveColumns(conn, schema, tables){
  const warnings = [];
  let attemptedColumns = 0;
  let profiledColumns = 0;
  const dialect = conn.dialect;
  const qSchema = quoteSourceIdentifier(dialect, schema);

  for (const table of tables){
    if (table.objectType !== 'table') continue;
    const columns = table.columns.filter(c => c.pk === true || c.nullable === false);
    if (!columns.length) continue;
    attemptedColumns += columns.length;

    const expressions = ['COUNT(*) AS total_rows'];
    columns.forEach((col, index) => {
      const qCol = quoteSourceIdentifier(dialect, col.name);
      const nullAlias = quoteSourceIdentifier(dialect, `c${index}_null`);
      const blankAlias = quoteSourceIdentifier(dialect, `c${index}_blank`);
      if (dialect === 'mysql'){
        expressions.push(`SUM(${qCol} IS NULL) AS ${nullAlias}`);
        expressions.push(`SUM(CASE WHEN ${qCol} IS NOT NULL AND TRIM(CAST(${qCol} AS CHAR)) = '' THEN 1 ELSE 0 END) AS ${blankAlias}`);
      } else if (dialect === 'sqlserver') {
        expressions.push(`SUM(CASE WHEN ${qCol} IS NULL THEN 1 ELSE 0 END) AS ${nullAlias}`);
        expressions.push(`SUM(CASE WHEN ${qCol} IS NOT NULL AND LTRIM(RTRIM(CONVERT(NVARCHAR(MAX), ${qCol}))) = N'' THEN 1 ELSE 0 END) AS ${blankAlias}`);
      } else {
        expressions.push(`COUNT(*) FILTER (WHERE ${qCol} IS NULL) AS ${nullAlias}`);
        expressions.push(`COUNT(*) FILTER (WHERE ${qCol} IS NOT NULL AND BTRIM(CAST(${qCol} AS text)) = '') AS ${blankAlias}`);
      }
    });

    const qTable = quoteSourceIdentifier(dialect, table.name);
    const sql = `SELECT ${expressions.join(', ')} FROM ${qSchema}.${qTable}`;
    try {
      const result = await conn.query(sql, []);
      const row = result.rows[0] || {};
      const totalRows = Number(row.total_rows || 0);
      columns.forEach((col, index) => {
        col.profile = {
          totalRows,
          distinctValues: null,
          nullValues: Number(row[`c${index}_null`] || 0),
          blankValues: Number(row[`c${index}_blank`] || 0),
          source: 'infer-schema',
        };
        profiledColumns++;
      });
    } catch (err) {
      warnings.push(`${table.name}: ${err.message}`);
    }
  }
  return { attemptedColumns, profiledColumns, warnings };
}

app.post('/api/introspect', async (req, res) => {
  const schema = (req.body && req.body.schema) || ((req.body && req.body.dialect) === 'sqlserver' ? 'dbo' : 'public');
  let conn;
  try {
    conn = await openSourceConnection(req.body);
    const result = conn.dialect === 'mysql'
      ? await conn.query(MYSQL_INTROSPECT_SQL, [schema, schema])
      : conn.dialect === 'sqlserver'
        ? await conn.query(SQLSERVER_INTROSPECT_SQL, [schema, schema])
        : await conn.query(INTROSPECT_SQL, [schema]);

    let fkRows = [], countRows = [];
    try {
      const fkSql = conn.dialect === 'mysql' ? MYSQL_FK_SQL : conn.dialect === 'sqlserver' ? SQLSERVER_FK_SQL : PG_FK_SQL;
      fkRows = (await conn.query(fkSql, [schema])).rows;
    } catch (_) { fkRows = []; }
    try {
      const countSql = conn.dialect === 'mysql' ? MYSQL_ROWCOUNT_SQL : conn.dialect === 'sqlserver' ? SQLSERVER_ROWCOUNT_SQL : PG_ROWCOUNT_SQL;
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
    res.json({ ok: true, schema, tables, foreignKeys, profileSummary });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  } finally {
    if (conn) { try { await conn.end(); } catch (_) {} }
  }
});

// Table profile used by the single Profile table button. It returns row,
// distinct, SQL-null and blank counts for every requested column using one
// aggregate scan. Identifiers are validated before any connection is opened.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
app.post('/api/profile-table', async (req, res) => {
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
    conn = await openSourceConnection(req.body);
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
      } else if (dialect === 'sqlserver') {
        expressions.push(`COUNT(DISTINCT CONVERT(NVARCHAR(4000), ${qCol})) AS ${distinctAlias}`);
        expressions.push(`SUM(CASE WHEN ${qCol} IS NULL THEN 1 ELSE 0 END) AS ${nullAlias}`);
        expressions.push(`SUM(CASE WHEN ${qCol} IS NOT NULL AND LTRIM(RTRIM(CONVERT(NVARCHAR(MAX), ${qCol}))) = N'' THEN 1 ELSE 0 END) AS ${blankAlias}`);
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
app.post('/api/profile-column', async (req, res) => {
  const { schema, table, column } = req.body || {};
  for (const [label, val] of [['schema', schema], ['table', table], ['column', column]]){
    if (!val || !IDENT_RE.test(val)) return res.status(400).json({ ok: false, error: `Invalid ${label} identifier: ${val}` });
  }
  let conn;
  try {
    conn = await openSourceConnection(req.body);
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
    } else if (dialect === 'sqlserver') {
      q = `SELECT COUNT(*) AS total_rows,
                  COUNT(DISTINCT CONVERT(NVARCHAR(4000), ${qColumn})) AS distinct_values,
                  SUM(CASE WHEN ${qColumn} IS NULL THEN 1 ELSE 0 END) AS null_values,
                  SUM(CASE WHEN ${qColumn} IS NOT NULL AND LTRIM(RTRIM(CONVERT(NVARCHAR(MAX), ${qColumn}))) = N'' THEN 1 ELSE 0 END) AS blank_values
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
function resolveFolderInsideProject(requested, fallback){
  const folder = path.resolve((requested && requested.trim()) || fallback);
  // Compare against the resolved real path of the project root; the folder
  // itself may not exist yet, so resolve its nearest existing ancestor.
  let probe = folder;
  while (!fs.existsSync(probe)){
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  const realRoot = fs.realpathSync(PROJECT_ROOT);
  const rebuilt = path.join(realProbe, path.relative(probe, folder));
  if (rebuilt !== realRoot && !rebuilt.startsWith(realRoot + path.sep)){
    throw new Error(`Folder must be inside the project root (${PROJECT_ROOT}); got: ${folder}`);
  }
  return folder;
}

app.post('/api/deploy-files', async (req, res) => {
  const { files, encoding } = req.body || {};
  let folder;
  try {
    folder = resolveFolderInsideProject(req.body && req.body.folder, DB_INIT_PATH);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
    return res.status(400).json({ ok: false, error: 'No files provided.' });
  }
  for (const name of Object.keys(files)) {
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      return res.status(400).json({ ok: false, error: `Unsafe file name: ${name}` });
    }
    if (name.toLowerCase() === '.env') {
      return res.status(400).json({ ok: false, error: 'The project .env file is read-only to Data Vault Studio.' });
    }
  }
  try {
    await fs.promises.mkdir(folder, { recursive: true });
    const written = [];
    for (const [name, content] of Object.entries(files)) {
      const fullPath = path.join(folder, name);
      if (encoding === 'base64') {
        await fs.promises.writeFile(fullPath, Buffer.from(content, 'base64'));
      } else {
        await fs.promises.writeFile(fullPath, content, 'utf8');
      }
      written.push(fullPath);
    }
    res.json({ ok: true, folder, written });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Fetches a JDBC driver jar server-side and writes it straight into the
// project's jdbc-drivers/ folder — avoids the manual "download, then drag
// the file into the right place yourself" step. Restricted to a small
// allowlist of trusted driver-hosting domains rather than accepting any
// URL, since this endpoint fetches-and-writes-to-disk on request and
// shouldn't become a general-purpose SSRF/download proxy.
const ALLOWED_DRIVER_HOSTS = ['repo1.maven.org', 'repo.maven.apache.org', 'central.sonatype.com', 'downloads.mysql.com', 'dev.mysql.com'];
app.post('/api/fetch-driver', async (req, res) => {
  const { url, filename, folder } = req.body || {};
  if (!url || !filename) return res.status(400).json({ ok:false, error:'url and filename are required.' });
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return res.status(400).json({ ok:false, error:`Unsafe file name: ${filename}` });
  }
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch(_) { return res.status(400).json({ ok:false, error:'Invalid URL.' }); }
  if (parsedUrl.protocol !== 'https:' || !ALLOWED_DRIVER_HOSTS.includes(parsedUrl.hostname)) {
    return res.status(400).json({ ok:false, error:`URL host not in the allowed driver-source list: ${parsedUrl.hostname}` });
  }
  try {
    const targetFolder = resolveFolderInsideProject(folder, JDBC_DRIVER_PATH);
    const response = await fetch(url, { headers: { 'User-Agent': 'data-vault-studio/1.0 (+local-driver-fetch)' } });
    if (!response.ok) return res.status(400).json({ ok:false, error:`Fetch failed: HTTP ${response.status}` });
    const buf = Buffer.from(await response.arrayBuffer());
    await fs.promises.mkdir(targetFolder, { recursive: true });
    const fullPath = path.join(targetFolder, filename);
    await fs.promises.writeFile(fullPath, buf);
    res.json({ ok: true, folder: targetFolder, written: [fullPath], bytes: buf.length });
  } catch(err){
    res.status(400).json({ ok:false, error: err.message });
  }
});

// Executes a SQL script directly against a real database — used to apply
// the staging/data-vault/pdi_meta DDL for real, instead of just downloading
// it. Runs inside a transaction: if any statement fails, everything rolls
// back rather than leaving a half-applied schema.
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
    if (conn.dialect === 'mysql') {
      if (requestedRole) throw new Error('PostgreSQL SET ROLE is not available for a MySQL query connection.');
      await conn.query('SET SESSION MAX_EXECUTION_TIME = 10000');
      const result = await conn.query(trimmed);
      res.json({ ok: true, rows: result.rows, fields: (result.fields || []).map(f => f.name) });
    } else if (conn.dialect === 'sqlserver') {
      if (requestedRole) throw new Error('PostgreSQL SET ROLE is not available for a SQL Server query connection.');
      if (/\bSELECT\s+.*\bINTO\b/is.test(trimmed) || /\b(?:OPENROWSET|OPENQUERY|EXEC(?:UTE)?)\b/i.test(trimmed)) {
        throw new Error('SQL Server reporting queries may not use SELECT INTO, OPENROWSET, OPENQUERY, or EXEC. Use a read-only database account.');
      }
      await conn.query('SET LOCK_TIMEOUT 10000');
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

/* =========================================================================
   DOCKER CONTROL — every command here is HARDCODED server-side. The
   browser can only ask "run this one fixed action", never supply its own
   command string. That's deliberate: a generic "run whatever command the
   browser sends" endpoint would be a remote-code-execution hole reachable
   by any tab in the browser, not just this app.

   Only hop gets started from here — postgres/mysql are treated as
   already-running long-lived services (per this project's own README),
   not something a design tool should be toggling on and off.

   Goes through start.sh rather than calling `docker compose` directly,
   so the project's own license-acceptance gate stays in effect. stdin is
   explicitly closed on every spawn: if the license hasn't been accepted
   yet and ACCEPT_LICENSE isn't set, start.sh's prompt fails fast instead
   of hanging the server waiting on input that can never arrive.
   ========================================================================= */
/* =========================================================================
   License — status + explicit acceptance from the GUI.
   Acceptance is the same mechanism both start scripts use: a marker file
   under .license-state/ holding the SHA-256 of the LICENSE file. Writing it
   here (after the user reads and explicitly accepts in the GUI) is
   equivalent to answering Y at start.sh's prompt — just better recorded.
   Honors the same env overrides as the scripts (LICENSE_FILE,
   LICENSE_STATE_DIR). Nothing is ever accepted implicitly.
   ========================================================================= */
const crypto = require('crypto');
function licenseFilePath(){ return process.env.LICENSE_FILE || path.join(PROJECT_ROOT, 'LICENSE'); }
function licenseStateDir(){ return process.env.LICENSE_STATE_DIR || path.join(PROJECT_ROOT, '.license-state'); }
function licenseMarkerPath(){ return path.join(licenseStateDir(), 'license.accepted'); }
function licenseHash(){
  return crypto.createHash('sha256').update(fs.readFileSync(licenseFilePath())).digest('hex').toLowerCase();
}
function licenseAccepted(){
  try {
    const lines = fs.readFileSync(licenseMarkerPath(), 'utf8').split(/\r?\n/);
    return lines.includes(`license_sha256=${licenseHash()}`);
  } catch(_){ return false; }
}

/* Root .env credentials used by Connections and deployment.
   SOURCE_PASSWORD is the selected source login secret. DB_USER remains the
   packaged/internal PostgreSQL login and is never changed here. For native
   external PostgreSQL, the Connections target login is also used by the
   bootstrap container, so POSTGRES_BOOTSTRAP_USER/PASSWORD and
   VAULT_PASSWORD are synchronised through one narrow, allowlisted endpoint.
   Generic file deployment is still forbidden from writing .env. */

function decodeSingleQuotedEnvValue(value){
  let out = '';
  for (let i = 0; i < value.length; i++){
    if (value[i] === '\\' && i + 1 < value.length && (value[i + 1] === '\\' || value[i + 1] === "'")){
      out += value[++i];
    } else out += value[i];
  }
  return out;
}

function validateEnvCredential(name, value, { allowEmpty = false } = {}){
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (!allowEmpty && value.length === 0) throw new Error(`${name} is required.`);
  if (/\r|\n|\0/.test(value)) throw new Error(`${name} cannot contain line breaks or NUL characters.`);
  return value;
}

function encodeEnvValue(value){
  const text = String(value);
  if (/^[A-Za-z0-9_./:@+\-=]*$/.test(text)) return text;
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function patchEnvCredentials(updates){
  if (!fs.existsSync(ENV_FILE_PATH)) throw new Error(`Root .env not found at ${ENV_FILE_PATH}.`);
  const stat = fs.statSync(ENV_FILE_PATH);
  const original = fs.readFileSync(ENV_FILE_PATH, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = /\r?\n$/.test(original);
  let lines = original.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  const updated = [];
  for (const [key, rawValue] of Object.entries(updates)){
    const encoded = encodeEnvValue(rawValue);
    const re = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`);
    let found = false;
    lines = lines.map(line => {
      if (!re.test(line)) return line;
      found = true;
      return line.replace(re, (_, prefix) => `${prefix}${encoded}`);
    });
    if (!found) lines.push(`${key}=${encoded}`);
    updated.push(key);
  }

  const next = lines.join(newline) + (hadFinalNewline ? newline : '');
  const tempPath = `${ENV_FILE_PATH}.studio-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, next, { encoding:'utf8', mode:stat.mode });
    try { fs.chownSync(tempPath, stat.uid, stat.gid); } catch (_) { /* same-user installs do not need chown */ }
    fs.renameSync(tempPath, ENV_FILE_PATH);
  } finally {
    try { fs.rmSync(tempPath, { force:true }); } catch (_) { /* best effort */ }
  }
  return updated;
}

function parseEnvFile(){
  try {
    const entries = {};
    fs.readFileSync(ENV_FILE_PATH, 'utf8').split(/\r?\n/).forEach(line => {
      if (/^\s*#/.test(line) || !line.trim()) return;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) return;
      let raw = m[2];
      let literal = false;
      if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")){
        raw = decodeSingleQuotedEnvValue(raw.slice(1, -1));
        literal = true;
      } else if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')){
        raw = raw.slice(1, -1)
          .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
          .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      } else {
        raw = raw.replace(/\s+#.*$/, '').trim();
      }
      entries[m[1]] = { value: raw, literal };
    });

    const memo = {};
    function resolveValue(key, stack = new Set()){
      if (Object.prototype.hasOwnProperty.call(memo, key)) return memo[key];
      const entry = entries[key];
      if (!entry) return '';
      if (entry.literal) return (memo[key] = entry.value);
      if (stack.has(key)) return entry.value;
      const nextStack = new Set(stack); nextStack.add(key);
      const resolved = entry.value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
        (_, v) => resolveValue(v, nextStack));
      memo[key] = resolved;
      return resolved;
    }
    const out = {};
    Object.keys(entries).forEach(k => { out[k] = resolveValue(k); });
    return out;
  } catch (_) { return null; }
}

app.get('/api/env-defaults', (req, res) => {
  const env = parseEnvFile();
  if (!env) return res.json({ ok: true, found: false });
  res.json({ ok: true, found: true,
    mysql:    { user: env.MYSQL_USER || '', password: env.MYSQL_PASSWORD || env.SOURCE_PASSWORD || '' },
    target:   { user: env.DB_USER || '', password: env.VAULT_PASSWORD || env.DB_PASSWORD || '' },
    // Legacy keys are retained for older GUI builds that still expect them.
    bootstrap:{ user: env.POSTGRES_BOOTSTRAP_USER || '', password: env.POSTGRES_BOOTSTRAP_PASSWORD || '' },
    vault:    { password: env.VAULT_PASSWORD || env.DB_PASSWORD || '' },
  });
});

app.post('/api/env-credentials/status', (req, res) => {
  const sourcePassword = typeof req.body?.sourcePassword === 'string' ? req.body.sourcePassword : '';
  const targetPassword = typeof req.body?.targetPassword === 'string' ? req.body.targetPassword : '';
  const targetUser = typeof req.body?.targetUser === 'string' ? req.body.targetUser : '';
  const externalPostgres = req.body?.externalPostgres === true;
  const env = parseEnvFile();
  if (!env) return res.json({ ok: true, found: false, sourceConfigured: false, targetConfigured: false,
    targetUserConfigured: false, sourceMatches: false, targetMatches: false, targetUserMatches: false });
  const sourceConfigured = typeof env.SOURCE_PASSWORD === 'string' && env.SOURCE_PASSWORD.length > 0;
  const targetConfigured = externalPostgres
    ? typeof env.POSTGRES_BOOTSTRAP_PASSWORD === 'string' && env.POSTGRES_BOOTSTRAP_PASSWORD.length > 0
      && typeof env.VAULT_PASSWORD === 'string' && env.VAULT_PASSWORD.length > 0
    : typeof env.VAULT_PASSWORD === 'string' && env.VAULT_PASSWORD.length > 0;
  const targetUserConfigured = externalPostgres
    ? typeof env.POSTGRES_BOOTSTRAP_USER === 'string' && env.POSTGRES_BOOTSTRAP_USER.length > 0
    : typeof env.DB_USER === 'string' && env.DB_USER.length > 0;
  res.json({ ok: true, found: true, sourceConfigured, targetConfigured, targetUserConfigured,
    sourceMatches: sourcePassword.length > 0 && env.SOURCE_PASSWORD === sourcePassword,
    targetMatches: targetPassword.length > 0 && (externalPostgres
      ? env.POSTGRES_BOOTSTRAP_PASSWORD === targetPassword && env.VAULT_PASSWORD === targetPassword
      : env.VAULT_PASSWORD === targetPassword),
    targetUserMatches: targetUser.length > 0 && (externalPostgres
      ? env.POSTGRES_BOOTSTRAP_USER === targetUser
      : env.DB_USER === targetUser) });
});

app.post('/api/env-credentials', (req, res) => {
  try {
    const sourcePassword = validateEnvCredential('Source password', req.body?.sourcePassword);
    const externalPostgres = req.body?.externalPostgres === true;
    const updates = { SOURCE_PASSWORD: sourcePassword };
    if (externalPostgres){
      const targetUser = validateEnvCredential('External PostgreSQL username', req.body?.targetUser);
      const targetPassword = validateEnvCredential('External PostgreSQL password', req.body?.targetPassword);
      updates.POSTGRES_BOOTSTRAP_USER = targetUser;
      updates.POSTGRES_BOOTSTRAP_PASSWORD = targetPassword;
      // The bootstrap creates pdi_meta/staging/data_vault roles with this
      // existing password variable, and Hop resolves the same variable later.
      updates.VAULT_PASSWORD = targetPassword;
    }
    const updated = patchEnvCredentials(updates);
    res.json({ ok:true, updated });
  } catch (err) {
    res.status(400).json({ ok:false, error:err.message });
  }
});

app.get('/api/license', (req, res) => {
  try {
    if (!fs.existsSync(licenseFilePath())) {
      return res.json({ ok: true, exists: false, accepted: false, text: '' });
    }
    res.json({ ok: true, exists: true, accepted: licenseAccepted(),
      text: fs.readFileSync(licenseFilePath(), 'utf8') });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/license-accept', (req, res) => {
  try {
    if ((req.body || {}).accept !== true) {
      return res.status(400).json({ ok: false, error: 'Acceptance must be explicit — send { accept: true }.' });
    }
    if (!fs.existsSync(licenseFilePath())) {
      return res.status(400).json({ ok: false, error: `License file not found at ${licenseFilePath()}.` });
    }
    fs.mkdirSync(licenseStateDir(), { recursive: true });
    const content = [
      `license_sha256=${licenseHash()}`,
      `accepted_at_utc=${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
      'accepted_method=vault studio gui',
    ].join('\n') + '\n';
    fs.writeFileSync(licenseMarkerPath(), content, 'utf8');
    res.json({ ok: true, accepted: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const START_SH = path.join(PROJECT_ROOT, 'start.sh');

function projectRootError(extra){
  return `${extra} Resolved project root: ${PROJECT_ROOT}. Start the local server from <project-root>/data_vault_studio or set DVS_PROJECT_ROOT=/path/to/project-root.`;
}

function runFixedCommand(args, timeoutMs, envOverrides = {}){
  return new Promise((resolve) => {
    if (!fs.existsSync(START_SH)){
      resolve({ ok:false, error:projectRootError(`start.sh not found at ${START_SH}.`) });
      return;
    }
    let stdout = '', stderr = '', settled = false;
    const child = spawn('bash', [START_SH, ...args], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'], // no stdin — never hang waiting for interactive input
      env: { ...process.env, ...envOverrides },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok:false, error:`Timed out after ${timeoutMs/1000}s waiting for: start.sh ${args.join(' ')}`, stdout, stderr });
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, code, stdout, stderr });
      // Non-zero exit: surface WHY. The license prompt writes to stdout, so
      // stderr alone is often empty — without this, the GUI can only say
      // "Could not start X" with no way to self-diagnose.
      let error;
      if (/LICENSE AGREEMENT|accept the license/i.test(stdout + stderr)) {
        error = 'License not accepted yet — accept it in the GUI (license panel on first load), or run ./start.sh (.\\start.ps1 on Windows) once in a terminal.';
      } else {
        const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-40).join('\n');
        error = `start.sh ${args.join(' ')} exited with code ${code}${detail ? ':\n' + detail : ''}`;
      }
      resolve({ ok: false, code, stdout, stderr, error });
    });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok:false, error: err.message, stdout, stderr });
    });
  });
}

// Engine start — start.sh now selects the run type with flags:
//   --demo               sakila MySQL + internal Postgres (profiles demo + internal-postgres)
//   (no flag)            internal Postgres only
//   --external-postgres  external Postgres; optional --build runs the
//                        metadata setup once before Hop starts
// The MODE decides the flags; everything stays a fixed, allowlisted
// command — the browser can only pick a mode name, never arguments.
const ENGINE_MODES = {
  demo:     ['up', '--demo', '-d', 'hop'],
  internal: ['up', '-d', 'hop'],
  external: ['up', '--external-postgres', '-d', 'hop'],
};
app.post('/api/docker/run-hop', async (req, res) => {
  const { mode = 'internal', build = false } = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(ENGINE_MODES, mode)) {
    return res.status(400).json({ ok: false, error: `Unknown engine mode "${mode}" — allowed: ${Object.keys(ENGINE_MODES).join(', ')}.` });
  }
  let args = ENGINE_MODES[mode];
  let timeout = 120000;
  if (mode === 'external' && build === true) {
    // First run against an external Postgres: target setup builds + seeds the
    // metadata schema before hop starts, so allow it much longer.
    args = ['up', '--external-postgres', '--build', '-d', 'hop'];
    timeout = 600000;
  }
  const result = await runFixedCommand(args, timeout);
  res.json({ ...result, mode, args: args.join(' ') });
});

// Start/stop the packaged database containers (the "MySQL Demo" and
// "Postgres Internal" options in the GUI). Service names are allowlisted —
// the browser can never pass an arbitrary compose service, let alone a
// command. Runs through start.sh like everything else, so the license
// gate stays in effect. The sakila mysql service only exists under the
// --demo profile; postgres lives under the default internal-postgres one.
// Reports on generated deployment files so the GUI can derive deployment
// state without any manifest: presence, size, mtime, and (for small .json
// files) the content for direct comparison with the freshly generated
// version. Roots are fixed keys — never arbitrary paths.
const FILE_STATUS_ROOTS = { mappings: () => MAPPINGS_PATH, hop: () => HOP_CONFIG_PATH, rdbms: () => METADATA_RDBMS_PATH };
app.post('/api/file-status', (req, res) => {
  const { files } = req.body || {};
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ ok: false, error: 'No files requested.' });
  const out = [];
  for (const f of files) {
    const rootFn = FILE_STATUS_ROOTS[f && f.root];
    if (!rootFn) return res.status(400).json({ ok: false, error: `Unknown root "${f && f.root}" — allowed: ${Object.keys(FILE_STATUS_ROOTS).join(', ')}.` });
    const name = String(f.name || '');
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      return res.status(400).json({ ok: false, error: `Unsafe file name: ${name}` });
    }
    const full = path.join(rootFn(), name);
    try {
      const st = fs.statSync(full);
      const entry = { root: f.root, name, exists: true, size: st.size, mtimeMs: st.mtimeMs };
      if (name.toLowerCase().endsWith('.json') && st.size <= 65536) {
        entry.content = fs.readFileSync(full, 'utf8');
      }
      out.push(entry);
    } catch (_) {
      out.push({ root: f.root, name, exists: false });
    }
  }
  res.json({ ok: true, files: out });
});

// Reports whether supported non-PostgreSQL JDBC drivers are present in
// jdbc-drivers/. Hop needs Connector/J for MySQL and Microsoft's JDBC driver
// for external SQL Server sources; the same mount is used by JDBC FDW.
app.get('/api/driver-status', (req, res) => {
  try {
    const jars = fs.existsSync(JDBC_DRIVER_PATH)
      ? fs.readdirSync(JDBC_DRIVER_PATH).filter(f => f.toLowerCase().endsWith('.jar'))
      : [];
    const mysqlDriver = jars.find(f => /mysql-connector/i.test(f)) || null;
    const sqlServerDriver = jars.find(f => /mssql-jdbc/i.test(f)) || null;
    res.json({ ok: true, folder: JDBC_DRIVER_PATH, jars, mysqlDriver, sqlServerDriver });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});


// Resolves the container-visible /opt/jdbc-drivers/<name>.jar path to the
// project bind-mount source. Only a plain jar basename is accepted; arbitrary
// host paths are never exposed through this endpoint.
app.post('/api/driver-path-status', (req, res) => {
  try {
    const jarfile = String((req.body && req.body.jarfile) || '');
    const filename = path.posix.basename(jarfile.replace(/\\/g, '/'));
    if (!filename || !filename.toLowerCase().endsWith('.jar') || filename.includes('..')) {
      return res.status(400).json({ ok:false, error:'jarfile must name a .jar inside /opt/jdbc-drivers/.' });
    }
    if (jarfile && !jarfile.replace(/\\/g, '/').startsWith('/opt/jdbc-drivers/')) {
      return res.status(400).json({ ok:false, error:'The packaged Postgres container only mounts jars below /opt/jdbc-drivers/.' });
    }
    const fullPath = path.join(JDBC_DRIVER_PATH, filename);
    const exists = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
    res.json({ ok:true, exists, filename, folder:JDBC_DRIVER_PATH, fullPath:exists?fullPath:undefined });
  } catch (err) {
    res.status(400).json({ ok:false, error:err.message });
  }
});

function externalDialect(body){
  const dialect = String((body && body.dialect) || 'postgresql').toLowerCase();
  if (!['postgresql','mysql','sqlserver'].includes(dialect)) throw new Error(`Automatic external deployment does not support dialect "${dialect}".`);
  return dialect;
}
function externalIdentifier(value, label){
  const name=String(value||'');
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(name)) throw new Error(`${label} must be a plain identifier.`);
  return name;
}
async function openExternalTarget(body, { databaseRequired=true, multipleStatements=false }={}){
  const dialect=externalDialect(body);
  const {host,port,database,user,password}=body||{};
  if (!host || !user || (databaseRequired && !database)) throw new Error(`host, ${databaseRequired?'database, ':''}and user are required.`);
  if (dialect==='postgresql'){
    const client=await connectPgWithFallback({host,port:port||5432,database:database||'postgres',user,password});
    return {dialect, query:(sql,params)=>client.query(sql,params), end:()=>client.end()};
  }
  if (dialect==='sqlserver') return openSqlServerConnection({...body,database:database||'master'},database||'master');
  const conn=await mysql.createConnection({
    host,
    port:port?Number(port):3306,
    database:databaseRequired?(database||undefined):undefined,
    user,
    password:password||undefined,
    connectTimeout:6000,
    multipleStatements,
  });
  return {
    dialect,
    query:async(sql,params)=>{
      const [rows]=await conn.query(sql,params);
      return {rows,rowCount:Array.isArray(rows)?rows.length:0};
    },
    end:()=>conn.end(),
  };
}

async function mysqlConnectionIdentity(conn){
  const result=await conn.query('SELECT @@hostname AS server_hostname, @@port AS server_port, CURRENT_USER() AS authenticated_user, USER() AS client_user');
  const row=(result.rows&&result.rows[0])||{};
  return {
    serverHostname:String(row.server_hostname ?? row.SERVER_HOSTNAME ?? ''),
    serverPort:Number(row.server_port ?? row.SERVER_PORT ?? 0),
    currentUser:String(row.authenticated_user ?? row.AUTHENTICATED_USER ?? ''),
    clientUser:String(row.client_user ?? row.CLIENT_USER ?? ''),
  };
}

async function sqlServerConnectionIdentity(conn){
  const result=await conn.query(`SELECT
    CAST(SERVERPROPERTY('ServerName') AS nvarchar(256)) AS server_hostname,
    CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS product_version,
    SUSER_SNAME() AS authenticated_user,
    DB_NAME() AS selected_database,
    SCHEMA_NAME() AS default_schema`);
  const row=(result.rows&&result.rows[0])||{};
  return {
    serverHostname:String(row.server_hostname||''),
    serverPort:0,
    currentUser:String(row.authenticated_user||''),
    selectedDatabase:String(row.selected_database||''),
    productVersion:String(row.product_version||''),
    defaultSchema:String(row.default_schema||''),
  };
}

app.post('/api/external-db-status', async (req,res)=>{
  let conn;
  try{
    const dialect=externalDialect(req.body);
    const database=externalIdentifier(req.body && req.body.database,'Database name');
    if(dialect==='postgresql'){
      conn=await openExternalTarget({...req.body,database:(req.body&&req.body.maintenanceDatabase)||'postgres'});
      const result=await conn.query('SELECT 1 FROM pg_database WHERE datname=$1',[database]);
      return res.json({ok:true,connected:true,exists:result.rowCount>0});
    }
    if(dialect==='sqlserver'){
      conn=await openExternalTarget({...req.body,database:'master'});
      const result=await conn.query('SELECT 1 AS found FROM sys.databases WHERE name=?',[database]);
      const identity=await sqlServerConnectionIdentity(conn);
      return res.json({ok:true,connected:true,exists:(result.rows||[]).length>0,...identity});
    }
    conn=await openExternalTarget(req.body,{databaseRequired:false});
    const result=await conn.query('SELECT 1 FROM information_schema.schemata WHERE schema_name=?',[database]);
    const identity=await mysqlConnectionIdentity(conn);
    res.json({ok:true,connected:true,exists:Array.isArray(result.rows)&&result.rows.length>0,...identity});
  }catch(err){res.status(400).json({ok:false,error:err.message});}
  finally{if(conn){try{await conn.end();}catch(_){}}}
});

app.post('/api/external-create-database', async (req,res)=>{
  let conn;
  try{
    const dialect=externalDialect(req.body);
    const database=externalIdentifier(req.body && req.body.database,'Database name');
    if(dialect==='postgresql'){
      conn=await openExternalTarget({...req.body,database:(req.body&&req.body.maintenanceDatabase)||'postgres'});
      const existing=await conn.query('SELECT 1 FROM pg_database WHERE datname=$1',[database]);
      if(existing.rowCount) return res.json({ok:true,created:false,exists:true});
      await conn.query(`CREATE DATABASE "${database}"`);
      const verify=await conn.query('SELECT 1 FROM pg_database WHERE datname=$1',[database]);
      if(!verify.rowCount) throw new Error(`Database "${database}" was not visible after CREATE DATABASE.`);
      return res.json({ok:true,created:true,exists:true});
    }
    if(dialect==='sqlserver'){
      conn=await openExternalTarget({...req.body,database:'master'});
      const existing=await conn.query('SELECT 1 AS found FROM sys.databases WHERE name=?',[database]);
      const created=!(existing.rows||[]).length;
      if(created) await conn.query(`CREATE DATABASE [${database.replace(/]/g,']]')}]`);
      const verify=await conn.query('SELECT 1 AS found FROM sys.databases WHERE name=?',[database]);
      if(!(verify.rows||[]).length) throw new Error(`Database "${database}" was not visible after CREATE DATABASE.`);
      const identity=await sqlServerConnectionIdentity(conn);
      await conn.end(); conn=null;
      const databaseConn=await openExternalTarget({...req.body,database});
      try{await databaseConn.query('SELECT DB_NAME() AS selected_database');}
      finally{await databaseConn.end();}
      return res.json({ok:true,created,exists:true,...identity,selectedDatabase:database});
    }
    conn=await openExternalTarget(req.body,{databaseRequired:false});
    const existing=await conn.query('SELECT 1 FROM information_schema.schemata WHERE schema_name=?',[database]);
    const created=!Array.isArray(existing.rows)||existing.rows.length===0;
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
    const verify=await conn.query('SELECT 1 FROM information_schema.schemata WHERE schema_name=?',[database]);
    if(!Array.isArray(verify.rows)||verify.rows.length===0) throw new Error(`Database "${database}" was not visible after CREATE DATABASE.`);
    const identity=await mysqlConnectionIdentity(conn);
    await conn.end(); conn=null;
    const databaseConn=await openExternalTarget({...req.body,database});
    try{await databaseConn.query('SELECT DATABASE() AS selected_database');}
    finally{await databaseConn.end();}
    res.json({ok:true,created,exists:true,...identity,selectedDatabase:database});
  }catch(err){res.status(400).json({ok:false,error:err.message});}
  finally{if(conn){try{await conn.end();}catch(_){}}}
});

app.post('/api/external-verify-user-access', async (req,res)=>{
  let conn;
  try{
    const dialect=externalDialect(req.body);
    conn=await openExternalTarget(req.body);
    if(dialect==='mysql'){
      const identity=await mysqlConnectionIdentity(conn);
      const grants=await conn.query('SHOW GRANTS FOR CURRENT_USER()');
      await conn.query('SELECT 1 AS route_ok');
      return res.json({ok:true,...identity,grants:grants.rows||[]});
    }
    if(dialect==='sqlserver'){
      const identity=await sqlServerConnectionIdentity(conn);
      const schema=externalIdentifier((req.body&&req.body.schema)||'dbo','Schema name');
      const permissions=await conn.query(`SELECT
        HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS can_create_table,
        HAS_PERMS_BY_NAME(?, 'SCHEMA', 'ALTER') AS can_alter_schema`,[schema]);
      await conn.query('SELECT 1 AS route_ok');
      return res.json({ok:true,...identity,permissions:(permissions.rows&&permissions.rows[0])||{}});
    }
    const identity=await conn.query('SELECT current_user, current_database()');
    await conn.query('SELECT 1 AS route_ok');
    res.json({ok:true,currentUser:identity.rows&&identity.rows[0]&&identity.rows[0].current_user,database:identity.rows&&identity.rows[0]&&identity.rows[0].current_database});
  }catch(err){res.status(400).json({ok:false,error:err.message});}
  finally{if(conn){try{await conn.end();}catch(_){}}}
});

app.post('/api/external-execute-sql', async (req,res)=>{
  const sql=String((req.body&&req.body.sql)||'');
  if(!sql.trim()) return res.status(400).json({ok:false,error:'No SQL provided.'});
  let conn;
  try{
    conn=await openExternalTarget(req.body,{multipleStatements:true});
    if(conn.dialect==='postgresql'){
      await conn.query('BEGIN');
      try{
        await conn.query("SET LOCAL lock_timeout='10s'");
        await conn.query("SET LOCAL statement_timeout='120s'");
        await conn.query(sql);
        await conn.query('COMMIT');
      }catch(err){
        await conn.query('ROLLBACK').catch(()=>{});
        throw err;
      }
    }else if(conn.dialect==='sqlserver'){
      await conn.batch(`SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;
${sql}
  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH`);
    }else{
      await conn.query(sql);
    }
    res.json({ok:true});
  }catch(err){res.status(400).json({ok:false,error:err.message});}
  finally{if(conn){try{await conn.end();}catch(_){}}}
});

app.post('/api/external-table-status', async (req,res)=>{
  let conn;
  try{
    const dialect=externalDialect(req.body);
    const database=externalIdentifier(req.body && req.body.database,'Database name');
    const tables=Array.isArray(req.body&&req.body.tables)?req.body.tables.map(t=>externalIdentifier(t,'Table name')):[];
    if(!tables.length) return res.status(400).json({ok:false,error:'At least one table is required.'});
    conn=await openExternalTarget(req.body);
    let rows;
    if(dialect==='postgresql'){
      const schema=externalIdentifier((req.body&&req.body.schema)||'public','Schema name');
      const result=await conn.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name=ANY($2::text[])',[schema,tables]);
      rows=result.rows;
    }else if(dialect==='sqlserver'){
      const schema=externalIdentifier((req.body&&req.body.schema)||'dbo','Schema name');
      const marks=tables.map(()=>'?').join(',');
      const result=await conn.query(`SELECT TABLE_NAME AS table_name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${marks})`,[schema,...tables]);
      rows=result.rows;
    }else{
      const marks=tables.map(()=>'?').join(',');
      const result=await conn.query(`SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${marks})`,[database,...tables]);
      rows=result.rows;
    }
    const found=new Set((rows||[]).map(r=>String(r.table_name ?? r.TABLE_NAME ?? '').toLowerCase()).filter(Boolean));
    res.json({ok:true,found:tables.filter(t=>found.has(t.toLowerCase())),missing:tables.filter(t=>!found.has(t.toLowerCase()))});
  }catch(err){res.status(400).json({ok:false,error:err.message});}
  finally{if(conn){try{await conn.end();}catch(_){}}}
});

const DB_SERVICES = ['mysql', 'postgres'];
// External-target metadata setup — builds and runs the packaged
// metadata setup container (which owns markers/versioning/CREATE
// DATABASE logic) WITHOUT starting hop. Args are fixed; license is
// enforced here because this path calls compose directly, not start.sh.
app.post('/api/docker/bootstrap', async (req, res) => {
  if (!fs.existsSync(licenseFilePath()) || !licenseAccepted()) {
    return res.status(403).json({ ok: false, error: 'License not accepted yet — accept it in the GUI first.' });
  }
  const build = await runComposeCommand(['--profile', 'external-postgres-bootstrap', 'build', 'metadata-bootstrap'], 600000);
  if (!build.ok) return res.json({ ...build, step: 'build' });
  const run = await runComposeCommand(['--profile', 'external-postgres-bootstrap', 'run', '--rm', 'metadata-bootstrap'], 900000);
  res.json({ ...run, step: run.ok ? 'done' : 'run' });
});

function runComposeCommand(args, timeoutMs){
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn('docker', ['compose', ...args], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok:false, error:`Timed out after ${timeoutMs/1000}s: docker compose ${args.join(' ')}`, stdout, stderr });
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-8).join('\n');
      resolve({ ok: code===0, code, stdout, stderr,
        error: code===0 ? undefined : `docker compose ${args.join(' ')} exited with code ${code}${detail ? ':\n' + detail : ''}` });
    });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok:false, error: err.message, stdout, stderr });
    });
  });
}

app.post('/api/docker/start-db', async (req, res) => {
  const { service, fdw = false } = req.body || {};
  if (!DB_SERVICES.includes(service)) {
    return res.status(400).json({ ok: false, error: `Unknown service "${service}" — allowed: ${DB_SERVICES.join(', ')}.` });
  }
  if (typeof fdw !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'fdw must be true or false.' });
  }
  if (service !== 'postgres' && fdw) {
    return res.status(400).json({ ok: false, error: 'FDW mode is only valid for the postgres service.' });
  }
  const args = service === 'mysql'
    ? ['up', '--demo', '-d', 'mysql']
    : service === 'postgres' && fdw
      ? ['up', '--fdw', '-d', 'postgres']
      : ['up', '-d', 'postgres'];
  // Keep FDW selection explicit in the launcher command. start.sh owns the
  // Compose override, making the chosen image visible in logs and reproducible
  // from the command line.
  const result = await runFixedCommand(args, service === 'postgres' && fdw ? 600000 : 120000);
  res.json({ ...result, fdw: service === 'postgres' && fdw, args: args.join(' ') });
});
app.post('/api/docker/stop-db', async (req, res) => {
  const { service } = req.body || {};
  if (!DB_SERVICES.includes(service)) {
    return res.status(400).json({ ok: false, error: `Unknown service "${service}" — allowed: ${DB_SERVICES.join(', ')}.` });
  }
  const result = await runFixedCommand(['stop', service], 60000);
  res.json(result);
});

// Tail of the hop container's logs — read-only, command fully hardcoded.
// `up -d` returns as soon as the container starts, so this is how you
// actually see what the ETL run is doing / why it failed. `tail` is
// clamped server-side so the browser can't request unbounded output.
app.post('/api/docker/logs', async (req, res) => {
  const requested = Number((req.body || {}).tail);
  const tail = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 10), 2000) : 200;
  let settled = false;
  const respond = (payload) => { if (settled) return; settled = true; res.json(payload); };
  const child = spawn('docker', ['compose', 'logs', '--no-color', '--tail', String(tail), 'hop'], {
    cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    respond({ ok: false, error: 'Timed out waiting for docker compose logs.' });
  }, 20000);
  child.stdout.on('data', d => stdout += d.toString());
  child.stderr.on('data', d => stderr += d.toString());
  child.on('close', code => {
    clearTimeout(timer);
    if (code !== 0) { respond({ ok: false, error: stderr || `docker compose logs exited with code ${code}` }); return; }
    respond({ ok: true, logs: stdout });
  });
  child.on('error', err => { clearTimeout(timer); respond({ ok: false, error: err.message }); });
});

// Runs the project's own canonical Python workbook validator against a
// workbook generated in the browser — so the GUI's JS validation can never
// silently drift from the validator the pipeline itself trusts. Best-effort:
// returns a clear error if python3 or the script isn't present.
const VALIDATOR_CANDIDATES = [
  process.env.DVS_VALIDATOR,
  path.join(PROJECT_ROOT, 'scripts', 'validate_mapping_workbook.py'),
  path.join(PROJECT_ROOT, 'skills', 'hop-data-vault-setup', 'scripts', 'validate_mapping_workbook.py'),
].filter(Boolean);
app.post('/api/validate-workbook', async (req, res) => {
  const { workbookBase64, filename } = req.body || {};
  if (!workbookBase64) return res.status(400).json({ ok: false, error: 'No workbook provided.' });
  const script = VALIDATOR_CANDIDATES.find(p => fs.existsSync(p));
  if (!script) {
    return res.status(400).json({ ok: false, error: `Canonical validator not found. Looked for: ${VALIDATOR_CANDIDATES.join(', ')}. Set DVS_VALIDATOR=/path/to/validate_mapping_workbook.py if it lives elsewhere.` });
  }
  const safeName = (filename && !/[/\\]|\.\./.test(filename)) ? filename : 'workbook.xlsx';
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dvs-validate-'));
  const tmpFile = path.join(tmpDir, safeName.replace(/\.xls$/i, '.xlsx'));
  try {
    await fs.promises.writeFile(tmpFile, Buffer.from(workbookBase64, 'base64'));
    const result = await new Promise((resolve) => {
      let stdout = '', stderr = '', settled = false;
      const child = spawn('python3', [script, tmpFile], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        if (settled) return; settled = true;
        child.kill('SIGKILL');
        resolve({ ok: false, error: 'Validator timed out after 60s.', stdout, stderr });
      }, 60000);
      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());
      child.on('close', code => {
        if (settled) return; settled = true; clearTimeout(timer);
        resolve({ ok: true, exitCode: code, passed: code === 0, stdout, stderr });
      });
      child.on('error', err => {
        if (settled) return; settled = true; clearTimeout(timer);
        resolve({ ok: false, error: `Could not run python3: ${err.message}`, stdout, stderr });
      });
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// =========================================================================
// SCHEDULER — recurring "start the data vault engine" runs.
//
// Lives here rather than in the browser deliberately: a scheduler that only
// fires while a specific browser tab stays open isn't really a scheduler in
// any useful sense. This keeps running for as long as `npm start` itself is
// alive, and its config survives a server restart via a small JSON file
// next to start.sh — still not true OS-level cron (if the machine or this
// Node process stops, so does the schedule), but a meaningfully stronger
// guarantee than "don't close the tab."
// =========================================================================
const SCHEDULER_STATE_PATH = path.join(PROJECT_ROOT, '.vault-studio-scheduler.json');
const SCHEDULER_LOG_LIMIT = 25;
let schedulerState = { enabled: false, intervalMinutes: 60, mode: 'internal', nextRunAt: null, lastRunAt: null, log: [] };

function loadSchedulerState(){
  try {
    const raw = fs.readFileSync(SCHEDULER_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    schedulerState = { ...schedulerState, ...parsed };
  } catch(_) { /* no persisted state yet, or unreadable — start fresh */ }
}
function saveSchedulerState(){
  try { fs.writeFileSync(SCHEDULER_STATE_PATH, JSON.stringify(schedulerState, null, 2)); }
  catch(_) { /* best-effort — a failed save shouldn't crash a scheduled run */ }
}
function schedulerLog(entry){
  schedulerState.log.unshift({ at: new Date().toISOString(), ...entry });
  schedulerState.log = schedulerState.log.slice(0, SCHEDULER_LOG_LIMIT);
}
async function runSchedulerNow(reason){
  schedulerState.lastRunAt = new Date().toISOString();
  const args = ENGINE_MODES[schedulerState.mode] || ENGINE_MODES.internal; // never --build on a schedule
  const result = await runFixedCommand(args, 120000);
  schedulerLog({ ok: result.ok, reason, error: result.ok ? undefined : (result.error || 'Failed — see server logs.') });
  if (schedulerState.enabled){
    schedulerState.nextRunAt = new Date(Date.now() + schedulerState.intervalMinutes * 60000).toISOString();
  }
  saveSchedulerState();
  return result;
}
loadSchedulerState();
// Checked every 15s rather than computing a precise setTimeout for the
// exact due time — simpler, self-correcting if the process was asleep or
// paused (e.g. a laptop lid closed), and 15s of jitter on an hourly-or-
// longer schedule is never going to matter.
setInterval(() => {
  if (!schedulerState.enabled || !schedulerState.nextRunAt) return;
  if (new Date(schedulerState.nextRunAt).getTime() <= Date.now()){
    runSchedulerNow('scheduled').catch(()=>{});
  }
}, 15000);

app.get('/api/scheduler/status', (req, res) => {
  res.json({ ok: true, ...schedulerState });
});

app.post('/api/scheduler/config', (req, res) => {
  const { enabled, intervalMinutes, mode } = req.body || {};
  if (intervalMinutes != null){
    const n = Number(intervalMinutes);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ ok:false, error:'intervalMinutes must be a number of 1 or more.' });
    schedulerState.intervalMinutes = n;
  }
  if (mode != null){
    if (!Object.prototype.hasOwnProperty.call(ENGINE_MODES, mode)) {
      return res.status(400).json({ ok:false, error:`Unknown engine mode "${mode}" — allowed: ${Object.keys(ENGINE_MODES).join(', ')}.` });
    }
    schedulerState.mode = mode;
  }
  if (enabled != null){
    schedulerState.enabled = !!enabled;
    schedulerState.nextRunAt = schedulerState.enabled
      ? new Date(Date.now() + schedulerState.intervalMinutes * 60000).toISOString()
      : null;
  }
  saveSchedulerState();
  res.json({ ok: true, ...schedulerState });
});

app.post('/api/scheduler/run-now', async (req, res) => {
  const result = await runSchedulerNow('manual');
  res.json({ ok: true, result, ...schedulerState });
});

// Read-only container status check — not gated by the license flow since
// it doesn't start anything.
app.post('/api/docker/status', async (req, res) => {
  let settled = false;
  const respond = (payload) => { if (settled) return; settled = true; res.json(payload); };
  try {
    if (!fs.existsSync(START_SH)){
      respond({ ok:false, error:projectRootError(`start.sh not found at ${START_SH}.`) });
      return;
    }
    const child = spawn('docker', ['compose', 'ps', '--format', 'json'], {
      cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      respond({ ok:false, error:'Timed out waiting for docker compose ps.' });
    }, 15000);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0){ respond({ ok:false, error: stderr || `docker compose ps exited with code ${code}` }); return; }
      try {
        // docker compose ps --format json emits one JSON object per line
        // (NDJSON) on most versions, but a single JSON array on some —
        // handle both.
        const trimmed = stdout.trim();
        const containers = trimmed.startsWith('[')
          ? JSON.parse(trimmed)
          : trimmed.split('\n').filter(Boolean).map(l => JSON.parse(l));
        respond({ ok:true, containers });
      } catch (parseErr) {
        respond({ ok:false, error:'Could not parse docker compose output.', raw: stdout });
      }
    });
    // spawn failures (e.g. docker isn't installed) can fire 'error' AND
    // still fire 'close' afterwards — the settled guard above is what
    // stops that from trying to send two responses and crashing the
    // whole server, which is exactly what happened before this fix.
    child.on('error', err => { clearTimeout(timer); respond({ ok:false, error: err.message }); });
  } catch (err) {
    respond({ ok:false, error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Data Vault Studio introspection server listening on http://127.0.0.1:${PORT}`);
  console.log(`Studio mode: ${STUDIO_MODE}`);
  console.log('This server only accepts connections from your own machine.');
  console.log('');
  console.log(`Open the GUI at:  http://127.0.0.1:${PORT}/`);
});
