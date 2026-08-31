function renderExport(el){
  const { errors, warnings } = validateModel();
  const v = state.vault;
  const deploymentCurrent = !!(deployStatus && !deployStatus.error && !deployBoardIsStale()
    && deployStatus.rows.length && deployStatus.rows.every(r=>r.state==='current'));
  el.innerHTML = `
    <h2 class="section-title">Step 5 — Export &amp; Deploy</h2>
    <p class="section-desc">Review deployment status, apply the complete route in one place, and download generated project files.</p>

    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Validation</h3></div>
      ${errors.length===0 ? `<div class="ai-status ok" style="display:inline-flex;">No blocking errors found.</div>` : errors.map(e=>`<div class="ai-status err" style="margin-bottom:6px;">${e}</div>`).join('')}
      ${warnings.map(w=>`<div class="hint" style="color:var(--hub);margin-top:6px;">${w}</div>`).join('')}
    </div>


    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Deployment <span class="badge-count">&nbsp;·&nbsp;single authoritative workflow</span></h3></div>
      ${state.externalTables.enabled ? `<div class="ai-status busy" style="align-items:flex-start;"><span><b>Ordered external route:</b> 1) verify/create the physical target and core tables; 2) configure PostgreSQL jdbc_fdw plus the <span class="mono">data_vault</span> and <span class="mono">pdi_meta</span> mappings; 3) create local support objects and foreign-table bindings; 4) deploy metadata and engine files. Apply All performs ordered preflight and stops at the first failure. Individual Deploy/Re-deploy buttons apply only that item; use Check status whenever you want to refresh the board.</span></div>` : ''}
      <div class="flex-between mt">
        <p class="hint mb0">Status is derived from the databases and project files. Deployment controls exist only on this Export page.</p>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <button class="btn ghost" id="btn-deploy-probe" ${deployBusy()?'disabled':''}>⟳ Check status</button>
          <button class="btn primary" id="btn-deploy-apply-all" ${deployBusy()?'disabled':''}>Apply all updates in order</button>
        </div>
      </div>
      <div id="deploy-board">${deployBoardHtml()}</div>
    </div>

    <div class="flex-between mt" style="margin-bottom:8px;">
      <button class="btn ghost" id="btn-export-advanced">${exportAdvancedOpen?'▾':'▸'} Advanced — file downloads, previews &amp; manual deploys</button>
      <span></span>
    </div>
    <div id="export-advanced" style="display:${exportAdvancedOpen?'block':'none'};">
    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Download files</h3></div>
      <div class="grid cols-2">
        <div class="field"><label>Metadata spreadsheet name <span class="hint">("_1.xls" always appended)</span></label><input type="text" id="f-mapping-basename" value="${state.vault.mappingBaseName}" placeholder="metadata_spreadsheet"></div>
        <div style="display:flex;align-items:flex-end;"><p class="hint mb0">Saves as <span class="mono mapping-filename-preview">${escapeHtml(mappingWorkbookFilename())}</span> — the name the engine's Excel input step expects.</p></div>
      </div>
      <div class="grid cols-3 mt">
        <button class="btn primary" id="btn-dl-xlsx">⬇ Metadata spreadsheet (.xls)</button>
        <span></span>
        <span></span>
      </div>
      <div class="export-file-list mt">
        ${exportFileRowHtml('staging', 'Staging DDL', '<span class="mono">staging</span> schema, this Postgres', true)}
        ${exportFileRowHtml('datavault', 'Data vault DDL', 'vault schema, this Postgres', true)}
        ${exportFileRowHtml('pdimeta', 'Metadata inserts', 'reference tables, this Postgres', true)}
        ${state.externalTables.enabled ? exportFileRowHtml('remotetables', 'Remote table DDL', 'external database — different engine, run it yourself', false) : ''}
      </div>
      <p class="hint mt">"Execute" runs against ${v.dvHost||'(host not set)'}:${v.dvPort||''}/${v.dvDatabase||'(database not set)'} inside a transaction. Expand a file to preview or edit before running — edits are used until reset.</p>
    </div>

    ${v.targetPreset === 'internal' ? `
    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Deploy files locally <span class="badge-count">&nbsp;·&nbsp;internal Postgres only</span></h3></div>
      <p class="hint">Writes a combined <span class="mono">ddls.sql</span> (staging + vault) and a metadata SQL file into the internal container's init folder, alongside the existing numbered scripts. With an external Postgres target, DDL is applied with "Execute" above or downloaded to run yourself — this panel doesn't apply.</p>
      <div class="grid cols-3 mt">
        <div class="field" style="grid-column:span 2;">
          <label>Target folder <span class="hint">(auto-detected — override only if this project's layout differs)</span></label>
          <input type="text" id="f-deploy-folder" value="${deployFolder}" placeholder="${deployFolderDetected || 'detecting… (needs the local server running)'}">
        </div>
        <div class="field"><label>Start numbering at</label><input type="number" id="f-deploy-startnum" value="${deployStartNum}" min="1"></div>
      </div>
      <p class="hint" id="deploy-numbering-hint">Will write <span class="mono">${String(deployStartNum).padStart(2,'0')}-ddls.sql</span> and <span class="mono">${String(deployStartNum+1).padStart(2,'0')}-pdi-meta.sql</span> — pick a number after whatever's already in that folder.</p>
      <button class="btn primary mt" id="btn-deploy-files">⬆ Deploy files to folder</button>
      <div id="deploy-status"></div>
    </div>` : ''}

    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Deploy metadata spreadsheet locally</h3></div>
      <p class="hint">Writes <span class="mono mapping-filename-preview">${escapeHtml(mappingWorkbookFilename())}</span> into the mappings folder.</p>
      <div class="field mt">
        <label>Target folder <span class="hint">(auto-detected — override only if this project's layout differs)</span></label>
        <input type="text" id="f-mappings-folder" value="${mappingsFolder}" placeholder="${mappingsFolderDetected || 'detecting… (needs the local server running)'}">
      </div>
      <button class="btn primary mt" id="btn-deploy-mapping">⬆ Deploy metadata spreadsheet</button>
      <div id="mapping-deploy-status"></div>
    </div>

    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Save engine settings</h3></div>
      <p class="hint">Writes <span class="mono">hop/postgres-environment.json</span>. Apply All also synchronises <span class="mono">SOURCE_PASSWORD</span> and, for native PostgreSQL, the existing bootstrap/runtime password variables in the root <span class="mono">.env</span>; internal <span class="mono">DB_*</span> values are never changed. Generated JSON refers to credentials by variable name. Packaged containers use their Docker hostnames here (<span class="mono">postgres:5432</span> / <span class="mono">mysql:3306</span>).</p>
      <div class="field mt">
        <label>Target folder <span class="hint">(auto-detected — override only if this project's layout differs)</span></label>
        <input type="text" id="f-hop-folder" value="${hopConfigFolder}" placeholder="${hopConfigFolderDetected || 'detecting… (needs the local server running)'}">
      </div>
      <div class="grid cols-2 mt">
        <button class="btn ghost" id="btn-dl-hopconfig">⬇ Download postgres-environment.json</button>
        <button class="btn primary" id="btn-deploy-hopconfig">⬆ Save engine settings</button>
      </div>
      <div id="hopconfig-deploy-status"></div>

      <div class="panel-head" style="margin:16px -20px 16px;"><h3>Source connection metadata <span class="badge-count">&nbsp;·&nbsp;metadata/rdbms/source.json — ${DIALECTS[v.dialect].label}</span></h3></div>
      <p class="hint">The engine connection is generated for the selected source. This writes a <b>${DIALECTS[v.dialect].label}</b> <span class="mono">source.json</span> to <span class="mono">metadata/rdbms/</span>, using <span class="mono">${'$'}{source_*}</span> variables — no real credentials.</p>
      <div class="field mt">
        <label>Target folder <span class="hint">(auto-detected — override only if this project's layout differs)</span></label>
        <input type="text" id="f-rdbms-folder" value="${rdbmsFolder}" placeholder="${rdbmsFolderDetected || 'detecting… (needs the local server running)'}">
      </div>
      <div class="grid cols-2 mt">
        <button class="btn ghost" id="btn-dl-sourceconn">⬇ Download source.json</button>
        <button class="btn primary" id="btn-deploy-sourceconn">⬆ Deploy source connection</button>
      </div>
      <div id="sourceconn-deploy-status"></div>
    </div>

    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Update a deployed vault <span class="badge-count">&nbsp;·&nbsp;incremental DDL</span></h3></div>
      <p class="hint">Compares the generated DDL with what exists on ${v.dvHost||'(host not set)'}:${v.dvPort||''}/${v.dvDatabase||'(database not set)'} and builds only the required changes: <span class="mono">CREATE TABLE</span> for new objects, <span class="mono">ADD COLUMN</span> for new columns, and removal of specifically identified obsolete Link Satellite Hub columns from older Studio DDL. Type differences are flagged, never altered.</p>
      <button class="btn primary mt" id="btn-target-diff">⟳ Diff against target</button>
      <div id="target-diff-result"></div>
    </div>
    </div><!-- /export-advanced -->

    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Continue in Data Vault Hub</h3></div>
      ${deploymentCurrent
        ? `<div class="ai-status ok" style="align-items:flex-start;"><span>The vault is deployed and current. Start the engine, monitor the run, inspect logs, and verify loaded rows from the Data Vault Hub.</span></div>`
        : `<p class="hint">Complete the deployment updates above. When every item shows <b>Deployed ✓</b>, continue to the Data Vault Hub to start and monitor the engine.</p>`}
      <button class="btn ${deploymentCurrent?'primary':'ghost'} mt" id="btn-open-data-vault-hub">Open Data Vault Hub →</button>
    </div>

    <div class="flex-between mt">
      <button class="btn ghost" id="btn-back-export">← Back to vault model</button>
      <span></span>
    </div>
  `;
  document.getElementById('btn-back-export').addEventListener('click', ()=> navigateDesignerTab('vault'));
  document.getElementById('btn-deploy-probe').addEventListener('click', probeDeploymentStatus);
  document.getElementById('btn-deploy-apply-all').addEventListener('click', applyAllPending);
  el.querySelectorAll('[data-deploy-row]').forEach(b=> b.addEventListener('click', ()=> runDeployRow(b.dataset.deployRow)));
  document.getElementById('btn-export-advanced').addEventListener('click', ()=>{
    exportAdvancedOpen = !exportAdvancedOpen;
    renderAll(); setActiveTabViewOnly('export');
  });
  document.getElementById('btn-target-diff').addEventListener('click', runTargetDiff);
  if (targetDelta) renderTargetDiffResult(document.getElementById('target-diff-result'));
  document.getElementById('btn-dl-xlsx').addEventListener('click', ()=>{
    if (errors.length){ toast('Resolve validation errors before exporting the workbook.','err'); return; }
    downloadWorkbook(); toast('Workbook downloaded.','ok');
  });
  el.querySelectorAll('[data-dl]').forEach(b=>{
    b.addEventListener('click', ()=> downloadBlob(getExportSql(b.dataset.dl), EXPORT_FILENAMES[b.dataset.dl](), 'text/plain'));
  });
  el.querySelectorAll('[data-run]').forEach(b=>{
    const labels = { staging:'Staging DDL', datavault:'Data vault DDL', pdimeta:'Metadata inserts' };
    b.addEventListener('click', ()=> runSqlAgainstTarget(getExportSql(b.dataset.run), labels[b.dataset.run]));
  });

  const deployFolderInput = document.getElementById('f-deploy-folder');
  if (deployFolderInput) deployFolderInput.addEventListener('input', e=> deployFolder = e.target.value);
  detectDbInitPath();
  document.getElementById('btn-open-data-vault-hub').addEventListener('click', ()=>{
    appMode = 'dashboard';
    renderAll();
  });

  const startNumInput = document.getElementById('f-deploy-startnum');
  if (startNumInput) startNumInput.addEventListener('input', e=>{
    const parsed = parseInt(e.target.value, 10);
    if (!isNaN(parsed) && parsed > 0) deployStartNum = parsed;
    const hint = document.getElementById('deploy-numbering-hint');
    if (hint) hint.innerHTML = `Will write <span class="mono">${String(deployStartNum).padStart(2,'0')}-ddls.sql</span> and <span class="mono">${String(deployStartNum+1).padStart(2,'0')}-pdi-meta.sql</span> — pick a number after whatever's already in that folder.`;
  });
  const deployFilesBtn = document.getElementById('btn-deploy-files');
  if (deployFilesBtn) deployFilesBtn.addEventListener('click', deployFilesToFolder);
  document.getElementById('f-mapping-basename').addEventListener('input', e=>{
    state.vault.mappingBaseName = e.target.value;
    // Targeted updates only — a full re-render here would corrupt the
    // field mid-keystroke, the same bug already fixed once on the
    // db-init numbering field.
    document.querySelectorAll('.mapping-filename-preview').forEach(elm=>{ elm.textContent = mappingWorkbookFilename(); });
  });
  document.getElementById('f-mappings-folder').addEventListener('input', e=> mappingsFolder = e.target.value);
  document.getElementById('btn-deploy-mapping').addEventListener('click', deployMappingWorkbook);
  document.getElementById('f-hop-folder').addEventListener('input', e=> hopConfigFolder = e.target.value);
  document.getElementById('btn-dl-hopconfig').addEventListener('click', ()=> downloadBlob(buildHopEnvironmentJson(), 'postgres-environment.json', 'application/json'));
  document.getElementById('btn-deploy-hopconfig').addEventListener('click', deployHopConfig);
  document.getElementById('f-rdbms-folder').addEventListener('input', e=> rdbmsFolder = e.target.value);
  document.getElementById('btn-dl-sourceconn').addEventListener('click', ()=> downloadBlob(buildHopSourceConnectionJson(), 'source.json', 'application/json'));
  document.getElementById('btn-deploy-sourceconn').addEventListener('click', deployHopSourceConnection);

  el.querySelectorAll('[data-toggle]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const key = b.dataset.toggle;
      exportExpanded[key] = !exportExpanded[key];
      renderAll(); setActiveTabViewOnly('export');
    });
  });
  el.querySelectorAll('[data-editor]').forEach(ta=>{
    // Update state directly on input rather than calling renderAll() —
    // a full re-render mid-keystroke would reset the cursor position and
    // corrupt typing, the same class of bug already fixed on the other
    // free-text fields on this step.
    ta.addEventListener('input', e=>{ exportOverrides[e.target.dataset.editor] = e.target.value; });
  });
  el.querySelectorAll('[data-reset]').forEach(b=>{
    b.addEventListener('click', ()=>{
      exportOverrides[b.dataset.reset] = null;
      renderAll(); setActiveTabViewOnly('export');
      toast('Reverted to the generated version.', 'ok');
    });
  });
}

