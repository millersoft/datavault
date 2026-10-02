'use strict';

const express = require('express');
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { resolveStudioMode, resolvePort } = require('./config/runtime');
const { createApiAccess } = require('./api-access');
const { createAuditLogger } = require('./audit-log');
const { createApiResponseSanitizer } = require('./api-response-sanitizer');
const { createRequestControls } = require('./request-controls');
const { createProjectPaths } = require('./config/project-paths');
const { createPackagedCredentialService, readResolvedEnv } = require('./packaged-credentials');
const { createDatabasePackService } = require('./database-packs');
const { createOutboundConnectionPolicy } = require('./outbound-connections');
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
  const suppliedEnv = options.env || process.env;
  const paths = options.paths || createProjectPaths({
    studioDir: STUDIO_DIR,
    env:suppliedEnv,
    cwd: options.cwd || process.cwd(),
  });
  const {
    PROJECT_ROOT, DB_INIT_PATH, MAPPINGS_PATH, HOP_CONFIG_PATH,
    JDBC_DRIVER_PATH, ENV_FILE_PATH, METADATA_RDBMS_PATH,
  } = paths;
  let fileEnv = {};
  try { fileEnv = readResolvedEnv(ENV_FILE_PATH); } catch (_) { /* .env is optional for tests and initial setup */ }
  const env = { ...fileEnv, ...suppliedEnv };
  const studioMode = options.studioMode || resolveStudioMode(options.argv, env);

  const packagedCredentialService = createPackagedCredentialService({
    envFilePath:ENV_FILE_PATH,
    hopEnvironmentPath:path.join(HOP_CONFIG_PATH,'postgres-environment.json'),
  });
  const outboundConnectionPolicy=options.outboundConnectionPolicy||createOutboundConnectionPolicy();

  const databasePackService = createDatabasePackService({
    projectRoot: PROJECT_ROOT,
    jdbcDriverPath: JDBC_DRIVER_PATH,
    studioDir: STUDIO_DIR,
    outboundConnectionPolicy,
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

  const requestControls = options.requestControls || createRequestControls({ env });

  const { connectPgWithFallback, openSourceConnection } = createSourceDatabase({
    Client, mysql, isPackDialect, getDatabasePack, runJdbcBridge, outboundConnectionPolicy,
    connectionTestTimeoutMs:requestControls.config.connectionTestTimeoutMs,
    resolveConnection:packagedCredentialService.resolveConnection,
  });

  const app = express();
  const auditLogger = options.auditLogger || createAuditLogger();
  const apiAccess = createApiAccess({ apiToken: options.apiToken, audit:auditLogger.audit });
  app.locals.studioMode = studioMode;
  app.locals.port = resolvePort(env);
  app.locals.requestControlConfig = requestControls.config;
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()');
    next();
  });
  app.use(apiAccess.validateLocalHost);
  app.use('/api', apiAccess.validateApiRequest);
  app.use('/api', createApiResponseSanitizer({
    resolveCredential: packagedCredentialService.resolveRedactionValues,
    sensitiveValues: Object.values(paths),
  }));
  app.use('/api', requestControls.rateLimit);
  app.use('/api/deploy-files', express.json({ limit: requestControls.config.deployBodyLimit }));
  app.use('/api/validate-workbook', express.json({ limit: requestControls.config.workbookBodyLimit }));
  app.use('/api', express.json({ limit: requestControls.config.defaultBodyLimit }));

  function serveStudio(_req, res){
    try {
      const html = fs.readFileSync(path.join(STUDIO_DIR, 'public', 'index.html'), 'utf8')
        .replace(/__STUDIO_RUNTIME_MODE__/g, studioMode)
        .replace(/__DVS_API_TOKEN__/g, apiAccess.apiToken);
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (_) {
      res.status(500).send('Could not load Data Vault Studio.');
    }
  }
  app.get('/', serveStudio);
  app.get('/index.html', serveStudio);

  app.use(express.static(path.join(STUDIO_DIR, 'public'), {
    index: false,
    etag: false,
    maxAge: 0,
    setHeaders(res){ res.set('Cache-Control', 'no-store'); },
  }));

  const sharedDependencies = {
    express, fs, path, os, spawn, mysql, studioMode, env, launcherEnv:suppliedEnv,
    appVersion: require('../package.json').version,
    ...paths,
    ...databasePackService,
    packagedCredentialService,
    outboundConnectionPolicy,
    requestControls,
    audit:auditLogger.audit,
    fetchImpl: options.fetch || global.fetch,
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

  app.use('/api', (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      const tooLarge = err.type === 'entity.too.large';
      return res.status(tooLarge ? 413 : 400).json({
        ok:false,
        code:tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
        error:tooLarge ? 'Request body is too large for this endpoint.' : 'Invalid JSON request body.',
        retryable:false,
      });
    }
    return res.status(500).json({ok:false,error:'The server could not complete the request.'});
  });

  return app;
}

module.exports = {
  createApp,
  PORT: resolvePort(),
  STUDIO_MODE: resolveStudioMode(),
};
