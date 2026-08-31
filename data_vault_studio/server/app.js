'use strict';

const express = require('express');
const cors = require('cors');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { resolveStudioMode, resolvePort } = require('./config/runtime');
const { createProjectPaths } = require('./config/project-paths');
const { createDatabasePackService } = require('./database-packs');
const { createSourceDatabase } = require('./database/source');
const { registerSystemRoutes } = require('./routes/system');
const { registerDatabasePackRoutes } = require('./routes/database-packs');
const { registerSourceRoutes } = require('./routes/source');
const { registerTargetRoutes } = require('./routes/target');
const { registerEnvironmentRoutes } = require('./routes/environment');
const { registerLicenseRoutes } = require('./routes/license');
const { registerWorkspaceRoutes } = require('./routes/workspace');
const { registerExternalTargetRoutes } = require('./routes/external-target');
const { registerEngineRoutes } = require('./routes/engine');
const { registerSchedulerRoutes } = require('./routes/scheduler');

const STUDIO_DIR = path.resolve(__dirname, '..');

function createApp(options = {}){
  const env = options.env || process.env;
  const studioMode = options.studioMode || resolveStudioMode(options.argv, env);
  const paths = options.paths || createProjectPaths({
    studioDir: STUDIO_DIR,
    env,
    cwd: options.cwd || process.cwd(),
  });
  const {
    PROJECT_ROOT, DB_INIT_PATH, MAPPINGS_PATH, HOP_CONFIG_PATH,
    JDBC_DRIVER_PATH, ENV_FILE_PATH, METADATA_RDBMS_PATH,
  } = paths;

  const databasePackService = createDatabasePackService({
    projectRoot: PROJECT_ROOT,
    jdbcDriverPath: JDBC_DRIVER_PATH,
    studioDir: STUDIO_DIR,
    env,
  });
  const {
    DATABASE_PACK_FEATURE_VERSION, DATABASE_PACK_SCHEMA_VERSION,
    DATABASE_PACK_DIR, HOP_DATABASE_TYPES_PATH, isPackDialect,
    validateDatabasePackManifest, findPackJdbcDriver, loadHopDatabaseTypes,
    listDatabasePacks, getDatabasePack, writeDatabasePack, removeDatabasePack,
    semanticTypeForJdbc, applyPackSemanticTypes,
    sourceHopCapabilitiesFromJdbcAnalysis, sourceHopCapabilitiesFromTables,
    sourceHopCapabilitiesFromHopCatalog, analysisValue,
    resolveJdbcTargetProfile, runJdbcBridge, firstNonBlank,
    packNamespaceFromBody,
  } = databasePackService;

  const { connectPgWithFallback, openSourceConnection } = createSourceDatabase({
    Client, mysql, isPackDialect, getDatabasePack, runJdbcBridge,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '25mb' }));

  app.get('/', (req, res) => {
    try {
      const html = fs.readFileSync(path.join(STUDIO_DIR, 'public', 'index.html'), 'utf8')
        .replace(/__STUDIO_RUNTIME_MODE__/g, studioMode);
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (err) {
      res.status(500).send('Could not load public/index.html: ' + err.message);
    }
  });

  app.use(express.static(path.join(STUDIO_DIR, 'public'), {
    index: false,
    etag: false,
    maxAge: 0,
    setHeaders(res){ res.set('Cache-Control', 'no-store'); },
  }));

  const sharedDependencies = {
    express, fs, path, os, spawn, mysql, studioMode,
    ...paths,
    ...databasePackService,
    connectPgWithFallback,
    openSourceConnection,
  };

  registerSystemRoutes(app, sharedDependencies);
  registerDatabasePackRoutes(app, sharedDependencies);
  registerSourceRoutes(app, sharedDependencies);
  registerTargetRoutes(app, sharedDependencies);
  registerEnvironmentRoutes(app, sharedDependencies);
  const licenseServices = registerLicenseRoutes(app, sharedDependencies);
  registerWorkspaceRoutes(app, sharedDependencies);
  registerExternalTargetRoutes(app, sharedDependencies);
  const engineServices = registerEngineRoutes(app, {
    ...sharedDependencies,
    ...licenseServices,
  });
  if (options.scheduler !== false){
    registerSchedulerRoutes(app, { ...sharedDependencies, ...engineServices });
  }

  return app;
}

module.exports = {
  createApp,
  PORT: resolvePort(),
  STUDIO_MODE: resolveStudioMode(),
};
