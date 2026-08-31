const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function existingDirectory(candidate){
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  try { return fs.statSync(resolved).isDirectory() ? resolved : null; }
  catch (_) { return null; }
}

function findProjectRoot({ studioDir, env = process.env, cwd = process.cwd() }){
  const starts = [env.DVS_PROJECT_ROOT, env.PROJECT_ROOT, cwd, studioDir]
    .map(existingDirectory).filter(Boolean);
  const seen = new Set();
  for (const start of starts){
    let dir = start;
    while (!seen.has(dir)){
      seen.add(dir);
      const hasStartScript = fs.existsSync(path.join(dir, 'start.sh'));
      const hasComposeFile = fs.existsSync(path.join(dir, 'docker-compose.yaml'))
        || fs.existsSync(path.join(dir, 'docker-compose.yml'))
        || fs.existsSync(path.join(dir, 'compose.yaml'))
        || fs.existsSync(path.join(dir, 'compose.yml'));
      if (hasStartScript && hasComposeFile) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.resolve(studioDir, '..');
}

function createProjectPaths({ studioDir, env = process.env, cwd = process.cwd() }){
  const projectRoot = findProjectRoot({ studioDir, env, cwd });
  const bundledDatabasePackDir = path.join(studioDir, 'database-packs');
  return {
    PROJECT_ROOT: projectRoot,
    DB_INIT_PATH: path.join(projectRoot, 'db-init'),
    MAPPINGS_PATH: path.join(projectRoot, 'mappings'),
    HOP_CONFIG_PATH: path.join(projectRoot, 'hop'),
    JDBC_DRIVER_PATH: path.join(projectRoot, 'jdbc-drivers'),
    ENV_FILE_PATH: path.join(projectRoot, '.env'),
    METADATA_RDBMS_PATH: path.join(projectRoot, 'metadata', 'rdbms'),
    DATABASE_PACK_HOME: path.resolve(env.DVS_DATABASE_PACK_HOME || bundledDatabasePackDir),
    BUNDLED_DATABASE_PACK_DIR: bundledDatabasePackDir,
    HOP_DATABASE_TYPES_PATH: path.join(studioDir, 'hop', 'database-types.json'),
    JDBC_BRIDGE_SOURCE_PATH: path.join(studioDir, 'jdbc-bridge', 'JdbcBridge.java'),
    JDBC_BRIDGE_BUNDLED_CLASS_DIR: path.join(studioDir, 'jdbc-bridge', 'classes'),
    JDBC_BRIDGE_CACHE_DIR: path.join(os.tmpdir(), 'data-vault-studio-jdbc-bridge-v0_1_2'),
  };
}

module.exports = { existingDirectory, findProjectRoot, createProjectPaths };
