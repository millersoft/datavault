/* =========================================================================
   MODEL COVERAGE — which parts of the Tables step haven't reached the
   Staging derivations or the Vault model yet. Drives the "unmodelled
   items" banners on the Staging and Vault steps, so a drift merge (new
   tables/columns) is visibly flagged until it's been modelled.
   ========================================================================= */
function stagingTablesMissingHashColumns(){
  // Hashes are materialised by the PostgreSQL staging _vw in v0.2+, not by
  // the physical landing table. Coverage is therefore a modelling question:
  // does this source table have at least one hash-producing derivation?
  return includedTables().filter(t=> !(t.derivations||[]).some(d=>d.kind==='hash'||d.kind==='both'));
}
function stagingHashColumnsReady(){
  return includedTables().length>0 && stagingTablesMissingHashColumns().length===0;
}
function stagingHashRequirementMessage(){
  const tables = includedTables();
  if (!tables.length) return 'Include at least one source table before continuing.';
  const missing = stagingTablesMissingHashColumns();
  if (!missing.length) return '';
  const names = missing.slice(0, 4).map(sourceTableLabel);
  const remainder = missing.length - names.length;
  const tableList = names.join(', ') + (remainder>0 ? ` and ${remainder} more` : '');
  return `Create hash columns for ${tableList} using Detect Hash Keys or AI Assist before continuing.`;
}
function stagingUncoveredTables(){
  return stagingTablesMissingHashColumns();
}
function vaultUncoveredTables(){
  const used = new Set();
  state.hubs.forEach(h=>hubSourceFeeds(h).forEach(feed=>used.add(feed.tableId)));
  state.links.forEach(l=>used.add(l.tableId));
  state.hubSats.concat(state.linkSats).forEach(s=>used.add(s.tableId));
  return includedTables().filter(t=> stagedColumns(t).length>0 && !used.has(t.id));
}
// Columns on modelled tables that no derivation and no satellite carries —
// exactly what a drift merge leaves behind until the model catches up.
function unmappedAttributeColumns(){
  const out = [];
  includedTables().forEach(t=>{
    const covered = satelliteCoveredColumnIds(t);
    vaultEligibleAttributeColumns(t).forEach(c=>{
      if (!covered.has(c.id)) out.push({ table:t.name, column:c.name });
    });
  });
  return out;
}
// On-demand gap check for the Staging and Vault steps — opens a modal
// listing what hasn't been modelled yet, with apply actions.
//
// Scope matters here, and the two tabs check DIFFERENT things:
// - Staging: tables with no key derivations. Column inclusion itself is an
//   explicit user choice in the selected staging columns; excluded columns
//   are intentionally absent from the DDL, override, AI payload and Vault.
//   What the staging key check still needs is hash/business-key derivations.
// - Vault: tables absent from the model, plus columns that no satellite
//   maps. Such columns still appear in the staging DDL/override — staging
//   carries everything — but their DATA never lands in any vault table.
function openCoverageModal(tab){
  const uncovered = tab==='staging' ? stagingUncoveredTables() : vaultUncoveredTables();
  const unmapped = tab==='vault' ? unmappedAttributeColumns() : [];
  if (!uncovered.length && !unmapped.length){
    toast(tab==='staging'
      ? 'Integrity check passed — every included table has key derivations.'
      : 'Integrity check passed — every included table is modelled and every column is carried by a satellite.', 'ok');
    return;
  }
  const wrap = document.createElement('div');
  wrap.id = 'coverage-modal-backdrop';
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal-card" style="max-height:85vh;overflow:auto;">
      <div class="flex-between" style="margin-bottom:4px;">
        <h3 style="font-family:var(--font-display);font-size:15px;margin:0;">Integrity Check — ${tab==='staging' ? 'staging' : 'vault model'}</h3>
        <button class="btn small ghost" id="coverage-close">&times;</button>
      </div>
      <p class="section-desc" style="margin-bottom:14px;">Not modelled yet — won't reach the DDL or spreadsheet until they are.</p>

      ${uncovered.length ? `
      <div class="panel" style="margin-bottom:12px;">
        <div class="panel-head" style="margin:-18px -20px 10px;"><h3>${tab==='staging' ? 'Tables with no key derivations' : 'Tables not in the vault model'} <span class="badge-count">&nbsp;·&nbsp;${uncovered.length}</span></h3></div>
        <p class="hint mb0">${uncovered.map(t=>`<span class="mono">${escapeHtml(sourceTableLabel(t))}</span> (${t.columns.length} cols)`).join(' · ')}</p>
        ${tab==='staging' ? `<p class="hint mb0" style="margin-top:6px;">Staged, but without key derivations the load has no keys to build.</p>` : ''}
      </div>` : ''}
      ${unmapped.length ? `
      <div class="panel" style="margin-bottom:12px;">
        <div class="panel-head" style="margin:-18px -20px 10px;"><h3>Columns whose data never reaches the vault <span class="badge-count">&nbsp;·&nbsp;${unmapped.length}</span></h3></div>
        <p class="hint mb0">${unmapped.slice(0,40).map(u=>`<span class="mono">${escapeHtml(u.table)}.${escapeHtml(u.column)}</span>`).join(' · ')}${unmapped.length>40?' …':''}</p>
        <p class="hint mb0" style="margin-top:6px;">Included in staging, but not mapped to a satellite. To leave one out intentionally, untick it on the Staging page; otherwise add it to a satellite before export.</p>
      </div>` : ''}

      <div class="flex-between mt">
        <button class="btn ghost" id="coverage-cancel">Close</button>
        <div style="display:flex;gap:8px;">
          <button class="btn" id="coverage-ai">AI Assist</button>
          <button class="btn primary" id="coverage-suggest">${tab==='staging' ? 'Detect Hash Keys' : 'Detect Vault Tables'} — apply now</button>
        </div>
      </div>
      <p class="hint mt mb0">${tab==='staging' ? '"Detect Hash Keys" derives staging keys' : '"Detect Vault Tables" models Vault objects'} from the source's keys, with Undo. AI Assist uses an LLM instead.</p>
    </div>`;
  document.body.appendChild(wrap);
  const close = ()=>{ const m = document.getElementById('coverage-modal-backdrop'); if (m) m.remove(); };
  document.getElementById('coverage-close').addEventListener('click', close);
  document.getElementById('coverage-cancel').addEventListener('click', close);
  wrap.addEventListener('click', e=>{ if (e.target===wrap) close(); });
  document.getElementById('coverage-suggest').addEventListener('click', ()=>{ close(); runSuggestFromKeys(tab); });
  document.getElementById('coverage-ai').addEventListener('click', ()=>{ close(); openAiModal(tab==='staging' ? 'staging' : 'vault'); });
}
