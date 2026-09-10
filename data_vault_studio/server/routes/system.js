'use strict';

function registerSystemRoutes(parentApp, dependencies){
  const { express, studioMode, appVersion } = dependencies;
  const router = express.Router();

  router.get('/api/runtime-profile', (req, res) => {
    res.json({
      ok: true,
      mode: studioMode,
      isDemo: studioMode === 'demo',
      isProduction: studioMode === 'production',
    });
  });

  router.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'data-vault-studio',
      version: appVersion,
    });
  });

  parentApp.use(router);
}

module.exports = { registerSystemRoutes };
