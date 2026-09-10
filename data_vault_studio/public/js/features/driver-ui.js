/* =========================================================================
   STEP 1 — CONNECTIONS
   ========================================================================= */
// The bundled MySQL/PostgreSQL Database Packs use the same local JDBC bridge
// as every other Pack, so their JDBC jars live in project-root jdbc-drivers/.
// The same folder is mounted into Hop and the internal PostgreSQL FDW image.
function jdbcDriverSectionHtml(v){
  const spec=jdbcDriverSpec(v.dialect);
  if(!spec) return '';
  return `
      <div class="panel-head" style="margin:16px -14px 0;"><h3>${escapeHtml(spec.label)} <span class="badge-count">&nbsp;·&nbsp;required for this source</span></h3></div>
      <p class="hint mt">This JDBC driver must be present in <span class="mono">jdbc-drivers/</span> for Studio connection tests and the Hop runtime.</p>
      <div class="grid cols-2 mt">
        <a class="btn" href="${escapeHtml(spec.url)}" download>⬇ Download ${escapeHtml(spec.label)} ${escapeHtml(spec.version)}</a>
        <a class="btn ghost" href="${escapeHtml(spec.otherUrl)}" target="_blank" rel="noopener">Other versions ↗</a>
      </div>
      <div class="field mt">
        <label>Target folder <span class="hint">(project default — override only if this project's layout differs)</span></label>
        <input type="text" id="f-jdbc-folder" value="${jdbcDriverFolder}" placeholder="${jdbcDriverDefaultFolder}">
      </div>
      <button class="btn primary mt" id="btn-deploy-jdbc-driver">${jdbcDriverDeployStatus==='loading'?'Fetching & deploying…':'⬆ Fetch and deploy driver to jdbc-drivers/'}</button>
      <div id="jdbc-driver-deploy-status"></div>
      <div id="jdbc-driver-status"></div>
  `;
}
function mysqlJdbcDriverSectionHtml(v){ return jdbcDriverSectionHtml(v); }
async function checkJdbcDrivers(){
  const resp = await localFetch(`/api/driver-status`);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Could not check jdbc-drivers/.');
  return data;
}
async function checkMysqlDriver(){ return checkJdbcDrivers(); }
async function refreshJdbcDriverStatus(){
  const el = document.getElementById('jdbc-driver-status');
  if (!el) return;
  const dialect=state.vault.dialect;
  const spec=jdbcDriverSpec(dialect);
  if(!spec){ el.innerHTML=''; return; }
  try {
    const data = await checkJdbcDrivers();
    const found=data[spec.statusField];
    if (found && state.externalTables.enabled && state.externalTables.remoteDialect===dialect){
      const detected=`/opt/jdbc-drivers/${found}`;
      if (!state.externalTables.jarfile || state.externalTables.jarfile.endsWith(spec.filename)) state.externalTables.jarfile=detected;
    }
    el.innerHTML = found
      ? `<div class="ai-status ok mt">Driver found: <span class="mono">&nbsp;${escapeHtml(found)}</span>&nbsp; in jdbc-drivers/.</div>`
      : `<div class="ai-status err mt">No ${escapeHtml(spec.label)} jar in <span class="mono">&nbsp;jdbc-drivers/</span>&nbsp; yet — required before the engine can read this source.</div>`;
  } catch(err){
    el.innerHTML = `<div class="ai-status err mt">Could not check jdbc-drivers/: ${escapeHtml(err.message)}</div>`;
  }
}

let targetJdbcDriverStatus = null;
let targetJdbcDriverMessage = '';
function targetJdbcDriverCheckRequired(){
  const ext=state.externalTables;
  return !!(ext.enabled && ext.remoteDialect && ext.remoteDialect!=='postgresql' && ext.remoteDialect!==state.vault.dialect);
}
function targetJdbcDriverSectionHtml(){
  const ext=state.externalTables;
  if(!targetJdbcDriverCheckRequired()) return '';
  const spec=jdbcDriverSpec(ext.remoteDialect);
  const fetch = spec && spec.url ? `<button class="btn" id="btn-deploy-target-jdbc-driver">Fetch ${escapeHtml(spec.label)}</button>` : '';
  const status = targetJdbcDriverStatus==='loading'
    ? `<div class="ai-status busy mt"><span class="dot"></span>Checking ${escapeHtml(ext.jarfile||'the configured target driver')}…</div>`
    : targetJdbcDriverStatus==='ok'
      ? `<div class="ai-status ok mt">${escapeHtml(targetJdbcDriverMessage)}</div>`
      : targetJdbcDriverStatus==='error'
        ? `<div class="ai-status err mt">${escapeHtml(targetJdbcDriverMessage)}</div>` : '';
  return `
    <div class="panel" style="margin:16px 0 0;padding:14px;box-shadow:none;">
      <div class="flex-between" style="gap:12px;align-items:flex-start;">
        <div>
          <label class="mb0">Target JDBC driver</label>
          <p class="hint mb0">The source uses ${escapeHtml((DIALECTS[state.vault.dialect]||{}).label||state.vault.dialect)}, while the physical target uses ${escapeHtml((DIALECTS[ext.remoteDialect]||{}).label||ext.remoteDialect)}. Check the separate target driver mounted into the PostgreSQL FDW container.</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
          ${fetch}
          <button class="btn primary" id="btn-check-target-jdbc-driver">Check target driver</button>
        </div>
      </div>
      ${status}
    </div>`;
}
async function refreshTargetJdbcDriverStatus(){
  if(!targetJdbcDriverCheckRequired()){
    targetJdbcDriverStatus=null; targetJdbcDriverMessage=''; return;
  }
  targetJdbcDriverStatus='loading';
  const statusWrap=document.getElementById('target-jdbc-driver-wrap');
  if(statusWrap) statusWrap.innerHTML=targetJdbcDriverSectionHtml();
  try{
    const data=await localFetch('/api/driver-path-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jarfile:state.externalTables.jarfile})}).then(r=>r.json());
    if(!data.ok) throw new Error(data.error||'Could not check the target driver.');
    if(!data.exists) throw new Error(`${data.filename||state.externalTables.jarfile||'Configured jar'} was not found in jdbc-drivers/.`);
    targetJdbcDriverStatus='ok';
    targetJdbcDriverMessage=`${data.filename} is present in jdbc-drivers/ and available to the packaged PostgreSQL FDW container.`;
  }catch(err){
    targetJdbcDriverStatus='error'; targetJdbcDriverMessage=err.message;
  }
  if(activeTab==='connections'){
    const wrap=document.getElementById('target-jdbc-driver-wrap');
    if(wrap){ wrap.innerHTML=targetJdbcDriverSectionHtml(); wireTargetJdbcDriverActions(wrap); }
  }
}
function wireTargetJdbcDriverActions(root=document){
  const check=root.querySelector ? root.querySelector('#btn-check-target-jdbc-driver') : null;
  if(check) check.addEventListener('click',refreshTargetJdbcDriverStatus);
  const fetchBtn=root.querySelector ? root.querySelector('#btn-deploy-target-jdbc-driver') : null;
  if(fetchBtn) fetchBtn.addEventListener('click',()=>deployJdbcDriver('target'));
}

function databaseTypeIdFromLabel(label){
  return String(label||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64);
}
const DATABASE_TYPE_WIZARD_GENERIC='__generic__';
const DATABASE_TYPE_WIZARD_PACK_DEFAULTS={
  // SQL Server is a Database Pack. Prefer Hop's Microsoft JDBC connection
  // type for the bundled/reference Pack; keep the old jTDS plugin selectable
  // but label it explicitly as legacy in the authoring UI.
  MSSQL:{
    id:'sqlserver',label:'SQL Server',
    hop:{attributes:{
      'EXTRA_OPTION_MSSQL.encrypt':'true',
      'EXTRA_OPTION_MSSQL.trustServerCertificate':'true'
    }}
  },
  MSSQLNATIVE:{
    id:'sqlserver',label:'SQL Server',
    hop:{attributes:{
      'EXTRA_OPTION_MSSQLNATIVE.encrypt':'true',
      'EXTRA_OPTION_MSSQLNATIVE.trustServerCertificate':'true'
    }}
  }
};
