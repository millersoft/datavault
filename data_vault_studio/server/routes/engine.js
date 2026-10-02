'use strict';

const nodePath = require('path');
const { createRuntimeResourceService } = require('../runtime-resources');

function selectStudioLauncher(projectRoot, args, platform = process.platform, pathImpl = nodePath){
  const windows = platform === 'win32';
  const label = windows ? 'start.ps1' : 'start.sh';
  const scriptPath = pathImpl.join(projectRoot, label);
  return windows
    ? {
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
        scriptPath,
        label,
      }
    : { command: 'bash', args: [scriptPath, ...args], scriptPath, label };
}

function registerEngineRoutes(parentApp, dependencies){
  const {
    express,
    fs,
    path,
    spawn,
    studioMode,
    PROJECT_ROOT,
    licenseFilePath,
    licenseAccepted,
    requestControls,
    audit,
    launcherEnv,
  } = dependencies;
  const app = express.Router();
  const DB_SERVICES = ['mysql', 'postgres'];
  const runtimeResources = createRuntimeResourceService({ fs, path, projectRoot:PROJECT_ROOT });

  function projectRootError(extra){
    return `${extra} Resolved project root: ${PROJECT_ROOT}. Start the local server from <project-root>/data_vault_studio or set DVS_PROJECT_ROOT=/path/to/project-root.`;
  }
  
  function runFixedCommand(args, timeoutMs, envOverrides = {}){
    return new Promise((resolve) => {
      const launcher = selectStudioLauncher(PROJECT_ROOT, args, process.platform, path);
      if (!fs.existsSync(launcher.scriptPath)){
        resolve({ ok:false, error:projectRootError(`${launcher.label} not found at ${launcher.scriptPath}.`) });
        return;
      }
      let stdout = '', stderr = '', settled = false, timedOut = false, killTimer;
      const child = spawn(launcher.command, launcher.args, {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'], // no stdin — never hang waiting for interactive input
        // Compose reads PROJECT_ROOT/.env for every invocation. Do not pass
        // Studio's startup-time .env cache here, because inherited values
        // take precedence over Compose's current .env values.
        env: { ...launcherEnv, ...envOverrides },
        detached: process.platform !== 'win32',
      });
      const timeoutResult = () => ({
        ok:false,
        error:`Timed out after ${timeoutMs/1000}s waiting for: ${launcher.label} ${args.join(' ')}`,
        stdout,
        stderr,
      });
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
        // Normally `close` follows the kill and releases the operation gate.
        // Keep a bounded fallback for unusual platform/process failures.
        if (process.platform !== 'win32'){
          killTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(timeoutResult());
          }, 5000);
        }
      }, timeoutMs);
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (timedOut) return resolve(timeoutResult());
        if (code === 0) return resolve({ ok: true, code, stdout, stderr });
        // Non-zero exit: surface WHY. The license prompt writes to stdout, so
        // stderr alone is often empty — without this, the GUI can only say
        // "Could not start X" with no way to self-diagnose.
        let error;
        if (/LICENSE AGREEMENT|accept the license/i.test(stdout + stderr)) {
          error = 'License not accepted yet — accept it in the GUI (license panel on first load), or run ./start.sh (.\\start.ps1 on Windows) once in a terminal.';
        } else {
          const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-40).join('\n');
          error = `${launcher.label} ${args.join(' ')} exited with code ${code}${detail ? ':\n' + detail : ''}`;
        }
        resolve({ ok: false, code, stdout, stderr, error });
      });
      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolve(timedOut ? timeoutResult() : { ok:false, error:`${launcher.label}: ${err.message}`, stdout, stderr });
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

  function runEtlTransition(args, timeoutMs, options = {}){
    const gates = [];
    if (options.build === true) gates.push({ group:'container-build', key:'exclusive' });
    gates.push({ group:'etl-transition', key:'exclusive' });
    return requestControls.execute(gates, () => runFixedCommand(args, timeoutMs, options.envOverrides));
  }

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
    const result = await runEtlTransition(args, timeout, { build:mode === 'external' && build === true });
    audit('etl.start', { mode, build:mode === 'external' && build === true, success:result.ok });
    requestControls.sendResult(res, result, { mode, args:args.join(' ') });
  });

  app.post('/api/docker/stop-hop', async (_req, res) => {
    const args = ['stop', 'hop'];
    const result = await runEtlTransition(args, 60000);
    audit('etl.stop', { success:result.ok });
    requestControls.sendResult(res, result, { args:args.join(' ') });
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
  
  app.post('/api/docker/bootstrap', async (req, res) => {
    if (!fs.existsSync(licenseFilePath()) || !licenseAccepted()) {
      return res.status(403).json({ ok: false, error: 'License not accepted yet — accept it in the GUI first.' });
    }
    const { mode, database, fdw = false } = req.body || {};
    if (mode !== undefined && mode !== 'internal') {
      return res.status(400).json({ ok: false, error: 'mode must be "internal" when provided.' });
    }
    if ((mode === 'internal' || database !== undefined) && (typeof database !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(database))) {
      return res.status(400).json({ ok: false, error: 'database must be a plain SQL identifier.' });
    }
    if (typeof fdw !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'fdw must be true or false.' });
    }
    const result = await requestControls.execute([
      { group:'container-build', key:'exclusive' },
      { group:'etl-transition', key:'exclusive' },
    ], async () => {
      if (mode === 'internal') {
        const recreateArgs = fdw
          ? ['up', '--fdw', '--build', '--force-recreate', '-d', 'postgres']
          : ['up', '--studio-build', '--force-recreate', '-d', 'postgres'];
        const databaseEnv = { INTERNAL_DATA_VAULT_DATABASE: database };
        const recreate = await runFixedCommand(recreateArgs, 600000, databaseEnv);
        if (!recreate.ok) return { ...recreate, step:'recreate', mode, database };
        const password = await runFixedCommand(['exec', '-T', 'postgres', 'bash', '/docker-entrypoint-initdb.d/01-vault-password.sh'], 120000);
        if (!password.ok) return { ...password, step:'password', mode, database };
        const dump = await runFixedCommand([
          'exec', '-T', 'postgres', 'psql', '-U', 'dvuser', '-d', 'postgres',
          '-v', 'ON_ERROR_STOP=1', '-v', `target_database=${database}`,
          '-f', '/docker-entrypoint-initdb.d/02-dump.sql',
        ], 900000);
        return { ...dump, step:dump.ok ? 'done' : 'dump', mode, database };
      }
      const bootstrap = await runFixedCommand(['bootstrap-external-postgres'], 900000);
      return { ...bootstrap, step:bootstrap.ok ? 'done' : 'bootstrap' };
    });
    audit('bootstrap.executed', { mode:mode || 'external', fdw, database, success:result.ok });
    requestControls.sendResult(res, result);
  });
  
  app.post('/api/docker/start-db', async (req, res) => {
    const request = req.body || {};
    const { service, fdw = false } = request;
    if (!DB_SERVICES.includes(service)) {
      return res.status(400).json({ ok: false, error: `Unknown service "${service}" — allowed: ${DB_SERVICES.join(', ')}.` });
    }
    // The packaged MySQL service is demo data, not a general MySQL runtime.
    // Production connections to MySQL are always user-supplied Database Pack
    // connections and must never cause Studio to start the demo container.
    if (service === 'mysql' && studioMode !== 'demo') {
      return res.status(403).json({ ok:false, error:'The packaged MySQL service can only be started in demo mode.' });
    }
    if (typeof fdw !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'fdw must be true or false.' });
    }
    if (service !== 'postgres' && fdw) {
      return res.status(400).json({ ok: false, error: 'FDW mode is only valid for the postgres service.' });
    }
    if (service !== 'postgres' && Object.prototype.hasOwnProperty.call(request, 'database')) {
      return res.status(400).json({ ok: false, error: 'database is only valid for the postgres service.' });
    }
    let database;
    if (service === 'postgres') {
      if (request.database !== undefined && typeof request.database !== 'string') {
        return res.status(400).json({ ok: false, error: 'database must be a plain SQL identifier.' });
      }
      const requestedDatabase = request.database || '';
      database = requestedDatabase.trim() === '' ? 'datavault' : requestedDatabase;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
        return res.status(400).json({ ok: false, error: 'database must be a plain SQL identifier.' });
      }
    }
    const args = service === 'mysql'
      ? ['up', '--demo', '-d', 'mysql']
      : fdw
        ? ['up', '--fdw', '--build', '--force-recreate', '-d', 'postgres']
        : ['up', '--studio-build', '-d', 'postgres'];
    // FDW mode must be deterministic even if ordinary PostgreSQL was started
    // earlier. Force the postgres service to be rebuilt from Dockerfile.fdw and
    // recreate the container; Docker layer caching keeps repeated starts cheap.
    // start.sh still owns the Compose override ordering.
    const envOverrides = service === 'postgres' ? { INTERNAL_DATA_VAULT_DATABASE: database } : {};
    const result = service === 'postgres'
      ? await requestControls.execute([
          { group:'container-build', key:'exclusive' },
          { group:'etl-transition', key:'exclusive' },
        ], () => runFixedCommand(args, 600000, envOverrides))
      : await requestControls.execute(
          { group:'etl-transition', key:'exclusive' },
          () => runFixedCommand(args, 120000, envOverrides),
        );
    audit('database.start', { service, fdw:service === 'postgres' && fdw, database, success:result.ok });
    requestControls.sendResult(res, result, { fdw:service === 'postgres' && fdw, database, args:args.join(' ') });
  });
  app.post('/api/docker/stop-db', async (req, res) => {
    const { service } = req.body || {};
    if (!DB_SERVICES.includes(service)) {
      return res.status(400).json({ ok: false, error: `Unknown service "${service}" — allowed: ${DB_SERVICES.join(', ')}.` });
    }
    const result = service === 'postgres'
      ? await requestControls.execute([
          { group:'container-build', key:'exclusive' },
          { group:'etl-transition', key:'exclusive' },
        ], () => runFixedCommand(['stop', service], 60000))
      : await requestControls.execute(
          { group:'etl-transition', key:'exclusive' },
          () => runFixedCommand(['stop', service], 60000),
        );
    audit('database.stop', { service, success:result.ok });
    requestControls.sendResult(res, result);
  });
  
  // Resource settings are isolated in a managed Compose override. These routes
  // inherit the app-level /api loopback, origin, token, sanitizer, and rate
  // limit middleware; no resource values are accepted by launcher commands.
  app.get('/api/docker/resources', (_req, res) => {
    try {
      const resources = runtimeResources.current();
      res.json({ ok:true, ...resources });
    } catch (err) {
      res.status(400).json({ ok:false, error:err.message });
    }
  });

  app.post('/api/docker/resources', (req, res) => {
    try {
      const resources = runtimeResources.save((req.body || {}).resources);
      audit('container.resources.configured', { services:Object.keys((req.body || {}).resources || {}), success:true });
      res.json({ ok:true, ...resources });
    } catch (err) {
      audit('container.resources.configured', { success:false });
      res.status(400).json({ ok:false, error:err.message });
    }
  });

  // Tail of the hop container's logs — read-only, command fully hardcoded.
  // `up -d` returns as soon as the container starts, so this is how you
  // actually see what the ETL run is doing / why it failed. `tail` is
  // clamped server-side so the browser can't request unbounded output.
  app.post('/api/docker/logs', async (req, res) => {
    const requested = Number((req.body || {}).tail);
    const tail = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 10), 2000) : 200;
    const result = await runFixedCommand(['logs', '--no-color', '--tail', String(tail), 'hop'], 20000);
    if (!result.ok) return res.json(result);
    res.json({ ok: true, logs: result.stdout });
  });
  
  // Runs the project's own canonical Python workbook validator against a
  // workbook generated in the browser — so the GUI's JS validation can never
  // silently drift from the validator the pipeline itself trusts. Best-effort:
  // returns a clear error if python3 or the script isn't present.
  
  async function getHopStatus(){
    const result = await runFixedCommand(['ps', '-a', '--format', 'json', 'hop'], 15000);
    if (!result.ok) return result;
    try {
      const trimmed = result.stdout.trim();
      const containers = !trimmed ? [] : (trimmed.startsWith('[')
        ? JSON.parse(trimmed)
        : trimmed.split('\n').filter(Boolean).map(l => JSON.parse(l)));
      const c = containers.find(x => String(x.Service || '').toLowerCase() === 'hop') || containers[0] || null;
      const state = String(c && c.State || '').toLowerCase();
      const status = String(c && c.Status || '');
      const running = state === 'running' || /^up\b/i.test(status);
      const rawExit = c && c.ExitCode;
      const exitCode = rawExit === undefined || rawExit === null || rawExit === '' || Number.isNaN(Number(rawExit))
        ? null : Number(rawExit);
      return {
        ok:true,
        present:!!c,
        running,
        state,
        status,
        exitCode,
        name:c ? String(c.Name || '') : '',
      };
    } catch (parseErr) {
      return { ok:false, error:'Could not parse container status for Hop.', raw: result.stdout };
    }
  }

  app.post('/api/docker/hop-status', async (_req, res) => {
    res.json(await getHopStatus());
  });
  
  // Read-only container status check — not gated by the license flow since
  // it doesn't start anything.
  app.post('/api/docker/status', async (req, res) => {
    const result = await runFixedCommand(['ps', '--format', 'json'], 15000);
    if (!result.ok) return res.json(result);
    try {
      // Compose ps --format json emits one JSON object per line (NDJSON) on
      // most versions, but a single JSON array on some — handle both.
      const trimmed = result.stdout.trim();
      const containers = trimmed.startsWith('[')
        ? JSON.parse(trimmed)
        : trimmed.split('\n').filter(Boolean).map(l => JSON.parse(l));
      res.json({ ok:true, containers });
    } catch (parseErr) {
      res.json({ ok:false, error:'Could not parse container status output.', raw: result.stdout });
    }
  });

  parentApp.use(app);
  return { ENGINE_MODES, runFixedCommand, runEtlTransition, getHopStatus, runtimeResources };
}

module.exports = { registerEngineRoutes, selectStudioLauncher };
