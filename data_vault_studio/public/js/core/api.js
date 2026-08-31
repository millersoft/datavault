/* =========================================================================
   LOCAL INTROSPECTION SERVER — built-in PostgreSQL/MySQL + Database Packs
   ========================================================================= */
// When the GUI is served by the companion server itself (http://127.0.0.1:8420/),
// talk to that same origin; when opened as a file:// page, default to the
// server's standard localhost port.
let localServerUrl = location.protocol.startsWith('http') ? location.origin : 'http://localhost:8420';
// Single choke-point for every companion-server call — all former
// fetch(`${localServerUrl}/api/...`) call sites route through here.
function localFetch(path, opts){
  return fetch(`${localServerUrl}${path}`, opts);
}
let deployFolder = '';
let deployFolderDetected = '';
let deployStartNum = 4;
let mappingsFolder = '';
let mappingsFolderDetected = '';
let hopConfigFolder = '';
let hopConfigFolderDetected = '';
let jdbcDriverFolder = '';
let jdbcDriverFolderDetected = '';
let jdbcDriverDeployStatus = null; // null | 'loading' | 'ok' | 'error'
let rdbmsFolder = '';
let rdbmsFolderDetected = '';

async function detectDbInitPath(){
  if (deployFolderDetected && mappingsFolderDetected && hopConfigFolderDetected && jdbcDriverFolderDetected && rdbmsFolderDetected) return; // already know all five
  try {
    const resp = await localFetch(`/api/health`);
    const data = await resp.json();
    if (data && data.dbInitPath){
      deployFolderDetected = data.dbInitPath;
      const input = document.getElementById('f-deploy-folder');
      if (input) input.placeholder = deployFolderDetected;
    }
    if (data && data.hopConfigPath){
      hopConfigFolderDetected = data.hopConfigPath;
      const hopInput = document.getElementById('f-hop-folder');
      if (hopInput) hopInput.placeholder = hopConfigFolderDetected;
    }
    if (data && data.jdbcDriverPath){
      jdbcDriverFolderDetected = data.jdbcDriverPath;
      const jdbcInput = document.getElementById('f-jdbc-folder');
      if (jdbcInput) jdbcInput.placeholder = jdbcDriverFolderDetected;
    }
    if (data && data.mappingsPath){
      mappingsFolderDetected = data.mappingsPath;
      const mInput = document.getElementById('f-mappings-folder');
      if (mInput) mInput.placeholder = mappingsFolderDetected;
    }
    if (data && data.metadataRdbmsPath){
      rdbmsFolderDetected = data.metadataRdbmsPath;
      const rInput = document.getElementById('f-rdbms-folder');
      if (rInput) rInput.placeholder = rdbmsFolderDetected;
    }
  } catch(_){ /* local server not running — placeholders stay as-is */ }
}
