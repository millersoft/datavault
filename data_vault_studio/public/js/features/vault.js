/* =========================================================================
   MODEL TAB — hubs, links, satellites
   ========================================================================= */
let modelSub = 'hubs';

function renderVault(el){
  pruneDownstreamModel({ dropExcluded:true });
  const v = state.vault;
  if (!v.vaultDbName && v.dvDatabase) v.vaultDbName = v.dvDatabase;
  el.innerHTML = `
    <div class="flex-between">
      <div>
        <h2 class="section-title">Step 4 — Vault model</h2>
        <p class="section-desc mb0">Hub, link, and satellite definitions built from the source tables.</p>
        <p class="hint mb0">Naming convention: <span class="mono">&lt;type&gt;_${state.vault.name||'&lt;vault&gt;'}_&lt;entity&gt;</span>.</p>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;">
        <span class="quick-tip" data-tooltip="Build deterministic Hub, Link and Satellite proposals from the detected source keys.">
          <button class="btn primary" id="btn-suggest-keys">Detect Vault Tables</button>
        </span>
        <span class="quick-tip" data-tooltip="Find source tables or columns that still do not reach the Vault model.">
          <button class="btn" id="btn-coverage-vault">Integrity Check</button>
        </span>
        <span class="quick-tip" data-tooltip="Use an AI provider to propose Vault objects for review.">
          <button class="btn" id="btn-ai-vault">AI Assist</button>
        </span>
      </div>
    </div>

    <div class="panel mt">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Vault identity <span class="badge-count">&nbsp;·&nbsp;vault identity sheet</span></h3></div>
      <div class="grid cols-2">
        <div class="field"><label>Data vault database name <span class="hint">(usually matches the target connection's database)</span></label><input type="text" id="f-dbname" value="${v.vaultDbName}" placeholder="datavault_sales"></div>
        <div class="field"><label>Data vault description</label><input type="text" id="f-dbdesc" value="${v.vaultDescription}" placeholder="Sales data vault"></div>
      </div>
    </div>

    <div class="tabs" style="padding:0;margin:16px 0;border:1px solid var(--border);border-radius:var(--radius);background:var(--panel);">
      ${['hubs','links','satellites','diagram'].map(s=>`<button class="tab-btn model-sub ${modelSub===s?'active':''}" data-sub="${s}" style="flex:1;justify-content:center;">${s}${s!=='diagram'?` <span class="tab-count">${s==='hubs'?state.hubs.length:s==='links'?state.links.length:(state.hubSats.length+state.linkSats.length)}</span>`:''}</button>`).join('')}
    </div>
    <div id="model-sub-view"></div>
    <div class="flex-between mt">
      <button class="btn ghost" id="btn-back-vault">← Back to staging</button>
      <button class="btn primary" id="btn-next-vault">Next: export →</button>
    </div>
  `;
  el.querySelector('#f-dbname').addEventListener('input', e=> v.vaultDbName = e.target.value);
  el.querySelector('#f-dbdesc').addEventListener('input', e=> v.vaultDescription = e.target.value);
  el.querySelectorAll('.model-sub').forEach(b=>{
    b.addEventListener('click', ()=>{ modelSub=b.dataset.sub; renderAll(); setActiveTabViewOnly('vault'); });
  });
  document.getElementById('btn-ai-vault').addEventListener('click', ()=> openAiModal('vault'));
  document.getElementById('btn-suggest-keys').addEventListener('click', ()=> runSuggestFromKeys());
  document.getElementById('btn-coverage-vault').addEventListener('click', ()=> openCoverageModal('vault'));
  document.getElementById('btn-back-vault').addEventListener('click', ()=> navigateDesignerTab('staging'));
  document.getElementById('btn-next-vault').addEventListener('click', ()=> navigateDesignerTab('export'));
  const sv = document.getElementById('model-sub-view');
  if (modelSub==='hubs') renderHubsSub(sv);
  if (modelSub==='links') renderLinksSub(sv);
  if (modelSub==='satellites') renderSatsSub(sv);
  if (modelSub==='diagram') renderVaultDiagram(sv);
}

