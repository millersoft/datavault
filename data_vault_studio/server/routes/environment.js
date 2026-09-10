'use strict';

function registerEnvironmentRoutes(parentApp, dependencies){
  const {
    express,
    fs,
    ENV_FILE_PATH,
    packagedCredentialService,
    audit,
  } = dependencies;
  const app = express.Router();

  /* Root .env credentials used by Connections and deployment.
     SOURCE_PASSWORD is the selected source login secret. DB_USER remains the
     packaged/internal PostgreSQL login and is never changed here. For native
     external PostgreSQL, the Connections target login is also used by the
     bootstrap container, so POSTGRES_BOOTSTRAP_USER/PASSWORD and
     VAULT_PASSWORD are synchronised through one narrow, allowlisted endpoint.
     Generic file deployment is still forbidden from writing .env. */
  

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
  

  app.get('/api/env-defaults', (_req, res) => {
    const defaults=packagedCredentialService.publicDefaults();
    res.json({ok:true,...defaults});
  });
  
  app.post('/api/env-credentials/status', (req, res) => {
    const externalPostgres = req.body?.externalPostgres === true;
    const defaults=packagedCredentialService.publicDefaults();
    if(!defaults.found)return res.json({ok:true,found:false,sourceConfigured:false,targetConfigured:false,targetUserConfigured:false});
    res.json({ok:true,found:true,
      sourceConfigured:!!defaults.mysql.passwordConfigured,
      targetConfigured:externalPostgres?!!defaults.bootstrap.passwordConfigured:!!defaults.target.passwordConfigured,
      targetUserConfigured:externalPostgres?!!defaults.bootstrap.user:!!defaults.target.user,
    });
  });
  
  app.post('/api/env-credentials', (req, res) => {
    try {
      const externalPostgres = req.body?.externalPostgres === true;
      const sourceCredentialMode = req.body?.sourceCredentialMode === 'preserve' ? 'preserve' : 'replace';
      const updates = {};
      if(sourceCredentialMode==='replace') updates.SOURCE_PASSWORD=validateEnvCredential('Source password', req.body?.sourcePassword);
      else if(!packagedCredentialService.publicDefaults().mysql?.passwordConfigured) throw new Error('Packaged MySQL credentials are not configured.');
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
      audit('credentials.configured', { externalPostgres, updated, sourceCredentialMode, success:true });
      res.json({ ok:true, updated });
    } catch (err) {
      audit('credentials.configured', { externalPostgres:req.body?.externalPostgres === true, success:false });
      res.status(400).json({ ok:false, error:err.message });
    }
  });
  
  parentApp.use(app);
}

module.exports = { registerEnvironmentRoutes };
