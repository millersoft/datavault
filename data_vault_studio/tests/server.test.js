/**
 * Companion-server tests — spawn server.js against a throwaway project root
 * and exercise the security and validation behaviour over real HTTP:
 *   - GUI serving at /
 *   - deploy-files folder confinement + filename safety
 *   - /api/query read-only shape gate (CTEs allowed, mutations rejected)
 *   - fetch-driver host allowlist
 *   - scheduler config validation
 *
 * No database or Docker needed — everything tested here fails/succeeds
 * before those layers, by design.
 *
 * Run:  npm test        (or: node --test tests/)
 */
const { test, before, after, beforeEach, afterEach, describe } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18420 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let projectRoot;

function api(pathname, { method = 'POST', body, headers = {} } = {}){
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
  return fetch(`${BASE}${pathname}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  // Fake project root: server treats the dir containing start.sh + compose
  // as the project. Token + scheduler state land here, not in the repo.
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-server-test-'));
  // Stub start.sh records its arguments so tests can assert the exact
  // flag-based invocations (matching the real script's new interface).
  fs.writeFileSync(path.join(projectRoot, 'start.sh'),
    '#!/bin/bash\necho "$@" >> args.log\necho "${COMPOSE_FILE:-}" >> env.log\nexit 0\n');
  fs.writeFileSync(path.join(projectRoot, 'docker-compose.yaml'), 'services: {}\n');

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mode=production'], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DVS_PROJECT_ROOT: projectRoot }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  // Wait for the server to answer /api/health.
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline){
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok){ up = true; break; }
    } catch (_){ /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  if (!up) throw new Error(`Server did not start on ${BASE}. stderr: ${stderr}`);
});

after(() => {
  if (child) child.kill('SIGKILL');
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('runtime mode defaults', () => {
  test('npm start defaults to production when no mode override is supplied', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(source, /requested \|\| process\.env\.STUDIO_MODE \|\| 'production'/);
  });
});

describe('basics', () => {
  test('GET /api/health answers with the resolved project root', async () => {
    const r = await fetch(`${BASE}/api/health`);
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.projectRoot, projectRoot);
    assert.strictEqual(body.studioMode, 'production');
  });

  test('GET / serves the GUI', async () => {
    const r = await fetch(`${BASE}/`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.ok(html.includes('Data Vault Studio'));
    assert.ok(html.includes('millersoft'), 'should be the real GUI page');
    assert.ok(html.includes("const STUDIO_RUNTIME_MODE = 'production' === 'demo' ? 'demo' : 'production'"));
    assert.ok(!html.includes('__STUDIO_RUNTIME_MODE__'));
  });

  test('GET /api/runtime-profile reports the selected npm-start mode', async () => {
    const r = await fetch(`${BASE}/api/runtime-profile`);
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(body, { ok:true, mode:'production', isDemo:false, isProduction:true });
  });
});

describe('Studio-managed Postgres bootstrap scope', () => {
  test('always masks generated 03-ddls.sql while keeping FDW packaging opt-in', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'postgres', 'Dockerfile'), 'utf8');
    const fdwDockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'postgres', 'Dockerfile.fdw'), 'utf8');
    const studioOverride = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.studio.yaml'), 'utf8');
    const fdwOverride = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.fdw.yaml'), 'utf8');
    const startScript = fs.readFileSync(path.join(__dirname, '..', '..', 'start.sh'), 'utf8');
    const noOpDdl = fs.readFileSync(path.join(__dirname, '..', '..', 'docker', 'studio-skip-ddls.sql'), 'utf8');

    assert.match(dockerfile, /^FROM postgres:17$/m);
    assert.match(dockerfile, /^COPY db-init\/ \/docker-entrypoint-initdb\.d\/$/m);
    assert.doesNotMatch(dockerfile, /jdbc_fdw|openjdk/i);

    assert.match(studioOverride, /studio-skip-ddls\.sql:\/docker-entrypoint-initdb\.d\/03-ddls\.sql:ro/);
    assert.doesNotMatch(studioOverride, /Dockerfile\.fdw|jdbc-drivers/);
    assert.match(startScript, /COMPOSE_FILE="docker-compose\.yaml:docker-compose\.studio\.yaml"/);
    assert.match(startScript, /COMPOSE_FILE="\$\{COMPOSE_FILE\}:docker-compose\.fdw\.yaml"/);

    assert.match(fdwDockerfile, /^FROM postgres:17\.10-bookworm AS jdbc-fdw-build$/m);
    assert.match(fdwDockerfile, /https:\/\/apt\.postgresql\.org/);
    assert.match(fdwOverride, /dockerfile: postgres\/Dockerfile\.fdw/);
    assert.match(fdwOverride, /jdbc-drivers:\/opt\/jdbc-drivers:ro/);
    assert.doesNotMatch(fdwOverride, /studio-skip-ddls\.sql:\/docker-entrypoint-initdb\.d\/03-ddls\.sql:ro/);

    assert.match(noOpDdl, /SELECT 1;/);
    assert.doesNotMatch(noOpDdl, /\bCREATE\s+(?:TABLE|VIEW|SCHEMA)\b/i);
  });
});

describe('deploy-files hardening', () => {
  test('writes files inside the project root', async () => {
    const folder = path.join(projectRoot, 'db-init');
    const r = await api('/api/deploy-files', { body: { folder, files: { '04-test.sql': 'SELECT 1;' } } });
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(folder, '04-test.sql'), 'utf8'), 'SELECT 1;');
  });

  test('defaults to <root>/db-init when no folder is given', async () => {
    const r = await api('/api/deploy-files', { body: { files: { 'default-loc.sql': '-- hi' } } });
    const body = await r.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.folder, path.join(projectRoot, 'db-init'));
  });

  test('rejects folders outside the project root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-outside-'));
    try {
      const r = await api('/api/deploy-files', { body: { folder: outside, files: { 'evil.sh': 'rm -rf /' } } });
      const body = await r.json();
      assert.strictEqual(r.status, 400);
      assert.match(body.error, /inside the project root/i);
      assert.ok(!fs.existsSync(path.join(outside, 'evil.sh')));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('rejects path-traversal folder values', async () => {
    const r = await api('/api/deploy-files', { body: { folder: path.join(projectRoot, '..', '..'), files: { 'x.sql': '1' } } });
    assert.strictEqual(r.status, 400);
  });

  test('rejects unsafe filenames', async () => {
    for (const name of ['../escape.sql', 'a/b.sql', 'a\\b.sql', '..']){
      const r = await api('/api/deploy-files', { body: { files: { [name]: 'x' } } });
      const body = await r.json();
      assert.strictEqual(r.status, 400, `${name} should be rejected`);
      assert.match(body.error, /Unsafe file name/);
    }
  });

  test('rejects an empty file set', async () => {
    const r = await api('/api/deploy-files', { body: { files: {} } });
    assert.strictEqual(r.status, 400);
  });
});

describe('read-only query gate', () => {
  test('rejects non-SELECT statements outright', async () => {
    for (const sql of [
      'DELETE FROM pdi_meta.inst_runs',
      'UPDATE t SET a=1',
      'DROP TABLE x',
      'INSERT INTO t VALUES (1)',
      'SELECT 1; DELETE FROM t', // multi-statement
    ]){
      const r = await api('/api/query', { body: { host:'127.0.0.1', database:'x', user:'x', sql } });
      const body = await r.json();
      assert.strictEqual(r.status, 400, `${sql} should be rejected`);
      assert.match(body.error, /Only a single SELECT/i, `${sql} should hit the shape gate`);
    }
  });

  test('WITH … SELECT CTEs pass the shape gate (fail later only on connection)', async () => {
    const r = await api('/api/query', {
      body: { host: '127.0.0.1', port: 59999, database: 'nope', user: 'nobody', sql: 'WITH t AS (SELECT 1 AS a) SELECT * FROM t' },
    });
    const body = await r.json();
    assert.strictEqual(r.status, 400);
    // The point: the error is a CONNECTION failure, not the shape-gate message.
    assert.doesNotMatch(body.error, /Only a single SELECT/i);
  });

  test('plain SELECT passes the shape gate too', async () => {
    const r = await api('/api/query', {
      body: { host: '127.0.0.1', port: 59999, database: 'nope', user: 'nobody', sql: 'SELECT 1' },
    });
    const body = await r.json();
    assert.doesNotMatch(body.error, /Only a single SELECT/i);
  });

  test('read-only role probes only allow the data_vault and pdi_meta service roles', async () => {
    const rejected = await api('/api/query', {
      body: { host: '127.0.0.1', port: 59999, database: 'nope', user: 'nobody', role: 'dvuser', sql: 'SELECT 1' },
    });
    const rejectedBody = await rejected.json();
    assert.strictEqual(rejected.status, 400);
    assert.match(rejectedBody.error, /Unsupported read-only query role/);

    for (const role of ['data_vault', 'pdi_meta']) {
      const allowed = await api('/api/query', {
        body: { host: '127.0.0.1', port: 59999, database: 'nope', user: 'nobody', role, sql: 'SELECT 1' },
      });
      const allowedBody = await allowed.json();
      assert.doesNotMatch(allowedBody.error, /Unsupported read-only query role/);
    }
  });
});

describe('fetch-driver allowlist', () => {
  test('rejects non-allowlisted hosts', async () => {
    const r = await api('/api/fetch-driver', { body: { url: 'https://evil.example.com/x.jar', filename: 'x.jar' } });
    const body = await r.json();
    assert.strictEqual(r.status, 400);
    assert.match(body.error, /not in the allowed driver-source list/);
  });

  test('rejects plain http even for allowed hosts', async () => {
    const r = await api('/api/fetch-driver', { body: { url: 'http://repo1.maven.org/x.jar', filename: 'x.jar' } });
    assert.strictEqual(r.status, 400);
  });

  test('rejects unsafe driver filenames', async () => {
    const r = await api('/api/fetch-driver', { body: { url: 'https://repo1.maven.org/x.jar', filename: '../x.jar' } });
    const body = await r.json();
    assert.strictEqual(r.status, 400);
    assert.match(body.error, /Unsafe file name/);
  });
});

describe('profile-table identifier validation', () => {
  test('rejects malformed table profile identifiers before touching any database', async () => {
    for (const bad of [
      { schema:'public; DROP TABLE x', table:'t', columns:['c'] },
      { schema:'public', table:'t"t', columns:['c'] },
      { schema:'public', table:'t', columns:['c or 1=1'] },
      { schema:'public', table:'t', columns:[] },
    ]){
      const r = await api('/api/profile-table', { body:Object.assign({ host:'127.0.0.1', database:'x', user:'x' }, bad) });
      const body = await r.json();
      assert.strictEqual(r.status, 400);
      assert.match(body.error, /Invalid (schema|table|column) identifier|Profile columns/);
    }
  });
});

describe('profile-column identifier validation', () => {
  test('rejects malformed identifiers before touching any database', async () => {
    for (const bad of [
      { schema: 'public; DROP TABLE x', table: 't', column: 'c' },
      { schema: 'public', table: 't"t', column: 'c' },
      { schema: 'public', table: 't', column: 'c or 1=1' },
      { schema: '', table: 't', column: 'c' },
    ]){
      const r = await api('/api/profile-column', { body: Object.assign({ host:'127.0.0.1', database:'x', user:'x' }, bad) });
      const body = await r.json();
      assert.strictEqual(r.status, 400);
      assert.match(body.error, /Invalid (schema|table|column) identifier/);
    }
  });
});

describe('file-status', () => {
  test('rejects unknown roots and unsafe names', async () => {
    let r = await api('/api/file-status', { body: { files: [{ root: 'etc', name: 'passwd' }] } });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /Unknown root/);
    r = await api('/api/file-status', { body: { files: [{ root: 'hop', name: '../secrets.json' }] } });
    assert.strictEqual(r.status, 400);
    r = await api('/api/file-status', { body: {} });
    assert.strictEqual(r.status, 400);
  });

  test('reports missing files, and returns content for small json files', async () => {
    const hopDir = path.join(projectRoot, 'hop');
    fs.mkdirSync(hopDir, { recursive: true });
    fs.writeFileSync(path.join(hopDir, 'postgres-environment.json'), '{"name":"postgres"}');
    const r = await api('/api/file-status', { body: { files: [
      { root: 'hop', name: 'postgres-environment.json' },
      { root: 'mappings', name: 'metadata_spreadsheet_1.xls' },
    ] } });
    const body = await r.json();
    assert.strictEqual(body.ok, true);
    const hop = body.files.find(f => f.root === 'hop');
    assert.strictEqual(hop.exists, true);
    assert.strictEqual(hop.content, '{"name":"postgres"}');
    assert.ok(hop.mtimeMs > 0);
    const wb = body.files.find(f => f.root === 'mappings');
    assert.strictEqual(wb.exists, false);
    fs.rmSync(hopDir, { recursive: true, force: true });
  });
});

describe('driver-status', () => {
  test('reports no MySQL driver when jdbc-drivers/ is empty or missing', async () => {
    const r = await fetch(`${BASE}/api/driver-status`);
    const body = await r.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.mysqlDriver, null);
    assert.strictEqual(body.sqlServerDriver, null);
    assert.deepStrictEqual(body.jars, []);
  });

  test('finds a Connector/J jar once one is in place', async () => {
    const dir = path.join(projectRoot, 'jdbc-drivers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mysql-connector-j-9.7.0.jar'), 'stub');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored'); // non-jar ignored
    const r = await fetch(`${BASE}/api/driver-status`);
    const body = await r.json();
    assert.strictEqual(body.mysqlDriver, 'mysql-connector-j-9.7.0.jar');
    assert.deepStrictEqual(body.jars, ['mysql-connector-j-9.7.0.jar']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('finds a Microsoft SQL Server JDBC jar once one is in place', async () => {
    const dir = path.join(projectRoot, 'jdbc-drivers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mssql-jdbc-13.4.0.jre11.jar'), 'stub');
    const r = await fetch(`${BASE}/api/driver-status`);
    const body = await r.json();
    assert.strictEqual(body.sqlServerDriver, 'mssql-jdbc-13.4.0.jre11.jar');
    assert.deepStrictEqual(body.jars, ['mssql-jdbc-13.4.0.jre11.jar']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});


describe('external storage deployment API guards', () => {
  test('driver path status only accepts the packaged mount path', async () => {
    let r = await api('/api/driver-path-status', { body: { jarfile: '/tmp/driver.jar' } });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /only mounts jars below/i);

    r = await api('/api/driver-path-status', { body: { jarfile: '/opt/jdbc-drivers/postgresql-42.7.5.jar' } });
    let body = await r.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.exists, false);

    const dir = path.join(projectRoot, 'jdbc-drivers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'postgresql-42.7.5.jar'), 'stub');
    r = await api('/api/driver-path-status', { body: { jarfile: '/opt/jdbc-drivers/postgresql-42.7.5.jar' } });
    body = await r.json();
    assert.strictEqual(body.exists, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('unsupported remote engines fail before any connection attempt', async () => {
    for (const endpoint of ['/api/external-db-status','/api/external-create-database','/api/external-table-status','/api/external-verify-user-access']){
      const r = await api(endpoint, { body: { dialect:'oracle', host:'127.0.0.1', database:'dv', user:'x', tables:['hub_x'] } });
      const body = await r.json();
      assert.strictEqual(r.status, 400);
      assert.match(body.error, /does not support dialect/i);
    }
  });

  test('invalid database and table identifiers are rejected before connecting', async () => {
    let r = await api('/api/external-db-status', { body: { dialect:'postgresql', host:'127.0.0.1', database:'dv;drop database x', user:'x' } });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /plain identifier/i);

    r = await api('/api/external-table-status', { body: { dialect:'mysql', host:'127.0.0.1', database:'dv', user:'x', tables:['hub_ok','bad-name'] } });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /plain identifier/i);

    r = await api('/api/external-verify-user-access', { body: { dialect:'mysql', host:'127.0.0.1', database:'bad-name', user:'x', password:'x' } });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /plain identifier/i);

    r = await api('/api/external-table-status', { body: { dialect:'sqlserver', host:'127.0.0.1', database:'dv', schema:'dbo', user:'x', tables:['hub_ok','bad-name'] } });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /plain identifier/i);
  });

  test('external SQL execution requires a non-empty script', async () => {
    const r = await api('/api/external-execute-sql', { body: { dialect:'postgresql', sql:'   ' } });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /No SQL provided/i);
  });
});

describe('scheduler config', () => {
  test('rejects a sub-1-minute interval', async () => {
    const r = await api('/api/scheduler/config', { body: { intervalMinutes: 0 } });
    assert.strictEqual(r.status, 400);
  });

  test('enabling sets nextRunAt; disabling clears it', async () => {
    let r = await api('/api/scheduler/config', { body: { enabled: true, intervalMinutes: 60 } });
    let body = await r.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.enabled, true);
    assert.ok(body.nextRunAt, 'nextRunAt should be scheduled');
    r = await api('/api/scheduler/config', { body: { enabled: false } });
    body = await r.json();
    assert.strictEqual(body.enabled, false);
    assert.strictEqual(body.nextRunAt, null);
  });

  test('status endpoint reflects persisted state', async () => {
    const r = await fetch(`${BASE}/api/scheduler/status`);
    const body = await r.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(typeof body.intervalMinutes, 'number');
  });
});

describe('docker endpoints stay fixed-command and answer JSON', () => {
  test('docker/logs returns a JSON envelope even when docker is unavailable', async () => {
    const r = await api('/api/docker/logs', { body: { tail: 50 } });
    const body = await r.json();
    assert.strictEqual(typeof body.ok, 'boolean'); // ok:false w/ error when docker is missing — never a crash
  });

  test('start-db/stop-db reject services outside the allowlist', async () => {
    for (const p of ['/api/docker/start-db', '/api/docker/stop-db']){
      for (const service of ['hop', 'evil; rm -rf /', '', undefined]){
        const r = await api(p, { body: { service } });
        const body = await r.json();
        assert.strictEqual(r.status, 400, `${p} should reject service "${service}"`);
        assert.match(body.error, /allowed: mysql, postgres/);
      }
    }
  });

  test('start-db/stop-db accept the packaged services and answer JSON', async () => {
    for (const service of ['mysql', 'postgres']){
      const r = await api('/api/docker/start-db', { body: { service } });
      const body = await r.json();
      assert.strictEqual(typeof body.ok, 'boolean'); // stub start.sh exits 0 in this test root
      const r2 = await api('/api/docker/stop-db', { body: { service } });
      assert.strictEqual(typeof (await r2.json()).ok, 'boolean');
    }
  });

  test('start-db uses the FDW compose override only when explicitly requested', async () => {
    const logPath = path.join(projectRoot, 'args.log');
    const envLogPath = path.join(projectRoot, 'env.log');
    fs.rmSync(logPath, { force: true });
    fs.rmSync(envLogPath, { force: true });
    await api('/api/docker/start-db', { body: { service: 'mysql' } });
    await api('/api/docker/start-db', { body: { service: 'postgres' } });
    await api('/api/docker/start-db', { body: { service: 'postgres', fdw: true } });
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const envLog = fs.readFileSync(envLogPath, 'utf8').split('\n');
    assert.strictEqual(log[0], 'up --demo -d mysql');
    assert.strictEqual(log[1], 'up -d postgres');
    assert.strictEqual(log[2], 'up --fdw -d postgres');
    assert.strictEqual(envLog[0], '');
    assert.strictEqual(envLog[1], '');
    assert.strictEqual(envLog[2], '');
  });

  test('FDW mode is rejected for MySQL and non-boolean values', async () => {
    let r = await api('/api/docker/start-db', { body: { service: 'mysql', fdw: true } });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /only valid for the postgres/i);
    r = await api('/api/docker/start-db', { body: { service: 'postgres', fdw: 'yes' } });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /must be true or false/i);
  });

  test('run-hop maps engine modes to the new start.sh flags', async () => {
    const logPath = path.join(projectRoot, 'args.log');
    const cases = [
      [{ mode: 'demo' },                    'up --demo -d hop'],
      [{ mode: 'internal' },                'up -d hop'],
      [{},                                  'up -d hop'],            // default
      [{ mode: 'external' },                'up --external-postgres -d hop'],
      [{ mode: 'external', build: true },   'up --external-postgres --build -d hop'],
      [{ mode: 'internal', build: true },   'up -d hop'],            // build only applies to external
    ];
    for (const [body, expected] of cases){
      fs.rmSync(logPath, { force: true });
      const r = await api('/api/docker/run-hop', { body });
      const resp = await r.json();
      assert.strictEqual(resp.ok, true);
      assert.strictEqual(fs.readFileSync(logPath, 'utf8').trim(), expected, JSON.stringify(body));
    }
  });

  test('run-hop rejects unknown modes', async () => {
    const r = await api('/api/docker/run-hop', { body: { mode: 'both; rm -rf /' } });
    const body = await r.json();
    assert.strictEqual(r.status, 400);
    assert.match(body.error, /allowed: demo, internal, external/);
  });

  test('scheduler stores a validated engine mode and runs with it', async () => {
    let r = await api('/api/scheduler/config', { body: { mode: 'evil' } });
    assert.strictEqual(r.status, 400);
    r = await api('/api/scheduler/config', { body: { mode: 'demo' } });
    const body = await r.json();
    assert.strictEqual(body.mode, 'demo');
    const logPath = path.join(projectRoot, 'args.log');
    fs.rmSync(logPath, { force: true });
    await api('/api/scheduler/run-now', { body: {} });
    assert.strictEqual(fs.readFileSync(logPath, 'utf8').trim(), 'up --demo -d hop');
    await api('/api/scheduler/config', { body: { mode: 'internal', enabled: false } });
  });

  test('validate-workbook reports a clear error when no validator script exists', async () => {
    const r = await api('/api/validate-workbook', { body: { workbookBase64: Buffer.from('x').toString('base64'), filename: 'wb.xls' } });
    const body = await r.json();
    assert.strictEqual(r.status, 400);
    assert.match(body.error, /validator not found/i);
  });
});


describe('start.sh failure diagnostics', () => {
  const stubPath = () => path.join(projectRoot, 'start.sh');
  let original;
  beforeEach(() => { original = fs.readFileSync(stubPath()); });
  afterEach(() => { fs.writeFileSync(stubPath(), original); fs.chmodSync(stubPath(), 0o755); });

  test('license prompt on stdout becomes a clear, actionable error', async () => {
    fs.writeFileSync(stubPath(), '#!/bin/bash\necho "LICENSE AGREEMENT"\necho "You must accept the license agreement before the ETL process can start."\nexit 1\n');
    fs.chmodSync(stubPath(), 0o755);
    const r = await (await api('/api/docker/start-db', { body: { service: 'mysql' } })).json();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /License not accepted/i);
    assert.match(r.error, /accept it in the GUI/i);
  });

  test('other non-zero exits carry the exit code and the output tail', async () => {
    fs.writeFileSync(stubPath(), '#!/bin/bash\necho "no configuration file provided: not found" >&2\nexit 14\n');
    fs.chmodSync(stubPath(), 0o755);
    const r = await (await api('/api/docker/start-db', { body: { service: 'postgres' } })).json();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /exited with code 14/);
    assert.match(r.error, /no configuration file provided/);
  });
});


describe('license endpoints', () => {
  const licPath = () => path.join(projectRoot, 'LICENSE');
  const markerPath = () => path.join(projectRoot, '.license-state', 'license.accepted');
  afterEach(() => {
    fs.rmSync(licPath(), { force: true });
    fs.rmSync(path.join(projectRoot, '.license-state'), { recursive: true, force: true });
  });

  test('no LICENSE file: exists=false, never accepted, accept refused', async () => {
    const st = await (await api('/api/license', { method: 'GET' })).json();
    assert.deepStrictEqual({ exists: st.exists, accepted: st.accepted }, { exists: false, accepted: false });
    const r = await api('/api/license-accept', { body: { accept: true } });
    assert.strictEqual(r.status, 400);
  });

  test('acceptance must be explicit', async () => {
    fs.writeFileSync(licPath(), 'TEST LICENSE v1\n');
    const r = await api('/api/license-accept', { body: {} });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /explicit/i);
    assert.ok(!fs.existsSync(markerPath()), 'no marker without explicit accept');
  });

  test('accept writes the same marker the start scripts use, and status flips', async () => {
    fs.writeFileSync(licPath(), 'TEST LICENSE v1\n');
    let st = await (await api('/api/license', { method: 'GET' })).json();
    assert.strictEqual(st.exists, true);
    assert.strictEqual(st.accepted, false);
    assert.strictEqual(st.text, 'TEST LICENSE v1\n');

    const r = await (await api('/api/license-accept', { body: { accept: true } })).json();
    assert.strictEqual(r.ok, true);
    const marker = fs.readFileSync(markerPath(), 'utf8');
    const expectedHash = require('node:crypto').createHash('sha256').update('TEST LICENSE v1\n').digest('hex');
    assert.ok(marker.includes(`license_sha256=${expectedHash}`), 'marker carries the LICENSE sha256');
    assert.ok(marker.includes('accepted_method=vault studio gui'));

    st = await (await api('/api/license', { method: 'GET' })).json();
    assert.strictEqual(st.accepted, true);
  });

  test('changing the LICENSE file invalidates a previous acceptance', async () => {
    fs.writeFileSync(licPath(), 'TEST LICENSE v1\n');
    await api('/api/license-accept', { body: { accept: true } });
    fs.writeFileSync(licPath(), 'TEST LICENSE v2 — new terms\n');
    const st = await (await api('/api/license', { method: 'GET' })).json();
    assert.strictEqual(st.accepted, false, 'stale hash must not count as accepted');
  });
});


describe('env-defaults', () => {
  const envPath = () => path.join(projectRoot, '.env');
  afterEach(() => fs.rmSync(envPath(), { force: true }));

  test('no .env file: found=false, no credentials invented', async () => {
    const r = await (await api('/api/env-defaults', { method: 'GET' })).json();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.mysql, undefined);
  });

  test('parses the compose .env shape including ${VAR} references', async () => {
    fs.writeFileSync(envPath(), [
      '# Destination database password',
      'VAULT_PASSWORD=vault-password',
      'SOURCE_PASSWORD=password',
      'POSTGRES_BOOTSTRAP_USER=postgres_admin',
      'POSTGRES_BOOTSTRAP_PASSWORD=bootstrap-password',
      'DB_USER=dvuser',
      'DB_PASSWORD=${VAULT_PASSWORD}',
      'MYSQL_USER=sakila',
      'MYSQL_PASSWORD=${SOURCE_PASSWORD}',
      '',
    ].join('\n'));
    const r = await (await api('/api/env-defaults', { method: 'GET' })).json();
    assert.strictEqual(r.found, true);
    assert.deepStrictEqual(r.mysql, { user: 'sakila', password: 'password' });
    assert.deepStrictEqual(r.target, { user: 'dvuser', password: 'vault-password' });
    assert.deepStrictEqual(r.bootstrap, { user: 'postgres_admin', password: 'bootstrap-password' });
    assert.deepStrictEqual(r.vault, { password: 'vault-password' });
  });
});


describe('bootstrap endpoint', () => {
  const licPath = () => path.join(projectRoot, 'LICENSE');
  afterEach(() => {
    fs.rmSync(licPath(), { force: true });
    fs.rmSync(path.join(projectRoot, '.license-state'), { recursive: true, force: true });
  });

  test('refuses to run without an accepted license', async () => {
    fs.writeFileSync(licPath(), 'TEST LICENSE\n');
    const r = await api('/api/docker/bootstrap', { body: {} });
    assert.strictEqual(r.status, 403);
    assert.match((await r.json()).error, /license/i);
  });

  test('after acceptance it attempts the compose bootstrap (fixed args only)', async () => {
    fs.writeFileSync(licPath(), 'TEST LICENSE\n');
    await api('/api/license-accept', { body: { accept: true } });
    const r = await (await api('/api/docker/bootstrap', { body: {} })).json();
    // no docker in the test env — we only assert the gate opened and the
    // response has the endpoint's shape, never a hang or a 403
    assert.strictEqual(typeof r.ok, 'boolean');
    if (!r.ok) assert.ok(r.error);
  });
});

describe('allowlisted project .env credential deployment', () => {
  const envPath = () => path.join(projectRoot, '.env');
  afterEach(() => fs.rmSync(envPath(), { force: true }));

  test('credential status distinguishes internal and external PostgreSQL targets', async () => {
    fs.writeFileSync(envPath(), [
      'POSTGRES_BOOTSTRAP_USER=postgres_admin',
      'POSTGRES_BOOTSTRAP_PASSWORD=bootstrap-password',
      'SOURCE_PASSWORD=source-secret',
      'VAULT_PASSWORD=target-secret',
      'DB_USER=data-vault-user',
      '',
    ].join('\n'));

    const internal = await (await api('/api/env-credentials/status', {
      body: { sourcePassword:'source-secret', targetPassword:'target-secret', targetUser:'data-vault-user', externalPostgres:false },
    })).json();
    assert.strictEqual(internal.sourceMatches, true);
    assert.strictEqual(internal.targetMatches, true);
    assert.strictEqual(internal.targetUserMatches, true);

    const external = await (await api('/api/env-credentials/status', {
      body: { sourcePassword:'source-secret', targetPassword:'bootstrap-password', targetUser:'postgres_admin', externalPostgres:true },
    })).json();
    assert.strictEqual(external.sourceMatches, true);
    // Native PostgreSQL also requires VAULT_PASSWORD to match the single GUI target password.
    assert.strictEqual(external.targetMatches, false);
    assert.strictEqual(external.targetUserMatches, true);
  });

  test('internal/FDW deployment updates SOURCE_PASSWORD only', async () => {
    const original = [
      '# Existing deployment settings',
      'POSTGRES_BOOTSTRAP_USER=old-admin',
      'POSTGRES_BOOTSTRAP_PASSWORD=old-admin-secret',
      'UNRELATED_SETTING=keep-me',
      'SOURCE_PASSWORD=old-source',
      'VAULT_PASSWORD=internal-target-secret',
      'DB_USER=internal-user',
      'MYSQL_PASSWORD=${SOURCE_PASSWORD}',
      '',
    ].join('\n');
    fs.writeFileSync(envPath(), original);

    const response = await api('/api/env-credentials', {
      body: { sourcePassword:'new source #1', externalPostgres:false },
    });
    const body = await response.json();
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(body.updated, ['SOURCE_PASSWORD']);
    const next=fs.readFileSync(envPath(),'utf8');
    assert.match(next, /SOURCE_PASSWORD='new source #1'/);
    assert.match(next, /POSTGRES_BOOTSTRAP_USER=old-admin/);
    assert.match(next, /POSTGRES_BOOTSTRAP_PASSWORD=old-admin-secret/);
    assert.match(next, /VAULT_PASSWORD=internal-target-secret/);
    assert.match(next, /DB_USER=internal-user/);
    assert.match(next, /UNRELATED_SETTING=keep-me/);
    assert.match(next, /MYSQL_PASSWORD=\$\{SOURCE_PASSWORD\}/);
  });

  test('native PostgreSQL deployment updates source, bootstrap and runtime role secrets without touching DB_*', async () => {
    fs.writeFileSync(envPath(), [
      '# Preserve comments and unrelated values',
      'SOURCE_PASSWORD=old-source',
      'POSTGRES_BOOTSTRAP_USER=old-admin',
      'POSTGRES_BOOTSTRAP_PASSWORD=old-admin-secret',
      'VAULT_PASSWORD=old-vault-secret',
      'DB_USER=internal-user',
      'DB_PASSWORD=${VAULT_PASSWORD}',
      'UNRELATED_SETTING=keep-me',
      '',
    ].join('\n'));

    const response = await api('/api/env-credentials', {
      body: { sourcePassword:'new-source', targetUser:'customer_admin', targetPassword:'new-target', externalPostgres:true },
    });
    const body=await response.json();
    assert.strictEqual(response.status,200);
    assert.deepStrictEqual(body.updated, ['SOURCE_PASSWORD','POSTGRES_BOOTSTRAP_USER','POSTGRES_BOOTSTRAP_PASSWORD','VAULT_PASSWORD']);
    const next=fs.readFileSync(envPath(),'utf8');
    assert.match(next,/SOURCE_PASSWORD=new-source/);
    assert.match(next,/POSTGRES_BOOTSTRAP_USER=customer_admin/);
    assert.match(next,/POSTGRES_BOOTSTRAP_PASSWORD=new-target/);
    assert.match(next,/VAULT_PASSWORD=new-target/);
    assert.match(next,/DB_USER=internal-user/);
    assert.match(next,/DB_PASSWORD=\$\{VAULT_PASSWORD\}/);
    assert.match(next,/UNRELATED_SETTING=keep-me/);
  });

  test('updates duplicate allowlisted keys consistently', async () => {
    fs.writeFileSync(envPath(), 'SOURCE_PASSWORD=first\nSOURCE_PASSWORD=second\nDB_USER=keep\n');
    const response=await api('/api/env-credentials',{body:{sourcePassword:'replacement',externalPostgres:false}});
    assert.strictEqual(response.status,200);
    const next=fs.readFileSync(envPath(),'utf8');
    assert.strictEqual((next.match(/SOURCE_PASSWORD=replacement/g)||[]).length,2);
    assert.match(next,/DB_USER=keep/);
  });

  test('rejects line breaks and leaves .env unchanged', async () => {
    const original='SOURCE_PASSWORD=unchanged\nDB_USER=keep\n';
    fs.writeFileSync(envPath(),original);
    const response=await api('/api/env-credentials',{body:{sourcePassword:'bad\nvalue',externalPostgres:false}});
    assert.strictEqual(response.status,400);
    assert.match((await response.json()).error,/line breaks/i);
    assert.strictEqual(fs.readFileSync(envPath(),'utf8'),original);
  });

  test('generic file deployment still refuses the project .env target', async () => {
    const original = 'DB_USER=administrator-controlled\n';
    fs.writeFileSync(envPath(), original);
    const response = await api('/api/deploy-files', {
      body: { folder:projectRoot, files:{ '.env':'DB_USER=studio-overwrite\n' } },
    });
    assert.strictEqual(response.status, 400);
    assert.match((await response.json()).error, /\.env file is read-only/i);
    assert.strictEqual(fs.readFileSync(envPath(), 'utf8'), original);
  });
});
