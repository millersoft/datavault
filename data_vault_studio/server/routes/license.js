'use strict';

const crypto = require('node:crypto');

function registerLicenseRoutes(parentApp, dependencies){
  const { express, fs, path, PROJECT_ROOT, env } = dependencies;
  const router = express.Router();

  function licenseFilePath(){ return path.resolve(PROJECT_ROOT, env.LICENSE_FILE || 'LICENSE'); }
  function licenseStateDir(){ return path.resolve(PROJECT_ROOT, env.LICENSE_STATE_DIR || '.license-state'); }
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

  router.get('/api/license', (req, res) => {
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

  router.post('/api/license-accept', (req, res) => {
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

  parentApp.use(router);
  return { licenseFilePath, licenseAccepted };
}

module.exports = { registerLicenseRoutes };
