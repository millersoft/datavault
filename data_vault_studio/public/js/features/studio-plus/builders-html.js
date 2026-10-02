/* Studio Plus — Business Model / Business Vault library, builder and AI plan markup. */
function spViewPreviewHtml(){
  if(!spViewPreview)return '';
  if(spViewPreview.loading)return `<div class="ai-status mt">Running preview…</div>`;
  if(spViewPreview.error)return `<div class="ai-status err mt">${escapeHtml(spViewPreview.error)}</div>`;
  if(!spViewPreview.rows.length)return `<div class="ai-status ok mt">Query is valid. It currently returns no rows.</div>`;
  const fields=spViewPreview.fields||[];
  return `<div class="sp-preview-wrap mt"><table class="sp-preview-table"><thead><tr>${fields.map(f=>`<th>${escapeHtml(f)}</th>`).join('')}</tr></thead><tbody>${spViewPreview.rows.map(r=>`<tr>${fields.map(f=>`<td>${escapeHtml(r[f]==null?'':String(r[f]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function spViewLibraryHtml(){
  const views=spManagedViews().filter(v=>!spIsTechnicalViewName(v.name));
  if(!views.length)return `<div class="ai-status mt">No business models yet. Use the builder below to create the first one.</div>`;
  return `<div class="sp-view-library">${views.map(v=>{const dependencyIssue=spBusinessModelDependencyIssue(v);return `<div class="sp-view-card">
    <div class="sp-view-card-main"><strong>${escapeHtml(v.label||v.name)}</strong><span class="mono">${escapeHtml(v.name)}</span><span class="sp-bv-source-kind">${escapeHtml(spViewTypeLabel(v.type))}</span><span class="sp-bv-source-kind">${escapeHtml(spMaterializationLabel(v))}</span><span class="sp-view-status ${escapeHtml(v.status||'draft')}">${escapeHtml(spViewStatusLabel(v))}</span>${String(v.sql||'').trim()?'<span class="sp-bv-source-kind">SQL ready</span>':'<span class="sp-bv-source-kind">SQL needed</span>'}${dependencyIssue?`<p class="hint" style="color:var(--warn);"><strong>Dependency:</strong> ${escapeHtml(dependencyIssue)}</p>`:''}${v.description?`<p class="hint">${escapeHtml(v.description)}</p>`:''}${v.lastError?`<p class="hint" style="color:var(--err);">${escapeHtml(v.lastError)}</p>`:''}</div>
    <div class="sp-view-card-actions"><button class="btn small ghost" data-sp-view-edit="${v.id}">Edit</button><button class="btn small ghost" data-sp-view-lineage="${v.id}" title="Open this Business Model's end-to-end lineage">Lineage</button>${v.status==='error'&&v.lastError&&String(v.sql||'').trim()&&spIsRepairableTargetError(v.lastError)?`<button class="btn small" data-sp-view-fix="${v.id}" title="Send the SQL and the database error to AI and load the proposed fix into the editor (not saved)." ${spViewFixingId?'disabled':''}>${spViewFixingId===v.id?'Fixing…':'Fix with AI'}</button>`:''}<button class="btn small" data-sp-view-deploy="${v.id}" title="${escapeHtml(dependencyIssue||((v.materialization||'view')==='table'?'Builds the persisted table from the saved SELECT. Redeploy drops and rebuilds it.':'Creates or replaces the live view from the saved SELECT.'))}" ${spViewDeployingId===v.id||dependencyIssue?'disabled':''}>${spViewDeployingId===v.id?'Working…':dependencyIssue?'Deploy Business Vault first':(v.deployedAt?'Redeploy':'Deploy')}</button><button class="btn small ghost" data-sp-view-delete="${v.id}">Delete</button></div>
  </div>`;}).join('')}</div>`;
}
function spViewBuilderHtml(){
  const sources=spViewSourceTables();
  const allowedSourceNames=new Set(sources.map(t=>t.name));
  const excludedModelSources=spViewDraft.sourceObjects.filter(n=>!allowedSourceNames.has(n));
  const ai=spViewAiProposal;
  const pitCount=sources.filter(t=>spBusinessObjectKind(t)==='PIT').length;
  const bridgeCount=sources.filter(t=>spBusinessObjectKind(t)==='Bridge').length;
  const sourceQuery=String(spViewSourceSearch||'').trim().toLowerCase();
  return `<details class="panel sp-view-builder sp-editor-details" id="sp-view-builder" ${spViewBuilderOpen?'open':''}>
    <summary><span><strong>${spViewDraft.id?`Edit business model${spViewDraft.name?` <span class="sp-title-name">· ${escapeHtml(spViewDraft.name)}</span>`:''}`:'Create business model'}</strong></span><span class="hint">${spViewBuilderOpen?'':'Click to expand'}</span></summary>
    <div class="sp-editor-body">
    <div class="sp-bv-actions mb"><button class="btn small ghost" id="btn-sp-view-new">New model</button></div>
    <div class="grid cols-4">
      <div class="field"><label>Model name</label><input id="sp-view-name" value="${escapeHtml(spViewDraft.name)}" placeholder="sales_pipeline_history"></div>
      <div class="field"><label>Business label</label><input id="sp-view-label" value="${escapeHtml(spViewDraft.label)}" placeholder="Sales Pipeline History"></div>
      <div class="field"><label>Model type</label><select id="sp-view-type">${[['current','Current entity'],['history','Entity history'],['360','Entity 360'],['relationship','Relationship'],['custom','Custom']].map(([k,l])=>`<option value="${k}" ${spViewDraft.type===k?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Materialisation</label><select id="sp-view-materialization"><option value="table" ${spViewDraft.materialization==='table'?'selected':''}>Persisted table (recommended)</option><option value="view" ${spViewDraft.materialization==='view'?'selected':''}>Live view</option></select></div>
    </div>
    <div class="field mt"><label>Describe what you want</label><textarea id="sp-view-description" rows="3" placeholder="e.g. Analyse sales stage movement and pipeline trends over time by salesperson and account">${escapeHtml(spViewDraft.description)}</textarea><p class="hint">Guides SQL generation. Plan recommendations arrive with SQL already filled in.</p></div>
    <div class="field mt"><label>Vault objects this model may use</label>
      ${excludedModelSources.length?`<div class="ai-status err mb">This model still references an older Business Model as an input: ${escapeHtml(excludedModelSources.join(', '))}. Business Models now build directly from Raw Vault and optional Business Vault objects; remove the old dependency or regenerate this model.</div>`:''}
      ${spViewDraft.id&&spBusinessModelDependencyIssue(spViewDraft)?`<div class="ai-status warn mb">${escapeHtml(spBusinessModelDependencyIssue(spViewDraft))}. Deploy it in Business Vault before loading this model.</div>`:''}
      <div class="sp-bv-actions mb"><input type="search" id="sp-view-source-search" class="sp-source-search" value="${escapeHtml(spViewSourceSearch)}" placeholder="Search Hubs, Links, Satellites, PITs, Bridges…"><button class="btn small ghost" id="btn-sp-source-pits" ${pitCount?'':'disabled'}>Add all PITs (${pitCount})</button><button class="btn small ghost" id="btn-sp-source-bridges" ${bridgeCount?'':'disabled'}>Add all Bridges (${bridgeCount})</button><button class="btn small ghost" id="btn-sp-source-clear" ${spViewDraft.sourceObjects.length?'':'disabled'}>Clear</button><span class="hint"><strong id="sp-view-source-count">${spViewDraft.sourceObjects.length}</strong> selected</span></div>
      <div class="sp-bv-source-list" id="sp-view-source-list">${sources.map(t=>{const searchText=`${t.name} ${spBusinessObjectKind(t)} ${t.objectType||'table'}`.toLowerCase();return `<label class="sp-bv-source-row" ${sourceQuery&&!searchText.includes(sourceQuery)?'style="display:none"':''} data-sp-source-row data-sp-source-search="${escapeHtml(searchText)}"><input type="checkbox" data-sp-view-source="${escapeHtml(t.name)}" ${spViewDraft.sourceObjects.includes(t.name)?'checked':''}><span class="sp-bv-source-name mono">${escapeHtml(t.name)}</span><span class="sp-bv-source-kind">${escapeHtml(spBusinessObjectKind(t))}</span><span class="hint">${escapeHtml(t.objectType||'table')} · ${(t.columns||[]).length} columns</span></label>`;}).join('') || '<div class="hint" style="padding:12px;">Introspect the deployed Vault first.</div>'}</div>
    </div>
    <div class="sp-bv-actions mt"><button class="btn small ghost" id="btn-sp-view-starter" ${spViewDraft.sourceObjects.length?'':'disabled'}>Starter SQL</button><button class="btn small ghost" id="btn-sp-view-format" ${String(spViewDraft.sql||'').trim()?'':'disabled'}>Format SQL</button><button class="btn small" id="btn-sp-view-ai" ${spViewAiStatus==='loading'||!spViewDraft.sourceObjects.length?'disabled':''}>${spViewAiStatus==='loading'?'AI is regenerating…':(String(spViewDraft.sql||'').trim()?'✨ Regenerate with AI':'✨ Generate with AI')}</button></div>
    <div class="ai-status mt"><strong>SQL dialect: ${escapeHtml(spSqlDialectLabel())}</strong> · SQL is checked for cross-dialect syntax before preview and deployment.</div>
    ${spViewAiError?`<div class="ai-status err mt">${escapeHtml(spViewAiError)}</div>`:''}
    ${ai?`<div class="sp-ai-proposal mt"><strong>AI proposal — not saved</strong><p>${escapeHtml(ai.description||'')}</p>${ai.targetError?`<div class="ai-status warn mb">The target rejected this SQL even after one repair attempt: ${escapeHtml(ai.targetError)}</div>`:''}<pre>${escapeHtml(spFormatSqlForEditor(ai.sql||''))}</pre><div class="sp-bv-actions"><button class="btn small primary" id="btn-sp-view-ai-accept">Accept into editor</button><button class="btn small ghost" id="btn-sp-view-ai-discard">Discard</button></div></div>`:''}
    <div class="field mt"><label>SELECT definition</label><textarea class="code-edit sp-view-sql" id="sp-view-sql" spellcheck="false" wrap="off" placeholder="SELECT ...">${escapeHtml(spFormatSqlForEditor(spViewDraft.sql))}</textarea><p class="hint">Store the SELECT only — Deploy builds the persisted table or live view from it.</p></div>
    <div class="sp-bv-actions mt"><button class="btn" id="btn-sp-view-preview">Preview</button><button class="btn primary" id="btn-sp-view-save">Save Draft</button><button class="btn primary" id="btn-sp-view-save-deploy" title="Save this Business Model and deploy it to the target in one step.">Save &amp; deploy</button><span class="hint">Preview returns up to 10 rows.</span></div>
<div id="sp-view-preview-host">${spViewPreviewHtml()}</div>
    </div>
  </details>`;
}
// Ticking a source only changes counts and a few button states, so update
// those in place instead of rebuilding the page (keeps scroll, focus, search).
function spUpdateViewSourceUi(root){
  const n=spViewDraft.sourceObjects.length;
  const count=root.querySelector('#sp-view-source-count');if(count)count.textContent=String(n);
  const clear=root.querySelector('#btn-sp-source-clear');if(clear)clear.disabled=!n;
  const starter=root.querySelector('#btn-sp-view-starter');if(starter)starter.disabled=!n;
  const ai=root.querySelector('#btn-sp-view-ai');if(ai)ai.disabled=spViewAiStatus==='loading'||!n;
  const preview=root.querySelector('#sp-view-preview-host');if(preview)preview.innerHTML='';
}
function spBvPreviewHtml(){
  if(!spBvPreview)return '';
  const sql=spBvPreview.sql?`<details class="mt"><summary class="hint">Generated SQL</summary><pre class="sp-bv-sql-preview">${escapeHtml(spBvPreview.sql)}</pre></details>`:'';
  if(spBvPreview.loading)return `<div class="ai-status mt">Running Business Vault preview…</div>${sql}`;
  if(spBvPreview.error)return `<div class="ai-status err mt">${escapeHtml(spBvPreview.error)}</div>${sql}`;
  if(!spBvPreview.rows.length)return `<div class="ai-status ok mt">Definition is valid. It currently returns no rows.</div>${sql}`;
  const fields=spBvPreview.fields||[];
  return `${sql}<div class="sp-preview-wrap mt"><table class="sp-preview-table"><thead><tr>${fields.map(f=>`<th>${escapeHtml(f)}</th>`).join('')}</tr></thead><tbody>${spBvPreview.rows.map(r=>`<tr>${fields.map(f=>`<td>${escapeHtml(r[f]==null?'':String(r[f]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function spBvLibraryHtml(){
  const objects=spManagedBvObjects();
  if(!objects.length)return `<div class="ai-status">No managed PIT or Bridge structures yet. These Business Vault tables are optional — create them only when point-in-time history or complex relationship traversal benefits from them.</div>`;
  return `<div class="sp-view-library">${objects.map(o=>`<div class="sp-view-card"><div class="sp-view-card-main"><strong>${escapeHtml(o.label||o.name)}</strong><span class="mono">${escapeHtml(o.name)}</span><span class="sp-bv-source-kind">${o.type==='bridge'?'Bridge':'PIT'}</span><span class="sp-view-status ${escapeHtml(o.status||'draft')}">${escapeHtml(spBvStatusLabel(o))}</span>${o.description?`<p class="hint">${escapeHtml(o.description)}</p>`:''}${o.lastError?`<p class="hint" style="color:var(--err);">${escapeHtml(o.lastError)}</p>`:''}</div><div class="sp-view-card-actions"><button class="btn small ghost" data-sp-bv-edit="${o.id}">Edit</button><button class="btn small" data-sp-bv-deploy="${o.id}" title="Builds the physical table from the saved definition. Redeploy drops and rebuilds it." ${spBvDeployingId===o.id?'disabled':''}>${spBvDeployingId===o.id?'Working…':o.deployedAt?'Redeploy':'Deploy'}</button><button class="btn small ghost" data-sp-bv-delete="${o.id}">Delete</button></div></div>`).join('')}</div>`;
}
function spBvBuilderHtml(){
  const isPit=spBvDraft.type!=='bridge';
  const hubs=spBvPitParentTables(),links=spBvLinkTables(),sats=isPit?spBvCompatibleSatellites(spBvDraft.parentHub):[];
  const recommendations=spBvRecommendations();
  return `<details class="sp-bv-builder sp-editor-details mt" id="sp-bv-builder" ${spBvBuilderOpen?'open':''}>
    <summary><span><strong>${spBvDraft.id?`Edit Business Vault structure${spBvDraft.name?` <span class="sp-title-name">· ${escapeHtml(spBvDraft.name)}</span>`:''}`:'Create Business Vault structure'}</strong></span><span class="hint">${spBvBuilderOpen?'':'Click to expand'}</span></summary>
    <div class="sp-editor-body">
    <div class="sp-bv-actions"><button class="btn small ghost" id="btn-sp-bv-new">New table</button><button class="btn small ghost" id="btn-sp-bv-deploy-all" ${spBvDeployAllBusy?'disabled':''}>${spBvDeployAllBusy?'Deploying…':'Deploy all pending'}</button></div>
    ${recommendations.length?`<div class="sp-bv-recommendations mt"><span class="hint"><strong>Recommended from the deployed Vault:</strong></span><button class="btn small" id="btn-sp-bv-add-recommended">Add all recommended (${recommendations.length})</button>${recommendations.map((r,i)=>`<button class="btn small ghost" data-sp-bv-rec="${i}">${escapeHtml(r.label)}</button>`).join('')}</div>`:''}
    <div class="grid cols-4 mt"><div class="field"><label>Structure type</label><select id="sp-bv-type"><option value="pit" ${isPit?'selected':''}>PIT table</option><option value="bridge" ${!isPit?'selected':''}>Bridge table</option></select></div><div class="field"><label>Table name</label><input id="sp-bv-name" value="${escapeHtml(spBvDraft.name)}" placeholder="${isPit?'pit_customer':'br_customer_order'}"></div><div class="field"><label>Business label</label><input id="sp-bv-label" value="${escapeHtml(spBvDraft.label)}" placeholder="${isPit?'Customer PIT':'Customer Order Bridge'}"></div><div class="field"><label>Deployment</label><input value="Physical table · ${escapeHtml(spSqlDialectLabel())}" disabled></div></div>
    <div class="field mt"><label>Description <span class="hint">(optional)</span></label><input id="sp-bv-description" value="${escapeHtml(spBvDraft.description)}" placeholder="Why this helper exists"></div>
    ${isPit?`<div class="field mt"><label>Parent Hub / Link</label><select id="sp-bv-hub"><option value="">Choose Hub or Link…</option>${hubs.map(h=>`<option value="${escapeHtml(h.name)}" ${spBvDraft.parentHub===h.name?'selected':''}>${escapeHtml(h.name)}</option>`).join('')}</select></div><div class="field mt"><label>Satellites to point into</label><div class="sp-bv-actions mb"><button class="btn small ghost" id="btn-sp-bv-add-all" ${sats.length?'':'disabled'}>Add all</button><button class="btn small ghost" id="btn-sp-bv-clear">Clear</button><span class="hint">Event-driven snapshots are created at observed Satellite change timestamps.</span></div><div class="sp-bv-source-list">${sats.map(s=>`<label class="sp-bv-source-row"><input type="checkbox" data-sp-bv-sat="${escapeHtml(s.name)}" ${spBvDraft.satellites.includes(s.name)?'checked':''}><span class="sp-bv-source-name mono">${escapeHtml(s.name)}</span><span class="sp-bv-source-kind">Satellite</span><span class="hint">${(s.columns||[]).length} columns</span></label>`).join('')||'<div class="hint" style="padding:12px;">Choose a Hub or Link to see compatible Satellites / Link Satellites.</div>'}</div></div>`:`<div class="field mt"><label>Link path</label><div class="sp-bv-actions mb"><button class="btn small ghost" id="btn-sp-bv-add-all" ${links.length?'':'disabled'}>Add all</button><button class="btn small ghost" id="btn-sp-bv-clear">Clear</button><span class="hint">Selected Links must form one connected path through shared Hub keys.</span></div><div class="sp-bv-source-list">${links.map(l=>`<label class="sp-bv-source-row"><input type="checkbox" data-sp-bv-link="${escapeHtml(l.name)}" ${spBvDraft.links.includes(l.name)?'checked':''}><span class="sp-bv-source-name mono">${escapeHtml(l.name)}</span><span class="sp-bv-source-kind">Link</span><span class="hint">${escapeHtml(spBvLinkHubKeys(l).join(', ')||'no Hub keys detected')}</span></label>`).join('')||'<div class="hint" style="padding:12px;">No deployed Link tables were found.</div>'}</div></div>`}
    <div class="sp-bv-actions mt"><button class="btn" id="btn-sp-bv-preview">Preview generated table</button><button class="btn primary" id="btn-sp-bv-save">Save Draft</button><button class="btn primary" id="btn-sp-bv-save-deploy" title="Save this table and deploy it to the target in one step.">Save &amp; deploy</button></div>${spBvPreviewHtml()}
    </div>
  </details>`;
}
function spAiRecommendationsHtml(){
  const rec=spAiRecommendations;
  const bv=(rec&&rec.businessVault)||[],curated=(rec&&rec.curatedDatasets)||[];
  const selected=spAiSelectedBv.size+spAiSelectedCurated.size;
  return `<div class="panel sp-ai-recommendations">
    <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Goal &amp; AI Plan</h3></div>
    <p class="section-desc">Describe the outcome you want. AI proposes a small plan across optional Business Vault tables and Business Models. Select what you want and apply it as drafts.</p>
    <div class="field"><label>What do you want to analyse?</label><textarea id="sp-ai-recommend-prompt" rows="3" placeholder="e.g. Analyse sales stage movement, pipeline velocity and win/loss trends by owner and account">${escapeHtml(spAiRecommendPrompt)}</textarea></div>
    <div class="sp-bv-actions mt"><button class="btn" id="btn-sp-ai-recommend" ${spAiRecommendStatus==='loading'||spAiPlanApplying?'disabled':''}>${spAiRecommendStatus==='loading'?'Building plan…':'Generate AI plan'}</button></div>
    ${spAiRecommendError?`<div class="ai-status err mt">${escapeHtml(spAiRecommendError)}</div>`:''}
    ${rec?`<div class="sp-ai-rec-results mt">${rec.summary?`<div class="ai-status ok">${escapeHtml(rec.summary)}</div>`:''}
      ${bv.length?`<h4 class="mt">Business Vault</h4><div class="sp-ai-rec-grid">${bv.map((r,i)=>`<label class="sp-ai-rec-card sp-ai-selectable"><input type="checkbox" data-sp-ai-bv-select="${i}" ${spAiSelectedBv.has(i)?'checked':''}><div><span class="sp-bv-source-kind">${r.definition.type==='bridge'?'Bridge':'PIT'}</span><strong>${escapeHtml(r.definition.label||r.definition.name)}</strong><p class="hint">${escapeHtml(r.reason)}</p><p class="hint mono">${escapeHtml(r.definition.name)}</p></div><button type="button" class="btn small ghost" data-sp-ai-bv="${i}">Review</button></label>`).join('')}</div>`:''}
      ${curated.length?`<h4 class="mt">Business Models</h4><div class="sp-ai-rec-grid">${curated.map((r,i)=>`<label class="sp-ai-rec-card sp-ai-selectable"><input type="checkbox" data-sp-ai-curated-select="${i}" ${spAiSelectedCurated.has(i)?'checked':''}><div><span class="sp-bv-source-kind">${escapeHtml(spViewTypeLabel(r.type))}</span><strong>${escapeHtml(r.label)}</strong><p class="hint">${escapeHtml(r.reason)}</p><p class="hint mono">${escapeHtml(r.sourceObjects.join(' · '))}</p></div><button type="button" class="btn small ghost" data-sp-ai-curated="${i}" ${spAiReviewCuratedIndex!==null?'disabled':''}>${spAiReviewCuratedIndex===i?'Generating SQL…':'Review'}</button></label>`).join('')}</div>`:''}
      ${!bv.length&&!curated.length?`<div class="ai-status mt">No additional structures were recommended for this prompt.</div>`:''}
      ${(bv.length||curated.length)?`<div class="sp-ai-plan-apply mt"><div><strong id="sp-ai-selected-count">${selected} selected</strong><p class="hint">Apply creates drafts with SQL ready for review. Nothing is deployed until you deploy it.</p></div><button class="btn primary" id="btn-sp-ai-apply" ${selected&&!spAiPlanApplying?'':'disabled'}>${spAiPlanApplying?'Generating SQL & applying…':'Apply selected plan'}</button></div>`:''}
    </div>`:''}
  </div>`;
}
