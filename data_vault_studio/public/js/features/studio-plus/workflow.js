/* Studio Plus — workflow tabs, status bar, auto-infer on entry, Build step and Reporting scope markup. */
// Objects that still need a (re)deploy. Models without SQL are listed but can
// only be counted, not deployed, until their SELECT exists.
function spPendingDeployItems(){
  const bv=spManagedBvObjects().filter(o=>o.status!=='deployed'||!o.deployedAt).map(obj=>({kind:'bv',obj}));
  const models=spManagedViews().filter(v=>!spIsTechnicalViewName(v.name)&&(v.status!=='deployed'||!v.deployedAt)).map(obj=>({kind:'model',obj}));
  return [...bv,...models];
}
function spPendingSummary(){
  const items=spPendingDeployItems();
  const errors=items.filter(i=>i.obj.status==='error').length;
  const blocked=items.filter(i=>i.kind==='model'&&!String(i.obj.sql||'').trim()).length;
  return {items,total:items.length,errors,blocked,deployable:items.length-blocked};
}
function spTabBadgeHtml(count,tone,title){
  return count?`<em class="sp-tab-badge ${tone}" title="${escapeHtml(title)}">${count}</em>`:'';
}
function spWorkflowTabsHtml(){
  const ready=spSchemaTables.length>0;
  const pending=spPendingSummary();
  const reports=spManagedReports().length;
  const tabs=[
    ['plan','1','Goal & Plan',''],
    ['build','2','Build',spTabBadgeHtml(pending.total,pending.errors?'err':'warn',`${pending.total} object(s) not deployed${pending.errors?`, ${pending.errors} with errors`:''}`)],
    ['reporting','3','Reporting',spTabBadgeHtml(reports,'ok',`${reports} saved report(s)`)],
  ];
  const disabled=ready?'':'disabled title="Infer the schema first — the workflow unlocks once the deployed Vault is read."';
  const button=(key,num,label,badge,extra='')=>`<button class="sp-workflow-tab ${extra} ${spWorkflowStep===key?'active':''}" data-sp-workflow-step="${key}" role="tab" aria-selected="${spWorkflowStep===key?'true':'false'}" ${disabled}>${num?`<span>${num}</span>`:''}${label}${badge}</button>`;
  return `<div class="sp-workflow-tabs" role="tablist">${tabs.map(t=>button(...t)).join('')}<span class="sp-workflow-tabs-spacer"></span>${button('lineage','','Lineage','','secondary')}</div>`;
}
function spStatusBarHtml(){
  const dialectLabel=spSqlDialectLabel();
  const ready=spSchemaStatus==='ok'&&spSchemaTables.length>0;
  const target=spSchemaStatus==='loading'?'Connecting…':ready?`${dialectLabel} · ${spConn.database||'target'} · ${spConn.schema||''}`:(spSchemaStatus==='error'?'Connection failed':'Not connected');
  const targetTone=spSchemaStatus==='loading'?'busy':ready?'ok':(spSchemaStatus==='error'?'err':'warn');
  let bvText='n/a',bvTone='muted',bvTitle='';
  if(ready){
    if(!spBusinessSchemaSupported()){bvText='Same schema as Raw Vault';bvTitle=`${dialectLabel} does not use a separate business_vault schema.`;}
    else if(spBusinessSchemaStatus==='ready'){bvText=`${SP_BUSINESS_SCHEMA} ready`;bvTone='ok';}
    else if(spBusinessSchemaStatus==='missing'){bvText=`${SP_BUSINESS_SCHEMA} missing`;bvTone='warn';bvTitle='Create it below before deploying.';}
    else if(spBusinessSchemaStatus==='error'){bvText=`${SP_BUSINESS_SCHEMA} check failed`;bvTone='err';bvTitle=spBusinessSchemaError;}
  }
  const hasKey=aiProvider==='custom'||!!aiKey;
  const provider=(typeof AI_PROVIDERS!=='undefined'&&AI_PROVIDERS[aiProvider])?AI_PROVIDERS[aiProvider].label:aiProvider;
  const pending=spPendingSummary();
  const pendingText=pending.total?`${pending.total} not deployed${pending.errors?` · ${pending.errors} error${pending.errors===1?'':'s'}`:''}`:'';
  return `<div class="sp-statusbar" id="sp-statusbar">
    <button type="button" class="sp-chip ${targetTone}" id="sp-chip-target" title="Show connection details"><span class="sp-chip-label">Target</span>${escapeHtml(target)}</button>
    <span class="sp-chip ${bvTone}" title="${escapeHtml(bvTitle)}"><span class="sp-chip-label">Schema</span>${escapeHtml(bvText)}</span>
    <button type="button" class="sp-chip ${hasKey?'ok':'warn'}" id="sp-chip-ai" title="Show AI provider settings"><span class="sp-chip-label">AI</span>${escapeHtml(provider)}${hasKey?'':' · key needed'}</button>
    <span class="sp-statusbar-spacer"></span>
    ${pending.total?`<span class="sp-chip ${pending.errors?'err':'warn'}"><span class="sp-chip-label">Pending</span>${escapeHtml(pendingText)}</span>`:''}
  </div>`;
}
function spGoToStep(step){
  spWorkflowStep=step;
  if(step==='reporting')spPrefillReportDirection();
  renderAll();
}
function spShowModelLineage(id){
  const view=spFindManagedView(id);if(!view)return;
  spLineageSelection=`curated:${view.name}`;spLineageMode='focus';spLineageZoom=1;
  spGoToStep('lineage');
}
let spAutoInferSignature = '';
function spTargetConfigured(conn){
  return !!(conn&&conn.database&&(conn.user||conn.credentialRef||conn.managedTarget));
}
// Called when the user enters Studio Plus. The target is already known from
// Connections, so read the Vault straight away instead of waiting for a click.
function studioPlusEnter(){
  if(spConn.autoDefault!==false)spConn=studioPlusDefaultConnection();
  if(spSchemaStatus==='loading'||!spTargetConfigured(spConn))return;
  const signature=spSchemaSignature();
  const stale=spSchemaStatus===null
    ||(spSchemaStatus==='ok'&&signature!==spLastSchemaSignature)
    ||(spSchemaStatus==='error'&&signature!==spAutoInferSignature);
  if(!stale)return;
  spAutoInferSignature=signature;
  return spIntrospectSchema({auto:true,quiet:true});
}
function spBusinessVaultAccelerationHtml(){
  const objects=spManagedBvObjects();
  const deployed=objects.filter(o=>o.status==='deployed'&&o.deployedAt).length;
  const pendingBv=objects.length-deployed;
  const editing=!!(spBvDraft.id||spBvDraft.name||spBvDraft.parentHub||(spBvDraft.satellites||[]).length||(spBvDraft.links||[]).length);
  if(!objects.length&&!spBvSectionOpen&&!editing){
    const candidates=spBvRecommendations().length;
    return `<div class="panel sp-bv-acceleration sp-bv-collapsed" id="sp-bv-acceleration"><div class="sp-bv-actions"><strong>Business Vault</strong><span class="sp-optional-badge">optional</span><span class="hint">PIT and Bridge tables speed up history and multi-link queries. ${candidates?`${candidates} candidate${candidates===1?'':'s'} detected.`:'No candidates detected in this Vault.'}</span><button class="btn small ghost" id="btn-sp-bv-open">Add PIT / Bridge tables</button></div></div>`;
  }
  return `<div class="panel sp-bv-acceleration" id="sp-bv-acceleration"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>Business Vault <span class="sp-optional-badge">optional</span></h3><span class="hint">${objects.length?`${objects.length} managed · ${deployed} deployed`:'PIT & Bridge structures'}</span><button class="btn small ghost" id="btn-sp-deploy-bv" ${pendingBv&&!spDeployAllBusy&&!spBvDeployAllBusy&&!spBvDeployingId?'':'disabled'}>Deploy all pending structures${pendingBv?` (${pendingBv})`:''}</button></div><p class="section-desc">Physical PIT and Bridge tables for point-in-time history across Satellites and reusable relationship paths. They deploy to the same target as the Raw Vault, in the business_vault schema when supported.</p><h4>Managed Business Vault tables</h4>${spBvLibraryHtml()}${spBvBuilderHtml()}</div>`;
}

function spBusinessViewsHtml(){
  const views=spManagedViews().filter(v=>!spIsTechnicalViewName(v.name));
  const pendingModels=views.filter(v=>v.status!=='deployed'||!v.deployedAt).length;
  return `<div class="panel">
    <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Business Models</h3><button class="btn small ghost" id="btn-sp-deploy-models" ${pendingModels&&!spDeployAllBusy&&!spViewDeployingId?'':'disabled'}>Deploy all pending models${pendingModels?` (${pendingModels})`:''}</button></div>
    <p class="section-desc">Build business-ready datasets from Raw Vault objects and optional PIT/Bridge tables. Persisted tables are the default for predictable reporting performance; a Business Model never feeds another.</p>
    <div class="sp-bv-kind-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));"><div class="sp-bv-kind-card"><strong>Current</strong><span>Latest business state</span></div><div class="sp-bv-kind-card"><strong>History</strong><span>Temporal entity history</span></div><div class="sp-bv-kind-card"><strong>360</strong><span>Approved related context</span></div><div class="sp-bv-kind-card"><strong>Custom</strong><span>User/AI-defined dataset</span></div></div>
    <h4 class="mt">Business Model Library</h4>${spViewLibraryHtml()}
  </div>${spViewBuilderHtml()}`;
}
function spBuildStepHtml(){
  const pending=spPendingSummary();
  const busy=spDeployAllBusy||spBvDeployAllBusy||spViewDeployingId||spBvDeployingId;
  const blockedTitle=pending.total?`${pending.total} object${pending.total===1?'':'s'} not deployed yet${pending.blocked?` (${pending.blocked} Business Model${pending.blocked===1?'':'s'} still need SQL)`:''}. Deploy everything to continue.`:'';
  const deployAll=pending.total?`<button class="btn primary" id="btn-sp-deploy-pending" ${spSchemaTables.length&&pending.deployable&&!busy?'':'disabled'}>${spDeployAllBusy?'Deploying…':`Deploy all pending (${pending.total})`}</button>`:'';
  return `${spBusinessViewsHtml()}${spBusinessVaultAccelerationHtml()}<div class="sp-workflow-next">${deployAll}<button class="btn primary" data-sp-workflow-step="reporting" ${pending.total||busy?`disabled title="${escapeHtml(blockedTitle)}"`:''}>Continue to Reporting →</button></div>`;
}
function spReportLibraryHtml(){
  const reports=spManagedReports();
  if(!reports.length)return `<div class="panel"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>Report Library</h3><button class="btn small primary" id="btn-sp-report-new">+ New report</button></div><div class="ai-status">No saved reports yet. Generate a report below, review it, then save it to the library.</div></div>`;
  return `<div class="panel"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>Report Library</h3><button class="btn small primary" id="btn-sp-report-new">+ New report</button></div><p class="section-desc">Saved reports travel with the Studio project. Open one to edit its SQL/rendering, regenerate it with AI, rerun it against current Business Model data, or download it again.</p><div class="sp-view-library">${reports.map(r=>`<div class="sp-view-card"><div class="sp-view-card-main"><strong>${escapeHtml(r.name||'Report')}</strong><span class="sp-bv-source-kind">${escapeHtml(spReportStatusLabel(r))}</span><span class="hint">${(r.sourceModels||[]).length} Business Model${(r.sourceModels||[]).length===1?'':'s'} · updated ${r.updatedAt?escapeHtml(new Date(r.updatedAt).toLocaleString()):'unknown'}</span>${(r.sourceModels||[]).length?`<p class="hint mono">${escapeHtml((r.sourceModels||[]).join(' · '))}</p>`:''}</div><div class="sp-view-card-actions"><button class="btn small" data-sp-report-open="${r.id}">Open / Edit</button><button class="btn small ghost" data-sp-report-duplicate="${r.id}">Duplicate</button><button class="btn small ghost" data-sp-report-delete="${r.id}">Delete</button></div></div>`).join('')}</div></div>`;
}
function spReportingScopeHtml(){
  const available=spManagedReportingTables();
  if(!available.length)return `${spReportLibraryHtml()}<div class="panel"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>Reporting</h3></div><div class="ai-status">Load/deploy at least one managed business model before building new reports. Reporting intentionally does not use arbitrary Raw Vault tables.</div></div>`;
  return `${spReportLibraryHtml()}<details class="panel sp-editor-details" id="sp-report-scope" ${spReportScopeOpen?'open':''}><summary><span><strong>Business models</strong></span><span class="hint">${spSelectedSchemaTables().length} of ${available.length} models selected${spReportScopeOpen?'':' · click to change'}</span></summary><div class="sp-editor-body"><p class="section-desc">Choose exactly which business models this report is allowed to use.</p><div class="sp-bv-actions"><button class="btn small ghost" id="btn-sp-report-all">Select all models</button><button class="btn small ghost" id="btn-sp-report-none">Clear</button><span class="hint"><strong>${spSelectedSchemaTables().length}</strong> of ${available.length} models selected</span></div><div class="sp-bv-source-list mt">${available.map(t=>{const managed=spManagedViews().find(v=>v.name===t.name);return `<label class="sp-bv-source-row"><input type="checkbox" data-sp-report-view="${escapeHtml(t.name)}" ${spReportingSources.has(t.name)?'checked':''}><span class="sp-bv-source-name mono">${escapeHtml(t.name)}</span><span class="sp-bv-source-kind">${escapeHtml(spMaterializationLabel(managed||{}))}</span><span class="hint">${t.rowCount==null?'row count unknown':`${t.rowCount} rows`}</span></label>`;}).join('')}</div></div></details>`;
}

let spAiSettingsOpen = null; // null = open only while no API key has been entered
function spAiStepsUseAi(){ return spWorkflowStep!=='lineage'; }
function spAiSettingsPanelHtml(){
  if(!spSchemaTables.length||!spAiStepsUseAi())return '';
  const provider=(typeof AI_PROVIDERS!=='undefined'&&AI_PROVIDERS[aiProvider])?AI_PROVIDERS[aiProvider].label:aiProvider;
  const hasKey=aiProvider==='custom'||!!aiKey;
  const open=spAiSettingsOpen===null?!hasKey:spAiSettingsOpen;
  return `<details class="panel sp-ai-settings" id="sp-ai-settings" ${open?'open':''}><summary><span><strong>AI provider</strong></span><span class="hint">${escapeHtml(provider)} · ${escapeHtml(aiModel||'default model')} · ${hasKey?'✓ key set':'⚠ API key needed for AI actions'}</span></summary><div class="sp-ai-settings-body">${aiSettingsHtml('sp')}</div></details>`;
}
function spBusinessSchemaNoticeHtml(){
  if(!spSchemaTables.length||!spBusinessSchemaSupported())return '';
  if(spBusinessSchemaStatus==='missing')return `<div class="ai-status warn mb sp-business-schema-inline"><span>Business layer schema <span class="mono">${escapeHtml(SP_BUSINESS_SCHEMA)}</span> is missing. Business Vault objects and Business Models need it before deployment.</span><button class="btn small primary" id="btn-sp-create-business-schema">Create ${escapeHtml(SP_BUSINESS_SCHEMA)} schema</button></div>`;
  if(spBusinessSchemaStatus==='error')return `<div class="ai-status err mb sp-business-schema-inline"><span>Could not check <span class="mono">${escapeHtml(SP_BUSINESS_SCHEMA)}</span>: ${escapeHtml(spBusinessSchemaError)}</span><button class="btn small ghost" id="btn-sp-create-business-schema">Create schema</button></div>`;
  return '';
}
