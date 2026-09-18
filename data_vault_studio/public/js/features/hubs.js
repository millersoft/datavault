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
        <div class="field"><label>Source table</label><select id="hub-table">${tables.map(t=>`<option value="${t.id}">${sourceTableLabel(t)}</option>`).join('')}</select></div>
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
    const table = findTable(tableId);
    const cols = keyColIds.map(id=>findStagedColumn(table,id)).filter(Boolean);
    if (cols.length!==keyColIds.length){ toast('One or more selected business key columns are not staged.','err'); return; }
    const existing=state.hubs.find(h=>h.entity===entity);
    if (existing){
      const existingKeys=hubKeyCols(existing).map(c=>c.name);
      const compatible=existingKeys.length===cols.length && existingKeys.every((name,index)=>name===cols[index].name);
      const alreadyFed=hubSourceFeeds(existing).some(feed=>feed.tableId===table.id);
      if (!compatible){ toast(`Hub "${entity}" already exists with a different business key. Create a distinct entity or align the key columns.`, 'err'); return; }
      if (alreadyFed){ toast(`Table "${sourceTableLabel(table)}" already feeds Hub "${hubName(entity)}".`, 'err'); return; }
      if (!confirm(`Use ${sourceTableLabel(table)} as another source feed for Hub ${hubName(entity)}? This is an explicit shared-hub decision and will add a separate hub-source row.`)) return;
      existing.sourceFeeds=hubSourceFeeds(existing).concat([{tableId:table.id,keyColIds:keyColIds.slice()}]);
      ensureKeyDerivation(table, entity, cols.map(c=>c.name), 'both');
      renderAll(); setActiveTabViewOnly('vault'); modelSub='hubs';
      toast(`Added ${sourceTableLabel(table)} as a source feed for Hub "${hubName(entity)}".`, 'ok');
      return;
    }
    ensureKeyDerivation(table, entity, cols.map(c=>c.name), 'both');
    state.hubs.push({ id:uid('hub'), entity, description:'', tableId, pkColId:keyColIds[0], keyColIds, sourceFeeds:[{tableId,keyColIds:keyColIds.slice()}], statusSat:el.querySelector('#hub-statussat').checked });
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
    const sources=hubSourceFeeds(h).map(feed=>sourceTableLabel(findTable(feed.tableId)||{})).join(', ');
    const open = expandedHubId===h.id;
    return `
    <div class="entity-card">
      <div class="ehead ${open?'open':''}" data-toggle-hub="${h.id}">
        <div class="ehead-left">
          <span class="entity-marker hub"></span>
          <span class="entity-name">${hubName(h.entity)}</span>
          <span class="entity-meta">from <span class="mono">${sources||sourceTableLabel(t||{})}</span> · business key <span class="mono">${keyLabel}</span> ${h.statusSat?'':'· <span class="tag">no status sat</span>'}</span>
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
  const feeds=hubSourceFeeds(h);
  const availableFeedTables=includedTables().filter(t=>!feeds.some(feed=>feed.tableId===t.id));
  const primaryLocked=feeds.length>1;
  el.innerHTML = `
    <div class="grid cols-4">
      <div class="field"><label>Entity name</label><input type="text" id="edit-hub-entity" value="${h.entity}"></div>
      <div class="field"><label>Primary source table</label><select id="edit-hub-table" ${primaryLocked?'disabled':''}>${includedTables().map(t=>`<option value="${t.id}" ${t.id===h.tableId?'selected':''}>${sourceTableLabel(t)}</option>`).join('')}</select>${primaryLocked?'<span class="hint">Managed below as a shared Hub source feed.</span>':''}</div>
      <div class="field"><label>Business key columns</label><select id="edit-hub-pk" multiple size="5" ${primaryLocked?'disabled':''}></select><span class="hint">${primaryLocked?'Shared Hub feeds use this key; edit feeds before changing it.':'Select one or more columns. Composite keys use source-column order.'}</span></div>
      <div class="field checkbox-row" style="margin-top:22px;"><input type="checkbox" id="edit-hub-statussat" ${h.statusSat?'checked':''}><span>Status satellite</span></div>
    </div>
    <div class="panel mt" style="padding:14px 16px;">
      <div class="panel-head" style="margin:-14px -16px 12px;"><h3>Source feeds <span class="badge-count">&nbsp;·&nbsp;${feeds.length}</span></h3></div>
      <p class="hint">Each feed loads into this same Hub. Feeds are serialized during loading to avoid Hub-key contention.</p>
      <div class="mono" style="line-height:1.9;">${feeds.map((feed,index)=>{
        const table=findTable(feed.tableId)||{};
        const keys=(feed.keyColIds||[]).map(id=>findCol(table,id)).filter(Boolean).map(c=>c.name).join(' + ')||'?';
        return `${index===0?'Primary':'Feed'}: ${escapeHtml(sourceTableLabel(table))} <span class="hint">· ${escapeHtml(keys)}</span>`;
      }).join('<br>')}</div>
      <p id="hub-feed-draft-notice" class="hint" style="display:none; margin:10px 0 0;">Save the primary source table and business-key changes before adding another source feed.</p>
      ${availableFeedTables.length ? `
        <div class="grid cols-3 mt" style="align-items:end;">
          <div class="field"><label>Add source feed</label><select id="add-hub-feed-table">${availableFeedTables.map(t=>`<option value="${t.id}">${sourceTableLabel(t)}</option>`).join('')}</select></div>
          <div class="field"><label>Matching business key</label><select id="add-hub-feed-pk" multiple size="4"></select></div>
          <button class="btn primary" id="btn-add-hub-feed">+ Add source feed</button>
        </div>` : '<p class="hint mb0">All included source tables are already feeds for this Hub.</p>'}
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
  const feedTableSel=el.querySelector('#add-hub-feed-table');
  const feedPkSel=el.querySelector('#add-hub-feed-pk');
  const fillFeedPk=()=>{
    if(!feedTableSel||!feedPkSel) return;
    const table=findTable(feedTableSel.value);
    const hubKeys=hubKeyCols(h).map(c=>c.name);
    feedPkSel.innerHTML=stagedColumns(table).map(c=>`<option value="${c.id}" ${hubKeys.includes(c.name)?'selected':''}>${c.name}${c.pk?' (pk)':''}</option>`).join('');
  };
  const primaryDraftChanged=()=>{
    const currentKeys=hubKeyColIds(h);
    const selectedKeys=selectedValues(pkSel);
    return tableSel.value!==h.tableId || currentKeys.length!==selectedKeys.length || currentKeys.some((id,index)=>id!==selectedKeys[index]);
  };
  const updateFeedControls=()=>{
    if(!feedTableSel||!feedPkSel) return;
    const changed=primaryDraftChanged();
    feedTableSel.disabled=changed;
    feedPkSel.disabled=changed;
    el.querySelector('#btn-add-hub-feed').disabled=changed;
    el.querySelector('#hub-feed-draft-notice').style.display=changed?'block':'none';
  };
  tableSel.addEventListener('change',updateFeedControls);
  pkSel.addEventListener('change',updateFeedControls);
  if(feedTableSel){
    feedTableSel.addEventListener('change',fillFeedPk); fillFeedPk(); updateFeedControls();
    el.querySelector('#btn-add-hub-feed').addEventListener('click',()=>{
      const table=findTable(feedTableSel.value);
      const keyColIds=selectedValues(feedPkSel);
      const cols=keyColIds.map(id=>findStagedColumn(table,id)).filter(Boolean);
      const existingKeys=hubKeyCols(h).map(c=>c.name);
      const compatible=cols.length===existingKeys.length&&cols.every((c,index)=>c.name===existingKeys[index]);
      if(!compatible){ toast(`Source feed must use the same business key as Hub "${hubName(h.entity)}": ${existingKeys.join(' + ')}.`, 'err'); return; }
      h.sourceFeeds=feeds.concat([{tableId:table.id,keyColIds:keyColIds.slice()}]);
      ensureKeyDerivation(table,h.entity,cols.map(c=>c.name),'both');
      expandedHubId=h.id;
      renderAll(); setActiveTabViewOnly('vault'); modelSub='hubs';
      toast(`Added ${sourceTableLabel(table)} as a source feed for Hub "${hubName(h.entity)}".`, 'ok');
    });
  }
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
    const previousTableId=h.tableId;
    h.entity=entity; h.tableId=tableId; h.pkColId=keyColIds[0]; h.keyColIds=keyColIds;
    h.sourceFeeds=hubSourceFeeds(h).map(feed=>feed.tableId===previousTableId ? {tableId,keyColIds:keyColIds.slice()} : feed);
    h.statusSat=el.querySelector('#edit-hub-statussat').checked;
    ensureKeyDerivation(table, entity, cols.map(c=>c.name), 'both');
    expandedHubId = null;
    renderAll(); setActiveTabViewOnly('vault'); modelSub='hubs';
    toast(`Hub "${hubName(entity)}" updated.`,'ok');
  });
}
