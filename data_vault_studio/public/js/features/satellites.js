/* ---------------- SATELLITES ---------------- */
let satKind = 'hub'; // 'hub' | 'link'
let satAttrDraft = [];

function renderSatsSub(el){
  if (!FEATURE_LINK_SATELLITES) satKind = 'hub';
  el.innerHTML = `
    <div class="panel">
      <div class="grid cols-2">
        ${FEATURE_LINK_SATELLITES?`<div class="field">
          <label>Satellite type</label>
          <select id="sat-kind">
            <option value="hub" ${satKind==='hub'?'selected':''}>Hub satellite</option>
            <option value="link" ${satKind==='link'?'selected':''}>Link satellite</option>
          </select>
        </div>`:''}
        <div class="field" id="sat-parent-wrap"></div>
      </div>
      <div class="grid cols-3 mt">
        <div class="field"><label>Concern <span class="hint">(suffix, optional)</span></label><input type="text" id="sat-concern" placeholder="profile"></div>
        <div class="field"><label>Source table</label><select id="sat-table">${includedTables().map(t=>`<option value="${t.id}">${sourceTableLabel(t)}</option>`).join('')}</select></div>
        <div class="field"><label>Key status</label><div id="sat-key-status" class="hint" style="margin-top:9px;"></div></div>
      </div>
      <div class="panel-head" style="margin:14px -20px 0;"><h3>Attributes</h3></div>
      <div id="sat-attr-rows"></div>
      <button class="btn small mt" id="btn-add-attr-row">+ Add attribute</button>
      <div class="mt"><button class="btn primary" id="btn-add-sat">+ Add satellite</button></div>
    </div>
    <div id="sats-list"></div>
  `;
  const kindSel = el.querySelector('#sat-kind');
  if (kindSel) kindSel.addEventListener('change', ()=>{ satKind = kindSel.value; satAttrDraft=[]; renderAll(); setActiveTabViewOnly('vault'); modelSub='satellites'; });
  renderSatParentField(el);
  renderSatAttrRows(el);
  el.querySelector('#sat-table').addEventListener('change', ()=>{ updateSatKeyStatus(el); satAttrDraft=[]; renderSatAttrRows(el); });
  el.querySelector('#btn-add-attr-row').addEventListener('click', ()=>{ satAttrDraft.push({colId:'', target:''}); renderSatAttrRows(el); });
  updateSatKeyStatus(el);

  el.querySelector('#btn-add-sat').addEventListener('click', ()=>{
    const entity = satKind==='hub' ? el.querySelector('#sat-parent').value : el.querySelector('#sat-parent').value;
    const concernRaw = el.querySelector('#sat-concern').value.trim();
    const concern = concernRaw ? sqlNamePart(concernRaw) : '';
    const tableId = el.querySelector('#sat-table').value;
    const attrs = satAttrDraft.filter(a=>a.colId).map(a=>{
      const table = findTable(tableId);
      const col = findCol(table, a.colId);
      return { colId:a.colId, target: targetIdentifierBase(a.target.trim() || targetColumnName(col)) };
    });
    if (!entity){ toast('Pick a parent hub/link.','err'); return; }
    if (attrs.length===0){ toast('Add at least one attribute.','err'); return; }
    const table = findTable(tableId);
    if (satKind==='hub'){
      const hub = findHub(entity);
      ensureHubFeedHash(table,hub);
      if (!tableHasHubHashOnTable(table, hub)){
        toast(`Table "${table.name}" has no hash key derivation for "${hub.entity}" — add one in the Tables tab first.`,'err'); return;
      }
      const attrDup = findDuplicateHubSatByAttrs(hub.id, tableId, attrs);
      if (attrDup){
        toast(`A satellite for "${hubName(hub.entity)}" already covers attribute(s) ${satAttrLabel(tableId, attrs)} in "${satName(attrDup.entity, attrDup.concern)}" — edit that satellite instead of creating another name for the same source columns.`,'err'); return;
      }
      if (state.hubSats.some(s=>s.hubId===hub.id && (s.concern||'')===concern)){
        toast(`A satellite for "${hubName(hub.entity)}"${concern?` (concern "${concern}")`:''} already exists — edit it instead, or pick a different concern name.`,'err'); return;
      }
      state.hubSats.push({ id: uid('sat'), entity: hub.entity, concern, description:'', hubId: hub.id, tableId, attrs });
    } else {
      const link = findLink(entity);
      const missing = link.hubs.filter(h=>!ensureLinkHubHash(table, h, link));
      if (missing.length){
        toast(`Table "${table.name}" is missing hash keys for this link's hubs — add derivations in the Tables tab.`,'err'); return;
      }
      const attrDup = findDuplicateLinkSatByAttrs(link.id, tableId, attrs);
      if (attrDup){
        toast(`A satellite for "${linkNameOf(link.entity)}" already covers attribute(s) ${satAttrLabel(tableId, attrs)} in "${lsatName(attrDup.entity, attrDup.concern)}" — edit that satellite instead of creating another name for the same source columns.`,'err'); return;
      }
      if (state.linkSats.some(s=>s.linkId===link.id && (s.concern||'')===concern)){
        toast(`A satellite for "${linkNameOf(link.entity)}"${concern?` (concern "${concern}")`:''} already exists — edit it instead, or pick a different concern name.`,'err'); return;
      }
      state.linkSats.push({ id: uid('lsat'), entity: link.entity, concern, description:'', linkId: link.id, tableId, attrs });
    }
    satAttrDraft = [];
    renderAll(); setActiveTabViewOnly('vault'); modelSub='satellites';
    toast('Satellite created.','ok');
  });

  renderSatsList(el.querySelector('#sats-list'));
}

function renderSatParentField(el){
  const wrap = el.querySelector('#sat-parent-wrap');
  if (satKind==='hub'){
    wrap.innerHTML = `<label>Parent hub</label><select id="sat-parent">${state.hubs.map(h=>`<option value="${h.id}">${hubName(h.entity)}</option>`).join('') || '<option value="">no hubs yet</option>'}</select>`;
  } else {
    wrap.innerHTML = `<label>Parent link</label><select id="sat-parent">${state.links.map(l=>`<option value="${l.id}">${linkNameOf(l.entity)}</option>`).join('') || '<option value="">no links yet</option>'}</select>`;
  }
}

function updateSatKeyStatus(el){
  const tableId = el.querySelector('#sat-table').value;
  const table = findTable(tableId);
  const parentId = el.querySelector('#sat-parent') ? el.querySelector('#sat-parent').value : '';
  const statusEl = el.querySelector('#sat-key-status');
  if (!parentId || !table){ statusEl.textContent=''; return; }
  if (satKind==='hub'){
    const hub = findHub(parentId);
    ensureHubFeedHash(table,hub);
    statusEl.innerHTML = tableHasHubHashOnTable(table, hub)
      ? `<span style="color:var(--ok)">${hashColumnNameForHub(table,hub)} available</span>`
      : `<span style="color:var(--err)">no hash key for "${hub.entity}" on this table</span>`;
  } else {
    const link = findLink(parentId);
    const ok = link.hubs.every(h=>ensureLinkHubHash(table, h, link));
    statusEl.innerHTML = ok ? `<span style="color:var(--ok)">all hub keys available</span>` : `<span style="color:var(--err)">missing one or more hub hash keys</span>`;
  }
}

function renderSatAttrRows(el){
  const wrap = el.querySelector('#sat-attr-rows');
  const tableId = el.querySelector('#sat-table').value;
  const table = findTable(tableId);
  const cols = table ? table.columns : [];
  if (satAttrDraft.length===0) satAttrDraft.push({colId:'', target:''});
  wrap.innerHTML = satAttrDraft.map((a,i)=>`
    <div class="deriv-row" style="grid-template-columns:1fr 1fr auto;">
      <select data-ar="${i}" data-af="colId"><option value="">source column…</option>${cols.filter(isColumnStaged).map(c=>`<option value="${c.id}" ${a.colId===c.id?'selected':''}>${c.name}</option>`).join('')}</select>
      <input type="text" data-ar="${i}" data-af="target" placeholder="target column name (optional)" value="${a.target}">
      <button class="btn small danger" data-delar="${i}">&times;</button>
    </div>`).join('');
  wrap.querySelectorAll('select,input').forEach(s=>{
    s.addEventListener('input', e=>{ satAttrDraft[s.dataset.ar][s.dataset.af] = e.target.value; });
    s.addEventListener('change', e=>{ satAttrDraft[s.dataset.ar][s.dataset.af] = e.target.value; });
  });
  wrap.querySelectorAll('[data-delar]').forEach(b=>{
    b.addEventListener('click', ()=>{ satAttrDraft.splice(Number(b.dataset.delar),1); renderSatAttrRows(el); });
  });
  // re-hook parent select for key status after render
  const parentSel = el.querySelector('#sat-parent');
  if (parentSel) parentSel.addEventListener('change', ()=>updateSatKeyStatus(el));
}

let expandedSatId = null;
let editSatAttrDraft = [];

function satAttrNames(tableId, attrs){
  const table = findTable(tableId);
  return (attrs||[]).map(a=>{
    const col = table ? findCol(table, a.colId) : null;
    return (col && col.name) || a.column || a.attribute_source_column || a.target || '';
  }).map(x=>String(x||'').trim().toLowerCase()).filter(Boolean).sort();
}
function satAttrSignature(tableId, attrs){
  return satAttrNames(tableId, attrs).join('|');
}
function satAttrLabel(tableId, attrs){
  return satAttrNames(tableId, attrs).join(', ');
}
function findDuplicateHubSatByAttrs(hubId, tableId, attrs, ignoreId){
  const sig = satAttrSignature(tableId, attrs);
  if (!sig) return null;
  return state.hubSats.find(s=>s.id!==ignoreId && s.hubId===hubId && s.tableId===tableId && satAttrSignature(s.tableId, s.attrs)===sig) || null;
}
function findDuplicateLinkSatByAttrs(linkId, tableId, attrs, ignoreId){
  const sig = satAttrSignature(tableId, attrs);
  if (!sig) return null;
  return state.linkSats.find(s=>s.id!==ignoreId && s.linkId===linkId && s.tableId===tableId && satAttrSignature(s.tableId, s.attrs)===sig) || null;
}
function satelliteDisplayName(s, kind){
  return kind==='hub' ? satName(s.entity, s.concern) : lsatName(s.entity, s.concern);
}


function findDuplicateSatelliteGroups(){
  // Catch both duplicate names/concerns and the more subtle case where two
  // differently-named satellites cover the same parent + source table +
  // attribute set, e.g. lsat_*_relationship and plain lsat_* rows.
  const groups = {};
  const add = (key, sat) => { (groups[key] = groups[key]||[]).push(sat); };
  state.hubSats.forEach(s=>{
    add(`hub-name|${s.hubId}|${s.concern||''}`, s);
    const sig = satAttrSignature(s.tableId, s.attrs);
    if (sig) add(`hub-attrs|${s.hubId}|${s.tableId}|${sig}`, s);
  });
  state.linkSats.forEach(s=>{
    add(`link-name|${s.linkId}|${s.concern||''}`, s);
    const sig = satAttrSignature(s.tableId, s.attrs);
    if (sig) add(`link-attrs|${s.linkId}|${s.tableId}|${sig}`, s);
  });
  const seen = new Set();
  return Object.values(groups).filter(g=>g.length>1).filter(g=>{
    const key = g.map(s=>s.id).sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function removeDuplicateSatellites(){
  const groups = findDuplicateSatelliteGroups();
  let removed = 0;
  groups.forEach(group=>{
    // Keep the last one in each group — later entries have consistently
    // been the more-refined version in cases seen so far (e.g. a
    // corrected concern name from a subsequent AI Assist run).
    const toRemove = new Set(group.slice(0, -1).map(s=>s.id));
    if (toRemove.size===0) return;
    state.hubSats = state.hubSats.filter(s=>!toRemove.has(s.id));
    state.linkSats = state.linkSats.filter(s=>!toRemove.has(s.id));
    removed += toRemove.size;
  });
  renderAll(); setActiveTabViewOnly('vault'); modelSub='satellites';
  toast(`Removed ${removed} duplicate satellite(s).`, 'ok');
}

function renderSatsList(el){
  const all = [
    ...state.hubSats.map(s=>({...s, kind:'hub'})),
    ...state.linkSats.map(s=>({...s, kind:'link'})),
  ];
  const dupGroups = findDuplicateSatelliteGroups();
  const dupBanner = dupGroups.length ? `
    <div class="panel" style="border-color:var(--err);">
      <div class="flex-between">
        <p class="hint mb0" style="color:var(--err);">${dupGroups.reduce((n,g)=>n+g.length-1,0)} duplicate satellite(s) found across ${dupGroups.length} hub/link(s) — likely from running AI Assist more than once before this was fixed. Exporting like this would create duplicate Metadata rows.</p>
        <button class="btn small danger" id="btn-remove-dup-sats" style="flex-shrink:0;">Remove duplicates</button>
      </div>
    </div>
  ` : '';
  if (all.length===0){ el.innerHTML = dupBanner + `<div class="empty">No satellites yet.</div>`; return; }
  el.innerHTML = dupBanner + all.map(s=>{
    const t = findTable(s.tableId);
    const name = s.kind==='hub' ? satName(s.entity, s.concern) : lsatName(s.entity, s.concern);
    const open = expandedSatId===s.id;
    return `
    <div class="entity-card">
      <div class="ehead ${open?'open':''}" data-toggle-sat="${s.id}" data-toggle-sat-kind="${s.kind}">
        <div class="ehead-left">
          <span class="entity-marker sat"></span>
          <span class="entity-name">${name}</span>
          <span class="entity-meta">${s.attrs.length} attrs · from <span class="mono">${t?sourceTableLabel(t):'?'}</span> · ${s.kind==='hub'?'hub sat':'link sat'}</span>
        </div>
        <button class="btn small danger" data-del-sat="${s.id}" data-sat-kind="${s.kind}">Delete</button>
      </div>
      <div class="entity-body ${open?'open':''}" id="sat-edit-${s.id}"></div>
    </div>`;
  }).join('');
  const dupBtn = el.querySelector('#btn-remove-dup-sats');
  if (dupBtn) dupBtn.addEventListener('click', ()=>{
    if (confirm('Remove duplicate satellites? For each duplicate group, only the last one is kept.')) removeDuplicateSatellites();
  });
  el.querySelectorAll('[data-toggle-sat]').forEach(head=>{
    head.addEventListener('click', e=>{
      if (e.target.closest('[data-del-sat]')) return;
      const id = head.dataset.toggleSat;
      const kind = head.dataset.toggleSatKind;
      if (expandedSatId===id){ expandedSatId = null; }
      else {
        expandedSatId = id;
        const s = kind==='hub' ? state.hubSats.find(x=>x.id===id) : state.linkSats.find(x=>x.id===id);
        editSatAttrDraft = s.attrs.map(a=>({colId:a.colId, target:a.target}));
      }
      renderAll(); setActiveTabViewOnly('vault'); modelSub='satellites';
    });
  });
  el.querySelectorAll('[data-del-sat]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const id = b.dataset.delSat;
      if (b.dataset.satKind==='hub') state.hubSats = state.hubSats.filter(s=>s.id!==id);
      else state.linkSats = state.linkSats.filter(s=>s.id!==id);
      renderAll(); setActiveTabViewOnly('vault'); modelSub='satellites';
    });
  });
  all.forEach(s=>{
    if (expandedSatId===s.id) renderSatEditForm(document.getElementById('sat-edit-'+s.id), s);
  });
}

function renderSatEditForm(el, s){
  const isHubSat = s.kind==='hub';
  const parentOptions = isHubSat
    ? state.hubs.map(h=>`<option value="${h.id}" ${h.id===s.hubId?'selected':''}>${hubName(h.entity)}</option>`).join('')
    : state.links.map(l=>`<option value="${l.id}" ${l.id===s.linkId?'selected':''}>${linkNameOf(l.entity)}</option>`).join('');
  el.innerHTML = `
    <div class="grid cols-3">
      <div class="field"><label>${isHubSat?'Parent hub':'Parent link'}</label><select id="edit-sat-parent">${parentOptions}</select></div>
      <div class="field"><label>Concern</label><input type="text" id="edit-sat-concern" value="${s.concern||''}" placeholder="profile"></div>
      <div class="field"><label>Source table</label><select id="edit-sat-table">${includedTables().map(t=>`<option value="${t.id}" ${t.id===s.tableId?'selected':''}>${sourceTableLabel(t)}</option>`).join('')}</select></div>
    </div>
    <div id="edit-sat-key-status" class="hint mt"></div>
    <div class="panel-head" style="margin:14px -20px 0;"><h3>Attributes</h3></div>
    <div id="edit-sat-attr-rows"></div>
    <button class="btn small mt" id="btn-edit-add-attr-row">+ Add attribute</button>
    <div class="flex-between mt">
      <button class="btn ghost small" id="edit-sat-cancel">Cancel</button>
      <button class="btn primary small" id="edit-sat-save">Save changes</button>
    </div>
  `;
  const updateKeyStatus = ()=>{
    const table = findTable(el.querySelector('#edit-sat-table').value);
    const parentId = el.querySelector('#edit-sat-parent').value;
    const statusEl = el.querySelector('#edit-sat-key-status');
    if (!table || !parentId){ statusEl.textContent=''; return; }
    if (isHubSat){
      const hub = findHub(parentId);
      ensureHubFeedHash(table,hub);
      statusEl.innerHTML = tableHasHubHashOnTable(table, hub)
        ? `<span style="color:var(--ok)">${hashColumnNameForHub(table,hub)} available</span>`
        : `<span style="color:var(--err)">no hash key for "${hub.entity}" on this table</span>`;
    } else {
      const link = findLink(parentId);
      const ok = link.hubs.every(h=>ensureLinkHubHash(table, h, link));
      statusEl.innerHTML = ok ? `<span style="color:var(--ok)">all hub keys available</span>` : `<span style="color:var(--err)">missing one or more hub hash keys</span>`;
    }
  };
  el.querySelector('#edit-sat-table').addEventListener('change', ()=>{ updateKeyStatus(); renderEditSatAttrRows(el); });
  el.querySelector('#edit-sat-parent').addEventListener('change', updateKeyStatus);
  updateKeyStatus();
  renderEditSatAttrRows(el);
  el.querySelector('#btn-edit-add-attr-row').addEventListener('click', ()=>{
    editSatAttrDraft.push({colId:'', target:''});
    renderEditSatAttrRows(el);
  });
  el.querySelector('#edit-sat-cancel').addEventListener('click', ()=>{ expandedSatId=null; renderAll(); setActiveTabViewOnly('vault'); modelSub='satellites'; });
  el.querySelector('#edit-sat-save').addEventListener('click', ()=>{
    const parentId = el.querySelector('#edit-sat-parent').value;
    const concernRaw = el.querySelector('#edit-sat-concern').value.trim();
    const concern = concernRaw ? sqlNamePart(concernRaw) : '';
    const tableId = el.querySelector('#edit-sat-table').value;
    const table = findTable(tableId);
    const attrs = editSatAttrDraft.filter(a=>a.colId).map(a=>{
      const col = findCol(table, a.colId);
      return { colId:a.colId, target: targetIdentifierBase((a.target||'').trim() || targetColumnName(col)) };
    });
    if (!parentId){ toast('Pick a parent hub/link.','err'); return; }
    if (attrs.length===0){ toast('Add at least one attribute.','err'); return; }
    if (isHubSat){
      const hub = findHub(parentId);
      if (!tableHasHubHashOnTable(table, hub)){ toast(`Table "${table.name}" has no hash key derivation for "${hub.entity}".`,'err'); return; }
      const sat = state.hubSats.find(x=>x.id===s.id);
      sat.hubId = parentId; sat.entity = hub.entity; sat.concern = concern; sat.tableId = tableId; sat.attrs = attrs;
    } else {
      const link = findLink(parentId);
      const missing = link.hubs.filter(h=>!ensureLinkHubHash(table, h, link));
      if (missing.length){ toast(`Table "${table.name}" is missing hash keys for this link's hubs.`,'err'); return; }
      const sat = state.linkSats.find(x=>x.id===s.id);
      sat.linkId = parentId; sat.entity = link.entity; sat.concern = concern; sat.tableId = tableId; sat.attrs = attrs;
    }
    expandedSatId = null;
    renderAll(); setActiveTabViewOnly('vault'); modelSub='satellites';
    toast('Satellite updated.','ok');
  });
}

function renderEditSatAttrRows(el){
  const wrap = el.querySelector('#edit-sat-attr-rows');
  const table = findTable(el.querySelector('#edit-sat-table').value);
  const cols = table ? table.columns : [];
  if (editSatAttrDraft.length===0) editSatAttrDraft.push({colId:'', target:''});
  wrap.innerHTML = editSatAttrDraft.map((a,i)=>`
    <div class="deriv-row" style="grid-template-columns:1fr 1fr auto;">
      <select data-ear="${i}" data-eaf="colId"><option value="">source column…</option>${cols.filter(isColumnStaged).map(c=>`<option value="${c.id}" ${a.colId===c.id?'selected':''}>${c.name}</option>`).join('')}</select>
      <input type="text" data-ear="${i}" data-eaf="target" placeholder="target column name (optional)" value="${a.target||''}">
      <button class="btn small danger" data-deleditar="${i}">&times;</button>
    </div>`).join('');
  wrap.querySelectorAll('select,input').forEach(s=>{
    const handler = e=>{ editSatAttrDraft[s.dataset.ear][s.dataset.eaf] = e.target.value; };
    s.addEventListener('input', handler); s.addEventListener('change', handler);
  });
  wrap.querySelectorAll('[data-deleditar]').forEach(b=>{
    b.addEventListener('click', ()=>{ editSatAttrDraft.splice(Number(b.dataset.deleditar),1); renderEditSatAttrRows(el); });
  });
}
