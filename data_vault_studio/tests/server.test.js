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
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server/app');
const { createApiToken, createApiAccess } = require('../server/api-access');
const { createApiResponseSanitizer, sanitizeDiagnosticText } = require('../server/api-response-sanitizer');
const { createRequestControls } = require('../server/request-controls');
const { createPackagedCredentialService } = require('../server/packaged-credentials');
const { selectStudioLauncher } = require('../server/routes/engine');
const { registerSchedulerRoutes } = require('../server/routes/scheduler');
const { readServerSources } = require('./helpers/load-app');

const TEST_API_TOKEN = 'dvs-test-api-token-32-bytes-long';
let app;
let demoApp;
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

function invokeMiddleware(middleware, headers = {}){
  let status=200, payload, nextCalled=false;
  const responseHeaders=new Map();
  const req={headers};
  const res={
    status(code){status=code;return this;},
    set(name,value){responseHeaders.set(String(name).toLowerCase(),String(value));return this;},
    json(value){payload=value;return this;},
  };
  middleware(req,res,()=>{nextCalled=true;});
  return {status,payload,nextCalled,headers:responseHeaders};
}

async function apiOn(targetApp, pathname, { method = 'POST', body, headers = {} } = {}){
  const found=findRoute(targetApp._router.stack,method,pathname);
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
  const req={body:body||{},headers,params:found.params,method,path:pathname,originalUrl:pathname};
  for(const layer of found.route.stack){
    let nextCalled=false;
    await layer.handle(req,res,()=>{nextCalled=true;});
    if(!nextCalled && payload!==undefined) break;
  }
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

async function api(pathname, options = {}){
  return apiOn(app, pathname, options);
}

function requestFromServer(server, pathname, { method = 'GET', headers = {} } = {}){
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname:'127.0.0.1',
      port:server.address().port,
      path:pathname,
      method,
      headers,
    }, response => {
      let body='';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status:response.statusCode, headers:response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

function assertSecurityHeaders(response){
  assert.strictEqual(response.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(response.headers['referrer-policy'], 'no-referrer');
  assert.strictEqual(response.headers['x-frame-options'], 'DENY');
  assert.strictEqual(response.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.strictEqual(response.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()');
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
  app=createApp({studioMode:'production',env,apiToken:TEST_API_TOKEN});
  demoApp=createApp({studioMode:'demo',env,apiToken:TEST_API_TOKEN});
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

describe('request controls', () => {
  test('loads Studio runtime and request-control settings from the project .env', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-env-test-'));
    try {
      fs.writeFileSync(path.join(root, 'start.sh'), '#!/bin/bash\nexit 0\n');
      fs.writeFileSync(path.join(root, 'docker-compose.yaml'), 'services: {}\n');
      fs.writeFileSync(path.join(root, '.env'), [
        'PORT=9123',
        'STUDIO_MODE=demo',
        'DVS_API_RATE_LIMIT_REQUESTS=7',
        'DVS_MAX_JDBC_DRIVER_BYTES=2048',
        '',
      ].join('\n'));
      const configured = createApp({ env:{ DVS_PROJECT_ROOT:root }, scheduler:false });
      assert.strictEqual(configured.locals.port, '9123');
      assert.strictEqual(configured.locals.studioMode, 'demo');
      assert.strictEqual(configured.locals.requestControlConfig.rateLimitRequests, 7);
      assert.strictEqual(configured.locals.requestControlConfig.maxJdbcDriverBytes, 2048);
    } finally {
      fs.rmSync(root, { recursive:true, force:true });
    }
  });

  test('returns a recoverable 429 and allows requests after the configured window', () => {
    let current = 1000;
    const controls = createRequestControls({
      env:{ DVS_API_RATE_LIMIT_REQUESTS:'2', DVS_API_RATE_LIMIT_WINDOW_MS:'1000' },
      now:() => current,
    });
    assert.strictEqual(invokeMiddleware(controls.rateLimit).nextCalled, true);
    assert.strictEqual(invokeMiddleware(controls.rateLimit).nextCalled, true);
    const limited = invokeMiddleware(controls.rateLimit);
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.payload.code, 'RATE_LIMITED');
    assert.strictEqual(limited.payload.retryable, true);
    assert.strictEqual(limited.headers.get('retry-after'), '1');
    current += 1000;
    assert.strictEqual(invokeMiddleware(controls.rateLimit).nextCalled, true);
  });

  test('distinguishes duplicate operations from exhausted concurrency pools', () => {
    const controls = createRequestControls({ env:{ DVS_CONNECTION_TEST_CONCURRENCY:'2' } });
    const first = controls.acquire('connection-test', 'one');
    const duplicate = controls.acquire('connection-test', 'one');
    const second = controls.acquire('connection-test', 'two');
    const exhausted = controls.acquire('connection-test', 'three');
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual({ status:duplicate.httpStatus, code:duplicate.code }, { status:409, code:'OPERATION_IN_PROGRESS' });
    assert.strictEqual(second.ok, true);
    assert.deepStrictEqual({ status:exhausted.httpStatus, code:exhausted.code }, { status:429, code:'CONCURRENCY_LIMIT_REACHED' });
    first.release();
    second.release();
    assert.strictEqual(controls.acquire('connection-test', 'three').ok, true);
  });

  test('applies a small default body limit while retaining the larger deployment limit', async () => {
    const env = Object.assign({}, process.env, {
      DVS_PROJECT_ROOT:projectRoot,
      DVS_DATABASE_PACK_HOME:path.join(projectRoot, 'data_vault_studio', 'database-packs'),
      DVS_API_RATE_LIMIT_REQUESTS:'1000',
    });
    const localApp = createApp({ studioMode:'production', env, apiToken:TEST_API_TOKEN, scheduler:false });
    const server = await new Promise(resolve => {
      const listener = localApp.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const send = (pathname, payload) => new Promise((resolve, reject) => {
      const request = http.request({
        hostname:'127.0.0.1', port:server.address().port, path:pathname, method:'POST',
        headers:{
          'X-DVS-Token':TEST_API_TOKEN,
          'Content-Type':'application/json',
          'Content-Length':Buffer.byteLength(payload),
        },
      }, response => {
        let text = '';
        response.on('data', chunk => text += chunk);
        response.on('end', () => resolve({ status:response.statusCode, body:JSON.parse(text) }));
      });
      request.on('error', reject);
      request.end(payload);
    });
    try {
      const padding = 'x'.repeat(2 * 1024 * 1024);
      const ordinary = await send('/api/docker/status', JSON.stringify({ padding }));
      assert.strictEqual(ordinary.status, 413);
      assert.strictEqual(ordinary.body.code, 'BODY_TOO_LARGE');
      const deployment = await send('/api/deploy-files', JSON.stringify({ destination:'invalid', padding }));
      assert.strictEqual(deployment.status, 400);
      assert.match(deployment.body.error, /Unknown destination/);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe('basics', () => {
  test('GET /api/health returns only the public service identity', async () => {
    const r = await api('/api/health',{method:'GET'});
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(body, {
      ok:true,
      service:'data-vault-studio',
      version:require('../package.json').version,
    });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  });

  test('GET / serves the GUI', async () => {
    const r = await api('/',{method:'GET'});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.ok(html.includes('Data Vault Studio'));
    assert.ok(html.includes('millersoft'), 'should be the real GUI page');
    assert.ok(html.includes("const STUDIO_RUNTIME_MODE = 'production' === 'demo' ? 'demo' : 'production'"));
    assert.ok(html.includes(`<meta name="dvs-api-token" content="${TEST_API_TOKEN}">`));
    assert.ok(!html.includes('__STUDIO_RUNTIME_MODE__'));
    assert.ok(!html.includes('__DVS_API_TOKEN__'));
  });

  test('GET /index.html uses the same protected token-injection route', async () => {
    const r = await api('/index.html',{method:'GET'});
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes(`<meta name="dvs-api-token" content="${TEST_API_TOKEN}">`));
    assert.ok(!html.includes('__DVS_API_TOKEN__'));
  });

  test('applies security headers to HTML, static assets, API success, and API errors', async () => {
    const server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const html = await requestFromServer(server, '/');
      const asset = await requestFromServer(server, '/css/studio.css');
      const apiSuccess = await requestFromServer(server, '/api/health', {
        headers:{ 'X-DVS-Token':TEST_API_TOKEN },
      });
      const apiError = await requestFromServer(server, '/api/health');

      assert.strictEqual(html.status, 200);
      assert.strictEqual(asset.status, 200);
      assert.strictEqual(apiSuccess.status, 200);
      assert.strictEqual(apiError.status, 401);
      for (const response of [html, asset, apiSuccess, apiError]) assertSecurityHeaders(response);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('GET /api/runtime-profile reports the selected npm-start mode', async () => {
    const r = await api('/api/runtime-profile',{method:'GET'});
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(body, { ok:true, mode:'production', isDemo:false, isProduction:true });
  });
});

describe('DVS-002-d diagnostic redaction', () => {
  test('redacts known credentials, connection strings, SQL passwords, and host paths', () => {
    const message=[
      'login failed for studio_user at internal-db.example',
      'password=correct-horse-battery-staple',
      "CREATE LOGIN studio_user WITH PASSWORD 'generated-secret'",
      'POSTGRES_PASSWORD=environment-secret',
      '{"password":"json-secret"}',
      'jdbc:postgresql://internal-db.example:5432/vault?user=studio_user&password=correct-horse-battery-staple',
      '/Users/operator/private/jdbc/vendor.jar /etc/postgresql/config \\\\fileserver\\share\\driver.jar',
      'resolved endpoints 10.20.30.40 and [fd00::1234]',
    ].join('\n');
    const sanitized=sanitizeDiagnosticText(message,['correct-horse-battery-staple','studio_user','internal-db.example']);
    for (const secret of ['correct-horse-battery-staple','generated-secret','environment-secret','json-secret','studio_user','internal-db.example','jdbc:postgresql','/Users/operator','/etc/postgresql','fileserver','10.20.30.40','fd00::1234']) {
      assert.ok(!sanitized.includes(secret), `should redact ${secret}`);
    }
    assert.match(sanitized,/\[redacted(?: connection string| path)?\]/);
  });

  test('sanitizes failed API payloads with request and packaged credentials', () => {
    const middleware=createApiResponseSanitizer({
      sensitiveValues:['/private/project-root'],
      resolveCredential:ref=>ref==='internal-target'?{user:'packaged_user',password:'packaged_password',host:'packaged-db'}:null,
    });
    const req={body:{host:'request-db',username:'request_user',password:'request_password',credentialRef:'internal-target'}};
    let output;
    const res={statusCode:400,json(payload){output=payload;return this;}};
    middleware(req,res,()=>{});
    res.json({ok:false,error:'request_user request_password request-db packaged_user packaged_password packaged-db /private/project-root/config jdbc:mysql://request-db/vault'});
    const serialized=JSON.stringify(output);
    for (const secret of ['request_user','request_password','request-db','packaged_user','packaged_password','packaged-db','/private/project-root','jdbc:mysql']) {
      assert.ok(!serialized.includes(secret), `should redact ${secret}`);
    }
  });

  test('redacts arbitrary Database Pack fields and JDBC option values from failures', () => {
    const middleware=createApiResponseSanitizer();
    const req={body:{packValues:{endpoint:'private-pack-host',credential:'custom-pack-secret'},options:{vendorAuth:'vendor-option-secret'}}};
    let output;
    const res={statusCode:400,json(payload){output=payload;return this;}};
    middleware(req,res,()=>{});
    res.json({ok:false,error:'Driver echoed private-pack-host custom-pack-secret vendor-option-secret'});
    const serialized=JSON.stringify(output);
    for(const value of ['private-pack-host','custom-pack-secret','vendor-option-secret'])assert.ok(!serialized.includes(value));
  });

  test('sanitizes successful diagnostics without altering ordinary business fields', () => {
    const middleware=createApiResponseSanitizer();
    const req={body:{password:'request_password'}};
    let output;
    const res={statusCode:200,json(payload){output=payload;return this;}};
    middleware(req,res,()=>{});
    const payload={ok:true,data:'request_password is ordinary response data',stdout:'password=request_password',logs:'jdbc:mysql://user:request_password@db/vault'};
    res.json(payload);
    assert.strictEqual(output.data,payload.data);
    assert.ok(!output.stdout.includes('request_password'));
    assert.ok(!output.logs.includes('request_password'));
    assert.ok(!output.logs.includes('jdbc:mysql'));
  });
});

describe('DVS-002-a local API access protection', () => {
  const access = createApiAccess({apiToken:TEST_API_TOKEN});
  const authorized = (host='127.0.0.1:8420') => ({host,'x-dvs-token':TEST_API_TOKEN});

  test('generates a new cryptographically random token for each application process', () => {
    const first = createApiToken();
    const second = createApiToken();
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.match(second, /^[A-Za-z0-9_-]{43}$/);
    assert.notStrictEqual(first, second);
  });

  test('rejects missing and incorrect API tokens but accepts the configured token', () => {
    let result = invokeMiddleware(access.validateApiRequest, {host:'127.0.0.1:8420'});
    assert.strictEqual(result.status, 401);
    assert.match(result.payload.error, /authorization failed/i);
    assert.strictEqual(result.nextCalled, false);

    result = invokeMiddleware(access.validateApiRequest, {host:'127.0.0.1:8420','x-dvs-token':'wrong-token'});
    assert.strictEqual(result.status, 401);

    result = invokeMiddleware(access.validateApiRequest, authorized());
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.nextCalled, true);
    assert.strictEqual(result.headers.get('cache-control'), 'no-store');
  });

  test('accepts matching loopback origins and rejects foreign or opaque origins', () => {
    for (const host of ['127.0.0.1:8420', 'localhost:8420', '[::1]:8420']) {
      const result = invokeMiddleware(access.validateApiRequest, {...authorized(host),origin:`http://${host}`});
      assert.strictEqual(result.status, 200, host);
      assert.strictEqual(result.nextCalled, true, host);
    }

    for (const origin of ['https://attacker.example', 'null', 'http://127.0.0.1:9999']) {
      const result = invokeMiddleware(access.validateApiRequest, {...authorized(),origin});
      assert.strictEqual(result.status, 403, origin);
      assert.match(result.payload.error, /origin is not allowed/i);
      assert.strictEqual(result.nextCalled, false);
    }
  });

  test('accepts only loopback Host headers before any page or API route', () => {
    for (const host of ['127.0.0.1:8420', 'localhost:8420', '[::1]:8420']) {
      const result = invokeMiddleware(access.validateLocalHost, {host});
      assert.strictEqual(result.nextCalled, true, host);
    }
    for (const host of ['attacker.example', '192.168.1.10:8420', '', 'localhost:99999']) {
      const result = invokeMiddleware(access.validateLocalHost, {host});
      assert.strictEqual(result.status, 403, host);
      assert.strictEqual(result.nextCalled, false, host);
      assert.doesNotMatch(JSON.stringify(result.payload), new RegExp(TEST_API_TOKEN));
    }
  });

  test('mounts Host/API protection before body parsing and exposes no CORS middleware', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const hostIndex = source.indexOf('app.use(apiAccess.validateLocalHost)');
    const apiIndex = source.indexOf("app.use('/api', apiAccess.validateApiRequest)");
    const sanitizerIndex = source.indexOf("app.use('/api', createApiResponseSanitizer");
    const jsonIndex = source.indexOf("app.use('/api', express.json({ limit: requestControls.config.defaultBodyLimit }))");
    const routeIndex = source.indexOf('registerSystemRoutes(app');
    assert.ok(hostIndex >= 0 && apiIndex > hostIndex && sanitizerIndex > apiIndex && jsonIndex > sanitizerIndex && routeIndex > jsonIndex);
    assert.doesNotMatch(source, /require\(['"]cors['"]\)|access-control-allow-origin/i);
    assert.strictEqual(pkg.dependencies.cors, undefined);
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

  test('core PostgreSQL bootstrap uses directional cross-schema privileges', () => {
    const dump = fs.readFileSync(path.join(__dirname, '..', '..', 'db-init', '02-dump.sql'), 'utf8');
    const ddls = fs.readFileSync(path.join(__dirname, '..', '..', 'db-init', '03-ddls.sql'), 'utf8');

    assert.match(dump, /GRANT USAGE ON SCHEMA staging\s+TO pdi_meta, data_vault;/);
    assert.match(dump, /ALTER DEFAULT PRIVILEGES FOR ROLE staging\s+IN SCHEMA staging\s+GRANT SELECT ON TABLES TO pdi_meta, data_vault;/);
    assert.match(dump, /GRANT USAGE ON SCHEMA data_vault TO pdi_meta, staging;/);
    assert.match(dump, /ALTER DEFAULT PRIVILEGES FOR ROLE data_vault IN SCHEMA data_vault GRANT SELECT ON TABLES TO pdi_meta, staging;/);
    assert.match(dump, /GRANT SELECT ON TABLE pdi_meta\.stg_management_source_systems,[\s\S]*pdi_meta\.stg_management_link_satellites[\s\S]*TO data_vault;/);
    assert.match(dump, /GRANT SELECT \(name\) ON TABLE pdi_meta\.ref_connections TO data_vault;/);
    assert.match(dump, /GRANT EXECUTE ON FUNCTION pdi_meta\.prc_create_error_table\(character varying, character varying\) TO data_vault;/);
    assert.match(dump, /ALTER DEFAULT PRIVILEGES IN SCHEMA pdi_meta\s+REVOKE EXECUTE ON ROUTINES FROM PUBLIC;/);
    assert.doesNotMatch(dump, /GRANT ALL ON SCHEMA (pdi_meta|staging|data_vault)/);
    assert.doesNotMatch(dump, /GRANT ALL ON TABLES\s+TO pdi_meta, staging, data_vault/);
    assert.doesNotMatch(dump, /ALTER DEFAULT PRIVILEGES[\s\S]*REVOKE ALL/);
    assert.doesNotMatch(ddls, /GRANT ALL ON SCHEMA (pdi_meta|staging|data_vault)/);
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
  test('writes each approved generated file to its logical destination', async () => {
    const cases = [
      ['db-init', '04-ddls.sql', 'SELECT 1;', path.join(projectRoot, 'db-init'), 'SELECT 1;'],
      ['db-init', '05-pdi-meta.sql', 'SELECT 2;', path.join(projectRoot, 'db-init'), 'SELECT 2;'],
      ['mappings', 'deployment_test_1.xls', Buffer.from('workbook').toString('base64'), path.join(projectRoot, 'mappings'), 'workbook'],
      ['hop', 'postgres-environment.json', '{"name":"postgres"}', path.join(projectRoot, 'hop'), '{"name":"postgres"}'],
      ['metadata-rdbms', 'source.json', '{"name":"source"}', path.join(projectRoot, 'metadata', 'rdbms'), '{"name":"source"}'],
    ];
    for (const [destination, name, content, folder, expected] of cases) {
      const r = await api('/api/deploy-files', { body: { destination, files: { [name]: content } } });
      const body = await r.json();
      assert.strictEqual(r.status, 200, `${destination}/${name} should be accepted: ${body.error || ''}`);
      assert.strictEqual(body.destination, destination);
      const expectedLabel=destination==='metadata-rdbms'?'metadata/rdbms':destination;
      assert.strictEqual(body.folder, expectedLabel);
      assert.deepStrictEqual(body.written,[name]);
      assert.ok(!JSON.stringify(body).includes(projectRoot));
      assert.strictEqual(fs.readFileSync(path.join(folder, name), 'utf8'), expected);
    }
  });

  test('rejects legacy folder paths even when they point inside the project', async () => {
    const r = await api('/api/deploy-files', {
      body: { folder: path.join(projectRoot, 'db-init'), files: { '06-ddls.sql': 'SELECT 1;' } },
    });
    const body = await r.json();
    assert.strictEqual(r.status, 400);
    assert.match(body.error, /folder is not accepted/i);
    assert.ok(!fs.existsSync(path.join(projectRoot, 'db-init', '06-ddls.sql')));
  });

  test('rejects absolute, traversing, unknown, and missing destinations', async () => {
    for (const destination of [projectRoot, '../db-init', 'data_vault_studio/server', 'unknown', undefined]) {
      const r = await api('/api/deploy-files', { body: { destination, files: { '06-ddls.sql': 'SELECT 1;' } } });
      assert.strictEqual(r.status, 400, `${String(destination)} should be rejected`);
      assert.match((await r.json()).error, /Unknown destination/i);
    }
  });

  test('rejects unsafe filenames', async () => {
    for (const name of ['../escape.sql', 'a/b.sql', 'a\\b.sql', '..']){
      const r = await api('/api/deploy-files', { body: { destination: 'db-init', files: { [name]: 'x' } } });
      const body = await r.json();
      assert.strictEqual(r.status, 400, `${name} should be rejected`);
      assert.match(body.error, /Unsafe file name/);
    }
  });

  test('enforces the filename allowlist for every destination', async () => {
    const rejected = [
      ['db-init', 'arbitrary.sql'],
      ['db-init', '04-test.sql'],
      ['db-init', 'start.sh'],
      ['mappings', 'report.xlsx'],
      ['mappings', 'package.json'],
      ['hop', 'Dockerfile'],
      ['hop', 'postgres-environment.json.external'],
      ['metadata-rdbms', 'data_vault.json'],
      ['metadata-rdbms', 'pdi_meta.json'],
    ];
    for (const [destination, name] of rejected) {
      const r = await api('/api/deploy-files', { body: { destination, files: { [name]: 'x' } } });
      const body = await r.json();
      assert.strictEqual(r.status, 400, `${destination}/${name} should be rejected`);
      assert.match(body.error, /not allowed/i);
    }
  });

  test('cannot address launchers, configuration, Studio source, or git metadata', async () => {
    for (const name of ['start.sh', 'start.ps1', 'docker-compose.yaml', 'package.json', 'data_vault_studio/server/app.js', 'data_vault_studio/public/index.html', '.git/config']) {
      const r = await api('/api/deploy-files', { body: { destination: 'db-init', files: { [name]: 'overwritten' } } });
      assert.strictEqual(r.status, 400, `${name} should be protected`);
    }
    assert.match(fs.readFileSync(path.join(projectRoot, 'start.sh'), 'utf8'), /^#!\/bin\/bash/);
    assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'docker-compose.yaml'), 'utf8'), 'services: {}\n');
  });

  test('validates the whole batch before writing any file', async () => {
    const acceptedPath = path.join(projectRoot, 'db-init', '07-ddls.sql');
    fs.rmSync(acceptedPath, { force: true });
    const r = await api('/api/deploy-files', {
      body: { destination: 'db-init', files: { '07-ddls.sql': 'SELECT 1;', 'start.sh': 'bad' } },
    });
    assert.strictEqual(r.status, 400);
    assert.ok(!fs.existsSync(acceptedPath));
  });

  test('rejects a logical destination that is symlinked outside the project', async () => {
    const folder = path.join(projectRoot, 'db-init');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-outside-'));
    fs.rmSync(folder, { recursive: true, force: true });
    try {
      fs.symlinkSync(outside, folder, 'dir');
      const r = await api('/api/deploy-files', { body: { destination: 'db-init', files: { '08-ddls.sql': 'SELECT 1;' } } });
      assert.strictEqual(r.status, 400);
      assert.match((await r.json()).error, /symbolic link/i);
      assert.ok(!fs.existsSync(path.join(outside, '08-ddls.sql')));
    } finally {
      fs.rmSync(folder, { force: true });
      fs.mkdirSync(folder, { recursive: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('rejects an approved output filename that is an existing symlink', async () => {
    const folder = path.join(projectRoot, 'db-init');
    const target = path.join(projectRoot, 'start.sh');
    const link = path.join(folder, '09-ddls.sql');
    const original = fs.readFileSync(target, 'utf8');
    fs.mkdirSync(folder, { recursive: true });
    fs.rmSync(link, { force: true });
    try {
      fs.symlinkSync(target, link, 'file');
      const r = await api('/api/deploy-files', { body: { destination: 'db-init', files: { '09-ddls.sql': 'overwritten' } } });
      assert.strictEqual(r.status, 400);
      assert.match((await r.json()).error, /symbolic link/i);
      assert.strictEqual(fs.readFileSync(target, 'utf8'), original);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  test('rejects an empty file set', async () => {
    const r = await api('/api/deploy-files', { body: { destination: 'db-init', files: {} } });
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

  test('stops chunked downloads at the configured byte limit and removes the partial file', async () => {
    const originalApp = app;
    const chunks = [Buffer.from('123'), Buffer.from('456')];
    const fetchImpl = async () => ({
      ok:true,
      status:200,
      headers:{ get(){ return null; } },
      body:{ getReader(){ return { async read(){ return chunks.length ? { done:false, value:chunks.shift() } : { done:true }; } }; } },
    });
    const env = Object.assign({}, process.env, {
      DVS_PROJECT_ROOT:projectRoot,
      DVS_DATABASE_PACK_HOME:path.join(projectRoot, 'data_vault_studio', 'database-packs'),
      DVS_MAX_JDBC_DRIVER_BYTES:'5',
    });
    app = createApp({ studioMode:'production', env, apiToken:TEST_API_TOKEN, fetch:fetchImpl, scheduler:false });
    const target = path.join(projectRoot, 'jdbc-drivers', 'oversized.jar');
    try {
      const response = await api('/api/fetch-driver', { body:{ url:'https://repo1.maven.org/oversized.jar', filename:'oversized.jar' } });
      const body = await response.json();
      assert.strictEqual(response.status, 413);
      assert.strictEqual(body.code, 'DOWNLOAD_TOO_LARGE');
      assert.strictEqual(body.maxBytes, 5);
      assert.strictEqual(fs.existsSync(target), false);
      const leftovers = fs.existsSync(path.dirname(target)) ? fs.readdirSync(path.dirname(target)).filter(name => name.endsWith('.part')) : [];
      assert.deepStrictEqual(leftovers, []);
    } finally {
      fs.rmSync(target, { force:true });
      app = originalApp;
    }
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
  test('reports no bundled JDBC drivers when jdbc-drivers/ is empty or missing', async () => {
    const r = await api('/api/driver-status',{method:'GET'});
    const body = await r.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.mysqlDriver, null);
    assert.strictEqual(body.postgresDriver, null);
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

  test('finds a PostgreSQL JDBC jar once one is in place', async () => {
    const dir = path.join(projectRoot, 'jdbc-drivers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'postgresql-42.7.7.jar'), 'stub');
    const r = await api('/api/driver-status',{method:'GET'});
    const body = await r.json();
    assert.strictEqual(body.postgresDriver, 'postgresql-42.7.7.jar');
    assert.deepStrictEqual(body.jars, ['postgresql-42.7.7.jar']);
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

  test('an overdue scheduled occurrence is skipped and advanced when Hop is already running', async () => {
    const express = require('express');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-scheduler-overlap-'));
    const statePath = path.join(root, '.vault-studio-scheduler.json');
    fs.writeFileSync(statePath, JSON.stringify({
      enabled:true,
      intervalMinutes:60,
      mode:'internal',
      nextRunAt:new Date(Date.now() - 60000).toISOString(),
      lastRunAt:null,
      log:[],
    }));

    let pollTick;
    const realSetInterval = global.setInterval;
    try {
      global.setInterval = fn => {
        pollTick = fn;
        return { unref(){} };
      };
      const isolated = express();
      registerSchedulerRoutes(isolated, {
        express,
        fs,
        path,
        PROJECT_ROOT:root,
        ENGINE_MODES:{ internal:['up','-d','hop'] },
        runFixedCommand:async () => { throw new Error('overlapping Hop run must not be started'); },
        getHopStatus:async () => ({ ok:true, present:true, running:true, state:'running', status:'Up' }),
      });
    } finally {
      global.setInterval = realSetInterval;
    }

    try {
      assert.strictEqual(typeof pollTick, 'function');
      const before = Date.now();
      pollTick();
      await new Promise(resolve => setImmediate(resolve));
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.strictEqual(persisted.log[0].skipped, true);
      assert.strictEqual(persisted.log[0].skipReason, 'hop-already-running');
      assert.ok(new Date(persisted.nextRunAt).getTime() >= before + 59 * 60000, 'skipped occurrence should advance the schedule');
    } finally {
      fs.rmSync(root, { recursive:true, force:true });
    }
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

  test('rejects a concurrent ETL transition with a retryable conflict', async () => {
    const startPath = path.join(projectRoot, 'start.sh');
    const original = fs.readFileSync(startPath);
    try {
      fs.writeFileSync(startPath, '#!/bin/bash\nsleep 0.2\nexit 0\n');
      fs.chmodSync(startPath, 0o755);
      const first = api('/api/docker/run-hop', { body:{ mode:'internal' } });
      const second = await api('/api/docker/run-hop', { body:{ mode:'internal' } });
      const conflict = await second.json();
      assert.strictEqual(second.status, 409);
      assert.strictEqual(conflict.code, 'OPERATION_IN_PROGRESS');
      assert.strictEqual(conflict.operation, 'etl-transition');
      assert.strictEqual(conflict.retryable, true);
      assert.strictEqual(second.headers.get('retry-after'), '1');
      assert.strictEqual((await (await first).json()).ok, true);
    } finally {
      fs.writeFileSync(startPath, original);
      fs.chmodSync(startPath, 0o755);
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

  test('production can start packaged PostgreSQL but packaged MySQL is demo-only', async () => {
    const mysql = await api('/api/docker/start-db', { body: { service:'mysql' } });
    assert.strictEqual(mysql.status, 403);
    assert.match((await mysql.json()).error, /only be started in demo mode/i);

    const postgres = await api('/api/docker/start-db', { body: { service:'postgres' } });
    assert.strictEqual(typeof (await postgres.json()).ok, 'boolean');

    for (const service of ['mysql','postgres']) {
      const stopped = await api('/api/docker/stop-db', { body:{ service } });
      assert.strictEqual(typeof (await stopped.json()).ok, 'boolean');
    }
  });

  test('demo mode can start the packaged MySQL service', async () => {
    const r = await apiOn(demoApp, '/api/docker/start-db', { body:{ service:'mysql' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof (await r.json()).ok, 'boolean');
  });

  test('start-db uses exact native/FDW commands and postgres-only database overrides', async () => {
    const logPath = path.join(projectRoot, 'args.log');
    const envLogPath = path.join(projectRoot, 'env.log');
    fs.rmSync(logPath, { force: true });
    fs.rmSync(envLogPath, { force: true });
    await apiOn(demoApp, '/api/docker/start-db', { body: { service: 'mysql' } });
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
    const mysql = await apiOn(demoApp, '/api/docker/start-db', { body: { service:'mysql', database:'datavault' } });
    assert.strictEqual(mysql.status, 400);
    assert.match((await mysql.json()).error, /only valid for the postgres/i);
  });

  test('FDW mode is rejected for MySQL and non-boolean values', async () => {
    let r = await apiOn(demoApp, '/api/docker/start-db', { body: { service: 'mysql', fdw: true } });
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
    assert.deepStrictEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n'), [
      'ps -a --format json hop',
      'up --demo -d hop',
    ]);
    await api('/api/scheduler/config', { body: { mode: 'internal', enabled: false } });
  });

  test('scheduler skips a manual start when Hop is already running', async () => {
    const stubPath = path.join(projectRoot, 'start.sh');
    const original = fs.readFileSync(stubPath);
    const logPath = path.join(projectRoot, 'args.log');
    try {
      fs.writeFileSync(stubPath, `#!/bin/bash
echo "$@" >> args.log
if [ "$1" = "ps" ]; then
  echo '{"Service":"hop","State":"running","Status":"Up 2 minutes","ExitCode":0,"Name":"test-hop"}'
fi
exit 0
`);
      fs.chmodSync(stubPath, 0o755);
      fs.rmSync(logPath, { force:true });

      const r = await api('/api/scheduler/run-now', { body:{} });
      const body = await r.json();
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.result.ok, true);
      assert.strictEqual(body.result.skipped, true);
      assert.strictEqual(body.result.skipReason, 'hop-already-running');
      assert.match(body.result.message, /already active/i);
      assert.strictEqual(body.log[0].skipped, true);
      assert.strictEqual(body.log[0].skipReason, 'hop-already-running');
      assert.deepStrictEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n'), [
        'ps -a --format json hop',
      ]);
    } finally {
      fs.writeFileSync(stubPath, original);
      fs.chmodSync(stubPath, 0o755);
      await api('/api/scheduler/config', { body:{ mode:'internal', enabled:false } });
    }
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
    const r = await (await apiOn(demoApp, '/api/docker/start-db', { body: { service: 'mysql' } })).json();
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
    assert.deepStrictEqual(r.mysql, { user: 'sakila', passwordConfigured: true });
    assert.deepStrictEqual(r.target, { user: 'dvuser', passwordConfigured: true });
    assert.deepStrictEqual(r.bootstrap, { user: 'postgres_admin', passwordConfigured: true });
    assert.deepStrictEqual(r.vault, { passwordConfigured: true });
    assert.doesNotMatch(JSON.stringify(r), /vault-password|bootstrap-password|"password"\s*:/);
  });
});

describe('DVS-002-b packaged credential references', () => {
  let temp,envFile,hopEnvironmentFile,service;
  beforeEach(()=>{
    temp=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-credentials-'));
    envFile=path.join(temp,'.env');
    hopEnvironmentFile=path.join(temp,'postgres-environment.json');
    fs.writeFileSync(envFile,[
      'SOURCE_PASSWORD=canary-source-secret',
      'MYSQL_USER=sakila',
      'MYSQL_PASSWORD=${SOURCE_PASSWORD}',
      'VAULT_PASSWORD=canary-vault-secret',
      'DB_USER=dvuser',
      'DB_PASSWORD=${VAULT_PASSWORD}',
      'POSTGRES_BOOTSTRAP_USER=admin',
      'POSTGRES_BOOTSTRAP_PASSWORD=canary-bootstrap-secret',
      '',
    ].join('\n'));
    fs.writeFileSync(hopEnvironmentFile,JSON.stringify({variables:[
      {name:'pdi_meta_host_name',value:'external.example'},
      {name:'pdi_meta_port_number',value:'5432'},
      {name:'pdi_meta_database_name',value:'customer_vault'},
      {name:'data_vault_host_name',value:'external.example'},
      {name:'data_vault_port_number',value:'5432'},
      {name:'data_vault_database_name',value:'customer_vault'},
      {name:'stg_host_name',value:'external.example'},
      {name:'stg_port_number',value:'5432'},
      {name:'stg_database_name',value:'customer_vault'},
    ]}));
    service=createPackagedCredentialService({envFilePath:envFile,hopEnvironmentPath:hopEnvironmentFile});
  });
  afterEach(()=>fs.rmSync(temp,{recursive:true,force:true}));

  test('public defaults expose configuration state but no password values',()=>{
    const defaults=service.publicDefaults();
    assert.deepStrictEqual(defaults.mysql,{user:'sakila',passwordConfigured:true});
    assert.deepStrictEqual(defaults.target,{user:'dvuser',passwordConfigured:true});
    assert.doesNotMatch(JSON.stringify(defaults),/canary-|"password"\s*:/);
  });

  test('resolves only the four fixed server-side connection profiles',()=>{
    const source=service.resolveConnection({credentialRef:'packaged-mysql-source',database:'sakila',dialect:'mysql'});
    assert.strictEqual(source.host,'localhost');assert.strictEqual(source.port,'3306');assert.strictEqual(source.password,'canary-source-secret');
    const target=service.resolveConnection({credentialRef:'internal-postgres-target',database:'Customer_Vault'});
    assert.strictEqual(target.host,'localhost');assert.strictEqual(target.port,'5433');assert.strictEqual(target.password,'canary-vault-secret');
    const external=service.resolveConnection({credentialRef:'external-postgres-target',host:'external.example',port:'5432',database:'customer_vault',dialect:'postgresql'});
    assert.strictEqual(external.user,'admin');assert.strictEqual(external.password,'canary-bootstrap-secret');
    assert.deepStrictEqual(service.resolveRedactionValues('external-postgres-target'),{user:'admin',password:'canary-bootstrap-secret'});
    const physical=service.resolveConnection({credentialRef:'demo-fdw-physical-mysql',database:'datavault'});
    assert.strictEqual(physical.password,'canary-source-secret');
  });

  test('fails closed for unknown, conflicting, or redirectable references',()=>{
    assert.throws(()=>service.resolveConnection({credentialRef:'SOURCE_PASSWORD',database:'sakila'}),/unknown/i);
    assert.throws(()=>service.resolveConnection({credentialRef:'packaged-mysql-source',database:'sakila',password:'x'}),/cannot be combined/i);
    assert.throws(()=>service.resolveConnection({credentialRef:'packaged-mysql-source',database:'sakila',host:'attacker.example'}),/that host/i);
    assert.throws(()=>service.resolveConnection({credentialRef:'internal-postgres-target',database:'bad-name'}),/plain identifier/i);
    assert.throws(()=>service.resolveConnection({credentialRef:'external-postgres-target',host:'attacker.example',port:'5432',database:'customer_vault'}),/deployed host/i);
    assert.throws(()=>service.resolveConnection({credentialRef:'external-postgres-target',host:'external.example',port:'5432',database:'other_vault'}),/deployed database/i);
  });

  test('reads updated secrets on each request rather than retaining them in memory',()=>{
    assert.strictEqual(service.resolveSecret('packaged-mysql-source').password,'canary-source-secret');
    fs.writeFileSync(envFile,'SOURCE_PASSWORD=replaced\nMYSQL_USER=sakila\n');
    assert.strictEqual(service.resolveSecret('packaged-mysql-source').password,'replaced');
  });

  test('packaged query references cannot read credential-bearing system catalogs',async()=>{
    const response=await api('/api/query',{body:{credentialRef:'internal-postgres-target',database:'datavault',sql:'SELECT umoptions FROM pg_user_mappings'}});
    assert.strictEqual(response.status,400);
    assert.match((await response.json()).error,/security-sensitive credential catalogs/i);
  });

  test('demo FDW endpoint rejects arbitrary SQL, credentials, and wrong references before connecting',async()=>{
    let response=await api('/api/demo-fdw/infrastructure',{body:{gatewayDatabase:'datavault',serverName:'demo_srv',gatewayCredentialRef:'internal-postgres-target',physicalCredentialRef:'demo-fdw-physical-mysql',sql:'SELECT 1'}});
    assert.strictEqual(response.status,400);assert.match((await response.json()).error,/unsupported demo FDW field/i);
    response=await api('/api/demo-fdw/infrastructure',{body:{gatewayDatabase:'datavault',serverName:'demo_srv',gatewayCredentialRef:'internal-postgres-target',physicalCredentialRef:'wrong'}});
    assert.strictEqual(response.status,400);assert.match((await response.json()).error,/fixed internal PostgreSQL and demo MySQL/i);
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

  test('rejects a second bootstrap while the first bootstrap is running', async () => {
    await acceptLicense();
    const startPath = path.join(projectRoot, 'start.sh');
    const original = fs.readFileSync(startPath);
    try {
      fs.writeFileSync(startPath, '#!/bin/bash\nsleep 0.2\nexit 0\n');
      fs.chmodSync(startPath, 0o755);
      const first = api('/api/docker/bootstrap', { body:{} });
      const second = await api('/api/docker/bootstrap', { body:{} });
      const conflict = await second.json();
      assert.strictEqual(second.status, 409);
      assert.strictEqual(conflict.code, 'OPERATION_IN_PROGRESS');
      assert.strictEqual(conflict.operation, 'container-build');
      assert.strictEqual((await (await first).json()).ok, true);
    } finally {
      fs.writeFileSync(startPath, original);
      fs.chmodSync(startPath, 0o755);
    }
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
    assert.strictEqual(internal.sourceConfigured, true);
    assert.strictEqual(internal.targetConfigured, true);
    assert.strictEqual(internal.targetUserConfigured, true);
    assert.strictEqual(internal.sourceMatches, undefined);

    const external = await (await api('/api/env-credentials/status', {
      body: { sourcePassword:'source-secret', targetPassword:'bootstrap-password', targetUser:'postgres_admin', externalPostgres:true },
    })).json();
    assert.strictEqual(external.sourceConfigured, true);
    assert.strictEqual(external.targetConfigured, true);
    assert.strictEqual(external.targetUserConfigured, true);
    assert.strictEqual(external.targetMatches, undefined);
  });

  test('packaged source deployment preserves the server-side SOURCE_PASSWORD', async () => {
    fs.writeFileSync(envPath(),'SOURCE_PASSWORD=keep-packaged-secret\nMYSQL_USER=sakila\n');
    const response=await api('/api/env-credentials',{body:{sourceCredentialMode:'preserve',sourcePassword:'browser-must-not-win',externalPostgres:false}});
    const body=await response.json();
    assert.strictEqual(response.status,200);
    assert.deepStrictEqual(body.updated,[]);
    assert.match(fs.readFileSync(envPath(),'utf8'),/SOURCE_PASSWORD=keep-packaged-secret/);
    assert.doesNotMatch(fs.readFileSync(envPath(),'utf8'),/browser-must-not-win/);
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
      body: { destination:'db-init', files:{ '.env':'DB_USER=studio-overwrite\n' } },
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
