/* ---------------- HUBS ---------------- */
function renderHubsSub(el){
  const tables = includedTables();
  if (tables.length===0){
    el.innerHTML = `<div class="empty">Add and include at least one table in the Tables tab before defining hubs.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="panel">
      <div class="grid cols-4">
        <div class="field"><label>Entity name</label><input type="text" id="hub-entity" placeholder="customer"></div>
        <div class="field"><label>Source table</label><select id="hub-table">${tables.map(t=>`<option value="${t.id}">${t.name}</option>`).join('')}</select></div>
        <div class="field"><label>Business key columns</label><select id="hub-pk" multiple size="5"></select><span class="hint">Select one or more columns. Composite keys use source-column order.</span></div>
        <div class="field checkbox-row" style="margin-top:22px;"><input type="checkbox" id="hub-statussat" checked><span>Status satellite (uncheck for lookup/reference)</span></div>
      </div>
      <button class="btn primary mt" id="btn-add-hub">+ Add hub</button>
    </div>
    <div id="hubs-list"></div>
  `;
  const tableSel = el.querySelector('#hub-table');
  const pkSel = el.querySelector('#hub-pk');
  const fillPk = ()=>{
    const t = findTable(tableSel.value);
    const staged = stagedColumns(t);
    const pkIds = new Set(staged.filter(c=>c.pk).map(c=>c.id));
    pkSel.innerHTML = staged.map(c=>`<option value="${c.id}" ${pkIds.has(c.id)?'selected':''}>${c.name}${c.pk?' (pk)':''}</option>`).join('') || '<option value="">no columns</option>';
  };
  tableSel.addEventListener('change', fillPk); fillPk();

  el.querySelector('#btn-add-hub').addEventListener('click', ()=>{
    const entity = el.querySelector('#hub-entity').value.trim();
    const tableId = tableSel.value;
    const keyColIds = selectedValues(pkSel);
    if (!entity || !tableId || !keyColIds.length){ toast('Fill in the entity name, table and at least one business key column.','err'); return; }
    if (!/^[a-z][a-z0-9_]*$/.test(entity)){ toast('Entity name should be lowercase snake_case.','err'); return; }
    if (state.hubs.some(h=>h.entity===entity)){ toast('A hub with that entity name already exists.','err'); return; }
    const table = findTable(tableId);
    const cols = keyColIds.map(id=>findStagedColumn(table,id)).filter(Boolean);
    if (cols.length!==keyColIds.length){ toast('One or more selected business key columns are not staged.','err'); return; }
    ensureKeyDerivation(table, entity, cols.map(c=>c.name), 'both');
    state.hubs.push({ id:uid('hub'), entity, description:'', tableId, pkColId:keyColIds[0], keyColIds, statusSat:el.querySelector('#hub-statussat').checked });
    renderAll(); setActiveTabViewOnly('vault'); modelSub='hubs';
    toast(`Hub "${hubName(entity)}" created.`,'ok');
  });
  el.querySelector('#hub-entity').addEventListener('keydown', e=>{
    if (e.key==='Enter') el.querySelector('#btn-add-hub').click();
  });

  renderHubsList(el.querySelector('#hubs-list'));
}

let expandedHubId = null;

function renderHubsList(el){
  if (state.hubs.length===0){ el.innerHTML = `<div class="empty">No hubs yet.</div>`; return; }
  el.innerHTML = state.hubs.map(h=>{
    const t = findTable(h.tableId);
    const keyLabel = hubKeyCols(h).map(c=>c.name).join(' + ') || '?';
    const open = expandedHubId===h.id;
    return `
    <div class="entity-card">
      <div class="ehead ${open?'open':''}" data-toggle-hub="${h.id}">
        <div class="ehead-left">
          <span class="entity-marker hub"></span>
          <span class="entity-name">${hubName(h.entity)}</span>
          <span class="entity-meta">from <span class="mono">${t?t.name:'?'}</span> · business key <span class="mono">${keyLabel}</span> ${h.statusSat?'':'· <span class="tag">no status sat</span>'}</span>
        </div>
        <button class="btn small danger" data-del-hub="${h.id}">Delete</button>
      </div>
      <div class="entity-body ${open?'open':''}" id="hub-edit-${h.id}"></div>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-toggle-hub]').forEach(head=>{
    head.addEventListener('click', e=>{
      if (e.target.closest('[data-del-hub]')) return;
      const id = head.dataset.toggleHub;
      expandedHubId = expandedHubId===id ? null : id;
      renderAll(); setActiveTabViewOnly('vault'); modelSub='hubs';
    });
  });
  el.querySelectorAll('[data-del-hub]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const id = b.dataset.delHub;
      const used = state.links.some(l=>l.hubs.some(x=>x.hubId===id)) || state.hubSats.some(s=>s.hubId===id);
      if (used && !confirm('This hub is used by a link or satellite. Delete anyway? Dependent links/satellites will also be removed.')) return;
      state.hubs = state.hubs.filter(h=>h.id!==id);
      const removed = pruneDownstreamModel({ dropExcluded:true });
      renderAll(); setActiveTabViewOnly('vault'); modelSub='hubs';
      if (removedModelCount(removed)) toast(`Removed dependent model objects: ${modelRemovalSummary(removed)}.`, 'ok');
    });
  });
  state.hubs.forEach(h=>{
    if (expandedHubId===h.id) renderHubEditForm(document.getElementById('hub-edit-'+h.id), h);
  });
}

function renderHubEditForm(el, h){
  el.innerHTML = `
    <div class="grid cols-4">
      <div class="field"><label>Entity name</label><input type="text" id="edit-hub-entity" value="${h.entity}"></div>
      <div class="field"><label>Source table</label><select id="edit-hub-table">${includedTables().map(t=>`<option value="${t.id}" ${t.id===h.tableId?'selected':''}>${t.name}</option>`).join('')}</select></div>
      <div class="field"><label>Business key columns</label><select id="edit-hub-pk" multiple size="5"></select><span class="hint">Select one or more columns. Composite keys use source-column order.</span></div>
      <div class="field checkbox-row" style="margin-top:22px;"><input type="checkbox" id="edit-hub-statussat" ${h.statusSat?'checked':''}><span>Status satellite</span></div>
    </div>
    <div class="flex-between mt">
      <button class="btn ghost small" id="edit-hub-cancel">Cancel</button>
      <button class="btn primary small" id="edit-hub-save">Save changes</button>
    </div>
  `;
  const tableSel = el.querySelector('#edit-hub-table');
  const pkSel = el.querySelector('#edit-hub-pk');
  const fillPk = ()=>{
    const t = findTable(tableSel.value);
    const current = tableSel.value===h.tableId ? new Set(hubKeyColIds(h)) : new Set(stagedColumns(t).filter(c=>c.pk).map(c=>c.id));
    pkSel.innerHTML = stagedColumns(t).map(c=>`<option value="${c.id}" ${current.has(c.id)?'selected':''}>${c.name}${c.pk?' (pk)':''}</option>`).join('') || '<option value="">no columns</option>';
  };
  tableSel.addEventListener('change', fillPk); fillPk();
  el.querySelector('#edit-hub-cancel').addEventListener('click', ()=>{ expandedHubId=null; renderAll(); setActiveTabViewOnly('vault'); modelSub='hubs'; });
  el.querySelector('#edit-hub-save').addEventListener('click', ()=>{
    const entity = el.querySelector('#edit-hub-entity').value.trim();
    const tableId = tableSel.value;
    const keyColIds = selectedValues(pkSel);
    if (!entity || !tableId || !keyColIds.length){ toast('Fill in the entity name, table and at least one business key column.','err'); return; }
    if (!/^[a-z][a-z0-9_]*$/.test(entity)){ toast('Entity name should be lowercase snake_case.','err'); return; }
    if (entity!==h.entity && state.hubs.some(x=>x.entity===entity)){ toast('A hub with that entity name already exists.','err'); return; }
    const table = findTable(tableId);
    const cols = keyColIds.map(id=>findStagedColumn(table,id)).filter(Boolean);
    if (cols.length!==keyColIds.length){ toast('One or more selected business key columns are not staged.','err'); return; }
    h.entity=entity; h.tableId=tableId; h.pkColId=keyColIds[0]; h.keyColIds=keyColIds; h.statusSat=el.querySelector('#edit-hub-statussat').checked;
    ensureKeyDerivation(table, entity, cols.map(c=>c.name), 'both');
    expandedHubId = null;
    renderAll(); setActiveTabViewOnly('vault'); modelSub='hubs';
    toast(`Hub "${hubName(entity)}" updated.`,'ok');
  });
}

