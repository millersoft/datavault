/* ---------------- LINKS ---------------- */
let linkDraftHubs = [];

function linkDraftRow(){ return { hubId:'', colId:'', colIds:[], role:'' }; }
function draftColumnIds(row){ return Array.isArray(row.colIds) && row.colIds.length ? row.colIds : (row.colId ? [row.colId] : []); }

function renderLinksSub(el){
  const tables = includedTables();
  if (state.hubs.length<1){
    el.innerHTML = `<div class="empty">Create at least one hub before defining a link. A self-referencing relationship may use the same hub in two different roles.</div>`;
    return;
  }
  if (tables.length===0){
    el.innerHTML = `<div class="empty">Include at least one table in the Tables tab before defining links.</div>`;
    return;
  }
  if (linkDraftHubs.length===0) linkDraftHubs = [linkDraftRow(),linkDraftRow()];
  el.innerHTML = `
    <div class="panel">
      <div class="grid cols-2">
        <div class="field"><label>Relationship name</label><input type="text" id="link-entity" placeholder="customer_order"></div>
        <div class="field"><label>Source table <span class="hint">(table containing the relationship)</span></label><select id="link-table">${tables.map(t=>`<option value="${t.id}">${sourceTableLabel(t)}</option>`).join('')}</select></div>
      </div>
      <div class="panel-head" style="margin:14px -20px 0;"><h3>Connected hubs</h3></div>
      <p class="hint">Choose the staged source key column or columns for each role. Composite references use source-column order.</p>
      <div id="link-hub-rows"></div>
      <button class="btn small mt" id="btn-add-link-hub-row">+ Add another hub (3+ way link)</button>
      <div class="mt"><button class="btn primary" id="btn-add-link">+ Add link</button></div>
    </div>
    <div id="links-list"></div>
  `;
  renderLinkHubRows(el);
  el.querySelector('#btn-add-link-hub-row').addEventListener('click', ()=>{
    const maxHubs=pdiMetaMaxItems('linkHubs');
    if(linkDraftHubs.length>=maxHubs){
      toast(`A Link can contain a maximum of ${maxHubs} Hubs because the PDI metadata model only supports hub positions 1-${maxHubs}.`,'err');
      return;
    }
    linkDraftHubs.push(linkDraftRow());
    renderLinkHubRows(el);
  });
  el.querySelector('#btn-add-link').addEventListener('click', ()=>{
    const entity = el.querySelector('#link-entity').value.trim();
    const tableId = el.querySelector('#link-table').value;
    const table = findTable(tableId);
    const rows = linkDraftHubs.filter(r=>r.hubId && draftColumnIds(r).length).map(r=>Object.assign({},r,{colIds:draftColumnIds(r),colId:draftColumnIds(r)[0]}));
    if (!entity || rows.length<2){ toast('Name the link and pick at least 2 hub roles with source key columns.','err'); return; }
    if (state.links.some(l=>l.entity===entity)){ toast('A link with that name already exists.','err'); return; }
    const issue = linkHubRowsIssue(entity, table, rows);
    if (issue){ toast(issue+'.','err'); return; }
    const normalizedRows = normalizeLinkHubRows(table, rows);
    normalizedRows.forEach(r=>{
      const hub=findHub(r.hubId), cols=linkHubCols(table,r);
      ensureKeyDerivation(table, hub.entity, cols.map(c=>c.name), 'hash', r.role || linkHubRoleFromSource(table,r));
    });
    state.links.push({ id:uid('lnk'), entity, description:'', tableId, hubs:normalizedRows });
    linkDraftHubs = [];
    renderAll(); setActiveTabViewOnly('vault'); modelSub='links';
    toast(`Link "${linkNameOf(entity)}" created.`,'ok');
  });
  renderLinksList(el.querySelector('#links-list'));
}

function renderLinkHubRows(el){
  const wrap = el.querySelector('#link-hub-rows');
  const tableId = el.querySelector('#link-table').value;
  const table = findTable(tableId);
  wrap.innerHTML = linkDraftHubs.map((r,i)=>{
    const selected = new Set(draftColumnIds(r));
    return `<div class="deriv-row" style="grid-template-columns:1fr 1.25fr .8fr auto;align-items:start;">
      <select data-lr="${i}" data-lf="hubId"><option value="">hub…</option>${state.hubs.map(h=>`<option value="${h.id}" ${r.hubId===h.id?'selected':''}>${hubName(h.entity)}</option>`).join('')}</select>
      <select multiple size="4" data-lr="${i}" data-lf="colIds" title="Source key column(s)">${(table?stagedColumns(table):[]).map(c=>`<option value="${c.id}" ${selected.has(c.id)?'selected':''}>${c.name}</option>`).join('')}</select>
      <input type="text" data-lr="${i}" data-lf="role" value="${r.role||''}" placeholder="role (optional)">
      <button class="btn small danger" data-dellr="${i}">&times;</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('select,input').forEach(input=>{
    input.addEventListener('change', e=>{
      const row=linkDraftHubs[Number(input.dataset.lr)], field=input.dataset.lf;
      if (field==='colIds') { row.colIds=selectedValues(input); row.colId=row.colIds[0]||''; }
      else row[field]=e.target.value;
    });
    if (input.tagName==='INPUT') input.addEventListener('input', e=>{ linkDraftHubs[Number(input.dataset.lr)][input.dataset.lf]=e.target.value; });
  });
  wrap.querySelectorAll('[data-dellr]').forEach(b=>{
    b.addEventListener('click', ()=>{ linkDraftHubs.splice(Number(b.dataset.dellr),1); renderLinkHubRows(el); });
  });
  const tableSelect=el.querySelector('#link-table');
  if (!tableSelect.dataset.wired){
    tableSelect.dataset.wired='1';
    tableSelect.addEventListener('change', ()=>{ linkDraftHubs.forEach(r=>{r.colId='';r.colIds=[];}); renderLinkHubRows(el); });
  }
}

let expandedLinkId = null;
let editLinkDraftHubs = [];

function renderLinksList(el){
  if (state.links.length===0){ el.innerHTML = `<div class="empty">No links yet.</div>`; return; }
  el.innerHTML = state.links.map(l=>{
    const t = findTable(l.tableId);
    const hubNames = l.hubs.map(h=>{ const hub=findHub(h.hubId); const role=h.role?` (${h.role})`:''; return hub?hubName(hub.entity)+role:'?'; }).join(', ');
    const open = expandedLinkId===l.id;
    return `
    <div class="entity-card">
      <div class="ehead ${open?'open':''}" data-toggle-link="${l.id}">
        <div class="ehead-left">
          <span class="entity-marker link"></span>
          <span class="entity-name">${linkNameOf(l.entity)}</span>
          <span class="entity-meta">${hubNames} · from <span class="mono">${t?sourceTableLabel(t):'?'}</span></span>
        </div>
        <button class="btn small danger" data-del-link="${l.id}">Delete</button>
      </div>
      <div class="entity-body ${open?'open':''}" id="link-edit-${l.id}"></div>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-toggle-link]').forEach(head=>{
    head.addEventListener('click', e=>{
      if (e.target.closest('[data-del-link]')) return;
      const id = head.dataset.toggleLink;
      if (expandedLinkId===id){ expandedLinkId=null; }
      else {
        expandedLinkId=id;
        const l=findLink(id);
        editLinkDraftHubs=l.hubs.map(h=>({hubId:h.hubId,colId:h.colId||'',colIds:linkHubColIds(h),role:h.role||''}));
      }
      renderAll(); setActiveTabViewOnly('vault'); modelSub='links';
    });
  });
  el.querySelectorAll('[data-del-link]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const id=b.dataset.delLink;
      const used=state.linkSats.some(s=>s.linkId===id);
      if (used && !confirm('This link has satellites depending on it. Delete anyway? Dependent link satellites will also be removed.')) return;
      state.links=state.links.filter(l=>l.id!==id);
      const removed=pruneDownstreamModel({dropExcluded:true});
      renderAll(); setActiveTabViewOnly('vault'); modelSub='links';
      if (removedModelCount(removed)) toast(`Removed dependent model objects: ${modelRemovalSummary(removed)}.`,'ok');
    });
  });
  state.links.forEach(l=>{ if (expandedLinkId===l.id) renderLinkEditForm(document.getElementById('link-edit-'+l.id),l); });
}

function renderLinkEditForm(el,l){
  el.innerHTML = `
    <div class="grid cols-2">
      <div class="field"><label>Relationship name</label><input type="text" id="edit-link-entity" value="${l.entity}"></div>
      <div class="field"><label>Source table</label><select id="edit-link-table">${includedTables().map(t=>`<option value="${t.id}" ${t.id===l.tableId?'selected':''}>${sourceTableLabel(t)}</option>`).join('')}</select></div>
    </div>
    <div class="panel-head" style="margin:14px -20px 0;"><h3>Connected hubs</h3></div>
    <p class="hint">Choose the staged source key column or columns for each role.</p>
    <div id="edit-link-hub-rows"></div>
    <button class="btn small mt" id="btn-edit-add-link-hub-row">+ Add another hub</button>
    <div class="flex-between mt">
      <button class="btn ghost small" id="edit-link-cancel">Cancel</button>
      <button class="btn primary small" id="edit-link-save">Save changes</button>
    </div>`;
  renderEditLinkHubRows(el,l);
  el.querySelector('#btn-edit-add-link-hub-row').addEventListener('click',()=>{
    const maxHubs=pdiMetaMaxItems('linkHubs');
    if(editLinkDraftHubs.length>=maxHubs){
      toast(`A Link can contain a maximum of ${maxHubs} Hubs because the PDI metadata model only supports hub positions 1-${maxHubs}.`,'err');
      return;
    }
    editLinkDraftHubs.push(linkDraftRow());
    renderEditLinkHubRows(el,l);
  });
  el.querySelector('#edit-link-table').addEventListener('change',()=>{ editLinkDraftHubs.forEach(r=>{r.colId='';r.colIds=[];}); renderEditLinkHubRows(el,l); });
  el.querySelector('#edit-link-cancel').addEventListener('click',()=>{ expandedLinkId=null; renderAll(); setActiveTabViewOnly('vault'); modelSub='links'; });
  el.querySelector('#edit-link-save').addEventListener('click',()=>{
    const entity=el.querySelector('#edit-link-entity').value.trim();
    const tableId=el.querySelector('#edit-link-table').value;
    const table=findTable(tableId);
    const rows=editLinkDraftHubs.filter(r=>r.hubId&&draftColumnIds(r).length).map(r=>Object.assign({},r,{colIds:draftColumnIds(r),colId:draftColumnIds(r)[0]}));
    if (!entity||rows.length<2){ toast('Name the link and pick at least 2 hub roles with source key columns.','err'); return; }
    if (entity!==l.entity&&state.links.some(x=>x.entity===entity)){ toast('A link with that name already exists.','err'); return; }
    const issue=linkHubRowsIssue(entity,table,rows);
    if (issue){ toast(issue+'.','err'); return; }
    const normalizedRows=normalizeLinkHubRows(table,rows);
    normalizedRows.forEach(r=>{ const hub=findHub(r.hubId),cols=linkHubCols(table,r); ensureKeyDerivation(table,hub.entity,cols.map(c=>c.name),'hash',r.role||linkHubRoleFromSource(table,r)); });
    l.entity=entity; l.tableId=tableId; l.hubs=normalizedRows;
    expandedLinkId=null;
    renderAll(); setActiveTabViewOnly('vault'); modelSub='links';
    toast(`Link "${linkNameOf(entity)}" updated.`,'ok');
  });
}

function renderEditLinkHubRows(el,l){
  const wrap=el.querySelector('#edit-link-hub-rows');
  const table=findTable(el.querySelector('#edit-link-table').value);
  wrap.innerHTML=editLinkDraftHubs.map((r,i)=>{
    const selected=new Set(draftColumnIds(r));
    return `<div class="deriv-row" style="grid-template-columns:1fr 1.25fr .8fr auto;align-items:start;">
      <select data-elr="${i}" data-elf="hubId"><option value="">hub…</option>${state.hubs.map(h=>`<option value="${h.id}" ${r.hubId===h.id?'selected':''}>${hubName(h.entity)}</option>`).join('')}</select>
      <select multiple size="4" data-elr="${i}" data-elf="colIds">${(table?stagedColumns(table):[]).map(c=>`<option value="${c.id}" ${selected.has(c.id)?'selected':''}>${c.name}</option>`).join('')}</select>
      <input type="text" data-elr="${i}" data-elf="role" value="${r.role||''}" placeholder="role (optional)">
      <button class="btn small danger" data-deledlr="${i}">&times;</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('select,input').forEach(input=>{
    input.addEventListener('change',e=>{
      const row=editLinkDraftHubs[Number(input.dataset.elr)],field=input.dataset.elf;
      if (field==='colIds'){row.colIds=selectedValues(input);row.colId=row.colIds[0]||'';} else row[field]=e.target.value;
    });
    if(input.tagName==='INPUT') input.addEventListener('input',e=>{editLinkDraftHubs[Number(input.dataset.elr)][input.dataset.elf]=e.target.value;});
  });
  wrap.querySelectorAll('[data-deledlr]').forEach(b=>b.addEventListener('click',()=>{editLinkDraftHubs.splice(Number(b.dataset.deledlr),1);renderEditLinkHubRows(el,l);}));
}
