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
  } = dependencies;
  const app = express.Router();
  const FILE_STATUS_ROOTS = {
    mappings: () => MAPPINGS_PATH,
    hop: () => HOP_CONFIG_PATH,
    rdbms: () => METADATA_RDBMS_PATH,
  };
  const VALIDATOR_CANDIDATES = [
    process.env.DVS_VALIDATOR,
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
  // for Database Pack JDBC sources/targets; the same mount is used by JDBC FDW.
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
