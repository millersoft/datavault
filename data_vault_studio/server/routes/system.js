'use strict';

function registerSystemRoutes(parentApp, dependencies){
  const {
    express, studioMode, PROJECT_ROOT, DB_INIT_PATH, MAPPINGS_PATH,
    HOP_CONFIG_PATH, JDBC_DRIVER_PATH, METADATA_RDBMS_PATH,
    DATABASE_PACK_DIR, HOP_DATABASE_TYPES_PATH,
  } = dependencies;
  const router = express.Router();

  router.get('/api/runtime-profile', (req, res) => {
    res.json({
      ok: true,
      mode: studioMode,
      isDemo: studioMode === 'demo',
      isProduction: studioMode === 'production',
    });
  });

  router.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      service: 'vault-bench-introspect-server',
      version: '1.2.2',
      studioMode,
      projectRoot: PROJECT_ROOT,
      dbInitPath: DB_INIT_PATH,
      mappingsPath: MAPPINGS_PATH,
      hopConfigPath: HOP_CONFIG_PATH,
      jdbcDriverPath: JDBC_DRIVER_PATH,
      metadataRdbmsPath: METADATA_RDBMS_PATH,
      databasePackHome: DATABASE_PACK_DIR,
      hopDatabaseTypesPath: HOP_DATABASE_TYPES_PATH,
    });
  });

  parentApp.use(router);
}

module.exports = { registerSystemRoutes };
