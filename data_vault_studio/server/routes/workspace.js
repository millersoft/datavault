'use strict';

function registerWorkspaceRoutes(parentApp, dependencies){
  const {
    express,
    fs,
    path,
    os,
    spawn,
    PROJECT_ROOT,
    DB_INIT_PATH,
    MAPPINGS_PATH,
    HOP_CONFIG_PATH,
    JDBC_DRIVER_PATH,
    METADATA_RDBMS_PATH,
    requestControls,
    audit,
    fetchImpl,
    env,
  } = dependencies;
  const app = express.Router();
  const FILE_STATUS_ROOTS = {
    mappings: () => MAPPINGS_PATH,
    hop: () => HOP_CONFIG_PATH,
    rdbms: () => METADATA_RDBMS_PATH,
  };
  const DEPLOY_DESTINATIONS = {
    'db-init': {
      folder: DB_INIT_PATH,
      label: 'db-init',
      encoding: 'utf8',
      accepts: name => /^\d{2,}-(?:ddls|pdi-meta)\.sql$/i.test(name),
      expected: 'a numbered generated file such as 04-ddls.sql or 05-pdi-meta.sql',
    },
    mappings: {
      folder: MAPPINGS_PATH,
      label: 'mappings',
      encoding: 'base64',
      accepts: name => /^[A-Za-z0-9][A-Za-z0-9 ._-]*_1\.xls$/i.test(name),
      expected: 'a generated mapping workbook ending in _1.xls',
    },
    hop: {
      folder: HOP_CONFIG_PATH,
      label: 'hop',
      encoding: 'utf8',
      accepts: name => name === 'postgres-environment.json',
      expected: 'postgres-environment.json',
    },
    'metadata-rdbms': {
      folder: METADATA_RDBMS_PATH,
      label: 'metadata/rdbms',
      encoding: 'utf8',
      accepts: name => name === 'source.json',
      expected: 'source.json',
    },
  };
  const VALIDATOR_CANDIDATES = [
    env.DVS_VALIDATOR,
    path.join(PROJECT_ROOT, 'scripts', 'validate_mapping_workbook.py'),
    path.join(PROJECT_ROOT, 'skills', 'hop-data-vault-setup', 'scripts', 'validate_mapping_workbook.py'),
  ].filter(Boolean);

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
  
  function assertDeployDestinationContained(folder){
    const realRoot = fs.realpathSync(PROJECT_ROOT);
    const relative = path.relative(PROJECT_ROOT, folder);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Deployment destination must be a configured directory inside the project root.');
    }

    let current = PROJECT_ROOT;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) break;
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Deployment destination cannot contain a symbolic link: ${current}`);
      }
    }

    fs.mkdirSync(folder, { recursive: true });
    const realFolder = fs.realpathSync(folder);
    if (!realFolder.startsWith(realRoot + path.sep)) {
      throw new Error('Deployment destination resolves outside the project root.');
    }
  }

  app.post('/api/deploy-files', async (req, res) => {
    const body = req.body || {};
    if (Object.prototype.hasOwnProperty.call(body, 'folder')) {
      return res.status(400).json({ ok: false, error: 'folder is not accepted; use a logical destination.' });
    }
    const destination = DEPLOY_DESTINATIONS[body.destination];
    if (!destination) {
      return res.status(400).json({
        ok: false,
        error: `Unknown destination "${String(body.destination || '')}". Allowed destinations: ${Object.keys(DEPLOY_DESTINATIONS).join(', ')}.`,
      });
    }
    const files = body.files;
    if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length === 0) {
      return res.status(400).json({ ok: false, error: 'No files provided.' });
    }
    for (const [name, content] of Object.entries(files)) {
      if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) {
        return res.status(400).json({ ok: false, error: `Unsafe file name: ${name}` });
      }
      if (name.toLowerCase() === '.env') {
        return res.status(400).json({ ok: false, error: 'The project .env file is read-only to Data Vault Studio.' });
      }
      if (!destination.accepts(name)) {
        return res.status(400).json({ ok: false, error: `File "${name}" is not allowed for destination "${body.destination}"; expected ${destination.expected}.` });
      }
      if (typeof content !== 'string') {
        return res.status(400).json({ ok: false, error: `File content must be a string: ${name}` });
      }
    }

    const folder = destination.folder;
    try {
      assertDeployDestinationContained(folder);
      const targets = Object.keys(files).map(name => ({ name, fullPath: path.join(folder, name) }));
      for (const target of targets) {
        try {
          if (fs.lstatSync(target.fullPath).isSymbolicLink()) {
            throw new Error(`Refusing to overwrite symbolic link: ${target.fullPath}`);
          }
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }

      const written = [];
      for (const { name, fullPath } of targets) {
        const content = files[name];
        if (destination.encoding === 'base64') {
          await fs.promises.writeFile(fullPath, Buffer.from(content, 'base64'));
        } else {
          await fs.promises.writeFile(fullPath, content, 'utf8');
        }
        written.push(name);
      }
      audit('file.deployed', { destination:body.destination, folder:destination.label, fileCount:written.length, files:written, success:true });
      res.json({ ok: true, destination: body.destination, folder: destination.label, written });
    } catch (err) {
      audit('file.deployed', { destination:body.destination, fileCount:Object.keys(files).length, success:false });
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

  function parseAllowedDriverUrl(value){
    let parsedUrl;
    try { parsedUrl = new URL(value); } catch(_) { throw new Error('Invalid URL.'); }
    if (parsedUrl.protocol !== 'https:' || !ALLOWED_DRIVER_HOSTS.includes(parsedUrl.hostname)) {
      throw new Error(`URL host not in the allowed driver-source list: ${parsedUrl.hostname}`);
    }
    return parsedUrl;
  }

  async function fetchAllowedDriver(url, signal){
    let current = parseAllowedDriverUrl(url);
    for (let redirects = 0; redirects <= 5; redirects++){
      const response = await fetchImpl(current, {
        headers:{ 'User-Agent':'data-vault-studio/1.0 (+local-driver-fetch)' },
        redirect:'manual',
        signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirects === 5) throw new Error('JDBC driver download followed too many redirects.');
      const location = response.headers.get('location');
      if (!location) throw new Error('JDBC driver download redirect did not include a location.');
      if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
      current = parseAllowedDriverUrl(new URL(location, current).toString());
    }
    throw new Error('JDBC driver download followed too many redirects.');
  }

  app.post('/api/fetch-driver', requestControls.guard('driver-download'), async (req, res) => {
    const { url, filename, folder } = req.body || {};
    if (!url || !filename) return res.status(400).json({ ok:false, error:'url and filename are required.' });
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ ok:false, error:`Unsafe file name: ${filename}` });
    }
    try { parseAllowedDriverUrl(url); }
    catch(err) { return res.status(400).json({ ok:false, error:err.message }); }

    const maxBytes = requestControls.config.maxJdbcDriverBytes;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestControls.config.jdbcDownloadTimeoutMs);
    let temporaryPath = '';
    let fileHandle;
    try {
      const targetFolder = resolveFolderInsideProject(folder, JDBC_DRIVER_PATH);
      const response = await fetchAllowedDriver(url, controller.signal);
      if (!response.ok) return res.status(400).json({ ok:false, error:`Fetch failed: HTTP ${response.status}` });
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes){
        controller.abort();
        return res.status(413).json({
          ok:false, code:'DOWNLOAD_TOO_LARGE',
          error:`JDBC driver download exceeds the configured ${maxBytes} byte limit.`,
          maxBytes, retryable:false,
        });
      }
      if (!response.body || typeof response.body.getReader !== 'function') throw new Error('JDBC driver download returned no readable response body.');

      await fs.promises.mkdir(targetFolder, { recursive:true });
      const fullPath = path.join(targetFolder, filename);
      try {
        if (fs.lstatSync(fullPath).isSymbolicLink()) throw new Error(`Refusing to overwrite symbolic link: ${fullPath}`);
      } catch(err) {
        if (err.code !== 'ENOENT') throw err;
      }
      temporaryPath = path.join(targetFolder, `.${filename}.${process.pid}.${Date.now()}.part`);
      fileHandle = await fs.promises.open(temporaryPath, 'wx');
      const reader = response.body.getReader();
      let bytes = 0;
      while (true){
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > maxBytes){
          controller.abort();
          const error = new Error(`JDBC driver download exceeded the configured ${maxBytes} byte limit.`);
          error.code = 'DOWNLOAD_TOO_LARGE';
          throw error;
        }
        await fileHandle.write(chunk);
      }
      await fileHandle.close();
      fileHandle = null;
      try {
        await fs.promises.rename(temporaryPath, fullPath);
      } catch(err) {
        if (!['EEXIST', 'EPERM'].includes(err.code)) throw err;
        const current = await fs.promises.lstat(fullPath);
        if (current.isSymbolicLink()) throw new Error(`Refusing to overwrite symbolic link: ${fullPath}`);
        await fs.promises.rm(fullPath, { force:true });
        await fs.promises.rename(temporaryPath, fullPath);
      }
      temporaryPath = '';
      const displayFolder=path.relative(PROJECT_ROOT,targetFolder).split(path.sep).join('/')||'.';
      audit('driver.downloaded', { filename, folder:displayFolder, bytes, success:true });
      res.json({ ok:true, folder:displayFolder, written:[filename], bytes });
    } catch(err){
      if (fileHandle) { try { await fileHandle.close(); } catch(_) {} }
      if (temporaryPath) { try { await fs.promises.rm(temporaryPath, { force:true }); } catch(_) {} }
      const tooLarge = err.code === 'DOWNLOAD_TOO_LARGE';
      const timedOut = err.name === 'AbortError';
      audit('driver.downloaded', { filename, success:false, code:tooLarge ? 'DOWNLOAD_TOO_LARGE' : (timedOut ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_FAILED') });
      res.status(tooLarge ? 413 : 400).json({
        ok:false,
        code:tooLarge ? 'DOWNLOAD_TOO_LARGE' : (timedOut ? 'DOWNLOAD_TIMEOUT' : undefined),
        error:timedOut ? 'JDBC driver download timed out.' : err.message,
        ...(tooLarge ? { maxBytes } : {}),
        retryable:timedOut,
      });
    } finally {
      clearTimeout(timer);
    }
  });
  
  // Executes a SQL script directly against a real database — used to apply
  // the staging/data-vault/pdi_meta DDL for real, instead of just downloading
  // it. Runs inside a transaction: if any statement fails, everything rolls
  // back rather than leaving a half-applied schema.
  
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
  
  // Reports whether supported bundled JDBC drivers are present in jdbc-drivers/.
  // MySQL/PostgreSQL now use their generated Database Packs for Studio JDBC
  // work as well as Hop, and the same mount is reused by JDBC FDW.
  app.get('/api/driver-status', (req, res) => {
    try {
      const jars = fs.existsSync(JDBC_DRIVER_PATH)
        ? fs.readdirSync(JDBC_DRIVER_PATH).filter(f => f.toLowerCase().endsWith('.jar'))
        : [];
      const mysqlDriver = jars.find(f => /mysql-connector/i.test(f)) || null;
      const postgresDriver = jars.find(f => /^postgresql-.*\.jar$/i.test(f)) || null;
      const sqlServerDriver = jars.find(f => /mssql-jdbc/i.test(f)) || null;
      res.json({ ok: true, jars, mysqlDriver, postgresDriver, sqlServerDriver });
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
      res.json({ ok:true, exists, filename });
    } catch (err) {
      res.status(400).json({ ok:false, error:err.message });
    }
  });
  
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
  parentApp.use(app);
}

module.exports = { registerWorkspaceRoutes };
