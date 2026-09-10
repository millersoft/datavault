/* =========================================================================
   LOCAL INTROSPECTION SERVER — built-in PostgreSQL/MySQL + Database Packs
   ========================================================================= */
// Studio's privileged companion API is same-origin only. Opening index.html
// directly as file:// is intentionally unsupported because opaque/null origins
// would weaken the API's browser security boundary.
let localServerUrl = /^https?:$/.test(location.protocol) ? location.origin : '';
const dvsApiToken = document.querySelector('meta[name="dvs-api-token"]')?.content || '';
let dvsApiRestartWarningShown = false;
// Single choke-point for every companion-server call — all former
// fetch(`${localServerUrl}/api/...`) call sites route through here.
async function localFetch(path, opts = {}){
  if (!localServerUrl || !dvsApiToken || dvsApiToken === '__DVS_API_TOKEN__') {
    throw new Error('Data Vault Studio must be opened through its local server. Run npm start and open http://127.0.0.1:8420/.');
  }
  const headers = new Headers(opts.headers || {});
  headers.set('X-DVS-Token', dvsApiToken);
  const response = await fetch(`${localServerUrl}${path}`, { ...opts, headers });
  if (response.status === 401 && !dvsApiRestartWarningShown){
    dvsApiRestartWarningShown = true;
    toast('The Data Vault Studio server was restarted. Refresh this page to reconnect.', 'err');
  }
  return response;
}
let deployStartNum = 4;
let jdbcDriverFolder = '';
let jdbcDriverDefaultFolder = 'jdbc-drivers';
let jdbcDriverDeployStatus = null; // null | 'loading' | 'ok' | 'error'

async function detectDbInitPath(){
  const jdbcInput = document.getElementById('f-jdbc-folder');
  if (jdbcInput) jdbcInput.placeholder = jdbcDriverDefaultFolder;
}
