/* =========================================================================
   SCHEMA DRIFT — re-introspect the live source and diff it against the
   current model, then merge selectively. Real vaults outlive their first
   design; this is how the model catches up with the source.
   ========================================================================= */
// Pure diff between the model's tables and a live introspection result.
// Kept side-effect-free deliberately so it can be unit tested.
function computeSchemaDiff(currentTables, liveTables){
  const diff = { newTables: [], missingTables: [], newColumns: [], missingColumns: [], changedColumns: [] };
  const liveByName = {};
  (liveTables||[]).forEach(t=>{ liveByName[t.name] = t; });
  const curByName = {};
  (currentTables||[]).forEach(t=>{ curByName[t.name] = t; });

  (liveTables||[]).forEach(lt=>{ if (!curByName[lt.name]) diff.newTables.push(lt); });
  (currentTables||[]).forEach(ct=>{
    const live = liveByName[ct.name];
    if (!live){ diff.missingTables.push(ct.name); return; }
    const liveCols = {}; live.columns.forEach(c=>{ liveCols[c.name] = c; });
    const curCols = {}; ct.columns.forEach(c=>{ curCols[c.name] = c; });
    live.columns.forEach(lc=>{ if (!curCols[lc.name]) diff.newColumns.push({ table: ct.name, column: lc }); });
    ct.columns.forEach(cc=>{
      const lc = liveCols[cc.name];
      if (!lc){ diff.missingColumns.push({ table: ct.name, column: cc.name }); return; }
      const changes = [];
      if (String(lc.type).toLowerCase() !== String(cc.type).toLowerCase()) changes.push({ field:'type', from: cc.type, to: lc.type });
      if (!!lc.nullable !== !!cc.nullable) changes.push({ field:'nullable', from: !!cc.nullable, to: !!lc.nullable });
      if (!!lc.pk !== !!cc.pk) changes.push({ field:'pk', from: !!cc.pk, to: !!lc.pk });
      if (changes.length) diff.changedColumns.push({ table: ct.name, column: cc.name, changes });
    });
  });
  return diff;
}
function schemaDiffIsEmpty(diff){
  return !diff.newTables.length && !diff.missingTables.length && !diff.newColumns.length
      && !diff.missingColumns.length && !diff.changedColumns.length;
}

// Applies the selected parts of a diff to the model. Options mirror the
// checkboxes in the drift modal. Also pure enough to unit test — it only
// touches the state passed in via the tables/model helpers.
function applySchemaDiff(diff, options){
  const applied = { tablesAdded:0, columnsAdded:0, columnsUpdated:0, columnsRemoved:0, tablesExcluded:0 };
  if (options.addTables){
    diff.newTables.forEach(lt=>{
      const t = newTable(lt.name);
      t.objectType = normalizeSourceObjectType(lt.objectType);
      t.included = !isSourceView(t);
      t.columns = lt.columns.map(c=> Object.assign(newColumn(c.name, c.type), { nullable: c.pk ? false : c.nullable, pk: c.pk }));
      state.tables.push(t);
      applied.tablesAdded++;
    });
  }
  if (options.addColumns){
    diff.newColumns.forEach(entry=>{
      const t = findIncludedTableByName(entry.table) || state.tables.find(x=>x.name===entry.table);
      if (!t) return;
      t.columns.push(Object.assign(newColumn(entry.column.name, entry.column.type), { nullable: entry.column.pk ? false : entry.column.nullable, pk: entry.column.pk }));
      applied.columnsAdded++;
    });
  }
  if (options.updateColumns){
    diff.changedColumns.forEach(entry=>{
      const t = state.tables.find(x=>x.name===entry.table);
      const c = t && t.columns.find(x=>x.name===entry.column);
      if (!c) return;
      entry.changes.forEach(ch=>{ c[ch.field] = ch.to; });
      applied.columnsUpdated++;
    });
  }
  if (options.removeColumns){
    diff.missingColumns.forEach(entry=>{
      const t = state.tables.find(x=>x.name===entry.table);
      if (!t) return;
      const col = t.columns.find(c=>c.name===entry.column);
      if (!col) return;
      t.columns = t.columns.filter(c=>c.id!==col.id);
      t.derivations = t.derivations.filter(d=>!derivationUsesColumn(d,col.name));
      applied.columnsRemoved++;
    });
  }
  if (options.excludeMissingTables){
    diff.missingTables.forEach(name=>{
      const t = state.tables.find(x=>x.name===name);
      if (t && t.included!==false){ t.included = false; applied.tablesExcluded++; }
    });
  }
  if (options.removeColumns || options.excludeMissingTables) pruneDownstreamModel({ dropExcluded:true });
  return applied;
}

let driftDiff = null;

async function runDriftCheck(){
  const v = state.vault;
  if (!['postgresql','mysql'].includes(v.dialect) && !isDatabasePackDialect(v.dialect)){ toast('Drift check needs a supported live source or installed Database Pack.','err'); return; }
  const btn = document.getElementById('btn-drift');
  if (btn){ btn.disabled = true; btn.textContent = 'Comparing…'; }
  try {
    const data = await fetchIntrospection();
    captureSourceMeta(data);
    driftDiff = computeSchemaDiff(state.tables, data.tables);
    if (schemaDiffIsEmpty(driftDiff)){
      toast('No drift — the model matches the live source schema.', 'ok');
    } else {
      renderDriftModal();
    }
  } catch(err){
    toast('Drift check failed: ' + err.message, 'err');
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = 'Compare source changes'; }
  }
}

function closeDriftModal(){
  const m = document.getElementById('drift-modal-backdrop');
  if (m) m.remove();
}

function renderDriftModal(){
  closeDriftModal();
  const d = driftDiff;
  const wrap = document.createElement('div');
  wrap.id = 'drift-modal-backdrop';
  wrap.className = 'modal-backdrop';
  const section = (title, items, html) => items.length ? `
    <div class="panel" style="margin-bottom:12px;">
      <div class="panel-head" style="margin:-18px -20px 10px;"><h3>${title} <span class="badge-count">&nbsp;·&nbsp;${items.length}</span></h3></div>
      ${html}
    </div>` : '';
  wrap.innerHTML = `
    <div class="modal-card" style="max-height:85vh;overflow:auto;">
      <div class="flex-between" style="margin-bottom:4px;">
        <h3 style="font-family:var(--font-display);font-size:15px;margin:0;">Schema drift — live source vs. this model</h3>
        <button class="btn small ghost" id="drift-close">&times;</button>
      </div>
      <p class="section-desc" style="margin-bottom:14px;">Tick what to merge into the model. Nothing is written to any database — this only updates the design.</p>

      ${section('New tables in the source', d.newTables, `
        <p class="hint mb0">${d.newTables.map(t=>`<span class="mono">${escapeHtml(t.name)}</span> (${t.columns.length} cols${normalizeSourceObjectType(t.objectType)==='view'?' · view':''})`).join(' · ')}</p>
        <label class="checkbox-row mt"><input type="checkbox" id="drift-add-tables" checked><span>Add these source objects (base tables selected; views unselected)</span></label>
      `)}
      ${section('New columns', d.newColumns, `
        <p class="hint mb0">${d.newColumns.map(e=>`<span class="mono">${escapeHtml(e.table)}.${escapeHtml(e.column.name)}</span> ${escapeHtml(e.column.type)}`).join(' · ')}</p>
        <label class="checkbox-row mt"><input type="checkbox" id="drift-add-columns" checked><span>Add these columns</span></label>
      `)}
      ${section('Changed columns', d.changedColumns, `
        <table class="data"><tr><th>Column</th><th>Change</th></tr>
        ${d.changedColumns.map(e=>`<tr><td class="mono">${escapeHtml(e.table)}.${escapeHtml(e.column)}</td><td class="mono">${e.changes.map(ch=>`${ch.field}: ${escapeHtml(String(ch.from))} → ${escapeHtml(String(ch.to))}`).join(', ')}</td></tr>`).join('')}
        </table>
        <label class="checkbox-row mt"><input type="checkbox" id="drift-update-columns" checked><span>Apply these type/nullability/PK updates</span></label>
      `)}
      ${section('Columns no longer in the source', d.missingColumns, `
        <p class="hint mb0">${d.missingColumns.map(e=>`<span class="mono">${escapeHtml(e.table)}.${escapeHtml(e.column)}</span>`).join(' · ')}</p>
        <label class="checkbox-row mt"><input type="checkbox" id="drift-remove-columns"><span>Remove them (unticked by default — this can prune hubs/satellites that reference them)</span></label>
      `)}
      ${section('Tables no longer in the source', d.missingTables, `
        <p class="hint mb0">${d.missingTables.map(n=>`<span class="mono">${escapeHtml(n)}</span>`).join(' · ')}</p>
        <label class="checkbox-row mt"><input type="checkbox" id="drift-exclude-tables"><span>Exclude them from the run (unticked by default — this can prune downstream model objects)</span></label>
      `)}

      <div class="flex-between mt">
        <button class="btn ghost" id="drift-cancel">Cancel</button>
        <button class="btn primary" id="drift-apply">Merge selected</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const checked = id => { const el = document.getElementById(id); return !!(el && el.checked); };
  document.getElementById('drift-close').addEventListener('click', closeDriftModal);
  document.getElementById('drift-cancel').addEventListener('click', closeDriftModal);
  wrap.addEventListener('click', e=>{ if (e.target===wrap) closeDriftModal(); });
  document.getElementById('drift-apply').addEventListener('click', ()=>{
    pushUndo('schema drift merge');
    const applied = applySchemaDiff(driftDiff, {
      addTables: checked('drift-add-tables'),
      addColumns: checked('drift-add-columns'),
      updateColumns: checked('drift-update-columns'),
      removeColumns: checked('drift-remove-columns'),
      excludeMissingTables: checked('drift-exclude-tables'),
    });
    closeDriftModal();
    renderAll(); setActiveTabViewOnly('tables');
    toastUndo(`Drift merged: +${applied.tablesAdded} table(s), +${applied.columnsAdded} column(s), ${applied.columnsUpdated} updated, ${applied.columnsRemoved} removed, ${applied.tablesExcluded} excluded.`);
    // New tables/columns aren't in the vault model yet — offer to carry the
    // merge through Staging and Vault right away, instead of leaving it to
    // the "unmodelled items" banners to be noticed later.
    if (applied.tablesAdded || applied.columnsAdded) renderDriftFollowupModal(applied);
  });
}

// Post-merge follow-through: the model (hubs/links/sats/derivations) and
// therefore the DDL + metadata spreadsheet don't know about the merged
// items until they're modelled. Offer both routes.
function renderDriftFollowupModal(applied){
  const wrap = document.createElement('div');
  wrap.id = 'drift-followup-backdrop';
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal-card" style="max-width:520px;">
      <div class="flex-between" style="margin-bottom:4px;">
        <h3 style="font-family:var(--font-display);font-size:15px;margin:0;">Carry the merge into the model?</h3>
        <button class="btn small ghost" id="drift-fu-close">&times;</button>
      </div>
      <p class="section-desc" style="margin-bottom:14px;">
        ${applied.tablesAdded?`${applied.tablesAdded} new table(s)`:''}${applied.tablesAdded&&applied.columnsAdded?' and ':''}${applied.columnsAdded?`${applied.columnsAdded} new column(s)`:''}
        merged — not yet in the vault model, so not yet in the DDL or spreadsheet.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button class="btn primary" id="drift-fu-suggest">Detect Vault Tables — model automatically</button>
        <button class="btn" id="drift-fu-ai">AI Assist</button>
        <button class="btn ghost" id="drift-fu-later">Later — run an Integrity Check on the Staging or Vault step</button>
      </div>
      <p class="hint mt mb0">For a deployed vault, run "Diff against target" on the Export step afterwards.</p>
    </div>`;
  document.body.appendChild(wrap);
  const close = ()=>{ const m = document.getElementById('drift-followup-backdrop'); if (m) m.remove(); };
  document.getElementById('drift-fu-close').addEventListener('click', close);
  document.getElementById('drift-fu-later').addEventListener('click', close);
  wrap.addEventListener('click', e=>{ if (e.target===wrap) close(); });
  document.getElementById('drift-fu-suggest').addEventListener('click', ()=>{ close(); runSuggestFromKeys('tables'); });
  document.getElementById('drift-fu-ai').addEventListener('click', ()=>{ close(); openAiModal('vault'); });
}

