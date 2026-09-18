/* =========================================================================
   DASHBOARD — separate from the Designer wizard entirely. Reads real run
   history from the pdi_meta schema's own instrumentation tables
   (inst_runs, inst_run_dv_jobs, inst_run_stg_jobs, ref_runtypes,
   ref_statuses) via the read-only /api/query endpoint. Never writes
   anything.
   ========================================================================= */
let dashboardConn = { host:'localhost', port:'5432', database:'', user:'', password:'' };
let schedulerStatus = { enabled:false, intervalMinutes:60, nextRunAt:null, lastRunAt:null, log:[] };
let schedulerBusy = false;
let schedulerPollHandle = null;
let engineActionBusy = false;
let dashboardStatus = null; // null | 'loading' | 'ok' | 'error'
let dashboardError = '';
let dashboardRuns = [];
let dashboardObjectErrors = [];
let dashboardRowsLoaded = { staging: 0, vault: 0 };
let dashboardSelectedRun = null;
let dashboardDvJobs = [];
let dashboardStgJobs = [];
let dashboardDetailStatus = null;
let dashboardIncrementalState = { status:null, error:'', checkedAt:null, newlyReady:0 };
let dashboardIncrementalOpen = false; // collapsed by default; preserve the user's choice while the Hub rerenders
let dashboardAutoLoadKey = '';
let dashboardAutoLoadScheduled = false;
let dashboardVerification = {
  status: null, // null | loading | empty | complete | error
  headline: '',
  runSucceeded: false,
  findings: [],
  error: '',
};

function dashboardTruthy(value){
  const text=String(value==null?'':value).trim().toLowerCase();
  return value===true || value===1 || ['1','true','t','yes','y'].includes(text);
}

function normalizedDashboardTableName(name){
  // pdi_meta from different engine/database versions can record a source as
  // table, schema.table, "schema"."table", [schema].[table], or `schema`.`table`.
  // Incremental readiness is about the source object, so compare its final
  // identifier case-insensitively instead of requiring the stored spelling to
  // be identical to the Designer table name.
  const raw=String(name||'').trim();
  if (!raw) return '';
  const parts=raw.split('.');
  return String(parts[parts.length-1]||'')
    .trim()
    .replace(/^[`"\[]+/, '')
    .replace(/[`"\]]+$/, '')
    .trim()
    .toLowerCase();
}

function dashboardSourceTableMatches(recordedName, tableName){
  const recorded=normalizedDashboardTableName(recordedName);
  const table=normalizedDashboardTableName(tableName);
  return !!recorded && !!table && recorded===table;
}

function dashboardRunHasVaultWork(row){
  return dashboardTruthy(row && row.has_dv_jobs) || String(row && row.run_type || '').toLowerCase()==='data vault';
}

function dashboardRunHasStagingWork(row){
  const type=String(row && row.run_type || '').trim().toLowerCase();
  return dashboardTruthy(row && row.has_stg_jobs) || type==='staging';
}

function dashboardStagingJobMatchesTable(row, table){
  if (!row || !table) return false;
  if (dashboardSourceTableMatches(row.source_table_name, table.name)) return true;
  // Some engine versions record a blank/qualified source name but always keep
  // the generated staging target. Accept both the physical staging table and
  // its writable view as table-specific evidence of a successful source run.
  const target=normalizedDashboardTableName(row.target_table_name);
  if (!target) return false;
  return [stagingTableName(table), stagingViewName(table)]
    .map(normalizedDashboardTableName)
    .includes(target);
}

function dashboardConnectionKey(){
  return [dashboardConn.host||'', dashboardConn.port||'', dashboardConn.database||'', dashboardConn.user||''].join('|');
}

function scheduleDashboardAutoLoad(){
  const key=dashboardConnectionKey();
  if (!dashboardConn.database || !key || dashboardAutoLoadScheduled || dashboardStatus==='loading' || dashboardAutoLoadKey===key) return;
  dashboardAutoLoadScheduled=true;
  setTimeout(()=>{
    dashboardAutoLoadScheduled=false;
    if (appMode!=='dashboard' || !dashboardConn.database) return;
    const currentKey=dashboardConnectionKey();
    if (!currentKey || dashboardAutoLoadKey===currentKey) return;
    dashboardAutoLoadKey=currentKey;
    loadDashboardMetrics();
  }, 0);
}

function incrementalStatusLabel(table){
  if (!incrementalConfigured(table)) return 'Not configured';
  const pending = !!(table.incrementalConfigPending || table.incrementalDeploymentPending);
  if (incrementalActive(table)) return pending ? 'Enabled · deploy required' : 'Enabled';
  return pending ? 'Disabled · deploy required' : 'Disabled';
}

function incrementalStatusTag(table){
  const label = incrementalStatusLabel(table);
  const color = label.startsWith('Enabled') ? 'var(--ok)' : label.includes('deploy required') ? 'var(--hub)' : 'var(--muted-2)';
  return `<span class="tag" style="border-color:${color};color:${color};text-transform:none;">${label}</span>`;
}

function dashboardIncrementalColumnSelect(table){
  const candidates = incrementalColumnOptions(table);
  const configuredCol = String(table.incrementCol||'');
  const configuredExists = candidates.some(c=>c.name===configuredCol);
  return `<select data-dashboard-increment-col="${table.id}" aria-label="Incremental column for ${escapeHtml(table.name)}">
    <option value="">Not configured</option>
    ${configuredCol && !configuredExists ? `<option value="${escapeHtml(configuredCol)}" selected disabled>${escapeHtml(configuredCol)} (unsupported or not staged)</option>` : ''}
    ${candidates.map(c=>`<option value="${escapeHtml(c.name)}" ${c.name===configuredCol?'selected':''}>${escapeHtml(c.name)} · ${escapeHtml(incrementalColumnTypeLabel(c))}</option>`).join('')}
  </select>`;
}

function dashboardIncrementalToggle(table){
  const configured = incrementalConfigured(table);
  const checked = incrementalActive(table);
  return `<label class="theme-switch" style="gap:9px;${configured?'':'opacity:.55;'}" title="${configured?'Use incremental loading for this table':'Choose an incremental column first'}">
    <input type="checkbox" data-inc-toggle="${table.id}" ${checked?'checked':''} ${configured?'':'disabled'} aria-label="Incremental loading for ${escapeHtml(table.name)}">
    <span class="theme-switch-track"><span class="theme-switch-thumb"></span></span>
    <span class="mono" style="min-width:28px;">${checked?'On':'Off'}</span>
  </label>`;
}

function dashboardIncrementalHtml(){
  const tables = includedTables();
  const configured = tables.filter(incrementalConfigured);
  const enabled = configured.filter(incrementalActive);
  const disabled = configured.filter(t=>!incrementalActive(t));
  return `
    <details class="panel" id="incremental-loads-panel" ${dashboardIncrementalOpen?'open':''}>
      <summary class="panel-head" style="margin:-18px -20px ${dashboardIncrementalOpen?'16px':'-18px'};cursor:pointer;list-style:none;padding:14px 20px;">
        <h3>Incremental Loads <span class="badge-count">&nbsp;·&nbsp;${enabled.length} enabled · ${disabled.length} disabled · ${tables.length-configured.length} not configured${state.vault.incrementalSettingsDeploymentPending?' · settings deploy required':''}</span></h3>
        <span class="hint" style="margin-left:auto;">${dashboardIncrementalOpen?'Collapse':'Expand'} ▾</span>
      </summary>
      <p class="hint">Choose a timestamp/datetime <b>Incremental column</b> on Tables or adjust it here. The toggle directly controls whether the generated spreadsheet writes <span class="mono">ind_staging_is_incremental = 1</span>.</p>
      <div class="panel mt" style="margin-bottom:10px;padding:14px 16px;">
        <div class="flex-between" style="gap:16px;align-items:flex-end;flex-wrap:wrap;">
          <div class="field mb0" style="min-width:220px;max-width:320px;">
            <label>Incremental days to load <span class="hint">(all source tables)</span></label>
            <input type="number" id="f-incremental-days-to-load" min="0" step="1" value="${incrementalDaysToLoadDefault()}">
          </div>
          <div style="flex:1;min-width:280px;">
            <p class="hint mb0">Universal source-system setting written to <span class="mono">source_systems.staging_days_to_load_default</span>. It is deployed with this section's metadata spreadsheet.</p>
          </div>
          ${state.vault.incrementalSettingsDeploymentPending ? '<span class="tag" style="border-color:var(--hub);color:var(--hub);text-transform:none;">Deploy required</span>' : ''}
        </div>
      </div>
      <div class="flex-between mt" style="gap:10px;flex-wrap:wrap;">
        <div class="hint mb0">Enable incremental loading for any table with a supported Incremental column configured.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn" id="btn-enable-all-incremental" ${configured.length?'':'disabled'}>Enable all</button>
          <button class="btn primary" id="btn-deploy-incremental">Save &amp; deploy settings</button>
        </div>
      </div>
      ${tables.length ? `
      <div style="overflow:auto;margin-top:14px;">
        <table class="data">
          <tr><th>Source table</th><th style="min-width:300px;">Incremental column</th><th>Status</th><th style="width:120px;">Use incremental</th></tr>
          ${tables.map(t=>`<tr>
              <td class="mono">${escapeHtml(t.name)}</td>
              <td>${dashboardIncrementalColumnSelect(t)}</td>
              <td>${incrementalStatusTag(t)}</td>
              <td>${dashboardIncrementalToggle(t)}</td>
            </tr>`).join('')}
        </table>
      </div>` : `<div class="empty mt">No included source tables are available yet.</div>`}
      <p class="hint mt mb0">Changes to the column, toggle, or days value are metadata changes. Use <b>Save &amp; deploy settings</b> to write the complete spreadsheet before a scheduled run; a normal manual engine start also redeploys the current workbook first.</p>
    </details>`;
}

async function enableIncrementalTable(table){
  if (!table || !incrementalConfigured(table)) return false;
  table.incremental = true;
  table.incrementalDeploymentPending = true;
  return true;
}

function enableAllConfiguredIncrementalTables(){
  const candidates = includedTables().filter(t=>incrementalConfigured(t) && !incrementalActive(t));
  candidates.forEach(t=>{
    t.incremental = true;
    t.incrementalDeploymentPending = true;
  });
  return candidates.length;
}

// Backward-compatible helper name retained for older tests/extensions. Readiness
// is no longer a prerequisite; all configured tables are eligible.
function enableAllReadyIncrementalTables(){
  return enableAllConfiguredIncrementalTables();
}

function bindDashboardIncrementalControls(){
  if (!FEATURE_INCREMENTAL) return;
  const panel = document.getElementById('incremental-loads-panel');
  if (panel) panel.addEventListener('toggle', ()=>{ dashboardIncrementalOpen = panel.open; });

  const daysInput = document.getElementById('f-incremental-days-to-load');
  if (daysInput) daysInput.addEventListener('change', ()=>{
    const text = String(daysInput.value||'').trim();
    const raw = Number(text);
    if (!text || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)){
      daysInput.value = String(incrementalDaysToLoadDefault());
      toast('Incremental days to load must be zero or a positive whole number.', 'err');
      return;
    }
    const next = raw;
    daysInput.value = String(next);
    if (configureIncrementalDaysToLoad(next)){
      if (typeof scheduleAutosave === 'function') scheduleAutosave();
      toast(`Incremental days to load set to ${next}. Deploy settings to update the metadata spreadsheet.`, 'ok');
      renderAll();
    }
  });

  document.querySelectorAll('[data-dashboard-increment-col]').forEach(select=>{
    select.addEventListener('change', ()=>{
      const table = findTable(select.dataset.dashboardIncrementCol);
      if (!table) return;
      const wasActive = table.incremental===true;
      const changed = configureIncrementalColumn(table, select.value);
      if (!changed) return;
      // configureIncrementalColumn preserves activation when switching between
      // supported columns and turns it off when the configuration is cleared.
      table.incrementalDeploymentPending = true;
      if (typeof scheduleAutosave === 'function') scheduleAutosave();
      toast(select.value
        ? `${table.name}: Incremental column changed to ${select.value}${wasActive?' and incremental remains enabled':''}. Deploy settings to apply it.`
        : `${table.name}: Incremental column cleared and incremental loading disabled.`, 'ok');
      renderAll();
    });
  });

  document.querySelectorAll('[data-inc-toggle]').forEach(input=>{
    input.addEventListener('change', ()=>{
      const table = findTable(input.dataset.incToggle);
      if (!table || !incrementalConfigured(table)) return;
      table.incremental = !!input.checked;
      table.incrementalDeploymentPending = true;
      if (typeof scheduleAutosave === 'function') scheduleAutosave();
      toast(`${table.name}: incremental loading ${table.incremental?'enabled':'disabled'}. Deploy settings to apply the change.`, 'ok');
      renderAll();
    });
  });

  const enableAll = document.getElementById('btn-enable-all-incremental');
  if (enableAll) enableAll.addEventListener('click', ()=>{
    const enabledCount = enableAllConfiguredIncrementalTables();
    if (enabledCount){
      if (typeof scheduleAutosave === 'function') scheduleAutosave();
      toast(`Enabled incremental loading for ${enabledCount} configured table(s). Deploy settings to apply the changes.`, 'ok');
    } else {
      toast('All configured tables are already enabled. Tables without an Incremental column were left unchanged.', 'ok');
    }
    renderAll();
  });

  const deploy = document.getElementById('btn-deploy-incremental');
  if (deploy) deploy.addEventListener('click', async ()=>{
    deploy.disabled = true;
    try {
      const result = await deployMappingWorkbook({ silent:false });
      if (result){
        toast('Incremental settings deployed to the engine workbook.', 'ok');
        renderAll();
      }
    } finally {
      const current = document.getElementById('btn-deploy-incremental');
      if (current) current.disabled = false;
    }
  });
}

async function refreshIncrementalReadiness(options = {}){
  const configured = includedTables().filter(incrementalConfigured);
  if (!configured.length){
    dashboardIncrementalState = { status:'complete', error:'', checkedAt:new Date().toISOString(), newlyReady:0 };
    if (options.rerender!==false && appMode==='dashboard') renderAll();
    return 0;
  }
  if (!dashboardConn.database){
    dashboardIncrementalState = { status:'error', error:'Enter the Data Vault database connection above before checking previous staging history.', checkedAt:null, newlyReady:0 };
    if (options.rerender!==false && appMode==='dashboard') renderAll();
    return 0;
  }
  dashboardIncrementalState = { status:'loading', error:'', checkedAt:dashboardIncrementalState.checkedAt, newlyReady:0 };
  if (options.rerender!==false && appMode==='dashboard') renderAll();
  try {
    let rows;
    let hasPerTableStagingHistory = true;
    try {
      // Use the same staging-job records shown in Run Detail. They are only
      // informational here; no status/date/readiness rule can block activation.
      rows = await dashQuery(`
        SELECT j.id_run, r.date_start, r.date_end,
               j.source_table_name, j.target_table_name, j.num_records_loaded,
               TRUE AS has_stg_jobs
        FROM pdi_meta.inst_run_stg_jobs j
        LEFT JOIN pdi_meta.inst_runs r ON r.id_run = j.id_run
        ORDER BY j.id_run DESC
        LIMIT 10000
      `);
    } catch(jobHistoryError){
      hasPerTableStagingHistory = false;
      rows = await dashQuery(`
        SELECT r.id_run, rt.description AS run_type, r.date_start, r.date_end,
               NULL AS source_table_name, NULL AS target_table_name,
               CASE WHEN LOWER(rt.description) = 'staging' THEN TRUE ELSE FALSE END AS has_stg_jobs
        FROM pdi_meta.inst_runs r
        LEFT JOIN pdi_meta.ref_runtypes rt ON rt.id_rtyp = r.id_rtyp
        WHERE LOWER(rt.description) = 'staging'
        ORDER BY r.id_run DESC
        LIMIT 5000
      `);
    }
    let discovered = 0;
    configured.forEach(table=>{
      let qualifyingRun = null;
      if (hasPerTableStagingHistory){
        qualifyingRun = rows.find(row=>dashboardStagingJobMatchesTable(row, table));
      } else {
        qualifyingRun = rows.find(row=>dashboardRunHasStagingWork(row));
      }
      if (qualifyingRun && markIncrementalReady(table, qualifyingRun)) discovered++;
    });
    if (discovered && typeof scheduleAutosave === 'function') scheduleAutosave();
    dashboardIncrementalState = { status:'complete', error:'', checkedAt:new Date().toISOString(), newlyReady:discovered };
    if (!options.silent) toast('Previous staging history refreshed.', 'ok');
    if (options.rerender!==false && appMode==='dashboard') renderAll();
    return discovered;
  } catch(err){
    dashboardIncrementalState = { status:'error', error:err.message, checkedAt:null, newlyReady:0 };
    if (!options.silent) toast(`Could not check previous staging history: ${err.message}`, 'err');
    if (options.rerender!==false && appMode==='dashboard') renderAll();
    return 0;
  }
}

function dashboardVerificationHtml(){
  if (dashboardVerification.status === 'loading'){
    return `<div class="ai-status busy mt"><span class="dot"></span>Verifying the latest load…</div>`;
  }
  if (dashboardVerification.status === 'empty'){
    return `<div class="empty mt">No runs recorded in pdi_meta.inst_runs yet.</div>`;
  }
  if (dashboardVerification.status === 'error'){
    return `<div class="ai-status err mt">${escapeHtml(dashboardVerification.error)}</div>`;
  }
  if (dashboardVerification.status !== 'complete') return '';
  return `
    <div class="ai-status ${dashboardVerification.runSucceeded ? 'ok':'err'} mt">${escapeHtml(dashboardVerification.headline)}</div>
    ${dashboardVerification.findings.length===0
      ? `<div class="ai-status ok mt">All checks passed — no zero-row loads, no object errors, no rows in _err tables.</div>`
      : dashboardVerification.findings.map(f=>`<div class="ai-status ${f.kind==='err'?'err':'busy'} mt" style="align-items:flex-start;"><span>${escapeHtml(f.text)}</span></div>`).join('')}
  `;
}

function updateDashboardVerificationUi(){
  const results = document.getElementById('verify-results');
  if (results) results.innerHTML = dashboardVerificationHtml();
  const button = document.getElementById('btn-verify-load');
  if (button){
    const loading = dashboardVerification.status === 'loading';
    button.disabled = loading;
    button.textContent = loading ? 'Verifying…' : 'Verify latest load';
  }
}

function renderDashboard(el){
  // Convenience: borrow the target connection from the Designer if one's
  // already been entered there, but this stays independently editable —
  // the dashboard works on its own.
  if (demoTargetActive() && state.vault.dvDatabase){
    dashboardConn = {credentialRef:'internal-postgres-target',host:'localhost',port:'5433',database:state.vault.dvDatabase,user:'',password:''};
  } else if (!dashboardConn.database && state.vault.dvDatabase){
    dashboardConn = {host:state.vault.dvHost||'localhost',port:state.vault.dvPort||'5432',database:state.vault.dvDatabase,user:state.vault.dvUser||'',password:state.vault.dvPassword||''};
  }
  el.innerHTML = `
    <h2 class="section-title">Data Vault Hub</h2>
    <p class="section-desc">Run history, load metrics, and engine controls for a deployed vault.</p>

    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Connection</h3></div>
      <div class="grid cols-4">
        <div class="field"><label>Host</label><input type="text" id="dash-host" value="${dashboardConn.host}"></div>
        <div class="field"><label>Port</label><input type="text" id="dash-port" value="${dashboardConn.port}"></div>
        <div class="field"><label>Database</label><input type="text" id="dash-database" value="${dashboardConn.database}"></div>
        <div class="field"><label>Username</label><input type="text" id="dash-user" value="${dashboardConn.user}"></div>
      </div>
      <div class="grid cols-2 mt">
        <div class="field"><label>Password</label><input type="password" id="dash-password" value="${dashboardConn.password}"></div>
        <div style="display:flex;align-items:flex-end;"><button class="btn primary" id="btn-dash-load">${dashboardStatus==='loading'?'Loading…':'⟳ Load metrics'}</button></div>
      </div>
      <div id="dash-conn-status"></div>
    </div>

    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Engine <span class="badge-count">&nbsp;·&nbsp;run mode: ${engineModeLabel()}</span></h3></div>
      <p class="hint">The source and target databases must be reachable first — external servers or local containers.</p>
      ${engineModeInvalid() ? `<div class="ai-status err mt">The demo source only runs with the internal Postgres target — fix the Connections step before starting.</div>` : ''}
      ${externalLocalhostWarningHtml()}
      ${engineMode()==='external' ? `
      <p class="hint mt">First run against this external PostgreSQL database? Select <b>Set up metadata</b> under Export → Deployment status first.</p>` : ''}
      <div class="grid cols-2 mt" style="align-items:start;">
        <div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn primary" id="btn-docker-runhop" ${engineActionBusy?'disabled':''}>Start data vault engine</button>
            <button class="btn danger" id="btn-docker-stophop" ${engineActionBusy?'disabled':''}>Stop data vault engine</button>
          </div>
          <div id="docker-runhop-status"></div>
          <div id="run-watch-status">${runWatchStatusHtml()}</div>
        </div>
        <div>
          <button class="btn ghost" id="btn-engine-logs">▤ View engine logs</button>
          <div id="engine-logs-wrap">${engineLogsHtml()}</div>
        </div>
      </div>
      <div class="panel-head" style="margin:16px -20px 16px;"><h3>Post-run verification</h3></div>
      <p class="hint">Checks the latest run for zero-row loads, object errors, and rows in <span class="mono">_err</span> tables. Uses the connection above.</p>
      <button class="btn primary mt" id="btn-verify-load" ${dashboardVerification.status==='loading'?'disabled':''}>${dashboardVerification.status==='loading'?'Verifying…':'Verify latest load'}</button>
      <div id="verify-results">${dashboardVerificationHtml()}</div>
    </div>

    ${FEATURE_INCREMENTAL ? dashboardIncrementalHtml() : ''}

    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Scheduler</h3></div>
      <p class="hint">Starts the engine on a repeating interval while the local server (<span class="mono">npm start</span>) is running. Not tied to this tab; settings survive a server restart.</p>
      <div class="grid cols-3 mt" style="align-items:end;">
        <label class="theme-switch" style="gap:10px;">
          <span class="hint mb0" style="font-size:12px;">${schedulerStatus.enabled?'Enabled':'Disabled'}</span>
          <input type="checkbox" id="scheduler-enabled-toggle" ${schedulerStatus.enabled?'checked':''}>
          <span class="theme-switch-track"><span class="theme-switch-thumb"></span></span>
        </label>
        <div class="field">
          <label>Every</label>
          <select id="scheduler-interval">
            ${[15,30,60,180,360,720,1440].map(m=>`<option value="${m}" ${Number(schedulerStatus.intervalMinutes)===m?'selected':''}>${m<60?m+' minutes':(m/60)+' hour'+(m>60?'s':'')}</option>`).join('')}
          </select>
        </div>
        <button class="btn ghost" id="btn-scheduler-runnow">${schedulerBusy?'Running…':'Run now'}</button>
      </div>
      <p class="hint mt">
        ${schedulerStatus.enabled && schedulerStatus.nextRunAt ? `Next run: ${new Date(schedulerStatus.nextRunAt).toLocaleString()} (${timeUntil(schedulerStatus.nextRunAt)})` : 'Scheduling is off — enable above to start a recurring run.'}
        ${schedulerStatus.enabled && schedulerStatus.mode ? ` · mode: ${schedulerStatus.mode}` : ''}
        ${schedulerStatus.lastRunAt ? ` · Last run: ${timeAgo(schedulerStatus.lastRunAt)}` : ''}
      </p>
      ${schedulerStatus.log && schedulerStatus.log.length ? `
      <table class="data mt">
        <tr><th>When</th><th>Trigger</th><th>Result</th></tr>
        ${schedulerStatus.log.map(l=>`
          <tr>
            <td class="mono">${new Date(l.at).toLocaleString()}</td>
            <td>${l.reason==='manual'?'Manual':'Scheduled'}</td>
            <td>${(()=>{
              const label=l.skipped?'Skipped':(l.ok?'Success':'Failed');
              const color=l.skipped?'var(--muted)':(l.ok?'var(--ok)':'var(--err)');
              const detail=l.error||l.message||'';
              return `<span class="tag" style="border-color:${color};color:${color};">${label}</span>${detail?` <span class="hint">${escapeHtml(detail)}</span>`:''}`;
            })()}</td>
          </tr>`).join('')}
      </table>` : ''}
    </div>

    <div id="dash-results"></div>
  `;
  document.getElementById('btn-docker-runhop').addEventListener('click', dockerRunHop);
  document.getElementById('btn-docker-stophop').addEventListener('click', dockerStopHop);
  document.getElementById('btn-engine-logs').addEventListener('click', loadEngineLogs);
  bindEngineLogsRefresh();
  pinEngineLogsToBottom();

  document.getElementById('btn-verify-load').addEventListener('click', verifyLatestLoad);
  const bindDash = (id, key) => document.getElementById(id).addEventListener('input', e=> dashboardConn[key]=e.target.value);
  bindDash('dash-host','host'); bindDash('dash-port','port'); bindDash('dash-database','database');
  bindDash('dash-user','user'); bindDash('dash-password','password');
  document.getElementById('btn-dash-load').addEventListener('click', loadDashboardMetrics);
  bindDashboardIncrementalControls();
  document.getElementById('scheduler-enabled-toggle').addEventListener('change', e=> setSchedulerConfig(
    e.target.checked ? { enabled: true, mode: engineMode() } : { enabled: false }));
  document.getElementById('scheduler-interval').addEventListener('change', e=> setSchedulerConfig({ intervalMinutes: Number(e.target.value) }));
  document.getElementById('btn-scheduler-runnow').addEventListener('click', runSchedulerNowFromHub);
  startSchedulerPolling();

  if (dashboardStatus==='error'){
    document.getElementById('dash-conn-status').innerHTML = `<div class="ai-status err mt">${escapeHtml(dashboardError)}</div>`;
  }
  if (dashboardStatus==='loading'){
    document.getElementById('dash-results').innerHTML = `<div class="ai-status busy mt"><span class="dot"></span>Loading existing run history and metrics…</div>`;
  } else if (dashboardStatus==='ok'){
    renderDashboardResults(document.getElementById('dash-results'));
  }
  scheduleDashboardAutoLoad();
}

async function loadSchedulerStatus(){
  try {
    const resp = await localFetch(`/api/scheduler/status`);
    const data = await resp.json();
    if (data && data.ok) schedulerStatus = data;
  } catch(_) { /* local server not reachable — leave last-known status showing rather than erroring the whole Hub */ }
  if (appMode==='dashboard') renderAll();
}
function startSchedulerPolling(){
  if (schedulerPollHandle) return; // already polling
  loadSchedulerStatus();
  schedulerPollHandle = setInterval(loadSchedulerStatus, 10000);
}
function stopSchedulerPolling(){
  if (schedulerPollHandle){ clearInterval(schedulerPollHandle); schedulerPollHandle = null; }
}
async function setSchedulerConfig(patch){
  try {
    const resp = await localFetch(`/api/scheduler/config`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(patch),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Could not update the schedule.');
    schedulerStatus = data;
    toast(patch.enabled!=null ? (patch.enabled?'Scheduler enabled.':'Scheduler disabled.') : 'Interval updated.', 'ok');
  } catch(err){
    toast('Could not update the schedule: ' + err.message, 'err');
  }
  renderAll();
}
async function runSchedulerNowFromHub(){
  schedulerBusy = true;
  renderAll();
  try {
    const resp = await localFetch(`/api/scheduler/run-now`, { method:'POST' });
    const data = await resp.json();
    schedulerStatus = data;
    if (data.result && data.result.skipped){
      toast(data.result.message || 'Run skipped because another ETL is already active.', data.result.ok ? 'ok' : 'err');
    } else {
      toast(data.result && data.result.ok ? 'Engine started.' : `Run failed: ${(data.result && data.result.error) || 'see log below'}`, data.result && data.result.ok ? 'ok' : 'err');
    }
  } catch(err){
    toast('Could not reach the local server: ' + err.message, 'err');
  }
  schedulerBusy = false;
  renderAll();
}

async function dashQuery(sql){
  const packagedInternal=demoTargetActive();
  const database=dashboardConn.database||state.vault.dvDatabase;
  const restoredExternal=!packagedInternal&&!dashboardConn.password&&!state.vault.dvPassword;
  const payload=packagedInternal
    ? {credentialRef:'internal-postgres-target',database,sql}
    : restoredExternal
      ? {credentialRef:'external-postgres-target',host:dashboardConn.host||state.vault.dvHost,port:dashboardConn.port||state.vault.dvPort,database,dialect:'postgresql',sql}
      : (dashboardConn.credentialRef?{credentialRef:dashboardConn.credentialRef,database,sql}:{...dashboardConn,sql});
  const resp = await localFetch(`/api/query`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Query failed.');
  return data.rows;
}

function pauseRunWatchForUserStop(){
  const wasArmed = !!(runWatch && runWatch.handle);
  const previous = runWatch ? { ...runWatch, handle:null } : null;
  if (runWatch && runWatch.handle) clearInterval(runWatch.handle);
  runWatch = {
    ...(previous || { baselineMaxId:0, tries:0 }),
    handle:null,
    message:'Stopping engine at your request…',
    kind:'busy',
  };
  updateRunWatchUi();
  return { previous, wasArmed };
}

function restoreRunWatchAfterFailedUserStop(snapshot){
  runWatch = snapshot.previous;
  updateRunWatchUi();
  if (snapshot.wasArmed && runWatch) armRunWatch();
}

function setDockerRunHopStatus(html){
  const el = document.getElementById('docker-runhop-status');
  if (el) el.innerHTML = html;
}

async function dockerStopHop(){
  if (engineActionBusy) return;
  if (!confirm('Stop the data vault engine now?\n\nThe current ETL run will be stopped. If the scheduler is enabled, it may start another run later.')) return;

  engineActionBusy = true;
  const startBtn = document.getElementById('btn-docker-runhop');
  const stopBtn = document.getElementById('btn-docker-stophop');
  startBtn.disabled = true;
  stopBtn.disabled = true;
  stopBtn.textContent = 'Stopping…';
  const watchSnapshot = pauseRunWatchForUserStop();
  setDockerRunHopStatus(`<div class="ai-status busy mt"><span class="dot"></span>Requesting a graceful engine stop…</div>`);

  try {
    const resp = await localFetch('/api/docker/stop-hop', { method:'POST' });
    const data = await resp.json();
    if (!data.ok){
      restoreRunWatchAfterFailedUserStop(watchSnapshot);
      setDockerRunHopStatus(dockerResultHtml(data, 'Stopping the data vault engine'));
      toast('Could not stop the data vault engine — monitoring resumed.', 'err');
      return;
    }
    stopRunWatch('Engine stopped by user.', 'ok');
    setDockerRunHopStatus(`<div class="ai-status ok mt">Engine stopped by user.</div>`);
    toast('Data vault engine stopped by user.', 'ok');
  } catch(err){
    restoreRunWatchAfterFailedUserStop(watchSnapshot);
    setDockerRunHopStatus(`<div class="ai-status err mt">Could not stop the data vault engine: ${escapeHtml(err.message)}</div>`);
    toast('Could not stop the data vault engine — monitoring resumed.', 'err');
  } finally {
    engineActionBusy = false;
    const currentStartBtn = document.getElementById('btn-docker-runhop');
    const currentStopBtn = document.getElementById('btn-docker-stophop');
    if (currentStartBtn) currentStartBtn.disabled = false;
    if (currentStopBtn){ currentStopBtn.disabled = false; currentStopBtn.textContent = 'Stop data vault engine'; }
  }
}

/* ---- ENGINE LOGS — tail of the hop container, via the fixed server command ---- */
let engineLogsState = { status:'idle', text:'', error:'' };
function engineLogsHtml(){
  if (engineLogsState.status === 'loading') return `<div class="ai-status busy mt"><span class="dot"></span>Fetching engine logs…</div>`;
  if (engineLogsState.status === 'error') return `<div class="ai-status err mt">${escapeHtml(engineLogsState.error)}</div>`;
  if (engineLogsState.status !== 'loaded') return '';
  return `
    <div class="flex-between mt" style="margin-bottom:6px;">
      <span class="hint mb0">Last 300 lines of the hop container.</span>
      <button class="btn small ghost" id="btn-engine-logs-refresh">⟳ Refresh</button>
    </div>
    <pre class="code" id="engine-logs-tail" style="max-height:320px;overflow:auto;">${escapeHtml(engineLogsState.text || '(no log output yet)')}</pre>`;
}
function bindEngineLogsRefresh(){
  const refreshBtn = document.getElementById('btn-engine-logs-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', loadEngineLogs);
}
function pinEngineLogsToBottom(){
  const pre=document.getElementById('engine-logs-tail');
  if(!pre)return;
  const pin=()=>{pre.scrollTop=pre.scrollHeight;};
  pin();
  if(typeof requestAnimationFrame==='function')requestAnimationFrame(pin);
}
function updateEngineLogsUi(){
  const wrap = document.getElementById('engine-logs-wrap');
  if (!wrap) return;
  wrap.innerHTML = engineLogsHtml();
  bindEngineLogsRefresh();
  pinEngineLogsToBottom();
}
async function loadEngineLogs(){
  engineLogsState = { status:'loading', text:engineLogsState.text, error:'' };
  updateEngineLogsUi();
  try {
    const data = await localFetch(`/api/docker/logs`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tail: 300 }) }).then(r=>r.json());
    if (!data.ok) throw new Error(data.error || 'Could not fetch logs.');
    engineLogsState = { status:'loaded', text:data.logs || '', error:'' };
  } catch(err){
    engineLogsState = { status:'error', text:engineLogsState.text, error:err.message };
  }
  updateEngineLogsUi();
}

/* ---- RUN WATCHER ----------------------------------------------------------
   `start.sh up -d hop` returns as soon as Docker has started the service.  The
   Hub therefore watches TWO independent signals:
     1) pdi_meta.inst_runs for the run's logical status, and
     2) the actual Compose `hop` container for process completion.

   A metadata row saying Success is not enough on its own.  Some engine paths
   can update the parent run row before all work/cleanup has stopped, which was
   producing false "finished successfully in 0s" messages.  Success is only
   shown after the run row is terminal AND the Hop container has exited cleanly.
   The pdi_meta baseline is captured before Docker starts to avoid missing a
   run that is inserted very quickly. ------------------------------------------------ */
let runWatch = null; // { baselineMaxId, tries, handle, message, kind }
function runWatchStatusHtml(){
  if (!runWatch || !runWatch.message) return '';
  const cls = runWatch.kind==='ok' ? 'ok' : runWatch.kind==='err' ? 'err' : 'busy';
  return `<div class="ai-status ${cls} mt">${cls==='busy'?'<span class="dot"></span>':''}${escapeHtml(runWatch.message)}</div>`;
}
function updateRunWatchUi(){
  const el = document.getElementById('run-watch-status');
  if (el) el.innerHTML = runWatchStatusHtml();
}
function stopRunWatch(message, kind){
  if (runWatch && runWatch.handle) clearInterval(runWatch.handle);
  if (runWatch){ runWatch.handle = null; if (message){ runWatch.message = message; runWatch.kind = kind || 'err'; } }
  updateRunWatchUi();
}
function cancelPreparedRunWatch(){
  if (runWatch && runWatch.handle) clearInterval(runWatch.handle);
  runWatch = null;
  updateRunWatchUi();
}
async function prepareRunWatch(){
  if (!dashboardConn.database) return false;
  let baseline = 0;
  try {
    const rows = await dashQuery(`SELECT COALESCE(MAX(id_run),0) AS max_id FROM pdi_meta.inst_runs`);
    baseline = Number(rows[0] && rows[0].max_id || 0);
  } catch(_){
    // Monitoring is useful but must never prevent an otherwise valid engine run.
    return false;
  }
  if (runWatch && runWatch.handle) clearInterval(runWatch.handle);
  runWatch = { baselineMaxId: baseline, tries: 0, handle: null,
    message: 'Engine starting — waiting for a new run and the Hop process…', kind: 'busy' };
  updateRunWatchUi();
  return true;
}
function armRunWatch(){
  if (!runWatch) return;
  if (runWatch.handle) clearInterval(runWatch.handle);
  runWatch.handle = setInterval(runWatchTick, 5000);
  runWatchTick();
}
async function hopEngineProcessState(){
  try {
    const resp = await localFetch('/api/docker/hop-status', { method:'POST' });
    const data = await resp.json();
    if (!data.ok) return { known:false, error:data.error||'Hop process status unavailable.' };
    return {
      known:true,
      present:!!data.present,
      running:!!data.running,
      state:String(data.state||''),
      status:String(data.status||''),
      exitCode:data.exitCode==null ? null : Number(data.exitCode),
    };
  } catch(err){
    return { known:false, error:err.message };
  }
}
async function runWatchTick(){
  if (!runWatch || engineActionBusy) return;
  const watch = runWatch;
  runWatch.tries++;
  try {
    const rows = await dashQuery(`
      SELECT r.id_run, r.id_status, s.description AS status_desc,
             r.date_start, r.date_end, r.duration_in_seconds, r.error_message
      FROM pdi_meta.inst_runs r
      LEFT JOIN pdi_meta.ref_statuses s ON s.id_status = r.id_status
      WHERE r.id_run > ${Number(runWatch.baselineMaxId)}
      ORDER BY r.id_run DESC LIMIT 1
    `);
    const engine = await hopEngineProcessState();
    if (runWatch !== watch || engineActionBusy) return;

    if (!rows.length){
      if (engine.known && !engine.running && engine.present && engine.exitCode!=null && engine.exitCode!==0){
        stopRunWatch(`The Hop engine exited with code ${engine.exitCode} before a new pdi_meta run appeared — check the engine logs.`, 'err');
        return;
      }
      runWatch.message = `Engine starting — no new pdi_meta run yet (checked ${runWatch.tries}×, every 5s)…`;
      runWatch.kind = 'busy';
      updateRunWatchUi();
      return;
    }

    const run = rows[0];
    const metadataSuccess = Number(run.id_status)===2;
    const metadataFailed = Number(run.id_status)===3;
    const metadataTerminal = metadataSuccess || metadataFailed;
    const metadataClosed = !!run.date_end;

    // A non-zero process exit is definitive even if pdi_meta did not manage to
    // record the failure first.
    if (engine.known && !engine.running && engine.present && engine.exitCode!=null && engine.exitCode!==0){
      stopRunWatch(`Run #${run.id_run} stopped because the Hop engine exited with code ${engine.exitCode}${run.error_message?`: ${run.error_message}`:''} — check the engine logs.`, 'err');
      toast(`Run #${run.id_run} failed.`, 'err');
      loadDashboardMetrics();
      return;
    }

    if (metadataTerminal && engine.known && engine.running){
      runWatch.message = `Run #${run.id_run} metadata reports ${metadataSuccess?'success':'failure'}, but the Hop engine is still running — waiting for the process to end…`;
      runWatch.kind = 'busy';
      updateRunWatchUi();
      return;
    }

    if (metadataSuccess){
      if (!metadataClosed){
        runWatch.message = `Run #${run.id_run} reports success, but its end time is not recorded yet — waiting…`;
        runWatch.kind = 'busy'; updateRunWatchUi(); return;
      }
      if (!engine.known){
        runWatch.message = `Run #${run.id_run} reports success — confirming the Hop engine has stopped…`;
        runWatch.kind = 'busy'; updateRunWatchUi(); return;
      }
      // Known + not running is the second completion signal. A removed/absent
      // one-shot container also counts as stopped when pdi_meta has closed.
      if (!engine.running){
        stopRunWatch(`Run #${run.id_run} finished successfully${run.duration_in_seconds!=null?` in ${run.duration_in_seconds}s`:''}.`, 'ok');
        toast(`Run #${run.id_run} finished successfully.`, 'ok');
        loadDashboardMetrics();
        return;
      }
    }

    if (metadataFailed){
      if (!metadataClosed){
        runWatch.message = `Run #${run.id_run} reports failure; waiting for the run and Hop process to close…`;
        runWatch.kind = 'busy'; updateRunWatchUi(); return;
      }
      if (!engine.known){
        runWatch.message = `Run #${run.id_run} reports failure — confirming the Hop engine has stopped…`;
        runWatch.kind = 'busy'; updateRunWatchUi(); return;
      }
      if (!engine.running){
        stopRunWatch(`Run #${run.id_run} FAILED${run.error_message?`: ${run.error_message}`:''} — check the engine logs and run detail.`, 'err');
        toast(`Run #${run.id_run} failed.`, 'err');
        loadDashboardMetrics();
        return;
      }
    }

    if (engine.known && !engine.running && metadataTerminal===false){
      runWatch.message = `Hop has stopped, but Run #${run.id_run} has not reached a terminal metadata status yet (${run.status_desc || 'status '+run.id_status}) — waiting for pdi_meta to settle…`;
    } else {
      runWatch.message = `Run #${run.id_run} in progress (${run.status_desc || 'status '+run.id_status})…`;
    }
    runWatch.kind = 'busy';
    updateRunWatchUi();
  } catch(_){ /* transient query/status failure — keep polling */ }
}

/* ---- POST-RUN VERIFICATION — did the latest run actually load anything,
   and did any rows land in _err tables? Mirrors the setup skill's
   failure-diagnosis checks. ---- */
async function verifyLatestLoad(){
  if (!dashboardConn.database){
    dashboardVerification = {
      status:'error', headline:'', runSucceeded:false, findings:[],
      error:'Set the connection above (at least the database) first.',
    };
    updateDashboardVerificationUi();
    return;
  }
  dashboardVerification = { status:'loading', headline:'', runSucceeded:false, findings:[], error:'' };
  updateDashboardVerificationUi();
  try {
    const latest = await dashQuery(`
      SELECT r.id_run, r.id_status, s.description AS status_desc, r.date_start, r.duration_in_seconds, r.error_message
      FROM pdi_meta.inst_runs r
      LEFT JOIN pdi_meta.ref_statuses s ON s.id_status = r.id_status
      ORDER BY r.date_start DESC LIMIT 1
    `);
    if (!latest.length){
      dashboardVerification = { status:'empty', headline:'', runSucceeded:false, findings:[], error:'' };
      updateDashboardVerificationUi();
      return;
    }
    const run = latest[0];
    const findings = [];

    if (run.id_status===3) findings.push({ kind:'err', text:`Run #${run.id_run} FAILED${run.error_message?`: ${run.error_message}`:''}.` });

    let zeroStg = [], zeroDv = [], errDv = [];
    try {
      zeroStg = await dashQuery(`SELECT source_table_name, target_table_name FROM pdi_meta.inst_run_stg_jobs WHERE id_run = ${run.id_run} AND COALESCE(num_records_loaded,0) = 0 ORDER BY target_table_name`);
    } catch(_){}
    try {
      zeroDv = await dashQuery(`SELECT data_vault_object FROM pdi_meta.inst_run_dv_jobs WHERE id_run = ${run.id_run} AND COALESCE(num_records_loaded,0) = 0 ORDER BY data_vault_object`);
    } catch(_){}
    try {
      errDv = await dashQuery(`SELECT data_vault_object, num_errors FROM pdi_meta.inst_run_dv_jobs WHERE id_run = ${run.id_run} AND COALESCE(num_errors,0) > 0 ORDER BY num_errors DESC`);
    } catch(_){}
    if (zeroStg.length) findings.push({ kind:'warn', text:`${zeroStg.length} staging job(s) loaded ZERO rows: ${zeroStg.slice(0,10).map(j=>j.target_table_name||j.source_table_name).join(', ')}${zeroStg.length>10?'…':''}` });
    if (zeroDv.length) findings.push({ kind:'warn', text:`${zeroDv.length} vault object(s) loaded ZERO rows: ${zeroDv.slice(0,10).map(j=>j.data_vault_object).join(', ')}${zeroDv.length>10?'…':''}` });
    if (errDv.length) findings.push({ kind:'err', text:`${errDv.length} vault object(s) reported errors: ${errDv.slice(0,10).map(j=>`${j.data_vault_object} (${j.num_errors})`).join(', ')}${errDv.length>10?'…':''}` });

    // _err tables that actually contain rows. Table list from the catalog,
    // then a count per table (capped) — each count is one read-only query.
    let errTablesWithRows = [];
    try {
      const errTables = await dashQuery(`
        SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_name LIKE '%\\_err' AND table_schema IN ('vault','data_vault','staging')
        ORDER BY table_schema, table_name LIMIT 60
      `);
      for (const t of errTables.slice(0, 40)){
        try {
          const c = await dashQuery(`SELECT COUNT(*) AS n FROM "${t.table_schema}"."${t.table_name}"`);
          const n = Number(c[0] && c[0].n || 0);
          if (n > 0) errTablesWithRows.push({ table: `${t.table_schema}.${t.table_name}`, rows: n });
        } catch(_){}
      }
    } catch(_){}
    if (errTablesWithRows.length) findings.push({ kind:'err', text:`${errTablesWithRows.length} _err table(s) contain rows: ${errTablesWithRows.map(t=>`${t.table} (${t.rows.toLocaleString()})`).join(', ')} — inspect these rows to see which records were rejected and why.` });

    const headline = `Run #${run.id_run} · ${run.status_desc || 'status '+run.id_status} · started ${run.date_start ? new Date(run.date_start).toLocaleString() : '—'}${run.duration_in_seconds!=null?` · ${run.duration_in_seconds}s`:''}`;
    dashboardVerification = {
      status:'complete',
      headline,
      runSucceeded: run.id_status===2,
      findings,
      error:'',
    };
    updateDashboardVerificationUi();
  } catch(err){
    dashboardVerification = {
      status:'error', headline:'', runSucceeded:false, findings:[], error:err.message,
    };
    updateDashboardVerificationUi();
  }
}

async function loadDashboardMetrics(){
  dashboardStatus = 'loading';
  dashboardAutoLoadKey = dashboardConnectionKey();
  document.getElementById('btn-dash-load').textContent = 'Loading…';
  try {
    const health = await localFetch(`/api/health`).catch(()=>null);
    if (!health || !health.ok) throw new Error(`Local server not reachable at ${localServerUrl} — is it running?`);
    try {
      dashboardRuns = await dashQuery(`
        SELECT r.id_run, rt.description AS run_type,
               s.description AS status_desc, r.id_status,
               r.date_start, r.date_end, r.duration_in_seconds, r.error_message
        FROM pdi_meta.inst_runs r
        LEFT JOIN pdi_meta.ref_runtypes rt ON rt.id_rtyp = r.id_rtyp
        LEFT JOIN pdi_meta.ref_statuses s ON s.id_status = r.id_status
        WHERE rt.description IN ('Data Vault', 'Staging')
        ORDER BY r.date_start DESC
        LIMIT 50
      `);
    } catch(jobHistoryError){
      dashboardRuns = await dashQuery(`
        SELECT r.id_run, rt.description AS run_type,
               s.description AS status_desc, r.id_status,
               r.date_start, r.date_end, r.duration_in_seconds, r.error_message
        FROM pdi_meta.inst_runs r
        LEFT JOIN pdi_meta.ref_runtypes rt ON rt.id_rtyp = r.id_rtyp
        LEFT JOIN pdi_meta.ref_statuses s ON s.id_status = r.id_status
        WHERE rt.description IN ('Data Vault', 'Staging')
        ORDER BY r.date_start DESC
        LIMIT 50
      `);
    }
    // Best-effort extras — a vault with no load history yet, or an older
    // Metadata schema without these particular tables, shouldn't block the
    // core run list from showing. Each fails independently and silently.
    try {
      dashboardObjectErrors = await dashQuery(`
        WITH recent_visible_runs AS (
          SELECT r.id_run
          FROM pdi_meta.inst_runs r
          LEFT JOIN pdi_meta.ref_runtypes rt ON rt.id_rtyp = r.id_rtyp
          WHERE rt.description IN ('Data Vault', 'Staging')
          ORDER BY r.date_start DESC
          LIMIT 20
        )
        SELECT j.data_vault_object, SUM(j.num_errors) AS total_errors, COUNT(*) AS times_run, SUM(j.num_records_loaded) AS total_loaded
        FROM pdi_meta.inst_run_dv_jobs j
        JOIN recent_visible_runs r ON r.id_run = j.id_run
        GROUP BY j.data_vault_object
        HAVING SUM(j.num_errors) > 0
        ORDER BY total_errors DESC, total_loaded DESC
        LIMIT 8
      `);
    } catch(_) { dashboardObjectErrors = []; }
    try {
      const rows = await dashQuery(`
        WITH recent_visible_runs AS (
          SELECT r.id_run
          FROM pdi_meta.inst_runs r
          LEFT JOIN pdi_meta.ref_runtypes rt ON rt.id_rtyp = r.id_rtyp
          WHERE rt.description IN ('Data Vault', 'Staging')
          ORDER BY r.date_start DESC
          LIMIT 20
        )
        SELECT 'staging' AS layer, COALESCE(SUM(j.num_records_loaded),0) AS total
        FROM pdi_meta.inst_run_stg_jobs j
        JOIN recent_visible_runs r ON r.id_run = j.id_run
        UNION ALL
        SELECT 'vault' AS layer, COALESCE(SUM(j.num_records_loaded),0) AS total
        FROM pdi_meta.inst_run_dv_jobs j
        JOIN recent_visible_runs r ON r.id_run = j.id_run
      `);
      dashboardRowsLoaded = {
        staging: Number(rows.find(r=>r.layer==='staging')?.total || 0),
        vault: Number(rows.find(r=>r.layer==='vault')?.total || 0),
      };
    } catch(_) { dashboardRowsLoaded = { staging: 0, vault: 0 }; }
    dashboardStatus = 'ok'; dashboardError = '';
    dashboardSelectedRun = null; dashboardDvJobs = []; dashboardStgJobs = [];
    toast(`Loaded ${dashboardRuns.length} run(s).`, 'ok');
  } catch(err){
    dashboardStatus = 'error'; dashboardError = err.message;
    dashboardRuns = []; dashboardObjectErrors = []; dashboardRowsLoaded = { staging: 0, vault: 0 };
    toast('Could not load metrics — see details below.', 'err');
  }
  renderAll();
}

function timeAgo(dateStr){
  if (!dateStr) return null;
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs/60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs/24);
  return `${days}d ago`;
}

function timeUntil(dateStr){
  if (!dateStr) return null;
  const diffMs = new Date(dateStr).getTime() - Date.now();
  if (diffMs <= 0) return 'due now';
  const mins = Math.ceil(diffMs/60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins/60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins ? `in ${hrs}h ${remMins}m` : `in ${hrs}h`;
  const days = Math.floor(hrs/24);
  return `in ${days}d`;
}

function renderHealthBanner(){
  const lastOk = dashboardRuns.find(r=>r.id_status===2);
  const lastErr = dashboardRuns.find(r=>r.id_status===3);
  const chip = (label, run, color) => run
    ? `<div class="health-chip" style="border-color:${color};">
         <span class="health-chip-dot" style="background:${color};"></span>
         <div>
           <div class="hint mb0">${label}</div>
           <div style="font-weight:700;">${escapeHtml(run.run_type||'—')} <span class="hint">· ${timeAgo(run.date_start)}</span></div>
         </div>
       </div>`
    : `<div class="health-chip" style="border-color:var(--border);">
         <span class="health-chip-dot" style="background:var(--muted-2);"></span>
         <div><div class="hint mb0">${label}</div><div style="font-weight:700;color:var(--muted);">None yet</div></div>
       </div>`;
  return `<div class="grid cols-2 mt">
    ${chip('Last successful run', lastOk, 'var(--ok)')}
    ${chip('Last failed run', lastErr, 'var(--err)')}
  </div>`;
}

function renderDurationChart(){
  const recent = dashboardRuns.slice(0, 20).slice().reverse(); // chronological, oldest first
  if (!recent.length) return `<div class="empty">No runs to chart yet.</div>`;
  const w = 560, h = 120, barGap = 4;
  const barW = Math.max(6, (w / recent.length) - barGap);
  const maxDur = Math.max(1, ...recent.map(r=>r.duration_in_seconds||0));
  const bars = recent.map((r,i)=>{
    const dur = r.duration_in_seconds || 0;
    const barH = Math.max(2, (dur/maxDur) * (h-20));
    const x = i * (barW+barGap);
    const y = h - barH;
    const color = statusBadgeColor(r.id_status);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="${color}" opacity="0.85"><title>Run #${r.id_run} — ${escapeHtml(r.run_type||'')} — ${dur}s — ${escapeHtml(r.status_desc||'')}</title></rect>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:120px;display:block;">${bars}</svg>`;
}

function renderRunTypeBreakdown(){
  const counts = {};
  dashboardRuns.forEach(r=>{ const k = r.run_type||'Unknown'; counts[k] = (counts[k]||0)+1; });
  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) return `<div class="empty">No runs yet.</div>`;
  const max = Math.max(...entries.map(e=>e[1]));
  return entries.map(([type,count])=>`
    <div class="runtype-row">
      <span class="runtype-label">${escapeHtml(type)}</span>
      <div class="runtype-bar-track"><div class="runtype-bar-fill" style="width:${Math.round((count/max)*100)}%;"></div></div>
      <span class="mono runtype-count">${count}</span>
    </div>`).join('');
}

function statusBadgeColor(idStatus){
  if (idStatus===2) return 'var(--ok)';
  if (idStatus===3) return 'var(--err)';
  return 'var(--brand)'; // started / in progress
}

function renderDashboardResults(el){
  const total = dashboardRuns.length;
  const success = dashboardRuns.filter(r=>r.id_status===2).length;
  const errored = dashboardRuns.filter(r=>r.id_status===3).length;
  const durations = dashboardRuns.filter(r=>r.duration_in_seconds!=null).map(r=>r.duration_in_seconds);
  const avgDur = durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : null;
  const successRate = total ? Math.round((success/total)*100) : null;

  el.innerHTML = `
    ${renderHealthBanner()}

    <div class="grid cols-4 mt">
      <div class="panel" style="text-align:center;"><div class="hint mb0">Runs (last 50)</div><div style="font-family:var(--font-mono);font-size:24px;font-weight:700;color:var(--brand-deep);">${total}</div></div>
      <div class="panel" style="text-align:center;"><div class="hint mb0">Success rate</div><div style="font-family:var(--font-mono);font-size:24px;font-weight:700;color:${successRate==null?'var(--muted)':successRate>=90?'var(--ok)':successRate>=60?'var(--hub)':'var(--err)'};">${successRate!=null?successRate+'%':'—'}</div></div>
      <div class="panel" style="text-align:center;"><div class="hint mb0">Errored</div><div style="font-family:var(--font-mono);font-size:24px;font-weight:700;color:var(--err);">${errored}</div></div>
      <div class="panel" style="text-align:center;"><div class="hint mb0">Avg duration</div><div style="font-family:var(--font-mono);font-size:24px;font-weight:700;color:var(--brand-deep);">${avgDur!=null?avgDur+'s':'—'}</div></div>
    </div>

    <div class="grid cols-2 mt" style="align-items:start;">
      <div class="panel">
        <div class="hint mb0" style="margin-bottom:10px;">Run duration — last ${Math.min(20,total)} runs, oldest → newest</div>
        ${renderDurationChart()}
      </div>
      <div class="panel">
        <div class="hint mb0" style="margin-bottom:10px;">Runs by type</div>
        ${renderRunTypeBreakdown()}
      </div>
    </div>

    <div class="grid cols-2 mt" style="align-items:start;">
      <div class="panel">
        <div class="hint mb0" style="margin-bottom:10px;">Rows loaded — last ${Math.min(20,total)} runs</div>
        <div class="grid cols-2">
          <div style="text-align:center;"><div class="hint mb0">Staging</div><div style="font-family:var(--font-mono);font-size:20px;font-weight:700;color:var(--sat);">${dashboardRowsLoaded.staging.toLocaleString()}</div></div>
          <div style="text-align:center;"><div class="hint mb0">Data vault</div><div style="font-family:var(--font-mono);font-size:20px;font-weight:700;color:var(--hub);">${dashboardRowsLoaded.vault.toLocaleString()}</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="hint mb0" style="margin-bottom:10px;">Most error-prone objects — last ${Math.min(20,total)} runs</div>
        ${dashboardObjectErrors.length===0
          ? `<div class="empty">No errors in recent runs. 🎉</div>`
          : `<table class="data"><tr><th>Object</th><th>Errors</th><th>Loaded</th></tr>
             ${dashboardObjectErrors.map(o=>`<tr><td class="mono">${escapeHtml(o.data_vault_object||'—')}</td><td class="mono" style="color:var(--err);">${o.total_errors}</td><td class="mono">${Number(o.total_loaded||0).toLocaleString()}</td></tr>`).join('')}
             </table>`}
      </div>
    </div>

    <div class="grid cols-2 mt" style="align-items:start;">
      <div class="panel panel-flush">
        <div class="panel-head"><h3>Recent runs</h3></div>
        <table class="data" id="dash-runs-table">
          <tr><th>Run</th><th>Type</th><th>Status</th><th>Started</th><th>Duration</th></tr>
          ${dashboardRuns.length===0 ? `<tr><td colspan="5" class="hint" style="padding:16px;">No runs found yet.</td></tr>` :
            dashboardRuns.map(r=>`
            <tr data-run="${r.id_run}" style="cursor:pointer;${dashboardSelectedRun===r.id_run?'background:var(--brand-wash-2);':''}">
              <td class="mono">#${r.id_run}</td>
              <td>${escapeHtml(r.run_type||'—')}</td>
              <td><span class="tag" style="border-color:${statusBadgeColor(r.id_status)};color:${statusBadgeColor(r.id_status)};">${escapeHtml(r.status_desc||'—')}</span></td>
              <td class="mono">${r.date_start ? new Date(r.date_start).toLocaleString() : '—'}</td>
              <td class="mono">${r.duration_in_seconds!=null ? r.duration_in_seconds+'s' : '—'}</td>
            </tr>
          `).join('')}
        </table>
      </div>
      <div class="panel panel-flush">
        <div class="panel-head"><h3>Run detail ${dashboardSelectedRun?`· #${dashboardSelectedRun}`:''}</h3></div>
        <div id="dash-detail" style="padding:16px;">${dashboardSelectedRun ? '' : '<div class="empty">Click a run to see per-object breakdown.</div>'}</div>
      </div>
    </div>
  `;
  el.querySelectorAll('[data-run]').forEach(row=>{
    row.addEventListener('click', ()=> selectDashboardRun(Number(row.dataset.run)));
  });
  if (dashboardSelectedRun) renderDashboardDetail(document.getElementById('dash-detail'));
}

async function selectDashboardRun(idRun){
  dashboardSelectedRun = idRun;
  dashboardDetailStatus = 'loading';
  renderAll();
  try {
    dashboardDvJobs = await dashQuery(`
      SELECT data_vault_object, num_records_loaded, num_errors, duration_in_seconds
      FROM pdi_meta.inst_run_dv_jobs
      WHERE id_run = ${idRun}
      ORDER BY data_vault_object
    `);
    dashboardStgJobs = await dashQuery(`
      SELECT source_table_name, target_table_name, num_records_loaded, duration_in_seconds
      FROM pdi_meta.inst_run_stg_jobs
      WHERE id_run = ${idRun}
      ORDER BY target_table_name
    `);
    dashboardDetailStatus = 'ok';
  } catch(err){
    dashboardDetailStatus = 'error';
    dashboardError = err.message;
  }
  renderAll();
}

function renderDashboardDetail(el){
  if (dashboardDetailStatus==='loading'){ el.innerHTML = `<div class="ai-status busy"><span class="dot"></span>Loading…</div>`; return; }
  if (dashboardDetailStatus==='error'){ el.innerHTML = `<div class="ai-status err">${escapeHtml(dashboardError)}</div>`; return; }
  const rows = [];
  if (dashboardStgJobs.length){
    rows.push(`<div class="hint" style="text-transform:uppercase;font-weight:600;margin-bottom:4px;">Staging</div>`);
    rows.push(`<table class="data" style="margin-bottom:14px;"><tr><th>Source</th><th>Target</th><th>Loaded</th><th>Duration</th></tr>${
      dashboardStgJobs.map(j=>`<tr><td class="mono">${escapeHtml(j.source_table_name||'—')}</td><td class="mono">${escapeHtml(j.target_table_name||'—')}</td><td class="mono">${j.num_records_loaded??'—'}</td><td class="mono">${j.duration_in_seconds!=null?j.duration_in_seconds+'s':'—'}</td></tr>`).join('')
    }</table>`);
  }
  if (dashboardDvJobs.length){
    rows.push(`<div class="hint" style="text-transform:uppercase;font-weight:600;margin-bottom:4px;">Data vault objects</div>`);
    rows.push(`<table class="data"><tr><th>Object</th><th>Loaded</th><th>Errors</th><th>Duration</th></tr>${
      dashboardDvJobs.map(j=>`<tr><td class="mono">${escapeHtml(j.data_vault_object||'—')}</td><td class="mono">${j.num_records_loaded??'—'}</td><td class="mono" style="color:${j.num_errors>0?'var(--err)':'inherit'}">${j.num_errors??0}</td><td class="mono">${j.duration_in_seconds!=null?j.duration_in_seconds+'s':'—'}</td></tr>`).join('')
    }</table>`);
  }
  el.innerHTML = rows.length ? rows.join('') : `<div class="empty">No per-object detail recorded for this run.</div>`;
}
