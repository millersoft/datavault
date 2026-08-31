'use strict';

function registerEnvironmentRoutes(parentApp, dependencies){
  const {
    express,
    fs,
    ENV_FILE_PATH,
  } = dependencies;
  const app = express.Router();

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
    if (!fs.existsSync(ENV_FILE_PATH)) return res.json({ ok: true, found: false });
    const env = parseEnvFile();
    if (!env) return res.status(500).json({ ok: false, found: true, error: 'Could not read the root .env file.' });
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
  
  parentApp.use(app);
}

module.exports = { registerEnvironmentRoutes };
