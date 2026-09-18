/* =========================================================================
   STEP 3 — STAGING
   ========================================================================= */
let expandedStagingTableId;
let stagingConfirmedFingerprint = '';

function stagingReviewFingerprint(){
  return JSON.stringify({
    hashAlgorithm: hashAlgo(),
    tables: (state.tables||[]).map(t=>({
      id:t.id,
      name:t.name,
      included:t.included!==false,
      loadGroup:2000,
      incrementCol:t.incrementCol||'',
      columns:(t.columns||[]).map(c=>({
        id:c.id, name:c.name, targetName:targetColumnName(c), type:c.type,
        nullable:!!c.nullable, pk:!!c.pk, staged:isColumnStaged(c),
        profile:c.profile ? {
          totalRows:Number(c.profile.totalRows||0),
          nullValues:Number(c.profile.nullValues||0),
          blankValues:Number(c.profile.blankValues||0),
        } : null,
      })),
      derivations:(t.derivations||[]).map(d=>({
        id:d.id, columns:derivationSourceColumns(d), entity:d.entity,
        role:d.role, kind:d.kind,
      })),
      customOverride:t.customOverride,
    })),
  });
}
function stagingChangesConfirmed(){
  return !!stagingConfirmedFingerprint && stagingConfirmedFingerprint===stagingReviewFingerprint();
}
function updateStagingConfirmationUi(){
  const confirmed = stagingChangesConfirmed();
  const hashColumnsReady = stagingHashColumnsReady();
  const tables = includedTables();
  const confirmBtn = document.getElementById('btn-confirm-staging');
  const nextBtn = document.getElementById('btn-next-staging');
  const status = document.getElementById('staging-confirm-status');
  if (confirmBtn){
    confirmBtn.disabled = confirmed || !hashColumnsReady;
    confirmBtn.textContent = confirmed ? 'Changes Confirmed' : 'Confirm Changes';
  }
  if (nextBtn) nextBtn.disabled = !confirmed || !hashColumnsReady;
  if (status){
    if (!tables.length){
      status.textContent = 'Include at least one source table before continuing.';
      status.style.color = 'var(--err)';
    } else if (!hashColumnsReady){
      status.textContent = stagingHashRequirementMessage();
      status.style.color = 'var(--err)';
    } else {
      status.textContent = confirmed
        ? 'Current staging changes are confirmed.'
        : 'Hash columns are ready. Review and confirm the staging changes before continuing.';
      status.style.color = confirmed ? 'var(--ok)' : 'var(--muted-2)';
    }
  }
}
function invalidateStagingConfirmation(){
  stagingConfirmedFingerprint = '';
  updateStagingConfirmationUi();
}
function confirmStagingChanges(){
  if (!stagingHashColumnsReady()) return false;
  stagingConfirmedFingerprint = stagingReviewFingerprint();
  updateStagingConfirmationUi();
  return true;
}

function stagingKeyDerivationCount(){
  return (state.tables||[]).reduce((sum,t)=>sum+(t.derivations||[]).length,0);
}
function deleteAllStagingKeyDerivations(){
  let removed=0;
  (state.tables||[]).forEach(t=>{ removed+=(t.derivations||[]).length; t.derivations=[]; });
  return removed;
}

function renderStaging(el){
  const tables = includedTables();
  const missingHashTables = stagingTablesMissingHashColumns();
  tables.forEach(t=>{ t.loadGroup = 2000; });
  if (tables.length && expandedStagingTableId===undefined) expandedStagingTableId = tables[0].id;
  el.innerHTML = `
    <div class="flex-between step-header">
      <div class="step-header-copy">
        <h2 class="section-title">Step 3 — Staging</h2>
        <p class="section-desc mb0">Review source columns and detected staging hash keys. Only selected tables and columns feed the Vault model.</p>
      </div>
      <div class="step-actions">
        <span class="quick-tip" data-tooltip="Detect deterministic staging hash and business keys from the source primary and foreign keys.">
          <button class="btn primary" id="btn-suggest-keys-staging">Detect Hash Keys</button>
        </span>
        <span class="quick-tip" data-tooltip="Find included tables that still have no staging key derivations.">
          <button class="btn" id="btn-coverage-staging">Integrity Check</button>
        </span>
        <span class="quick-tip" data-tooltip="Use an AI provider to propose staging key choices for review.">
          <button class="btn" id="btn-ai-staging">AI Assist</button>
        </span>
        <span class="quick-tip" data-tooltip="Delete all staging key derivations. Source tables and Vault objects are kept; required keys must be detected again before confirmation.">
          <button class="btn danger" id="btn-delete-all-staging-keys" ${stagingKeyDerivationCount()?'':'disabled'}>Delete all keys</button>
        </span>
      </div>
    </div>

    ${tables.length && missingHashTables.length ? `
      <div class="ai-status err mt">${escapeHtml(stagingHashRequirementMessage())}</div>
    ` : ''}

    <div class="panel">
      <div class="grid cols-2">
        <div class="field">
          <label>Hash algorithm for hub/link/satellite keys <span class="hint">(locked to SHA-256 for now)</span></label>
          <select id="f-hashalgo" disabled title="Locked to SHA-256 for now" style="opacity:.6;cursor:not-allowed;">
            ${Object.entries(HASH_ALGORITHMS).map(([k,a])=>`<option value="${k}" ${hashAlgo()===k?'selected':''}>${a.label} — ${a.sqlLabel}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="mb0">&nbsp;</label>
          <p class="hint" style="margin-top:9px;">${HASH_ALGORITHMS[hashAlgo()].note}</p>
        </div>
      </div>
      <p class="hint mt">Applies vault-wide. Source SQL now extracts source columns only; PostgreSQL <span class="mono">*_vw</span> staging views calculate every business key and SHA-256 hash consistently for all source databases.</p>
    </div>

    <div class="flex-between" style="margin-bottom:8px;">
      <h3 style="font-family:var(--font-display);font-size:12.5px;margin:0;text-transform:uppercase;letter-spacing:.2px;color:var(--muted);">
        Tables in staging <span class="badge-count">&nbsp;·&nbsp;${tables.length} included</span>
      </h3>
      <button class="btn small" id="btn-deselect-staging" ${tables.length?'':'disabled'}>Deselect Tables</button>
    </div>

    ${tables.length===0 ? `<div class="empty mt">No included tables. Return to Tables to select at least one.</div>` : `<div id="staging-tables"></div>`}

    <div class="flex-between mt">
      <button class="btn ghost" id="btn-back-staging">← Back to tables</button>
      <div style="display:flex;align-items:center;gap:12px;">
        <span class="hint mb0" id="staging-confirm-status"></span>
        <button class="btn primary" id="btn-confirm-staging">Confirm Changes</button>
        <button class="btn primary" id="btn-next-staging">Next: vault model →</button>
      </div>
    </div>
  `;
  document.getElementById('btn-ai-staging').addEventListener('click', ()=> openAiModal('staging'));
  document.getElementById('btn-coverage-staging').addEventListener('click', ()=> openCoverageModal('staging'));
  document.getElementById('btn-suggest-keys-staging').addEventListener('click', ()=> runSuggestFromKeys('staging'));
  document.getElementById('btn-delete-all-staging-keys').addEventListener('click', ()=>{
    const count=stagingKeyDerivationCount();
    if(!count) return;
    if(!confirm(`Delete all ${count} staging key derivation(s)? Source tables and Vault objects will be kept, but required keys must be detected again before staging can be confirmed.`)) return;
    pushUndo('delete all staging keys');
    const removed=deleteAllStagingKeyDerivations();
    invalidateStagingConfirmation();
    renderAll(); setActiveTabViewOnly('staging');
    toastUndo(`Deleted all ${removed} staging key derivation(s).`);
  });
  document.getElementById('btn-deselect-staging').addEventListener('click', ()=>{
    if (!tables.length) return;
    pushUndo('deselect all staging tables');
    state.tables.forEach(t=>{ t.included = false; });
    const removed = pruneDownstreamModel({ dropExcluded:true });
    expandedStagingTableId = null;
    invalidateStagingConfirmation();
    renderAll(); setActiveTabViewOnly('staging');
    const extra = removedModelCount(removed) ? ` Removed ${modelRemovalSummary(removed)}.` : '';
    toastUndo(`Deselected all staging tables.${extra}`);
  });
  document.getElementById('btn-back-staging').addEventListener('click', ()=> navigateDesignerTab('tables'));
  document.getElementById('btn-confirm-staging').addEventListener('click', ()=>{
    if (!stagingHashColumnsReady()){
      toast(stagingHashRequirementMessage(), 'err');
      updateStagingConfirmationUi();
      return;
    }
    if (confirmStagingChanges()){
      renderAll(); setActiveTabViewOnly('staging');
      toast('Staging changes confirmed.', 'ok');
    }
  });
  document.getElementById('btn-next-staging').addEventListener('click', ()=>{
    if (!stagingHashColumnsReady()){
      toast(stagingHashRequirementMessage(), 'err');
      updateStagingConfirmationUi();
      return;
    }
    if (!stagingChangesConfirmed()){
      toast('Confirm the current staging changes before continuing.', 'err');
      updateStagingConfirmationUi();
      return;
    }
    navigateDesignerTab('vault');
  });
  if (tables.length){
    const list = document.getElementById('staging-tables');
    list.innerHTML = tables.map(t=>{
      const open = expandedStagingTableId===t.id;
      return `<div class="entity-card">
        <div class="ehead ${open?'open':''}" data-staging-toggle="${t.id}">
          <div class="ehead-left">
            <label class="checkbox-row" style="margin-right:2px;" title="Include in staging" onclick="event.stopPropagation();">
              <input type="checkbox" data-staging-include="${t.id}" checked>
            </label>
            <span class="entity-marker sat"></span>
            <span class="entity-name">${escapeHtml(t.name)}</span>
            <span class="entity-meta">→ staging.<span class="mono">${escapeHtml(stagingViewName(t))}</span> · ${stagedColumns(t).length} of ${t.columns.length} columns · ${t.derivations.length} key derivation(s)</span>
          </div>
          <span class="entity-meta">${open?'Collapse':'Expand'}</span>
        </div>
        <div class="entity-body ${open?'open':''}" id="stg-${t.id}"></div>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-staging-toggle]').forEach(head=>{
      head.addEventListener('click', e=>{
        if (e.target.closest('[data-staging-include]')) return;
        const id = head.dataset.stagingToggle;
        expandedStagingTableId = expandedStagingTableId===id ? null : id;
        renderAll(); setActiveTabViewOnly('staging');
      });
    });
    list.querySelectorAll('[data-staging-include]').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        const table = findTable(cb.dataset.stagingInclude);
        if (!table || cb.checked) return;
        pushUndo(`deselect staging table "${table.name}"`);
        table.included = false;
        const removed = pruneDownstreamModel({ dropExcluded:true });
        if (expandedStagingTableId===table.id) expandedStagingTableId = null;
        invalidateStagingConfirmation();
        renderAll(); setActiveTabViewOnly('staging');
        const extra = removedModelCount(removed) ? ` Removed ${modelRemovalSummary(removed)}.` : '';
        toastUndo(`Deselected "${table.name}" from staging.${extra}`);
      });
    });
    tables.forEach(t=>{
      if (expandedStagingTableId===t.id) renderStagingTable(document.getElementById('stg-'+t.id), t);
    });
  }
  updateStagingConfirmationUi();
}

function renderStagingTable(el, t){
  // Repair safe, same-source/same-output duplicates before the person sees
  // them. Genuine conflicts (different source keys targeting one alias) stay
  // visible and are still blocked by validation.
  repairForeignKeyDerivations(t);
  const isCustom = t.customOverride != null;
  el.innerHTML = `
    <div class="panel-head" style="margin:0 -14px 0;"><h3>Columns included in staging <span class="badge-count">&nbsp;·&nbsp;${stagedColumns(t).length} of ${t.columns.length}</span></h3></div>
    <p class="hint">Selected by default. Untick a source column only when its data should stop before staging; doing so also removes any Hub, Link or Satellite mappings that depend on it.</p>
    <div style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px;">
      <table class="data" style="margin:0;">
        <tr><th style="width:70px;">Stage</th><th>Column</th><th>Type</th><th style="width:80px;">Key</th></tr>
        ${t.columns.map(c=>`<tr style="${isColumnStaged(c)?'':'opacity:.55;'}">
          <td><input type="checkbox" data-stage-col="${c.id}" ${isColumnStaged(c)?'checked':''}></td>
          <td class="mono">${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td><td>${c.pk?'<span class="tag">PK</span>':''}</td>
        </tr>`).join('')}
      </table>
    </div>

    <div class="panel-head" style="margin:16px -14px 0;"><h3>Key derivations</h3></div>
    <div class="panel" style="margin:10px 0 12px;padding:12px 14px;box-shadow:none;">
      <p class="hint" style="margin:0;line-height:1.55;"><b>How business keys are identified:</b> declared primary keys are used first; foreign keys identify relationships to other business entities; and composite keys stay together in source-column order. Column-name conventions are used only when the source has no declared foreign-key constraints. Detection is deterministic, requires no AI, and remains editable before confirmation.</p>
    </div>
    <p class="hint">Detected Hubs and Links in Step 4 can add required derivations automatically. Manual entries are available for special cases and satellites sourced from a different table.</p>
    <div id="deriv-rows-${t.id}"></div>
    <div class="deriv-row mt">
      <select id="drv-col-${t.id}"><option value="">source column…</option>${stagedColumns(t).map(c=>`<option value="${c.name}">${c.name}</option>`).join('')}</select>
      <input type="text" id="drv-entity-${t.id}" placeholder="target hub, e.g. customer">
      <input type="text" id="drv-role-${t.id}" placeholder="role, e.g. billing_customer">
      <span class="hint">Output is generated</span>
      <select id="drv-kind-${t.id}"><option value="hash">hash</option><option value="bk">business key</option><option value="both">both</option></select>
      <button class="btn small" id="btn-add-drv-${t.id}">+ Add</button>
    </div>

    <div class="grid cols-2 mt">
      <div>
        <div class="panel-head" style="margin:0 0 0 0;">
          <h3>Staging SQL override</h3>
          <span class="tag ${isCustom?'sat':''}" style="text-transform:none;">${isCustom?'custom':'auto-generated'}</span>
        </div>
        <textarea id="override-text-${t.id}" maxlength="${pdiMetaMaxLength('stagingSqlOverride')}" class="mono" style="min-height:160px;background:#20142b;color:#e7d9f0;border-color:var(--border);">${escapeHtml(isCustom ? t.customOverride : buildOverride(t))}</textarea>
        <div class="flex-between mt">
          <p class="hint mb0">Edits here become the exported <span class="mono">staging_sql_override</span>. Column inclusion is controlled above and remains authoritative; custom SQL should still return every selected structural column and derived key alias.</p>
          <button class="btn small ${isCustom?'':'ghost'}" id="btn-reset-override-${t.id}" ${isCustom?'':'disabled'}>↺ Reset to auto</button>
        </div>
      </div>
      <div>
        <div class="panel-head" style="margin:0 0 0 0;"><h3>Staging DDL</h3></div>
        <p class="hint">The physical table mirrors selected source columns. The engine uses the writable <span class="mono">${escapeHtml(stagingViewName(t))}</span> view, which adds BK/hash/tenant metadata in PostgreSQL.</p>
        <pre class="code">${escapeHtml(ddlFromColumns(`staging.${stagingTableName(t)}`, buildStagingBaseColumns(t)) + '\n\n' + buildStagingViewSql(t))}</pre>
      </div>
    </div>
  `;
  wireStagingColumnToggles(el, t, 'staging');
  el.querySelectorAll('[data-tf]').forEach(inp=>{
    const key = inp.dataset.tf;
    inp.addEventListener('input', e=>{
      t[key] = inp.type==='checkbox' ? inp.checked : (inp.type==='number'? Number(e.target.value): e.target.value);
      invalidateStagingConfirmation();
      refreshStagingPreview(el, t);
    });
  });
  renderDerivRows(el.querySelector('#deriv-rows-'+t.id), t, el);
  el.querySelector('#btn-add-drv-'+t.id).addEventListener('click', ()=>{
    const colEl=el.querySelector('#drv-col-'+t.id);
    const entityEl=el.querySelector('#drv-entity-'+t.id);
    const roleEl=el.querySelector('#drv-role-'+t.id);
    const kindEl=el.querySelector('#drv-kind-'+t.id);
    const result=addManualKeyDerivation(t,colEl.value,entityEl.value,roleEl.value,kindEl.value);
    if(!result.ok){ toast(result.reason.endsWith('.')?result.reason:`${result.reason}.`,'err'); return; }
    invalidateStagingConfirmation();
    renderDerivRows(el.querySelector('#deriv-rows-'+t.id),t,el);
    refreshStagingPreview(el,t);
    if(result.added){
      colEl.value=''; entityEl.value=''; roleEl.value=''; kindEl.value='hash';
      toast(`Added key derivation "${derivationOutputLabel(t,result.derivation)}".`,'ok');
    } else {
      toast(`That key derivation already exists; the existing row was reused.`,'ok');
    }
  });
  const overrideTextarea = el.querySelector('#override-text-'+t.id);
  overrideTextarea.addEventListener('input', e=>{
    t.customOverride = e.target.value;
    invalidateStagingConfirmation();
    const tag = el.querySelector('.tag');
    if (tag){ tag.textContent = 'custom'; tag.classList.add('sat'); }
    const resetBtn = el.querySelector('#btn-reset-override-'+t.id);
    if (resetBtn){ resetBtn.disabled = false; resetBtn.classList.remove('ghost'); }
  });
  el.querySelector('#btn-reset-override-'+t.id).addEventListener('click', ()=>{
    t.customOverride = null;
    renderAll(); setActiveTabViewOnly('staging');
    toast('Reverted to the auto-generated override.', 'ok');
  });
}

function refreshStagingPreview(el, t){
  // Only refresh the DDL preview live — the override textarea is user-owned
  // once edited, so re-rendering it on every keystroke elsewhere would fight
  // the person typing into it.
  const isCustom = t.customOverride != null;
  if (!isCustom){
    const ta = el.querySelector('textarea[id^="override-text-"]');
    if (ta && document.activeElement !== ta) ta.value = buildOverride(t);
  }
  const pre = el.querySelector('pre.code');
  if (pre) pre.textContent = ddlFromColumns(`staging.${stagingTableName(t)}`, buildStagingBaseColumns(t)) + '\n\n' + buildStagingViewSql(t);
}
