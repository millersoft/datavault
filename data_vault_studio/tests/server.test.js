/**
 * Companion-server tests — create the Express app against a throwaway project
 * root and invoke its route handlers without opening a network listener:
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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server/app');
const { selectStudioLauncher } = require('../server/routes/engine');
const { readServerSources } = require('./helpers/load-app');

let app;
let projectRoot;

function readExternalPostgresBootstrap(){
  return fs.readFileSync(path.join(__dirname, '..', '..', 'docker', 'bootstrap_postgres_target.sh'), 'utf8');
}

function matchRoute(routePath, pathname){
  const expected=String(routePath).split('/').filter(Boolean);
  const actual=String(pathname).split('?')[0].split('/').filter(Boolean);
  if(expected.length!==actual.length)return null;
  const params={};
  for(let i=0;i<expected.length;i++){
    if(expected[i].startsWith(':'))params[expected[i].slice(1)]=decodeURIComponent(actual[i]);
    else if(expected[i]!==actual[i])return null;
  }
  return params;
}

function findRoute(stack, method, pathname){
  for(const layer of stack||[]){
    if(layer.route && layer.route.methods[method.toLowerCase()]){
      const params=matchRoute(layer.route.path,pathname);
      if(params)return {route:layer.route,params};
    }
    if(layer.handle&&Array.isArray(layer.handle.stack)){
      const nested=findRoute(layer.handle.stack,method,pathname);
      if(nested)return nested;
    }
  }
  return null;
}

async function api(pathname, { method = 'POST', body, headers = {} } = {}){
  const found=findRoute(app._router.stack,method,pathname);
  if(!found)throw new Error(`Route not registered: ${method} ${pathname}`);
  const responseHeaders=new Map();
  let status=200, payload;
  let finishResponse;
  const responseFinished=new Promise(resolve=>{finishResponse=resolve;});
  const res={
    status(code){status=code;return this;},
    set(name,value){responseHeaders.set(String(name).toLowerCase(),String(value));return this;},
    type(value){responseHeaders.set('content-type',value==='html'?'text/html; charset=utf-8':String(value));return this;},
    json(value){payload=value;finishResponse();return this;},
    send(value){payload=value;finishResponse();return this;},
  };
  const req={body:body||{},headers,params:found.params,method,path:pathname};
  for(const layer of found.route.stack)await layer.handle(req,res,()=>{});
  if(payload===undefined){
    await Promise.race([
      responseFinished,
      new Promise((_,reject)=>setTimeout(()=>reject(new Error(`Route did not respond: ${method} ${pathname}`)),30000)),
    ]);
  }
  return {
    status,
    ok:status>=200&&status<300,
    headers:{get(name){return responseHeaders.get(String(name).toLowerCase())||null;}},
    async json(){return payload;},
    async text(){return typeof payload==='string'?payload:JSON.stringify(payload);},
  };
}

before(async () => {
  // Fake project root: server treats the dir containing start.sh + compose
  // as the project. Token + scheduler state land here, not in the repo.
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-server-test-'));
  // Stub start.sh records its arguments so tests can assert the exact
  // flag-based invocations (matching the real script's new interface).
  fs.writeFileSync(path.join(projectRoot, 'start.sh'),
    '#!/bin/bash\necho "$@" >> args.log\necho "${INTERNAL_DATA_VAULT_DATABASE:-}" >> env.log\nexit 0\n');
  fs.writeFileSync(path.join(projectRoot, 'docker-compose.yaml'), 'services: {}\n');

  const env=Object.assign({},process.env,{
    DVS_PROJECT_ROOT:projectRoot,
    DVS_DATABASE_PACK_HOME:path.join(projectRoot,'data_vault_studio','database-packs'),
  });
  app=createApp({studioMode:'production',env});
});

after(() => {
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('Studio launcher selection', () => {
  test('uses bash and start.sh on non-Windows platforms', () => {
    const root = path.join('tmp', 'studio project');
    const scriptPath = path.join(root, 'start.sh');
    assert.deepStrictEqual(selectStudioLauncher(root, ['up', '--fdw'], 'linux'), {
      command: 'bash',
      args: [scriptPath, 'up', '--fdw'],
      scriptPath,
      label: 'start.sh',
    });
  });

  test('uses native noninteractive Windows PowerShell and start.ps1 on win32', () => {
    const winPath = path.win32;
    const root = 'C:\\studio project';
    const scriptPath = winPath.join(root, 'start.ps1');
    assert.deepStrictEqual(selectStudioLauncher(root, ['exec', '-T', 'postgres'], 'win32', winPath), {
      command: 'powershell.exe',
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, 'exec', '-T', 'postgres',
      ],
      scriptPath,
      label: 'start.ps1',
    });
  });
});

describe('runtime mode defaults', () => {
  test('npm start defaults to production when no mode override is supplied', () => {
    const source = readServerSources();
    assert.match(source, /requested \|\| env\.STUDIO_MODE \|\| 'production'/);
  });
});

describe('basics', () => {
  test('GET /api/health answers with the resolved project root', async () => {
    const r = await api('/api/health',{method:'GET'});
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.projectRoot, projectRoot);
    assert.strictEqual(body.studioMode, 'production');
  });

  test('GET / serves the GUI', async () => {
    const r = await api('/',{method:'GET'});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.ok(html.includes('Data Vault Studio'));
    assert.ok(html.includes('millersoft'), 'should be the real GUI page');
    assert.ok(html.includes("const STUDIO_RUNTIME_MODE = 'production' === 'demo' ? 'demo' : 'production'"));
    assert.ok(!html.includes('__STUDIO_RUNTIME_MODE__'));
  });

  test('GET /api/runtime-profile reports the selected npm-start mode', async () => {
    const r = await api('/api/runtime-profile',{method:'GET'});
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(body, { ok:true, mode:'production', isDemo:false, isProduction:true });
  });
});

describe('Studio-managed Postgres bootstrap scope', () => {
  function runVaultPasswordInit(dumpSource, env = {}){
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-init-test-'));
    const dumpPath = path.join(temp, '02-dump.sql');
    const scriptPath = path.join(temp, '01-vault-password.sh');
    fs.writeFileSync(dumpPath, dumpSource);
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'db-init', '01-vault-password.sh'), 'utf8')
      .replace('DUMP_FILE="/docker-entrypoint-initdb.d/02-dump.sql"', `DUMP_FILE=${JSON.stringify(dumpPath)}`);
    fs.writeFileSync(scriptPath, source, { mode:0o755 });
    const sedPath = path.join(temp, 'sed');
    fs.writeFileSync(sedPath, '#!/bin/bash\nif [ "$1" = "-i" ]; then shift; exec /usr/bin/sed -i "" "$@"; fi\nexec /usr/bin/sed "$@"\n', { mode:0o755 });
    const result = spawnSync('bash', [scriptPath], {
      encoding:'utf8',
      env:{ ...process.env, PATH:`${temp}:${process.env.PATH}`, VAULT_PASSWORD:'test_password', ...env },
    });
    const dump = fs.readFileSync(dumpPath, 'utf8');
    fs.rmSync(temp, { recursive:true, force:true });
    return { ...result, dump };
  }

  test('internal init validates and exactly rewrites the default target database fallback', () => {
    const source = '\\set unrelated datavault\n\\set target_database datavault\nSELECT \'VAULT_PASSWORD\';\n';
    const valid = runVaultPasswordInit(source, { INTERNAL_DATA_VAULT_DATABASE:'Customer_Vault2' });
    assert.strictEqual(valid.status, 0, valid.stderr);
    assert.match(valid.dump, /^\\set target_database Customer_Vault2$/m);
    assert.doesNotMatch(valid.dump, /^\\set target_database datavault$/m);
    assert.match(valid.dump, /^\\set unrelated datavault$/m, 'only the exact fallback line is rewritten');

    const defaulted = runVaultPasswordInit(source);
    assert.strictEqual(defaulted.status, 0, defaulted.stderr);
    assert.match(defaulted.dump, /^\\set target_database datavault$/m);

    for (const database of ['9vault', 'vault-name', 'vault; SELECT 1']) {
      const invalid = runVaultPasswordInit(source, { INTERNAL_DATA_VAULT_DATABASE:database });
      assert.notStrictEqual(invalid.status, 0);
      assert.match(invalid.stderr + invalid.stdout, /plain SQL identifier/i);
      assert.match(invalid.dump, /^\\set target_database datavault$/m);
    }
  });

  test('external init keeps the fallback target line and injects only core target-role grants', () => {
    const source = '\\set target_database datavault\nDO $$\nBEGIN\n  NULL;\nEND\n$$;\nSELECT \'VAULT_PASSWORD\';\n';
    const result = runVaultPasswordInit(source, {
      EXTERNAL_POSTGRES_BOOTSTRAP:'true',
      POSTGRES_BOOTSTRAP_USER:'bootstrap_admin',
      INTERNAL_DATA_VAULT_DATABASE:'must_not_apply',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.dump, /^\\set target_database datavault$/m);
    assert.doesNotMatch(result.dump, /must_not_apply/);
    assert.match(result.dump, /External bootstrap role grants added by 01-vault-password\.sh/);
    assert.match(result.dump, /GRANT pdi_meta TO "bootstrap_admin";/);
    assert.match(result.dump, /GRANT staging TO "bootstrap_admin";/);
    assert.match(result.dump, /GRANT data_vault TO "bootstrap_admin";/);
    assert.doesNotMatch(result.dump, /GRANT sakila TO "bootstrap_admin";/);
  });

  test('parameterizes the operational database name for internal and external bootstrap', () => {
    const dump = fs.readFileSync(path.join(__dirname, '..', '..', 'db-init', '02-dump.sql'), 'utf8');
    const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yaml'), 'utf8');
    const wrapper = readExternalPostgresBootstrap();

    assert.match(compose, /^\s+INTERNAL_DATA_VAULT_DATABASE: \$\{INTERNAL_DATA_VAULT_DATABASE:-datavault\}$/m);

    assert.match(dump, /\\if :\{\?target_database\}[\s\S]*\\set target_database datavault[\s\S]*\\endif/);
    assert.match(dump, /format\('CREATE DATABASE %I OWNER data_vault', :'target_database'\)/);
    assert.match(dump, /\\connect :target_database/);
    for (const hardcoded of [
      /CREATE DATABASE datavault/i,
      /ALTER DATABASE datavault/i,
      /\\connect\s+datavault/i,
      /IN DATABASE datavault/i,
    ]) assert.doesNotMatch(dump, hardcoded);
    assert.doesNotMatch(dump, /DROP\s+DATABASE/i);

    assert.match(wrapper, /\[\[ ! "\$TARGET_DATABASE" =~ \^\[a-zA-Z_\]\[a-zA-Z0-9_\]\*\$ \]\]/);
    assert.match(wrapper, /format\('CREATE DATABASE %I', :'target_database'\)/);
    assert.strictEqual((wrapper.match(/-v target_database="\$TARGET_DATABASE"/g) || []).length, 2);
  });

  test('core PostgreSQL bootstrap contains no Sakila target role or schema', () => {
    const dump = fs.readFileSync(path.join(__dirname, '..', '..', 'db-init', '02-dump.sql'), 'utf8');
    const wrapper = readExternalPostgresBootstrap();

    assert.doesNotMatch(dump, /\bsakila\b/i);
    assert.doesNotMatch(dump, /include_sakila/i);
    assert.doesNotMatch(wrapper, /include_sakila/i);
    assert.match(dump, /ARRAY\['pdi_meta', 'staging', 'data_vault'\]/);
    assert.match(dump, /SET search_path TO staging, data_vault, pdi_meta, public/);
  });

  test('external bootstrap uses the exact ordered core-file allowlist and requires regular files', () => {
    const wrapper = readExternalPostgresBootstrap();
    const allowlist = wrapper.match(/core_files=\(\n([\s\S]*?)\n\)/);

    assert.ok(allowlist, 'core bootstrap allowlist should be declared explicitly');
    assert.deepStrictEqual(
      [...allowlist[1].matchAll(/"\$INIT_DIR\/([^"]+)"/g)].map(match => match[1]),
      ['01-vault-password.sh', '02-dump.sql']);
    assert.match(wrapper, /if \[ ! -d "\$INIT_DIR" \]; then[\s\S]*fail "Init directory not found: \$INIT_DIR"/);
    assert.match(wrapper, /for core_file in "\$\{core_files\[@\]\}"; do[\s\S]*if \[ ! -f "\$core_file" \]; then[\s\S]*fail "Required core bootstrap file not found or not a regular file: \$core_file"[\s\S]*done/);
  });

  test('external bootstrap logs every non-core entry and has no generic extension dispatcher', () => {
    const wrapper = readExternalPostgresBootstrap();
    const enumeration = wrapper.slice(
      wrapper.indexOf('for entry in "${init_entries[@]}"; do'),
      wrapper.indexOf('\ndone', wrapper.indexOf('for entry in "${init_entries[@]}"; do')) + '\ndone'.length);
    const allowlist = wrapper.match(/core_files=\(\n([\s\S]*?)\n\)/)[1];

    assert.match(wrapper, /shopt -s nullglob dotglob[\s\S]*init_entries=\("\$INIT_DIR"\/\*\)/);
    assert.match(enumeration, /01-vault-password\.sh\|02-dump\.sql\)[\s\S]*\*\)[\s\S]*Skipping non-core file during external PostgreSQL bootstrap: \$base_file/);
    for (const excluded of ['03-ddls.sql', '04-project.sql', '05-metadata.sql']) {
      assert.ok(!allowlist.includes(excluded), `${excluded} must not be in the core allowlist`);
    }
    assert.doesNotMatch(wrapper, /\*\.(?:sh|sql|sql\.gz)\)/);
    assert.doesNotMatch(wrapper, /gunzip|Running compressed SQL bootstrap file/);
  });

  test('external bootstrap executes 01 then 02 with target_database before writing the marker', () => {
    const wrapper = readExternalPostgresBootstrap();
    const shellIndex = wrapper.indexOf('bash "${core_files[0]}"');
    const sqlIndex = wrapper.indexOf('-f "${core_files[1]}"');
    const markerIndex = wrapper.lastIndexOf('write_bootstrap_marker');
    const sqlExecution = wrapper.slice(wrapper.lastIndexOf('psql \\', sqlIndex), sqlIndex + '-f "${core_files[1]}"'.length);

    assert.ok(shellIndex >= 0, '01-vault-password.sh should execute with bash');
    assert.ok(sqlIndex > shellIndex, '02-dump.sql should execute after 01-vault-password.sh');
    assert.ok(markerIndex > sqlIndex, 'the marker should be written only after both core files succeed');
    assert.match(sqlExecution, /-d "\$POSTGRES_BOOTSTRAP_DATABASE"[\s\S]*-v ON_ERROR_STOP=1[\s\S]*-v target_database="\$TARGET_DATABASE"/);
  });

  test('always masks generated 03-ddls.sql while keeping FDW packaging opt-in', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'postgres', 'Dockerfile'), 'utf8');
    const fdwDockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'postgres', 'Dockerfile.fdw'), 'utf8');
    const studioOverride = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.studio.yaml'), 'utf8');
    const fdwOverride = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.fdw.yaml'), 'utf8');
    const startScript = fs.readFileSync(path.join(__dirname, '..', '..', 'start.sh'), 'utf8');
    const startPowerShell = fs.readFileSync(path.join(__dirname, '..', '..', 'start.ps1'), 'utf8');
    const noOpDdl = fs.readFileSync(path.join(__dirname, '..', '..', 'docker', 'studio-skip-ddls.sql'), 'utf8');

    assert.match(dockerfile, /^FROM postgres:17$/m);
    assert.match(dockerfile, /^COPY db-init\/ \/docker-entrypoint-initdb\.d\/$/m);
    assert.doesNotMatch(dockerfile, /jdbc_fdw|openjdk/i);

    assert.match(studioOverride, /studio-skip-ddls\.sql:\/docker-entrypoint-initdb\.d\/03-ddls\.sql:ro/);
    assert.doesNotMatch(studioOverride, /Dockerfile\.fdw|jdbc-drivers/);
    assert.match(startScript, /if \[ "\$build_requested" = true \] && \[ "\$studio_build" = false \] && \[ "\$external_postgres" = false \] && \[ "\$fdw_mode" = false \]; then/);
    assert.match(startPowerShell, /if \(\$BuildRequested -and -not \$StudioBuild -and -not \$ExternalPostgres -and -not \$FdwMode\) \{/);
    assert.match(startScript, /COMPOSE_FILE="docker-compose\.yaml"/);
    assert.match(startScript, /COMPOSE_FILE="\$\{COMPOSE_FILE\}:docker-compose\.studio\.yaml"/);
    assert.match(startScript, /COMPOSE_FILE="\$\{COMPOSE_FILE\}:docker-compose\.fdw\.yaml"/);

    for (const launcher of [startScript, startPowerShell]) {
      assert.match(launcher, /--studio-build/);
      assert.match(launcher, /studio-build[\s\S]{0,180}--build/);
      assert.match(launcher, /studio-build[\s\S]*external-postgres[\s\S]{0,240}(?:only valid|Write-Error)/i);
    }
    assert.ok(
      startScript.indexOf('docker-compose.studio.yaml') < startScript.lastIndexOf('docker-compose.fdw.yaml'),
      'Bash must apply the Studio override before the FDW override');
    assert.ok(
      startPowerShell.indexOf('docker-compose.studio.yaml') < startPowerShell.lastIndexOf('docker-compose.fdw.yaml'),
      'PowerShell must apply the Studio override before the FDW override');
    assert.doesNotMatch(startScript, /compose[^\n]*--studio-build/);
    assert.doesNotMatch(startPowerShell, /ComposeArgs[^\n]*--studio-build/);

    const shellBootstrap = startScript.slice(
      startScript.indexOf('  bootstrap-external-postgres)'),
      startScript.indexOf('\n  up)', startScript.indexOf('  bootstrap-external-postgres)')));
    const powershellBootstrap = startPowerShell.slice(
      startPowerShell.indexOf('    "bootstrap-external-postgres" {'),
      startPowerShell.indexOf('\n    "up" {', startPowerShell.indexOf('    "bootstrap-external-postgres" {')));
    assert.match(shellBootstrap, /ensure_license_accepted/);
    assert.match(shellBootstrap, /COMPOSE_FILE="docker-compose\.yaml:docker-compose\.studio\.yaml"/);
    assert.match(shellBootstrap, /export DEMO_MODE=false[\s\S]*export WAIT_FOR_MYSQL=false/);
    assert.match(shellBootstrap, /compose --profile external-postgres-bootstrap build metadata-bootstrap[\s\S]*compose --profile external-postgres-bootstrap run --rm metadata-bootstrap[\s\S]*exit 0/);
    assert.doesNotMatch(shellBootstrap, /build hop|\bup\b/);
    assert.match(powershellBootstrap, /Ensure-LicenseAccepted/);
    assert.match(powershellBootstrap, /\[IO\.Path\]::PathSeparator/);
    assert.match(powershellBootstrap, /COMPOSE_FILE = "docker-compose\.yaml\$\{ComposeFileSeparator\}docker-compose\.studio\.yaml"/);
    assert.match(powershellBootstrap, /DEMO_MODE = "false"[\s\S]*WAIT_FOR_MYSQL = "false"/);
    assert.match(powershellBootstrap, /external-postgres-bootstrap", "build", "metadata-bootstrap"[\s\S]*external-postgres-bootstrap", "run", "--rm", "metadata-bootstrap"[\s\S]*exit 0/);
    assert.doesNotMatch(powershellBootstrap, /build", "hop"|"up"/);

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
    const r = await api('/api/driver-status',{method:'GET'});
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
    const r = await api('/api/driver-status',{method:'GET'});
    const body = await r.json();
    assert.strictEqual(body.mysqlDriver, 'mysql-connector-j-9.7.0.jar');
    assert.deepStrictEqual(body.jars, ['mysql-connector-j-9.7.0.jar']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('finds a Microsoft SQL Server JDBC jar once one is in place', async () => {
    const dir = path.join(projectRoot, 'jdbc-drivers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mssql-jdbc-13.4.0.jre11.jar'), 'stub');
    const r = await api('/api/driver-status',{method:'GET'});
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
    const r = await api('/api/scheduler/status',{method:'GET'});
    const body = await r.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(typeof body.intervalMinutes, 'number');
  });
});

describe('docker endpoints stay fixed-command and answer JSON', () => {
  test('logs and status endpoints use exact launcher arguments', async () => {
    const logPath = path.join(projectRoot, 'args.log');
    const cases = [
      ['/api/docker/logs', { tail: 50 }, 'logs --no-color --tail 50 hop', { ok:true, logs:'' }],
      ['/api/docker/logs', { tail: 99999 }, 'logs --no-color --tail 2000 hop', { ok:true, logs:'' }],
      ['/api/docker/hop-status', {}, 'ps -a --format json hop', {
        ok:true, present:false, running:false, state:'', status:'', exitCode:null, name:'',
      }],
      ['/api/docker/status', {}, 'ps --format json', { ok:true, containers:[] }],
    ];
    for (const [route, body, expectedArgs, expectedPayload] of cases) {
      fs.rmSync(logPath, { force: true });
      const response = await api(route, { body });
      assert.deepStrictEqual(await response.json(), expectedPayload, route);
      assert.strictEqual(fs.readFileSync(logPath, 'utf8').trim(), expectedArgs, route);
    }
  });

  test('stop-hop always uses exact fixed launcher arguments and returns its result', async () => {
    const logPath = path.join(projectRoot, 'args.log');
    for (const body of [
      {},
      { args:['down'], service:'postgres' },
      { command:'stop postgres; rm -rf /', mode:'evil' },
    ]){
      fs.rmSync(logPath, { force:true });
      const response = await api('/api/docker/stop-hop', { body });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), {
        ok:true, code:0, stdout:'', stderr:'', args:'stop hop',
      });
      assert.strictEqual(fs.readFileSync(logPath, 'utf8').trim(), 'stop hop');
    }
  });

  test('engine routes never spawn a hardcoded container engine command', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'engine.js'), 'utf8');
    assert.doesNotMatch(source, /spawn\s*\(\s*['"](?:docker|docker-compose|podman)['"]/);
    assert.doesNotMatch(source, /runComposeCommand/);
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

  test('start-db uses exact native/FDW commands and postgres-only database overrides', async () => {
    const logPath = path.join(projectRoot, 'args.log');
    const envLogPath = path.join(projectRoot, 'env.log');
    fs.rmSync(logPath, { force: true });
    fs.rmSync(envLogPath, { force: true });
    await api('/api/docker/start-db', { body: { service: 'mysql' } });
    await api('/api/docker/start-db', { body: { service: 'postgres', database: 'Customer_Vault2' } });
    await api('/api/docker/start-db', { body: { service: 'postgres', database: 'fdw_vault', fdw: true } });
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const envLog = fs.readFileSync(envLogPath, 'utf8').trimEnd().split('\n');
    assert.deepStrictEqual(log, [
      'up --demo -d mysql',
      'up --studio-build -d postgres',
      'up --fdw --build --force-recreate -d postgres',
    ]);
    assert.deepStrictEqual(envLog, ['', 'Customer_Vault2', 'fdw_vault']);
  });

  test('start-db defaults blank postgres names and rejects unsafe names before invoking the launcher', async () => {
    const logPath = path.join(projectRoot, 'args.log');
    const envLogPath = path.join(projectRoot, 'env.log');
    for (const database of [undefined, '', '   ']) {
      fs.rmSync(logPath, { force: true });
      fs.rmSync(envLogPath, { force: true });
      const body = { service:'postgres' };
      if (database !== undefined) body.database = database;
      const response = await api('/api/docker/start-db', { body });
      assert.strictEqual(response.status, 200);
      assert.strictEqual((await response.json()).database, 'datavault');
      assert.strictEqual(fs.readFileSync(envLogPath, 'utf8').trim(), 'datavault');
    }
    for (const database of ['9vault', 'vault-name', 'vault; touch /tmp/injected', 'vault name', ' vault', 'vault ', {}, 12]) {
      fs.rmSync(logPath, { force: true });
      const response = await api('/api/docker/start-db', { body: { service:'postgres', database } });
      assert.strictEqual(response.status, 400, JSON.stringify(database));
      assert.match((await response.json()).error, /plain SQL identifier/i);
      assert.strictEqual(fs.existsSync(logPath), false, 'invalid database must not reach start.sh');
    }
    const mysql = await api('/api/docker/start-db', { body: { service:'mysql', database:'datavault' } });
    assert.strictEqual(mysql.status, 400);
    assert.match((await mysql.json()).error, /only valid for the postgres/i);
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
  const argsPath = () => path.join(projectRoot, 'args.log');
  const envPath = () => path.join(projectRoot, 'env.log');
  async function acceptLicense(){
    fs.writeFileSync(licPath(), 'TEST LICENSE\n');
    await api('/api/license-accept', { body: { accept: true } });
  }
  afterEach(() => {
    fs.rmSync(licPath(), { force: true });
    fs.rmSync(path.join(projectRoot, '.license-state'), { recursive: true, force: true });
    fs.rmSync(argsPath(), { force: true });
    fs.rmSync(envPath(), { force: true });
  });

  test('refuses to run without an accepted license', async () => {
    fs.writeFileSync(licPath(), 'TEST LICENSE\n');
    const r = await api('/api/docker/bootstrap', { body: {} });
    assert.strictEqual(r.status, 403);
    assert.match((await r.json()).error, /license/i);
  });

  test('external bootstrap uses only the dedicated fixed launcher subcommand', async () => {
    await acceptLicense();
    const r = await (await api('/api/docker/bootstrap', { body: {} })).json();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.step, 'done');
    assert.strictEqual(fs.readFileSync(argsPath(), 'utf8').trim(), 'bootstrap-external-postgres');
  });

  test('rejects invalid internal mode fields before invoking start.sh', async () => {
    await acceptLicense();
    for (const body of [
      { mode: 'external' },
      { database: 'vault-name' },
      { fdw: 'true' },
      { mode: 'internal' },
      { mode: 'internal', database: '9vault' },
      { mode: 'internal', database: 'vault; touch /tmp/injected' },
      { mode: 'internal', database: 'vault-name' },
      { mode: 'internal', database: 'vault', fdw: 'true' },
    ]) {
      const response = await api('/api/docker/bootstrap', { body });
      assert.strictEqual(response.status, 400, JSON.stringify(body));
      assert.strictEqual((await response.json()).ok, false);
    }
    assert.strictEqual(fs.existsSync(argsPath()), false, 'invalid fields must not reach start.sh');
  });

  test('internal native bootstrap uses only the exact fixed start.sh command sequence', async () => {
    await acceptLicense();
    const response = await api('/api/docker/bootstrap', { body: { mode:'internal', database:'customer_vault' } });
    const body = await response.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.step, 'done');
    assert.strictEqual(body.mode, 'internal');
    assert.strictEqual(body.database, 'customer_vault');
    assert.deepStrictEqual(fs.readFileSync(argsPath(), 'utf8').trim().split('\n'), [
      'up --studio-build --force-recreate -d postgres',
      'exec -T postgres bash /docker-entrypoint-initdb.d/01-vault-password.sh',
      'exec -T postgres psql -U dvuser -d postgres -v ON_ERROR_STOP=1 -v target_database=customer_vault -f /docker-entrypoint-initdb.d/02-dump.sql',
    ]);
    assert.deepStrictEqual(fs.readFileSync(envPath(), 'utf8').split('\n').slice(0, 3), ['customer_vault', '', '']);
  });

  test('internal FDW bootstrap selects the FDW build and keeps all exec arguments fixed', async () => {
    await acceptLicense();
    const response = await api('/api/docker/bootstrap', { body: { mode:'internal', database:'Customer_2', fdw:true } });
    const body = await response.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.database, 'Customer_2');
    assert.deepStrictEqual(fs.readFileSync(argsPath(), 'utf8').trim().split('\n'), [
      'up --fdw --build --force-recreate -d postgres',
      'exec -T postgres bash /docker-entrypoint-initdb.d/01-vault-password.sh',
      'exec -T postgres psql -U dvuser -d postgres -v ON_ERROR_STOP=1 -v target_database=Customer_2 -f /docker-entrypoint-initdb.d/02-dump.sql',
    ]);
    assert.deepStrictEqual(fs.readFileSync(envPath(), 'utf8').split('\n').slice(0, 3), ['Customer_2', '', '']);
  });

  test('internal bootstrap stops at the first failed step and identifies it', async () => {
    await acceptLicense();
    const startPath = path.join(projectRoot, 'start.sh');
    const original = fs.readFileSync(startPath);
    try {
      fs.writeFileSync(startPath, '#!/bin/bash\necho "$@" >> args.log\nif [ "$1" = "exec" ]; then echo "password failed" >&2; exit 7; fi\nexit 0\n');
      fs.chmodSync(startPath, 0o755);
      const body = await (await api('/api/docker/bootstrap', { body: { mode:'internal', database:'safe_name' } })).json();
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.step, 'password');
      assert.deepStrictEqual(fs.readFileSync(argsPath(), 'utf8').trim().split('\n'), [
        'up --studio-build --force-recreate -d postgres',
        'exec -T postgres bash /docker-entrypoint-initdb.d/01-vault-password.sh',
      ]);
    } finally {
      fs.writeFileSync(startPath, original);
      fs.chmodSync(startPath, 0o755);
    }
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

describe('Database Packs v0.2.2 manifest lifecycle', () => {
  const pack = {
    schemaVersion:1, featureVersion:'0.1.0', id:'testdb', label:'Test DB', version:'1.0.0',
    connectionFields:[
      {key:'endpoint',label:'Endpoint',type:'text',required:true},
      {key:'catalog',label:'Catalog',type:'text',required:true,mapsTo:'catalog'},
      {key:'schema',label:'Schema',type:'text',required:true,mapsTo:'schema'},
      {key:'user',label:'User',type:'text',required:true,mapsTo:'user'},
      {key:'password',label:'Password',type:'password',required:true,mapsTo:'password'}
    ],
    namespace:{usesCatalog:true,catalogLabel:'Catalog',usesSchema:true,schemaLabel:'Schema'},
    jdbc:{driverClass:'com.example.Driver',jarfile:'testdb.jar',urlTemplate:'jdbc:testdb://{endpoint}/{catalog}?schema={schema}',testSql:'SELECT 1'},
    source:{enabled:true,nativeTypeOverrides:{SPECIAL_XML:'XML'}},
    target:{enabled:true,identifierQuote:'"',createSchemaSql:'CREATE SCHEMA IF NOT EXISTS {schema};',types:{STRING:'VARCHAR({length})',LARGE_TEXT:'CLOB',INTEGER:'INT',BIG_INTEGER:'BIGINT',DECIMAL:'DECIMAL({precision},{scale})',TIMESTAMP:'TIMESTAMP',BINARY:'BLOB',UNKNOWN:'CLOB'}},
    fdw:{enabled:true,read:true,insert:true,update:false,delete:false,certified:false},
    hop:{enabled:true,pluginId:'GENERIC',pluginName:'Generic database'}
  };

  test('imports, overwrites, lists, and deletes a pack directly in the Studio database-packs folder', async () => {
    let r=await api('/api/database-packs',{body:{pack}}); let data=await r.json();
    assert.strictEqual(r.status,200); assert.strictEqual(data.pack.version,'1.0.0'); assert.strictEqual(data.pack.driverPresent,false);
    const directFile=path.join(projectRoot,'data_vault_studio','database-packs','testdb.json');
    assert.ok(fs.existsSync(directFile));
    assert.ok(!fs.existsSync(path.join(projectRoot,'data_vault_studio','database-packs','installed')));

    r=await api('/api/database-packs',{method:'GET'}); data=await r.json();
    assert.strictEqual(data.featureVersion,'0.2.2'); assert.ok(data.packs.some(p=>p.id==='testdb'&&p.version==='1.0.0')); assert.strictEqual(data.hopCatalog.databaseTypes.length,46);

    const next={...pack,version:'1.1.0',label:'Test DB Updated'};
    r=await api('/api/database-packs',{body:{pack:next}}); data=await r.json();
    assert.strictEqual(data.pack.version,'1.1.0');
    assert.strictEqual(JSON.parse(fs.readFileSync(directFile,'utf8')).version,'1.1.0');

    r=await api('/api/database-packs/testdb',{method:'DELETE'}); data=await r.json();
    assert.strictEqual(r.status,200); assert.strictEqual(data.removed.id,'testdb'); assert.ok(!fs.existsSync(directFile));
  });

  test('picks up any valid top-level pack JSON by manifest id, not by filename', async () => {
    const manual={...pack,id:'manualdb',label:'Manual DB'};
    const dir=path.join(projectRoot,'data_vault_studio','database-packs'); fs.mkdirSync(dir,{recursive:true});
    const manualFile=path.join(dir,'manualdb.database-pack.v1.0.0.json');
    fs.writeFileSync(manualFile,JSON.stringify(manual,null,2));
    let r=await api('/api/database-packs',{method:'GET'}); let data=await r.json();
    assert.strictEqual(r.status,200); assert.ok(data.packs.some(p=>p.id==='manualdb'&&p.label==='Manual DB'));
    r=await api('/api/database-packs/manualdb',{method:'DELETE'}); data=await r.json();
    assert.strictEqual(r.status,200); assert.strictEqual(data.removed.id,'manualdb'); assert.ok(!fs.existsSync(manualFile));
  });

  test('deduplicates multiple filenames for the same pack id and prefers canonical id.json', async () => {
    const dir=path.join(projectRoot,'data_vault_studio','database-packs'); fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'duplicate-old.json'),JSON.stringify({...pack,id:'dedupdb',label:'Old copy',version:'1.0.0'},null,2));
    fs.writeFileSync(path.join(dir,'dedupdb.json'),JSON.stringify({...pack,id:'dedupdb',label:'Canonical copy',version:'2.0.0'},null,2));
    const r=await api('/api/database-packs',{method:'GET'}); const data=await r.json();
    const matches=data.packs.filter(p=>p.id==='dedupdb');
    assert.strictEqual(matches.length,1); assert.strictEqual(matches[0].version,'2.0.0'); assert.strictEqual(matches[0].label,'Canonical copy');
  });


  test('accepts a minimal source pack, derives normal fields, keeps the stored JSON minimal, and defaults target/FDW off', async () => {
    const driverDir=path.join(projectRoot,'jdbc-drivers'); fs.mkdirSync(driverDir,{recursive:true});
    fs.writeFileSync(path.join(driverDir,'example-jdbc.jar'),'test');
    const minimal={schemaVersion:1,id:'exampledb',label:'Example DB',version:'1.0.0',jdbc:{driverClass:'com.example.Driver',jarfile:'example-jdbc.jar',urlTemplate:'jdbc:example://{host}:{port}/{database}',defaultPort:7777},namespace:{defaultSchema:'APP'}};
    const r=await api('/api/database-packs',{body:{pack:minimal,requireDriver:true}}); const data=await r.json();
    assert.strictEqual(r.status,200); assert.strictEqual(data.pack.driverPresent,true); assert.strictEqual(data.pack.driverFile,'example-jdbc.jar');
    assert.deepStrictEqual(data.pack.connectionFields.map(f=>f.key),['host','port','database','schema','user','password']);
    assert.strictEqual(data.pack.connectionFields.find(f=>f.key==='port').default,'7777');
    assert.strictEqual(data.pack.connectionFields.find(f=>f.key==='schema').default,'APP');
    assert.strictEqual(data.pack.target.enabled,false); assert.strictEqual(data.pack.fdw.enabled,false);
    const stored=JSON.parse(fs.readFileSync(path.join(projectRoot,'data_vault_studio','database-packs','exampledb.json'),'utf8'));
    assert.strictEqual(stored.connectionFields,undefined); assert.strictEqual(stored.source,undefined); assert.strictEqual(stored.target,undefined); assert.strictEqual(stored.fdw,undefined); assert.strictEqual(stored.hop,undefined); assert.strictEqual(stored.featureVersion,undefined);
  });

  test('wizard-style installation requires the named driver to already exist in project-root jdbc-drivers', async () => {
    const minimal={schemaVersion:1,id:'missingdriver',label:'Missing Driver DB',version:'1.0.0',jdbc:{driverClass:'com.example.Driver',jarfile:'missing-driver.jar',urlTemplate:'jdbc:missing://{host}:{port}/{database}',defaultPort:9999}};
    const r=await api('/api/database-packs',{body:{pack:minimal,requireDriver:true}}); const data=await r.json();
    assert.strictEqual(r.status,400); assert.match(data.error,/jdbc-drivers/i); assert.match(data.error,/missing-driver\.jar/i);
    assert.ok(!fs.existsSync(path.join(projectRoot,'data_vault_studio','database-packs','missingdriver.json')));
  });

  test('rejects manifests whose JDBC URL references an undeclared connection field', async () => {
    const invalid={...pack,id:'badpack',jdbc:{...pack.jdbc,urlTemplate:'jdbc:test://{missing_field}'}};
    const r=await api('/api/database-packs',{body:{pack:invalid}}); const data=await r.json();
    assert.strictEqual(r.status,400); assert.match(data.error,/unknown field/i);
  });

  test('rejects legacy direct SQL Server source connections so SQL Server is exercised through a Database Pack', async () => {
    const r=await api('/api/test-connection',{body:{dialect:'sqlserver',host:'127.0.0.1',port:1433,database:'Sales',user:'sa',password:'secret'}});
    const data=await r.json();
    assert.strictEqual(r.status,400);
    assert.match(data.error,/Unsupported source dialect "sqlserver"/i);
  });
});
