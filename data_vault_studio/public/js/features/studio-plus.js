/* =========================================================================
   DATA VAULT STUDIO PLUS — AI-assisted reporting (proof of concept)
   Connects to a deployed vault, introspects its real schema, gets AI report
   ideas to choose from, then generates: plain reporting SQL views, an Excel
   workbook (headers + an Instructions sheet with the SQL to run and paste
   back in), and a self-contained HTML report that reads that workbook.
   Deliberately does not create any new vault objects — the views are
   plain SELECTs, nothing is written back to the vault database itself.
   ========================================================================= */
let spConn = { dialect:'postgresql', host:'localhost', port:'5432', database:'', schema:'data_vault', user:'', password:'', autoDefault:true };

function studioPlusDefaultConnection(){
  if(state.externalTables.enabled){
    const ext=state.externalTables;
    const dialect=ext.remoteDialect||'postgresql';
    // Database Packs deliberately keep Studio Plus on the PostgreSQL logical
    // Vault. Core tables are foreign tables backed by the physical target, so
    // BI keeps one stable PostgreSQL SQL/type model even for Snowflake,
    // Databricks, DB2, etc. Native Studio Plus dialect support can be added to
    // a later pack contract without making v0.1-generated reports vendor SQL.
    if(isDatabasePackDialect(dialect)){
      return {
        dialect:'postgresql',
        host:state.vault.dvHost||'localhost',
        port:String(state.vault.dvPort||'5432'),
        database:state.vault.dvDatabase||'',
        schema:'data_vault',
        user:state.vault.dvUser||'',
        password:state.vault.dvPassword||'',
        autoDefault:true,
      };
    }
    const database=ext.studioDatabase||ext.remoteDatabase||'';
    return {
      dialect,
      host:ext.studioHost||'localhost',
      port:String(ext.studioPort||externalDefaultPort(dialect)),
      database,
      schema:ext.studioSchema||ext.remoteSchema||(dialect==='mysql'?database:'data_vault'),
      user:ext.studioUser||ext.username||'',
      password:ext.studioPassword||ext.password||'',
      autoDefault:true,
    };
  }
  return {
    dialect:'postgresql',
    host:state.vault.dvHost||'localhost',
    port:String(state.vault.dvPort||'5432'),
    database:state.vault.dvDatabase||'',
    schema:'data_vault',
    user:state.vault.dvUser||'',
    password:state.vault.dvPassword||'',
    autoDefault:true,
  };
}

function spQuoteIdentifier(name){
  const value=String(name||'');
  if(spConn.dialect==='mysql') return '`'+value.replace(/`/g,'``')+'`';
  return '"'+value.replace(/"/g,'""')+'"';
}
function spQualifiedTable(name){
  return `${spQuoteIdentifier(spConn.schema||spConn.database)}.${spQuoteIdentifier(name)}`;
}
let spSchemaStatus = null; // null | 'loading' | 'ok' | 'error'
let spSchemaError = '';
let spSchemaTables = []; // [{ name, columns:[{name,type}] }]
let spDashboardPlanStatus = null; // null | 'loading' | 'ok' | 'error'
let spDashboardPlan = null; // { title, sections:[{name, description}] }
let spSectionsIncluded = new Set(); // indices into spDashboardPlan.sections that are still included
let spCustomDirection = '';
let spGenerateStatus = null; // null | 'loading' | 'ok' | 'error'
let spGenerated = null; // { views:[{sheet_name,view_name,sql,columns}], report_html, notes }
let spExpanded = {};
let spOverrides = {};
let spViewValidation = {}; // keyed by view key -> { ok, error }
let spValidating = false;
let spSectionOverrides = {}; // keyed by section index -> edited render_js
let spBusinessReady = true; // richer analyst -> SQL -> result-aware designer workflow
let spResultAwareDesign = true; // when enabled, a capped live result sample is sent to the configured AI provider
const SP_AI_SAMPLE_ROWS = 30;
const SP_AI_SAMPLE_COLUMNS = 24;
const SP_AI_SAMPLE_STRING = 180;
const SP_AI_SAMPLE_TOTAL_CHARS = 32000;
let spGenerateStage = '';

function renderStudioPlus(el){
  if (spConn.autoDefault!==false){
    spConn = studioPlusDefaultConnection();
  }
  el.innerHTML = `
    <h2 class="section-title">Data Vault Studio Plus</h2>
    <p class="section-desc">AI-assisted reporting over the deployed Vault. Built-in external targets can be queried directly; Database Pack FDW targets use the PostgreSQL logical Vault/foreign tables so report SQL stays database-neutral while the physical data remains in the pack target.</p>

    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>① Connect &amp; introspect</h3></div>
      <div class="grid cols-4">
        <div class="field"><label>Database type</label><select id="sp-dialect"><option value="postgresql" ${spConn.dialect==='postgresql'?'selected':''}>PostgreSQL</option><option value="mysql" ${spConn.dialect==='mysql'?'selected':''}>MySQL</option></select></div>
        <div class="field"><label>Host</label><input type="text" id="sp-host" value="${escapeHtml(spConn.host)}"></div>
        <div class="field"><label>Port</label><input type="text" id="sp-port" value="${escapeHtml(spConn.port)}"></div>
        <div class="field"><label>Database</label><input type="text" id="sp-database" value="${escapeHtml(spConn.database)}"></div>
      </div>
      <div class="grid cols-3 mt">
        <div class="field"><label>Schema</label><input type="text" id="sp-schema" value="${escapeHtml(spConn.schema)}"></div>
        <div class="field"><label>Username</label><input type="text" id="sp-user" value="${escapeHtml(spConn.user)}"></div>
        <div class="field"><label>Password</label><input type="password" id="sp-password" value="${escapeHtml(spConn.password)}"></div>
      </div>
      <div class="mt"><button class="btn primary" id="btn-sp-introspect">${spSchemaStatus==='loading'?'Introspecting…':'Infer Schema'}</button></div>
      <div id="sp-schema-status">${spSchemaStatus==='error'?`<div class="ai-status err mt">${escapeHtml(spSchemaError)}</div>`:''}</div>
      ${spSchemaTables.length ? `<p class="hint mt">${spSchemaTables.length} populated table(s) sent to the AI: <span class="mono">${spSchemaTables.map(t=>escapeHtml(t.name)).join(', ')}</span></p>` : ''}
      ${spExcludedEmptyTables.length ? `<p class="hint mt" style="color:var(--hub);">Skipped ${spExcludedEmptyTables.length} empty table(s) (not sent to the AI, since there's nothing to report on yet): <span class="mono">${spExcludedEmptyTables.map(t=>escapeHtml(t)).join(', ')}</span></p>` : ''}
    </div>

    ${spSchemaTables.length ? `
    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>② Report direction</h3></div>
      ${aiSettingsHtml('sp')}
      <div class="panel" style="margin-top:10px;background:var(--panel-2);">
        <label class="checkbox-row" style="align-items:flex-start;"><input type="checkbox" id="sp-business-ready" ${spBusinessReady?'checked':''}><span><strong>Business-ready report</strong><br><span class="hint">Use a BI-consultant planning pass before SQL so the report is organised around business questions, analytical models and decision-useful views rather than generic charts.</span></span></label>
        <label class="checkbox-row mt" style="align-items:flex-start;"><input type="checkbox" id="sp-result-aware" ${spResultAwareDesign?'checked':''} ${spBusinessReady?'':'disabled'}><span><strong>Result-aware design review</strong><br><span class="hint">After SQL validates, Studio Plus runs each generated dataset and sends at most ${SP_AI_SAMPLE_ROWS} rows per dataset (with long values capped) to your configured AI provider. This lets the AI choose stronger visuals and business storytelling. The downloaded HTML never calls AI again; future refreshes only rerun the SQL stored in the workbook.</span></span></label>
      </div>
      <button class="btn mt" id="btn-sp-suggest">${spDashboardPlanStatus==='loading'?'Thinking…':spDashboardPlan?(spBusinessReady?'Suggest a different business report':'Suggest a different dashboard'):(spBusinessReady?'Suggest business-ready report':'Suggest a comprehensive dashboard')}</button>
      <p class="hint mt">The planning pass receives schema structure, data types, row counts and the authoritative Data Vault join map. ${spBusinessReady?'It is prompted to think like a business analyst before choosing report sections.':'No row values are sent during planning.'}</p>
      ${spDashboardPlan ? `
      <div class="panel" style="margin-top:10px;background:var(--panel-2);">
        <div style="font-family:var(--font-display);font-weight:700;font-size:14px;margin-bottom:10px;color:var(--brand-deep);">${escapeHtml(spDashboardPlan.title)}</div>
        ${spDashboardPlan.sections.map((s,i)=>`
          <label class="sp-suggestion-row">
            <input type="checkbox" data-secidx="${i}" ${spSectionsIncluded.has(i)?'checked':''}>
            <div>
              <div style="font-weight:600;">${escapeHtml(s.name)}</div>
              ${s.analysis_type ? `<div class="hint" style="margin:2px 0;color:var(--brand-deep);font-weight:600;">${escapeHtml(s.analysis_type)}</div>` : ''}
              ${s.business_question ? `<div class="hint" style="margin:2px 0;"><strong>Business question:</strong> ${escapeHtml(s.business_question)}</div>` : ''}
              <p class="hint" style="margin:2px 0 0;">${escapeHtml(s.description)}</p>
            </div>
          </label>`).join('')}
      </div>` : ''}
      <div class="field mt">
        <label>Anything else you want in the report? <span class="hint">(optional — works alone too, without picking a suggestion above)</span></label>
        <textarea id="sp-custom-direction" rows="3" placeholder="e.g. focus on the last 12 months, break revenue down by store">${escapeHtml(spCustomDirection)}</textarea>
      </div>
      <button class="btn primary mt" id="btn-sp-generate">${spGenerateStatus==='loading'?(spGenerateStage||'Generating…'):(spBusinessReady?'Generate business-ready report':'Generate report')}</button>
    </div>` : ''}

    ${spGenerated ? `
    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>③ Generated report</h3></div>
      ${spGenerated.notes ? `<p class="hint">${escapeHtml(spGenerated.notes)}</p>` : ''}
      <div class="grid cols-2 mt">
        <button class="btn primary" id="btn-sp-dl-excel">⬇ Download Excel workbook (runs SQL live)</button>
        <button class="btn primary" id="btn-sp-dl-html">⬇ Download HTML report</button>
      </div>
      <button class="btn ghost mt" id="btn-sp-validate">${spValidating?'Validating…':'Validate SQL now'}</button>
      <p class="hint mt">The workbook button runs every view below against this connection right now and downloads a workbook already full of results — no manual copy/paste needed. An Instructions sheet still lists the SQL for reference. SQL is validated automatically right after generation; use "Validate SQL now" again after editing any view by hand. <strong>The HTML is the reusable client report:</strong> download it once, then refresh/re-run the workbook SQL whenever the data changes and load that refreshed workbook into the same HTML.</p>
      <div class="field mt">
        <label>Already have a workbook you want fresh data in? <span class="hint">(re-runs the SQL live and overwrites the matching sheets in that file, leaving anything else in it — extra tabs, formatting — untouched)</span></label>
        <input type="file" id="sp-refresh-file" accept=".xlsx,.xls">
      </div>
      <div id="sp-refresh-status"></div>
      <div class="export-file-list mt">
        ${spGenerated.views.map(v=>spViewRowHtml(v)).join('')}
      </div>
      <p class="hint mt" style="margin-top:18px;">Report sections — each one's rendering code (KPIs, chart, filter, detail table), editable the same way as the SQL above:</p>
      <div class="export-file-list mt">
        ${spGenerated.sections.map((s,i)=>spSectionRowHtml(s,i)).join('')}
      </div>
      <button class="btn ghost mt" id="btn-sp-regenerate">Regenerate</button>
    </div>` : ''}
  `;

  const bindSp = (id, key, eventName='input') => document.getElementById(id).addEventListener(eventName, e=>{ spConn[key]=e.target.value; spConn.autoDefault=false; });
  bindSp('sp-dialect','dialect','change'); bindSp('sp-host','host'); bindSp('sp-port','port'); bindSp('sp-database','database');
  bindSp('sp-schema','schema'); bindSp('sp-user','user'); bindSp('sp-password','password');
  document.getElementById('btn-sp-introspect').addEventListener('click', spIntrospectSchema);

  wireAiSettings(el, 'sp', ()=>{ renderAll(); });
  const businessReadyEl = document.getElementById('sp-business-ready');
  if (businessReadyEl) businessReadyEl.addEventListener('change', e=>{
    spBusinessReady = e.target.checked;
    if (!spBusinessReady) spResultAwareDesign = false;
    else if (!spResultAwareDesign) spResultAwareDesign = true;
    spDashboardPlan = null; spSectionsIncluded = new Set(); spGenerated = null; spGenerateStage = '';
    renderAll();
  });
  const resultAwareEl = document.getElementById('sp-result-aware');
  if (resultAwareEl) resultAwareEl.addEventListener('change', e=>{ spResultAwareDesign = e.target.checked; });
  const suggestBtn = document.getElementById('btn-sp-suggest');
  if (suggestBtn) suggestBtn.addEventListener('click', spSuggestDashboardPlan);
  el.querySelectorAll('[data-secidx]').forEach(cb=>{
    cb.addEventListener('change', e=>{
      const i = Number(e.target.dataset.secidx);
      if (e.target.checked) spSectionsIncluded.add(i); else spSectionsIncluded.delete(i);
    });
  });
  const customDirEl = document.getElementById('sp-custom-direction');
  if (customDirEl) customDirEl.addEventListener('input', e=> spCustomDirection = e.target.value);
  const genBtn = document.getElementById('btn-sp-generate');
  if (genBtn) genBtn.addEventListener('click', spGenerateReport);

  const dlExcelBtn = document.getElementById('btn-sp-dl-excel');
  if (dlExcelBtn) dlExcelBtn.addEventListener('click', spDownloadWorkbook);
  const dlHtmlBtn = document.getElementById('btn-sp-dl-html');
  if (dlHtmlBtn) dlHtmlBtn.addEventListener('click', spDownloadReportHtml);
  const validateBtn = document.getElementById('btn-sp-validate');
  if (validateBtn) validateBtn.addEventListener('click', spValidateGeneratedViews);
  const refreshFileEl = document.getElementById('sp-refresh-file');
  if (refreshFileEl) refreshFileEl.addEventListener('change', e=>{
    const f = e.target.files && e.target.files[0];
    if (f) spRefreshUploadedWorkbook(f);
  });
  const regenBtn = document.getElementById('btn-sp-regenerate');
  if (regenBtn) regenBtn.addEventListener('click', spGenerateReport);
  el.querySelectorAll('[data-sptoggle]').forEach(b=>{
    b.addEventListener('click', ()=>{ spExpanded[b.dataset.sptoggle] = !spExpanded[b.dataset.sptoggle]; renderAll(); });
  });
  el.querySelectorAll('[data-speditor]').forEach(ta=>{
    ta.addEventListener('input', e=>{
      spOverrides[e.target.dataset.speditor] = e.target.value;
      delete spViewValidation[e.target.dataset.speditor]; // stale now — re-validate before trusting the badge again
    });
  });
  el.querySelectorAll('[data-spreset]').forEach(b=>{
    b.addEventListener('click', ()=>{ delete spOverrides[b.dataset.spreset]; renderAll(); });
  });
  el.querySelectorAll('[data-seceditor]').forEach(ta=>{
    ta.addEventListener('input', e=>{ spSectionOverrides[Number(e.target.dataset.seceditor)] = e.target.value; });
  });
  el.querySelectorAll('[data-secreset]').forEach(b=>{
    b.addEventListener('click', ()=>{ delete spSectionOverrides[Number(b.dataset.secreset)]; renderAll(); });
  });
}

function spSectionRowHtml(s, i){
  const key = `sec:${i}`;
  const expanded = !!spExpanded[key];
  const current = spSectionOverrides[i] != null ? spSectionOverrides[i] : (s.render_js||'');
  const edited = spSectionOverrides[i] != null;
  return `
    <div class="export-file-row ${expanded?'expanded':''}">
      <div class="export-file-row-head">
        <button class="export-file-toggle" data-sptoggle="${key}" aria-expanded="${expanded}">
          <span class="export-file-caret">${expanded?'▾':'▸'}</span>
          <span class="export-file-label">${escapeHtml(s.title||s.view_name)}</span>
          <span class="hint">(section · reads ${escapeHtml(s.view_name)})</span>
          ${edited ? `<span class="badge-count">edited</span>` : ''}
        </button>
      </div>
      ${expanded ? `
      <div class="export-file-body">
        <textarea class="code-edit" data-seceditor="${i}" spellcheck="false" wrap="off">${escapeHtml(current)}</textarea>
        <div class="export-file-body-actions">
          <p class="hint mb0">${edited ? 'Edited — used in the downloaded report.' : 'Generated by the model — edit above to override it.'} Receives rows (array of row objects), el (empty container element), and echarts (Apache ECharts when available).</p>
          ${edited ? `<button class="btn small ghost" data-secreset="${i}">Reset to generated</button>` : ''}
        </div>
      </div>` : ''}
    </div>`;
}

// Runs immediately after generation (and again on demand via the "Validate
// SQL now" button) so a broken view — wrong alias, wrong column, whatever —
// surfaces right here, rather than only being discovered later when
// someone tries to populate the workbook. Wraps each view in a LIMIT-0
// subquery so it's a pure syntax/execution check: Postgres still has to
// parse and plan the real query, but no actual rows come back.
async function spValidateGeneratedViews(){
  if (!spGenerated) return;
  spValidating = true;
  renderAll();
  spViewValidation = await spValidateViewList(spGenerated.views);
  spValidating = false;
  renderAll();
  const failed = Object.values(spViewValidation).filter(r=>!r.ok).length;
  if (failed) toast(`${failed} of ${spGenerated.views.length} view(s) failed validation — expand the red one(s) below to see the error.`, 'err');
  else toast(`All ${spGenerated.views.length} view(s) validated successfully against the connected database.`, 'ok');
}

function spViewKey(v){ return v.view_name || v.sheet_name; }
function spGetViewSql(v){
  const key = spViewKey(v);
  return spOverrides[key] != null ? spOverrides[key] : (v.sql||'');
}
function spViewRowHtml(v){
  const key = spViewKey(v);
  const validation = spViewValidation[key];
  const failed = validation && !validation.ok;
  const expanded = !!spExpanded[key] || failed; // auto-expand failed views so the error is impossible to miss
  const edited = spOverrides[key] != null;
  return `
    <div class="export-file-row ${expanded?'expanded':''}" style="${failed?'border-left:3px solid var(--err);':''}">
      <div class="export-file-row-head">
        <button class="export-file-toggle" data-sptoggle="${key}" aria-expanded="${expanded}">
          <span class="export-file-caret">${expanded?'▾':'▸'}</span>
          <span class="export-file-label">${escapeHtml(v.sheet_name||key)}</span>
          <span class="hint">(sheet · ${escapeHtml((v.columns||[]).join(', '))})</span>
          ${edited ? `<span class="badge-count">edited</span>` : ''}
          ${validation ? (validation.ok ? `<span class="badge-count" style="color:var(--ok);">✓ validated</span>` : `<span class="badge-count" style="color:var(--err);">✕ failed</span>`) : ''}
        </button>
      </div>
      ${expanded ? `
      <div class="export-file-body">
        ${failed ? `<div class="ai-status err mb">${escapeHtml(validation.error)}</div>` : ''}
        <textarea class="code-edit" data-speditor="${key}" spellcheck="false" wrap="off">${escapeHtml(spGetViewSql(v))}</textarea>
        <div class="export-file-body-actions">
          <p class="hint mb0">${edited ? 'Edited — this version is used in the downloaded workbook.' : 'Generated by the model — edit above to override it.'}</p>
          ${edited ? `<button class="btn small ghost" data-spreset="${key}">Reset to generated</button>` : ''}
        </div>
      </div>` : ''}
    </div>`;
}

async function spQuery(sql){
  await ensureLocalServerReachable();
  const resp = await localFetch(`/api/query`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ ...spConn, sql }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Query failed.');
  return data.rows || [];
}

let spExcludedEmptyTables = [];

async function spIntrospectSchema(){
  spSchemaStatus = 'loading';
  document.getElementById('btn-sp-introspect').textContent = 'Introspecting…';
  try {
    const health = await localFetch(`/api/health`).catch(()=>null);
    if (!health || !health.ok) throw new Error(`Local server not reachable at ${localServerUrl} — is it running?`);
    const response=await localFetch('/api/introspect',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...spConn,schema:spConn.schema||spConn.database,profileColumns:false}),
    });
    const data=await response.json();
    if(!data.ok) throw new Error(data.error||'Schema introspection failed.');
    const candidates=(data.tables||[]).filter(t=>t.objectType!=='view'&&!/_err$/i.test(t.name));
    if(!candidates.length) throw new Error(`Connected, but found no non-_err tables in ${spConn.schema||spConn.database}.`);
    const countRows=await spQuery(candidates.map(t=>
      `SELECT '${String(t.name).replace(/'/g,"''")}' AS table_name, COUNT(*) AS row_count FROM ${spQualifiedTable(t.name)}`
    ).join('\nUNION ALL\n'));
    const countByTable={};
    countRows.forEach(r=>{countByTable[r.table_name]=Number(r.row_count)||0;});
    const allTables=candidates.map(t=>({name:t.name,columns:t.columns||[],rowCount:countByTable[t.name]??null}));
    spExcludedEmptyTables=allTables.filter(t=>t.rowCount===0).map(t=>t.name);
    spSchemaTables=allTables.filter(t=>t.rowCount!==0);
    if(!spSchemaTables.length) throw new Error('Every table in the selected target schema is currently empty — nothing to report on yet.');
    spSchemaStatus='ok';spSchemaError='';
    spDashboardPlan=null;spSectionsIncluded=new Set();spGenerated=null;spSectionOverrides={};spViewValidation={};
    toast(`Introspected ${spSchemaTables.length} populated table(s)${spExcludedEmptyTables.length?`, skipped ${spExcludedEmptyTables.length} empty`:''}.`,'ok');
  }catch(err){
    spSchemaStatus='error';spSchemaError=err.message;spSchemaTables=[];spExcludedEmptyTables=[];
    toast('Could not introspect the schema — see details below.','err');
  }
  renderAll();
}

function spSchemaSummaryText(){
  // Column lists on satellites can be long — cap per-table to keep the
  // prompt a reasonable size without losing the shape of the schema.
  // Types are included (not just names) so the model knows, for example,
  // that a numeric-looking column is actually stored as character varying
  // and needs an explicit cast before SUM/AVG — this is a real, recurring
  // vault design quirk here, not a hypothetical.
  return spSchemaTables.map(t=>{
    const cols = t.columns.map(c=>`${c.name}:${c.type}`);
    const shown = cols.length > 25 ? cols.slice(0,25).concat(`…(+${cols.length-25} more)`) : cols;
    return `${t.name}[rows:${t.rowCount==null?'unknown':t.rowCount}](${shown.join(', ')})`;
  }).join('\n');
}

// Derives the actual join graph from the introspected schema, instead of
// leaving the model to reverse-engineer it from table/column naming
// conventions alone — which is exactly where the recurring "read a column
// off the wrong table's alias" bugs have come from. Fully domain-generic:
// this only ever looks at which column names are literally shared between
// tables, never at what any of it means, so it works identically whether
// this vault is retail, CRM, financial, or anything else.
//
// Every hub table's own hash key is named exactly `<hub_table_name>_id` by
// this framework's convention, and any other table that also carries that
// exact column name is joinable to that hub through it — a link joins two
// (or more) hubs this way, a satellite joins exactly one. Generic
// housekeeping columns that happen to appear on nearly every table
// (tenant_id, load_dts, record_source_id) are deliberately excluded here
// since "shares a column" isn't the same thing as "is a join key" — only
// columns matching an actual hub table's own key are treated as one.
function spComputeJoinMap(){
  const hubTables = spSchemaTables.filter(t=>/^hub_/i.test(t.name));
  const lines = [];
  hubTables.forEach(hub=>{
    const keyCol = `${hub.name}_id`;
    if (!hub.columns.some(c=>c.name===keyCol)) return; // sanity check — skip if this hub doesn't even have its own expected key column
    spSchemaTables.forEach(t=>{
      if (t.name===hub.name) return;
      if (t.columns.some(c=>c.name===keyCol)) lines.push(`${t.name} joins to ${hub.name} via ${keyCol}`);
    });
  });
  return lines.join('\n');
}

function spSchemaSummaryWithJoinsText(){
  const joinMap = spComputeJoinMap();
  return spSchemaSummaryText() + (joinMap
    ? `\n\nKnown joins, derived directly from shared hash-key columns above (this is the complete, authoritative join list — every valid join path is in it; do not join two tables on any column not listed here, and do not invent a join that isn't in this list):\n${joinMap}`
    : '');
}

// Studio Plus routes through the same provider-agnostic helper as the
// Designer's AI Assist — OpenAI, Anthropic, or a custom endpoint.
async function spCallOpenAI(rules, userMsg, temperature){
  return aiChat(rules, userMsg, temperature);
}

async function spSuggestDashboardPlan(){
  spDashboardPlanStatus = 'loading';
  renderAll();
  const standardRules = `You are a senior BI analyst. You are given the table and column names of a Data Vault 2.0 schema (hub_* = business entities, link_* = relationships between them, sat_*/lsat_* = descriptive/history attributes attached to a hub or link, joined via their hash key columns). Based ONLY on these names — no row values exist or should be assumed — design ONE comprehensive, cohesive dashboard for this data, not a list of separate unrelated report ideas. Propose 4 to 7 sections that together tell a complete story about this schema — typically an overview/KPI section plus several more specific breakdowns — each one a piece of a single dashboard rather than a standalone report.
Respond with ONLY minified JSON, no prose, no markdown fences, matching exactly this shape:
{"title":"short dashboard title","sections":[{"name":"short section name","description":"1-2 sentences on what this section shows and roughly which tables it draws from"}]}`;
  const businessRules = `You are the business-analysis lead on a BI consulting engagement. You are given a Data Vault 2.0 schema, table row counts, actual data types, and an authoritative list of valid joins. Do NOT jump straight to generic charts. First infer the likely business entities, events, lifecycle/status concepts, measures, dates and useful decision questions supported by the schema. Then design ONE cohesive, business-ready analytical report with 4 to 8 complementary sections.

The quality bar is a consultant-built analytical application, not a table browser. Where the available fields support them, actively consider techniques such as: executive KPI/variance summary; lifecycle or funnel analysis; cohort/retention analysis; recency-frequency-value or other scoring/segmentation; Pareto/concentration; contribution analysis; rankings; stage ageing and velocity; conversion; trends and period comparisons; exception analysis; performance bands; relationship/network analysis; and historical change from satellites. Only choose techniques that the supplied schema can actually support. Never invent a field, business event, relationship, target, budget or benchmark that is not evidenced by the schema.

Each proposed section must answer a distinct business question and state the analytical technique it will use. The sections should tell a story together: orient the reader, explain drivers, expose segments/behaviour, and finish with actionable detail or exceptions. Avoid proposing multiple sections that are merely the same aggregation sliced a different way.

Respond with ONLY minified JSON, no prose, no markdown fences, matching exactly this shape:
{"title":"short business report title","report_goal":"one sentence describing the decisions this report helps with","sections":[{"name":"short section name","business_question":"the decision-useful question answered","analysis_type":"e.g. Executive summary, Cohort analysis, RFV segmentation, Funnel, Pareto, Trend, Exceptions","description":"1-2 sentences describing the analysis and the likely vault objects involved"}]}`;
  const rules = spBusinessReady ? businessRules : standardRules;
  const userMsg = `Data Vault schema (table_name[row count](column:data_type, ...)) and authoritative joins:\n${spSchemaSummaryWithJoinsText()}`;
  try {
    const parsed = await spCallOpenAI(rules, userMsg, spBusinessReady ? 0.35 : 0.4);
    if (!parsed.title || !Array.isArray(parsed.sections) || !parsed.sections.length) throw new Error('Model response was missing a title or sections.');
    spDashboardPlan = parsed;
    spSectionsIncluded = new Set(parsed.sections.map((_,i)=>i));
    spDashboardPlanStatus = 'ok';
    toast(`Proposed "${parsed.title}" with ${parsed.sections.length} section(s).`, 'ok');
  } catch(err){
    spDashboardPlanStatus = 'error';
    toast('Could not get a report suggestion: ' + err.message, 'err');
  }
  renderAll();
}

function spValidationSql(sql){
  return `SELECT * FROM (${sql}) AS _sp_validate LIMIT 0`;
}

async function spValidateViewList(views){
  const results = {};
  for (const v of (views||[])){
    const key = spViewKey(v);
    try {
      await spQuery(spValidationSql(spOverrides[key] != null ? spOverrides[key] : (v.sql||'')));
      results[key] = { ok:true };
    } catch(err){
      results[key] = { ok:false, error:err.message };
    }
  }
  return results;
}

function spSampleSql(sql){
  return `SELECT * FROM (${sql}) AS _sp_ai_sample LIMIT ${SP_AI_SAMPLE_ROWS}`;
}

function spSanitizeAiSampleRows(rows){
  return (rows||[]).slice(0,SP_AI_SAMPLE_ROWS).map(row=>{
    const out = {};
    Object.keys(row||{}).slice(0,SP_AI_SAMPLE_COLUMNS).forEach(key=>{
      const value = row[key];
      if (value == null || typeof value==='number' || typeof value==='boolean') out[key] = value;
      else {
        const text = String(value);
        out[key] = text.length > SP_AI_SAMPLE_STRING ? text.slice(0,SP_AI_SAMPLE_STRING) + '…' : text;
      }
    });
    return out;
  });
}

async function spCollectResultSamples(views){
  const samples = [];
  let remainingChars = SP_AI_SAMPLE_TOTAL_CHARS;
  for (const v of (views||[])){
    const key = spViewKey(v);
    const sql = spOverrides[key] != null ? spOverrides[key] : (v.sql||'');
    const rows = await spQuery(spSampleSql(sql));
    const sanitized = spSanitizeAiSampleRows(rows);
    const kept = [];
    for (const row of sanitized){
      const cost = JSON.stringify(row).length;
      if (cost > remainingChars) break;
      kept.push(row);
      remainingChars -= cost;
    }
    samples.push({
      view_name:v.view_name,
      sheet_name:v.sheet_name,
      purpose:v.purpose||'',
      columns:v.columns||[],
      sampled_rows:kept,
      sample_truncated:kept.length < sanitized.length,
    });
    if (remainingChars <= 0) break;
  }
  return samples;
}

function spBusinessAnalyticsCookbook(){
  return `ANALYTICS COOKBOOK — choose only what the available data genuinely supports:\n- Executive performance: headline KPIs, current vs prior period, variance, contribution and driver views.\n- Customer/account: lifetime value, RFV/RFM, engagement, acquisition/retention cohorts, repeat behaviour, concentration, segmentation, inactivity/churn proxies.\n- Sales/pipeline: funnel conversion, stage ageing, deal velocity, average deal size, owner performance, won/lost analysis, pipeline mix and coverage when targets exist.\n- Finance: actual/period variance, margin and contribution, revenue/cost bridges, working-capital style ageing where fields exist.\n- Operations: throughput, cycle time, backlog ageing, SLA/exception analysis, capacity/utilisation where fields exist.\n- Data Vault history: entity state over time, change frequency, latest-state snapshots, relationship growth, record-source mix and data freshness.\n- General: Pareto, rankings, cohorts, heatmaps, distributions, quadrants, score bands, anomaly/exception lists and relationship/network views.`;
}

async function spGenerateBusinessReadyReport(directionParts){
  spGenerateStage = 'Planning analytical datasets…';
  renderAll();
  const sqlRules = `You are a senior BI consultant and analytics engineer. Translate the approved business-report blueprint into a small set of robust ${spConn.dialect==='mysql'?'MySQL':'PostgreSQL'} reporting datasets over a Data Vault 2.0 schema.

${spBusinessAnalyticsCookbook()}

SQL RULES:
- SELECT statements only. Never CREATE/ALTER/INSERT/UPDATE/DELETE.
- Use ONLY tables/columns supplied and ONLY joins in the authoritative join list. If two desired objects have no listed path, do not invent one.
- Recheck every SELECT/GROUP BY/WHERE column against the alias/table that actually owns it.
- Use actual supplied data types. Explicitly cast textual numerics before arithmetic and textual dates before date math.
- Build analytical datasets, not raw table dumps. Derive useful business measures when the source fields genuinely support them.
- Prefer one primary dataset per report section so the saved HTML can rerender that section from one refreshed Excel sheet.
- Keep outputs stable and refresh-safe: deterministic column names, no data-dependent aliases, no hardcoded values observed from a sample.
- Do not terminate the SELECT with a semicolon and do not add a final ORDER BY; the report renderer performs presentation sorting and Studio wraps the SELECT for validation/result sampling.

For each section include its business question, analysis type and role in the story. Do NOT write rendering JavaScript yet. Respond ONLY with minified JSON matching:
{"views":[{"sheet_name":"ExcelSafe31Chars","view_name":"short_snake_case","purpose":"what business analysis this dataset supports","sql":"SELECT ...","columns":["exact_output_col1","exact_output_col2"]}],"sections":[{"view_name":"must match a view_name","title":"business-facing title","business_question":"question answered","analysis_type":"technique","story_role":"executive|driver|segment|trend|exception|detail","description":"what this section should communicate"}],"notes":"brief assumptions or limitations"}`;
  const userMsg = `Data Vault schema and authoritative joins:\n${spSchemaSummaryWithJoinsText()}\n\nApproved report direction:\n${directionParts.join('\n\n')}`;
  const draft = await spCallOpenAI(sqlRules, userMsg, 0.2);
  if (!Array.isArray(draft.views) || !draft.views.length || !Array.isArray(draft.sections) || !draft.sections.length) throw new Error('Business-analysis pass did not return views and sections.');

  spGenerateStage = 'Validating SQL…';
  renderAll();
  spViewValidation = await spValidateViewList(draft.views);
  const failures = Object.entries(spViewValidation).filter(([,v])=>!v.ok);
  if (failures.length){
    spGenerated = { views:draft.views, sections:draft.sections.map(s=>({...s,render_js:''})), notes:`The business-analysis plan was created, but ${failures.length} generated SQL view(s) failed validation. Fix the SQL below, then regenerate the report.` };
    spGenerateStatus = 'error'; spGenerateStage = '';
    renderAll();
    throw new Error(`${failures.length} generated SQL view(s) failed validation: ${failures.map(([k,v])=>`${k}: ${v.error}`).join('; ')}`);
  }

  let samples = [];
  if (spResultAwareDesign){
    spGenerateStage = 'Reviewing live result samples…';
    renderAll();
    samples = await spCollectResultSamples(draft.views);
  }

  spGenerateStage = 'Designing business-ready report…';
  renderAll();
  const designRules = `You are a senior BI report designer and frontend analyst. The SQL datasets have already been validated. Design a polished, reusable, business-ready HTML analytical report from those datasets.

QUALITY BAR:
- Think like a consultant presenting to business users, not a chart generator.
- Establish clear visual hierarchy and analytical storytelling. The opening section should orient the reader with a strong executive summary or hero analysis when appropriate; later sections should explain drivers, segments/behaviour and exceptions/detail.
- Do not force the same layout into every section. Use the analytical technique that fits the business question: KPI strips, period variance, ranking bars, area/line trends, Pareto, funnels, cohort heatmaps, score bands, quadrants, timelines, relationship diagrams, waterfall-like bridges, compact detail tables, etc.
- The supplied live result samples are for choosing an effective design and understanding data shape. NEVER hardcode sample values, names, dates, insights or percentages into render_js. Every displayed value and every data-dependent sentence must be recalculated from the rows parameter so the SAME HTML remains correct when the workbook is refreshed months later.
- Explain important derived metrics and assumptions in concise business language. Dynamic insight text is encouraged when it is calculated from rows at render time.
- Detail tables support the story; they should normally be secondary/collapsible rather than dominating the page.

RUNTIME TOOLBOX:
Each render_js is the BODY of a function receiving exactly rows, el and echarts. rows is an array of objects with the exact output columns declared for its view; el is an empty section container; echarts is Apache ECharts when the CDN loaded, otherwise it may be undefined. You may use HTML5, CSS Grid/Flexbox, DOM APIs, inline SVG and ECharts. Prefer ECharts for conventional charts and custom SVG/HTML when a bespoke business visual (timeline, cohort matrix, scorecard, journey) communicates better. If using ECharts, create a chart container inside el, check that echarts exists, initialise it with echarts.init(container), and give the container an explicit height. If ECharts is unavailable, keep the section useful with an HTML/SVG/table fallback rather than throwing. Do not access XLSX or fetch data. Do not assume any global except standard browser APIs and the passed echarts value.

ROBUSTNESS:
Treat spreadsheet cells as sparse/untrusted. Guard missing rows/elements, coerce numerics with Number(value)||0 where appropriate, parse dates defensively, handle empty datasets gracefully, and never throw because a filter has no matching rows. Any filter must recalculate the section in memory. Do not use eval/new Function inside render_js.

Return ONLY minified JSON matching:
{"sections":[{"view_name":"must match an existing dataset","title":"business-facing title","render_js":"JavaScript function body using rows, el, echarts"}],"notes":"2-4 sentences describing the analytical story and any important data limitations"}`;
  const designInput = {
    report_title:(spDashboardPlan&&spDashboardPlan.title)||'Business report',
    report_goal:(spDashboardPlan&&spDashboardPlan.report_goal)||'',
    planned_sections:draft.sections,
    datasets:draft.views.map(v=>({view_name:v.view_name,sheet_name:v.sheet_name,purpose:v.purpose||'',columns:v.columns||[]})),
    live_result_samples:spResultAwareDesign?samples:'NOT PROVIDED — design from dataset columns and blueprint only',
  };
  const designed = await spCallOpenAI(designRules, JSON.stringify(designInput), 0.35);
  if (!Array.isArray(designed.sections) || !designed.sections.length) throw new Error('Report-design pass did not return any sections.');
  const validViews = new Set(draft.views.map(v=>v.view_name));
  const badSection = designed.sections.find(sec=>!validViews.has(sec.view_name));
  if (badSection) throw new Error(`Report-design pass referenced unknown dataset "${badSection.view_name}".`);

  spGenerated = {
    views:draft.views,
    sections:designed.sections,
    notes:[draft.notes, designed.notes].filter(Boolean).join(' '),
    report_goal:(spDashboardPlan&&spDashboardPlan.report_goal)||'',
    generation_mode:'business-ready',
  };
  spOverrides = {}; spExpanded = {}; spSectionOverrides = {};
  spViewValidation = await spValidateViewList(spGenerated.views);
  spGenerateStatus = 'ok'; spGenerateStage = '';
  toast(`Generated business-ready report with ${spGenerated.views.length} live dataset(s) and ${spGenerated.sections.length} section(s).`, 'ok');
  renderAll();
}

async function spGenerateStandardReport(){
  const includedSections = spDashboardPlan ? spDashboardPlan.sections.filter((s,i)=>spSectionsIncluded.has(i)) : [];
  const directionParts = [];
  if (includedSections.length){
    directionParts.push(`Build a single cohesive dashboard titled "${spDashboardPlan.title}" with these sections:\n` + includedSections.map(s=>`- ${s.name}: ${s.description}`).join('\n'));
  }
  if (spCustomDirection.trim()) directionParts.push('Additional direction from the person:\n' + spCustomDirection.trim());
  if (!directionParts.length){ toast('Get a dashboard suggestion first, or describe what you want, before generating.', 'err'); return; }
  spGenerateStatus = 'loading';
  renderAll();
  // Note on architecture: earlier versions of this asked the model to write
  // one giant self-contained HTML report (file-loading, sheet-parsing, all
  // of it) in a single JSON string. That gave the model too much surface
  // area, and nothing verified afterward that the report's parsing logic
  // actually agreed with the workbook it also described — a two-file
  // consistency problem with no check on it. Now the app itself owns the
  // shell (file loading, sheet parsing by the exact sheet_name/columns
  // below, branding, layout) — see spBuildReportHtml() — and the model is
  // only asked for one small, verifiable thing per section: given rows
  // already parsed into objects with known keys, render into a container.
  const rules = `You are a senior BI engineer. You are given a Data Vault 2.0 schema (table and column names only, hub_*/link_*/sat_*/lsat_* naming) and a description of the dashboard a business user wants. Produce:
1. A small number of plain ${spConn.dialect==='mysql'?'MySQL':'PostgreSQL'} reporting queries — SELECT statements only, do not use CREATE VIEW, just the SELECT body — that join the raw vault tables using ONLY the join list given below (each line names the two tables and the exact column to join them on) — that list is complete and authoritative, so if two tables you want to relate aren't in it, there is no direct join between them and you must go through whatever table does connect them, not guess a join condition of your own. Never invent a column or table name that was not given to you. If a join you set up doesn't end up feeding any output column, remove it rather than leaving it in unused. The schema gives each column's actual data type. Never call SUM/AVG or do numeric math on text without an explicit dialect-correct numeric cast, and cast date/timestamp-like text before date math.
2. For each view: a short sheet_name (Excel-safe, 31 characters or fewer, no spaces), a short_snake_case view_name, and the exact list of output column names it returns, in order. Before finishing, check every column reference in SELECT/GROUP BY/WHERE against the column list given for whichever table its alias actually points to — this has been the single most common mistake so far (e.g. writing s.some_column when s is aliased to a table that was never given that column).
3. One dashboard section per view (or per logical group of related views), each with a title and a render_js string. render_js is the BODY of a function — not the function declaration, just the statements inside it — that receives two parameters named exactly rows and el: rows is a plain JavaScript array of row objects already parsed from the matching sheet (each object's keys are exactly the columns list you gave for that view — the app has already handled file loading and sheet parsing, you never need to touch XLSX/file APIs at all), and el is an empty DOM element already in the page for you to render into by setting el.innerHTML. Every section must, inside its render_js:
   a. Compute and render a row of KPI stat cards from rows in plain JavaScript (total, average, count, min/max — whichever are meaningful for that view's actual columns). This is the first thing rendered, not an afterthought.
   b. Render at least one chart, unless rows has no numeric measure to aggregate at all. Pick the chart from the data shape actually present in rows: a time-like column + a measure → bar/line over time; one category column + a measure → a ranked bar chart; two category columns + a measure → an actual pivot (group rows by both categories in JavaScript, render as a table with the first category as rows and the second as columns, cells = aggregated measure — not just the flat rows relabeled). Build the chart as inline SVG markup assigned into el.innerHTML alongside the rest of the section — no charting library exists in this page, so write the SVG string yourself the same way you'd build any other HTML string. The chart is the main output of the section; the raw table is secondary.
   c. Render the detail rows last and collapsed by default (e.g. behind a <details> element or a toggle button), never as the first or only thing shown.
   d. Add at least one working interactive filter appropriate to that section's actual columns — a date range if there's a date-like column, and/or a dropdown built from the distinct values actually present in rows (never invented) for whichever category column is most relevant. The filter must actually work: changing it must re-run your grouping/aggregation over rows (in memory, no reload) and update that section's KPIs, chart, and table in place. Skip this only if the section genuinely has no sensible filter dimension.
   Everything you do — KPI math, grouping, pivoting, chart SVG, filter wiring, DOM updates — must be built with plain JavaScript and DOM APIs only inside render_js; there is no other script, library, or global available to you besides rows, el, and standard browser JavaScript. Real spreadsheets are frequently sparse — treat every cell value as possibly missing, blank, or the wrong type, and code defensively throughout: never read a property off the result of array.find/filter/querySelector/getElementById without first checking that result isn't undefined or null; when converting a cell value to a number, use something like (Number(row.someColumn) || 0) rather than assuming it's already numeric; when grouping or building a dropdown's options, skip or bucket rows where the grouping column is blank rather than letting them throw. A section should degrade to showing fewer rows or a "no data for this filter" message, never throw an uncaught error the person can't do anything about.
Respond with ONLY minified JSON, no prose, no markdown fences, matching exactly this shape:
{"views":[{"sheet_name":"...","view_name":"...","sql":"SELECT ...","columns":["col1","col2"]}],"sections":[{"view_name":"...","title":"...","render_js":"var total = rows.reduce(...); el.innerHTML = ...;"}],"notes":"2-3 plain-English sentences on what was built and anything to know before using it"}`;
  const userMsg = `Data Vault schema (table_name(column:data_type, ...)):\n${spSchemaSummaryWithJoinsText()}\n\n${directionParts.join('\n\n')}`;
  try {
    const parsed = await spCallOpenAI(rules, userMsg, 0.2);
    if (!Array.isArray(parsed.views) || !Array.isArray(parsed.sections) || !parsed.sections.length) throw new Error('Model response was missing views or sections.');
    spGenerated = parsed;
    spOverrides = {}; spExpanded = {}; spSectionOverrides = {}; spViewValidation = {};
    spGenerateStatus = 'ok';
    toast(`Generated ${parsed.views.length} view(s) across ${parsed.sections.length} section(s). Validating SQL…`, 'ok');
    renderAll();
    await spValidateGeneratedViews();
    return;
  } catch(err){
    spGenerateStatus = 'error';
    toast('Could not generate the report: ' + err.message, 'err');
  }
  renderAll();
}


async function spGenerateReport(){
  const includedSections = spDashboardPlan ? spDashboardPlan.sections.filter((s,i)=>spSectionsIncluded.has(i)) : [];
  const directionParts = [];
  if (includedSections.length){
    directionParts.push(`Build a single cohesive report titled "${spDashboardPlan.title}" with these sections:\n` + includedSections.map(s=>`- ${s.name}${s.business_question?` — ${s.business_question}`:''}: ${s.description}`).join('\n'));
  }
  if (spCustomDirection.trim()) directionParts.push('Additional direction from the person:\n' + spCustomDirection.trim());
  if (!directionParts.length){ toast('Get a report suggestion first, or describe what you want, before generating.', 'err'); return; }
  if (!spBusinessReady) return spGenerateStandardReport();
  spGenerateStatus = 'loading'; spGenerateStage = 'Planning analytical datasets…'; spGenerated = null;
  spOverrides = {}; spExpanded = {}; spSectionOverrides = {}; spViewValidation = {};
  renderAll();
  try {
    await spGenerateBusinessReadyReport(directionParts);
  } catch(err){
    spGenerateStatus = 'error'; spGenerateStage = '';
    toast('Could not generate the business-ready report: ' + err.message, 'err');
    renderAll();
  }
}


// Builds (or refreshes, if existingWb is passed) the workbook by actually
// running each view's SQL against the connected vault, via the same
// single-SELECT-only /api/query endpoint introspection already uses — no
// server changes needed, since every generated view is exactly that: one
// plain SELECT. Per-view failures are collected rather than aborting the
// whole workbook, so one bad view doesn't block the rest.
async function spBuildWorkbookLive(existingWb){
  const wb = existingWb || XLSX.utils.book_new();
  const instructions = [['Sheet', 'SQL used to populate this sheet (kept for reference / manual re-run elsewhere)']];
  const errors = [];
  for (const v of (spGenerated.views||[])){
    const sheetName = String(v.sheet_name||v.view_name||'Sheet').slice(0,31);
    const sql = spGetViewSql(v);
    let rows = [];
    try {
      rows = await spQuery(sql);
    } catch(err){
      errors.push(`${sheetName}: ${err.message}`);
    }
    const header = (v.columns && v.columns.length) ? v.columns : (rows[0] ? Object.keys(rows[0]) : ['column1']);
    const aoa = [header, ...rows.map(r=>header.map(h=> r[h]!==undefined && r[h]!==null ? r[h] : ''))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (existingWb && existingWb.Sheets[sheetName]){
      existingWb.Sheets[sheetName] = ws; // overwrite in place, leave any other sheets in the file untouched
    } else {
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }
    instructions.push([sheetName, sql]);
  }
  const instrWs = XLSX.utils.aoa_to_sheet(instructions);
  if (existingWb && existingWb.Sheets['Instructions']) existingWb.Sheets['Instructions'] = instrWs;
  else if (!existingWb) XLSX.utils.book_append_sheet(wb, instrWs, 'Instructions');
  return { wb, errors };
}

async function spDownloadWorkbook(){
  if (!spGenerated) return;
  const btn = document.getElementById('btn-sp-dl-excel');
  if (btn){ btn.disabled = true; btn.textContent = 'Running queries…'; }
  try {
    const { wb, errors } = await spBuildWorkbookLive();
    XLSX.writeFile(wb, `${state.vault.name||'vault'}_studio_plus.xlsx`, { bookType: 'xlsx' });
    toast(errors.length ? `Downloaded, but ${errors.length} view(s) failed to run — see toast log / Instructions sheet.` : 'Workbook downloaded with live data.', errors.length?'err':'ok');
    errors.forEach(e=>toast(e,'err'));
  } catch(err){
    toast('Could not build the workbook: ' + err.message, 'err');
  }
  if (btn){ btn.disabled = false; btn.textContent = '⬇ Download Excel workbook (runs SQL live)'; }
}

async function spRefreshUploadedWorkbook(file){
  if (!spGenerated) return;
  const statusEl = document.getElementById('sp-refresh-status');
  if (statusEl) statusEl.innerHTML = `<div class="ai-status busy mt"><span class="dot"></span>Refreshing…</div>`;
  try {
    const data = await file.arrayBuffer();
    const existingWb = XLSX.read(data, { type:'array' });
    const { errors } = await spBuildWorkbookLive(existingWb);
    const outName = file.name.replace(/\.xlsx?$/i,'') + '_refreshed.xlsx';
    XLSX.writeFile(existingWb, outName, { bookType:'xlsx' });
    if (statusEl) statusEl.innerHTML = errors.length
      ? `<div class="ai-status err mt">Refreshed and downloaded as ${escapeHtml(outName)}, but ${errors.length} view(s) failed: ${errors.map(escapeHtml).join('; ')}</div>`
      : `<div class="ai-status ok mt">Refreshed — downloaded as ${escapeHtml(outName)}.</div>`;
  } catch(err){
    if (statusEl) statusEl.innerHTML = `<div class="ai-status err mt">Could not refresh that file: ${escapeHtml(err.message)}</div>`;
  }
}
// The Millersoft mark, used verbatim from the main app's own header so
// the banner is guaranteed present on every generated report rather than
// depending on the model remembering to include it.
// Pulled live from millersoft.co rather than embedded, so every time
// someone opens a generated report, this image request shows up in your
// own server's access logs -- a simple, standard way to get a usage signal
// out of an otherwise fully offline static file, without building any
// dedicated analytics into the report itself.
const SP_MILLERSOFT_LOGO = "https://millersoft.co/img/data-vault/dvs-header-image.png";

const SP_REPORT_CSS = "*{box-sizing:border-box;}"
  + "body{font-family:'Inter',sans-serif;margin:0;background-color:#faf7fc;background-image:radial-gradient(circle, rgba(123,31,162,0.10) 1px, transparent 1px);background-size:24px 24px;color:#1a0a1e;}"
  + "header{background:#4a2060;color:#fff;padding:14px 24px;display:flex;align-items:center;gap:14px;}"
  + "header img{height:30px;width:auto;display:block;}"
  + "header h1{margin:0;font-size:18px;font-weight:800;letter-spacing:.2px;}"
  + "main{padding:22px;max-width:1200px;margin:0 auto;}"
  + "input[type=file]{margin:12px 0 20px;font-family:'IBM Plex Mono',monospace;font-size:12.5px;background:#fff;border:1px solid #e2d3ec;border-radius:4px;padding:8px 10px;color:#1a0a1e;}"
  + ".sp-section{background:#fff;border:1px solid #e2d3ec;border-radius:4px;padding:18px;margin:0 0 18px;box-shadow:0 1px 2px rgba(74,32,96,.05);}"
  + ".sp-section h2{margin:0 0 12px;font-family:'Inter',sans-serif;font-size:15px;font-weight:700;color:#4a2060;text-transform:uppercase;letter-spacing:.3px;}"
  + ".sp-section table{width:100%;border-collapse:collapse;font-size:12.5px;font-family:'IBM Plex Mono',monospace;}"
  + ".sp-section th,.sp-section td{border-bottom:1px solid #ede1f4;padding:8px 10px;text-align:left;vertical-align:top;}"
  + ".sp-section th{background:#f6eefb;color:#4a2060;font-weight:600;}"
  + ".sp-section tr:hover td{background:#f5eefa;}"
  + ".sp-empty{padding:28px;border:2px dashed #e2d3ec;border-radius:4px;background:#fff;color:#7a6b84;}"
  + ".sp-error{padding:14px;border:1px solid #f3c9c9;border-radius:4px;background:#fdf1f1;color:#b3261e;font-family:'IBM Plex Mono',monospace;font-size:12px;white-space:pre-wrap;}"
  + ".sp-pill{background:#f3e6fa;color:#4a2060;border-radius:999px;padding:6px 12px;font-size:12px;font-family:'IBM Plex Mono',monospace;font-weight:600;display:inline-block;margin:0 8px 8px 0;}"
  + ".sp-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:0 0 18px;}"
  + ".sp-kpi{padding:15px 16px;border:1px solid #e7dcec;border-radius:12px;background:linear-gradient(180deg,#fff,#fbf8fd);}"
  + ".sp-kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#7a6b84;font-weight:700;}"
  + ".sp-kpi-value{font-size:26px;line-height:1.1;font-weight:800;color:#2c1238;margin-top:7px;}"
  + ".sp-kpi-sub{font-size:11px;color:#7a6b84;margin-top:5px;}"
  + ".sp-grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;}"
  + ".sp-chart{width:100%;min-height:320px;}"
  + ".sp-insight{border-left:4px solid #7b1fa2;background:#f8f0fc;padding:12px 14px;border-radius:0 9px 9px 0;line-height:1.55;margin:12px 0;}"
  + ".sp-toolbar{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:0 0 14px;}"
  + ".sp-toolbar label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7a6b84;}"
  + ".sp-toolbar select,.sp-toolbar input{display:block;margin-top:4px;padding:7px 9px;border:1px solid #dbcbe5;border-radius:7px;background:#fff;}"
  + ".sp-section-nav{position:sticky;top:0;z-index:20;display:flex;gap:6px;overflow-x:auto;padding:9px 0 10px;margin:0 0 16px;background:rgba(250,247,252,.96);backdrop-filter:blur(8px);border-bottom:1px solid #eadff0;}"
  + ".sp-section-nav a{white-space:nowrap;text-decoration:none;color:#4a2060;background:#fff;border:1px solid #decfe7;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:700;}"
  + ".sp-section-nav a:hover{background:#f3e6fa;border-color:#caa9dc;}"
  + "@media(max-width:760px){.sp-grid-2{grid-template-columns:1fr;}main{padding:14px;}}"
  + "svg{max-width:100%;background:#fff;}";

// Deterministic report shell: the app owns file loading, sheet parsing
// (using the exact sheet_name/columns from spGenerated.views — the same
// values used to build the workbook, so there is no way for the report to
// expect a different sheet or column name than the workbook actually has),
// branding, and layout. The model's render_js only ever runs against
// rows already parsed into the shape it was told to expect.
function spBuildReportHtml(){
  const g = spGenerated;
  const title = (spDashboardPlan && spDashboardPlan.title) || state.vault.name || 'Data Vault Report';
  const viewsJson = JSON.stringify(g.views || []);
  const sectionsJson = JSON.stringify((g.sections||[]).map((s,i)=>({
    view_name: s.view_name,
    title: s.title,
    render_js: spSectionOverrides[i] != null ? spSectionOverrides[i] : (s.render_js||''),
  })));
  const parts = [];
  parts.push('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">');
  parts.push('<title>' + escapeHtml(title) + '</title>');
  parts.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
  parts.push('<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">');
  parts.push('<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"><' + '/script>');
  parts.push('<script src="https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js"><' + '/script>');
  parts.push('<style>' + SP_REPORT_CSS + '</style>');
  parts.push('</head><body>');
  parts.push('<header><a href="https://millersoft.co/data-vault-services" target="_blank" rel="noopener"><img src="' + SP_MILLERSOFT_LOGO + '" alt="Millersoft"></a><h1>' + escapeHtml(title) + '</h1></header>');
  parts.push('<main>');
  if (g.report_goal) parts.push('<div class="sp-insight"><strong>Report purpose</strong><br>' + escapeHtml(g.report_goal) + '</div>');
  parts.push('<input id="sp-report-file" type="file" accept=".xlsx,.xls">');
  parts.push('<div id="sp-report-status" class="sp-empty">No workbook loaded yet.</div>');
  parts.push('<nav id="sp-report-nav" class="sp-section-nav" style="display:none"></nav>');
  parts.push('<div id="sp-report-content"></div>');
  parts.push('</main>');
  parts.push('<' + 'script>');
  parts.push('var SP_VIEWS = ' + viewsJson + ';');
  parts.push('var SP_SECTIONS = ' + sectionsJson + ';');
  parts.push([
    'var statusEl = document.getElementById("sp-report-status");',
    'var contentEl = document.getElementById("sp-report-content");',
    'var navEl = document.getElementById("sp-report-nav");',
    'document.getElementById("sp-report-file").addEventListener("change", function(e){',
    '  var f = e.target.files && e.target.files[0];',
    '  if (!f) return;',
    '  var reader = new FileReader();',
    '  reader.onload = function(ev){',
    '    var wb;',
    '    try { wb = XLSX.read(new Uint8Array(ev.target.result), {type:"array"}); }',
    '    catch(err){ statusEl.className = "sp-error"; statusEl.textContent = "Could not read that file: " + err.message; return; }',
    '    contentEl.innerHTML = "";',
    '    var missing = SP_VIEWS.filter(function(v){ return !wb.Sheets[v.sheet_name]; }).map(function(v){ return v.sheet_name; });',
    '    statusEl.className = missing.length ? "sp-error" : "sp-pill";',
    '    statusEl.textContent = missing.length ? ("Loaded, but missing expected sheet(s): " + missing.join(", ")) : ("Loaded " + f.name + " successfully.");',
    '    var rowsBySheet = {};',
    '    if (navEl) { navEl.innerHTML = ""; navEl.style.display = SP_SECTIONS.length > 1 ? "flex" : "none"; }',
    '    SP_SECTIONS.forEach(function(sec, idx){ if (!navEl || SP_SECTIONS.length <= 1) return; var a=document.createElement("a"); a.href="#sp-report-section-"+idx; a.textContent=sec.title||sec.view_name; navEl.appendChild(a); });',
    '    SP_VIEWS.forEach(function(v){',
    '      var sheet = wb.Sheets[v.sheet_name];',
    '      rowsBySheet[v.view_name] = sheet ? XLSX.utils.sheet_to_json(sheet, {defval:""}) : [];',
    '    });',
    '    SP_SECTIONS.forEach(function(sec, secIndex){',
    '      var card = document.createElement("div");',
    '      card.className = "sp-section";',
    '      card.id = "sp-report-section-" + secIndex;',
    '      var h2 = document.createElement("h2");',
    '      h2.textContent = sec.title || sec.view_name;',
    '      var body = document.createElement("div");',
    '      card.appendChild(h2); card.appendChild(body);',
    '      contentEl.appendChild(card);',
    '      var rows = rowsBySheet[sec.view_name] || [];',
    '      try {',
    '        var renderFn = new Function("rows", "el", "echarts", sec.render_js || "");',
    '        renderFn(rows, body, window.echarts);',
    '      } catch(err){',
    '        var errDiv = document.createElement("div");',
    '        errDiv.className = "sp-error";',
    '        errDiv.textContent = "This section failed to render: " + err.message;',
    '        body.appendChild(errDiv);',
    '      }',
    '    });',
    '  };',
    '  reader.readAsArrayBuffer(f);',
    '});',
  ].join('\n'));
  parts.push('<' + '/script>');
  parts.push('</body></html>');
  return parts.join('');
}

function spDownloadReportHtml(){
  if (!spGenerated) return;
  downloadBlob(spBuildReportHtml(), `${state.vault.name||'vault'}_studio_plus_report.html`, 'text/html');
}

