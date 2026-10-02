/* =========================================================================
   TABLES TAB
   ========================================================================= */
function newTable(name){
  return { id: uid('tbl'), name: name||'', schema:'', objectType:'table', description:'', included:true, incremental:false, incrementCol:'',
           incrementalReady:false, incrementalReadyRunId:null, incrementalReadyAfterRunId:0, incrementalReadyAt:'', incrementalConfiguredAt:'',
           incrementalConfigPending:false, incrementalDeploymentPending:false, incrementalAutoDetectDismissed:false,
           loadGroup: 2000, columns: [], derivations: [], customOverride: null };
}
function newColumn(name, type){
  const sourceName = name||'';
  return {
    id: uid('col'),
    name: sourceName,
    targetName: sourceName ? targetIdentifierBase(sourceName) : '',
    targetNameAuto: true,
    type: type||'varchar(255)',
    nullable:true,
    pk:false,
    staged:true,
    profile:null,
  };
}

function parseCreateTable(sql){
  // Best-effort parse of `CREATE TABLE name (col type [constraints], ...)`
  const m = sql.match(/create\s+table\s+(?:if not exists\s+)?([`"\[]?[\w.]+[`"\]]?)\s*\(([\s\S]+)\)\s*;?\s*$/i);
  if (!m) return null;
  const rawName = m[1].replace(/[`"\[\]]/g,'').split('.').pop();
  const body = m[2];
  // split on commas not inside parens
  const parts = []; let depth=0, cur='';
  for (const ch of body){
    if (ch==='(') depth++;
    if (ch===')') depth--;
    if (ch===',' && depth===0){ parts.push(cur); cur=''; } else cur+=ch;
  }
  if (cur.trim()) parts.push(cur);
  const cols = [];
  const pkFromTableConstraint = [];
  parts.forEach(p=>{
    const t = p.trim();
    if (/^(primary\s+key|constraint|foreign\s+key|unique|check|key\s)/i.test(t)){
      const pkm = t.match(/primary\s+key\s*\(([^)]+)\)/i);
      if (pkm) pkm[1].split(',').forEach(c=>pkFromTableConstraint.push(c.trim().replace(/[`"\[\]]/g,'')));
      return;
    }
    const cm = t.match(/^[`"\[]?(\w+)[`"\]]?\s+([\w()., ]+?)(\s+not\s+null|\s+null|\s+primary\s+key|\s+default\s+[^,]+)*\s*$/i);
    if (cm){
      const col = newColumn(cm[1], cm[2].trim().toLowerCase());
      col.nullable = !/not\s+null/i.test(t);
      col.pk = /primary\s+key/i.test(t);
      if (col.pk) col.nullable = false;
      cols.push(col);
    }
  });
  cols.forEach(c=>{
    if (pkFromTableConstraint.includes(c.name)){
      c.pk = true;
      c.nullable = false;
    }
  });
  return { name: rawName, columns: cols };
}

let expandedTableId = null;

function parseInfoSchemaBulk(text){
  // Accepts CSV or tab-separated rows: table_name,column_name,data_type,is_nullable[,is_pk]
  // (the shape produced by a quick information_schema.columns export)
  const lines = text.trim().split(/\r?\n/).filter(l=>l.trim());
  if (lines.length===0) return null;
  let start = 0;
  const first = lines[0].toLowerCase();
  if (first.includes('table_name') && first.includes('column_name')) start = 1; // skip header row
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const byTable = {};
  for (let i=start;i<lines.length;i++){
    const parts = lines[i].split(sep).map(s=>s.trim().replace(/^"|"$/g,''));
    if (parts.length<3) continue;
    const [tableName, colName, dataType, isNullable, isPk] = parts;
    if (!tableName || !colName) continue;
    if (!byTable[tableName]) byTable[tableName] = [];
    const col = newColumn(colName, (dataType||'varchar(255)').toLowerCase());
    col.nullable = isNullable ? /yes|true|1/i.test(isNullable) : true;
    col.pk = isPk ? /yes|true|1/i.test(isPk) : false;
    if (col.pk) col.nullable = false;
    byTable[tableName].push(col);
  }
  return byTable;
}

function deleteAllSourceTables(){
  const count = state.tables.length;
  if (!count) return { count:0, removed:{hubs:0,links:0,hubSats:0,linkSats:0} };
  pushUndo(`delete all ${count} source tables`);
  const ids = state.tables.map(t=>t.id);
  const removed = pruneDownstreamModel({ dropTableIds:ids });
  state.tables = [];
  expandedTableId = null;
  if (state.sourceMeta){
    state.sourceMeta.foreignKeys = [];
    state.sourceMeta.approxRows = {};
    state.sourceMeta.relationshipSuggestions = [];
  }
  invalidateStagingConfirmation();
  return { count, removed };
}

function renderTables(el){
  const v = state.vault;
  const includedCount = state.tables.filter(t=>t.included!==false).length;
  const sourceTables = state.tables.filter(t=>!isSourceView(t));
  const sourceViews = state.tables.filter(isSourceView);
  const canIntrospect = ['postgresql','mysql'].includes(v.dialect) || isDatabasePackDialect(v.dialect);
  el.innerHTML = `
    <h2 class="section-title">Step 2 — Tables</h2>
    <p class="section-desc">Choose source tables for this run. Views are detected separately and left unselected unless you include one deliberately. Schema only, no row data. PK and NOT NULL columns are checked using aggregate blank/null counts.</p>

    <div class="panel" style="display:flex;align-items:center;gap:10px;">
      <span class="entity-marker sat" style="background:var(--sat);border-radius:2px;"></span>
      <span class="mono" style="font-size:12.5px;">${escapeHtml((isDatabasePackDialect(v.dialect)?(v.sourceCatalog||v.srcDatabase):v.srcDatabase) || '(namespace not set)')}${v.dialect==='mysql' ? '' : (()=>{const schemas=(v.sourceSchemas&&v.sourceSchemas.length?v.sourceSchemas:[isDatabasePackDialect(v.dialect)?sourceSqlEffectiveSchema():(v.sourceSchema||'public')]).filter(Boolean);return schemas.length?`<span style="color:var(--muted)">.${escapeHtml(schemas.join(', '))}</span>`:'';})()}</span>
      <span class="hint" style="margin-left:auto;">${DIALECTS[v.dialect].label} · set on the Connections step</span>
    </div>

    <div class="panel">
      <div class="flex-between">
        <div>
          <label class="mb0">Live from the database</label>
          <p class="hint" style="margin-top:2px;">${canIntrospect ? 'Table and column list from the source connected on Step 1.' : 'Install/configure a Database Pack for this source, or add tables manually below.'}</p>
        </div>
        <span class="quick-tip" data-tooltip="Detect tables, columns, keys and nullability, with blank/null checks for constrained columns.">
          <button class="btn primary" id="btn-introspect" ${canIntrospect?'':'disabled'}>Detect Source Tables</button>
        </span>
      </div>
    </div>

    <div class="flex-between" style="margin-bottom:8px;">
      <h3 style="font-family:var(--font-display);font-size:12.5px;margin:0;text-transform:uppercase;letter-spacing:.2px;color:var(--muted);">
        Source objects in selected schemas <span class="badge-count">&nbsp;·&nbsp;${includedCount} of ${state.tables.length} included</span>
      </h3>
      <div>
        ${state.tables.length>0 ? `
          <button class="btn small" id="btn-select-all">Select all tables</button>
          <button class="btn small" id="btn-select-none">Select none</button>
          <button class="btn small danger" id="btn-delete-all-tables">Delete all</button>
        ` : ''}
      </div>
    </div>

    <div id="tables-list"></div>

    <div class="panel mt">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Manual entry <span class="badge-count">&nbsp;·&nbsp;no local server needed</span></h3></div>
      <div class="flex-between">
        <div style="flex:1;min-width:220px;">
          <label>Quick add</label>
          <input type="text" id="new-table-name" maxlength="${pdiMetaMaxLength('sourceTableName')}" placeholder="table name, e.g. customers">
        </div>
        <button class="btn" id="btn-add-table" style="margin-top:18px;">+ Add table</button>
      </div>
      <div class="field mt">
        <label>Paste a CREATE TABLE statement <span class="hint">(review columns after parsing)</span></label>
        <textarea id="paste-ddl" placeholder="CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(100), is_active BOOLEAN, created_at TIMESTAMP);"></textarea>
        <button class="btn small mt" id="btn-parse-ddl">Parse &amp; add table</button>
      </div>
      <div class="field mt">
        <label>Bulk-import information_schema columns <span class="hint">(CSV/TSV: table_name, column_name, data_type, is_nullable, is_pk)</span></label>
        <textarea id="paste-infoschema" placeholder="table_name,column_name,data_type,is_nullable,is_pk&#10;customers,id,int,NO,YES&#10;customers,name,varchar,YES,NO"></textarea>
        <button class="btn small mt" id="btn-parse-infoschema">Import tables</button>
      </div>
    </div>


    <div class="flex-between mt">
      <button class="btn ghost" id="btn-back-tables">← Back to Connections</button>
      <button class="btn primary" id="btn-next-tables">Next: Staging →</button>
    </div>
  `;

  const introspectBtn = document.getElementById('btn-introspect');
  if (introspectBtn && !introspectBtn.disabled) introspectBtn.addEventListener('click', introspectDatabase);
  const selectAllBtn = document.getElementById('btn-select-all');
  const selectNoneBtn = document.getElementById('btn-select-none');
  const deleteAllBtn = document.getElementById('btn-delete-all-tables');
  if (selectAllBtn) selectAllBtn.addEventListener('click', ()=>{
    state.tables.filter(t=>!isSourceView(t)).forEach(t=> t.included = true);
    renderAll(); setActiveTabViewOnly('tables');
  });
  if (selectNoneBtn) selectNoneBtn.addEventListener('click', ()=>{
    pushUndo('exclude all tables');
    state.tables.forEach(t=> t.included = false);
    const removed = pruneDownstreamModel({ dropExcluded:true });
    renderAll(); setActiveTabViewOnly('tables');
    if (removedModelCount(removed)) toastUndo(`Removed downstream model objects for excluded tables: ${modelRemovalSummary(removed)}.`);
  });
  if (deleteAllBtn) deleteAllBtn.addEventListener('click', ()=>{
    const count = state.tables.length;
    if (!count) return;
    if (!confirm(`Delete all ${count} source table(s)? This also removes Vault objects sourced from them. You can run Detect Source Tables again immediately afterwards.`)) return;
    const result = deleteAllSourceTables();
    renderAll(); setActiveTabViewOnly('tables');
    const extra = removedModelCount(result.removed) ? ` Removed ${modelRemovalSummary(result.removed)}.` : '';
    toastUndo(`Deleted all ${result.count} source table(s).${extra} Run Detect Source Tables to rebuild the source schema.`);
  });
  document.getElementById('btn-add-table').addEventListener('click', ()=>{
    const name = document.getElementById('new-table-name').value.trim();
    if (!name){ toast('Enter a table name first.','err'); return; }
    const nameIssue=pdiMetaLengthIssue('sourceTableName',name,`Source table "${name}" name`);
    if(nameIssue){ toast(nameIssue,'err'); return; }
    if (state.tables.some(t=>t.name===name)){ toast('That table already exists.','err'); return; }
    const t = newTable(name);
    state.tables.push(t);
    expandedTableId = t.id;
    renderAll(); setActiveTabViewOnly('tables');
  });
  document.getElementById('new-table-name').addEventListener('keydown', e=>{
    if (e.key==='Enter') document.getElementById('btn-add-table').click();
  });
  document.getElementById('btn-parse-ddl').addEventListener('click', ()=>{
    const sql = document.getElementById('paste-ddl').value.trim();
    if (!sql){ toast('Paste a CREATE TABLE statement first.','err'); return; }
    const parsed = parseCreateTable(sql);
    if (!parsed){ toast('Could not parse that statement — check the syntax.','err'); return; }
    const parsedNameIssue=pdiMetaLengthIssue('sourceTableName',parsed.name,`Source table "${parsed.name}" name`);
    if(parsedNameIssue){ toast(parsedNameIssue,'err'); return; }
    if (state.tables.some(t=>t.name===parsed.name)){ toast(`Table "${parsed.name}" already exists.`,'err'); return; }
    const t = newTable(parsed.name);
    t.columns = parsed.columns;
    autoConfigureIncrementalColumn(t);
    state.tables.push(t);
    expandedTableId = t.id;
    renderAll(); setActiveTabViewOnly('tables');
    toast(`Parsed ${parsed.columns.length} columns for "${parsed.name}". Review types before continuing.`,'ok');
  });
  document.getElementById('btn-parse-infoschema').addEventListener('click', ()=>{
    const text = document.getElementById('paste-infoschema').value.trim();
    if (!text){ toast('Paste an information_schema export first.','err'); return; }
    const byTable = parseInfoSchemaBulk(text);
    if (!byTable || Object.keys(byTable).length===0){ toast('Could not find any rows to import.','err'); return; }
    const invalidTableName=Object.keys(byTable).map(name=>pdiMetaLengthIssue('sourceTableName',name,`Source table "${name}" name`)).find(Boolean);
    if(invalidTableName){ toast(`Import blocked: ${invalidTableName}`,'err'); return; }
    let added = 0, skipped = 0;
    Object.entries(byTable).forEach(([name, cols])=>{
      if (state.tables.some(t=>t.name===name)){ skipped++; return; }
      const t = newTable(name); t.columns = cols; autoConfigureIncrementalColumn(t); state.tables.push(t); added++;
    });
    renderAll(); setActiveTabViewOnly('tables');
    toast(`Imported ${added} table(s)${skipped?`, skipped ${skipped} already present`:''}.`, 'ok');
  });
  document.getElementById('btn-back-tables').addEventListener('click', ()=> navigateDesignerTab('connections'));
  document.getElementById('btn-next-tables').addEventListener('click', ()=>{
    if (state.tables.filter(t=>t.included!==false).length===0){ toast('Include at least one table before moving on.','err'); return; }
    navigateDesignerTab('staging');
  });

  renderTablesList(document.getElementById('tables-list'));
}

function setActiveTabViewOnly(tab){ activeTab = tab; }

function wireStagingColumnToggles(container, table, returnTab){
  container.querySelectorAll('[data-stage-col]').forEach(inp=>{
    inp.addEventListener('change', e=>{
      const col = findCol(table, inp.dataset.stageCol);
      if (!col) return;
      const next = e.target.checked;
      if (!next && col.pk && !confirm(`Exclude key column "${col.name}" from staging? Any dependent Hub or Link mappings will be removed.`)){
        e.target.checked = true;
        return;
      }
      pushUndo(`${next?'include':'exclude'} staging column "${col.name}" on "${table.name}"`);
      col.staged = next;
      if (!next && table.incrementCol===col.name) configureIncrementalColumn(table, '');
      const removed = pruneDownstreamModel({ dropExcluded:true });
      renderAll();
      setActiveTabViewOnly(returnTab || activeTab);
      if ((returnTab || activeTab)==='tables') expandedTableId = table.id;
      const extra = removedModelCount(removed) ? ` Removed ${modelRemovalSummary(removed)}.` : '';
      toastUndo(`${next?'Included':'Excluded'} ${table.name}.${col.name} ${next?'in':'from'} staging.${extra}`);
    });
  });
}

function renderTablesList(el){
  if (state.tables.length===0){
    el.innerHTML = `<div class="empty">No tables yet. Add one above to start staging it.</div>`;
    return;
  }
  const sourceTables = state.tables.filter(t=>!isSourceView(t));
  const sourceViews = state.tables.filter(isSourceView);
  const cards = tables=>tables.map(t=>{
    const open = expandedTableId===t.id;
    const included = t.included!==false;
    return `
    <div class="entity-card" style="${included?'':'opacity:.55;'}">
      <div class="ehead ${open?'open':''}" data-toggle="${t.id}">
        <div class="ehead-left">
          <label class="checkbox-row" style="margin-right:2px;" title="Include in this run" onclick="event.stopPropagation();">
            <input type="checkbox" data-include="${t.id}" ${included?'checked':''}>
          </label>
          <span class="entity-marker sat" style="background:var(--muted);border-radius:2px;"></span>
          <span class="entity-name">${escapeHtml(sourceTableLabel(t))}</span>
          <span class="entity-meta">${t.columns.length} cols${isSourceView(t)?' · view':''}${(state.sourceMeta && state.sourceMeta.approxRows && state.sourceMeta.approxRows[sourceTableIdentity(t)]!=null) ? ` · ~${Number(state.sourceMeta.approxRows[sourceTableIdentity(t)]).toLocaleString()} rows` : ''} · staging → <span class="mono">${stagingViewName(t)}</span> ${included?'':'· <span class=\"tag\">excluded</span>'}</span>
        </div>
        <div>
          <button class="btn small danger" data-del-table="${t.id}">Delete</button>
        </div>
      </div>
      <div class="entity-body ${open?'open':''}" id="tbody-${t.id}"></div>
    </div>`;
  }).join('');
  const group = (title, subtitle, tables, included)=>`
    <div class="flex-between" style="margin:${title==='Views'?'18px':'0'} 0 8px;">
      <h3 style="font-family:var(--font-display);font-size:12.5px;margin:0;text-transform:uppercase;letter-spacing:.2px;color:var(--muted);">
        ${title} <span class="badge-count">&nbsp;·&nbsp;${included} of ${tables.length} included</span>
      </h3>
      <span class="hint">${subtitle}</span>
    </div>
    ${tables.length ? cards(tables) : `<div class="empty">No ${title.toLowerCase()} detected.</div>`}
  `;
  el.innerHTML =
    group('Base tables', 'Selected by default', sourceTables, sourceTables.filter(t=>t.included!==false).length)
    + (sourceViews.length
      ? group('Views', 'Not selected by default · include only when intentional', sourceViews, sourceViews.filter(t=>t.included!==false).length)
      : '');

  el.querySelectorAll('[data-include]').forEach(cb=>{
    cb.addEventListener('change', (e)=>{
      const t = findTable(cb.dataset.include);
      const wasIncluded = t.included!==false;
      if (wasIncluded && !e.target.checked) pushUndo(`exclude table "${t.name}"`);
      t.included = e.target.checked;
      const removed = (wasIncluded && t.included===false) ? pruneDownstreamModel({ dropExcluded:true }) : {hubs:0,links:0,hubSats:0,linkSats:0};
      renderAll(); setActiveTabViewOnly('tables'); expandedTableId=t.id;
      if (removedModelCount(removed)) toastUndo(`Removed downstream model objects for excluded table: ${modelRemovalSummary(removed)}.`);
    });
  });
  el.querySelectorAll('[data-toggle]').forEach(h=>{
    h.addEventListener('click', (e)=>{
      if (e.target.closest('[data-del-table]') || e.target.closest('[data-include]')) return;
      const id = h.dataset.toggle;
      expandedTableId = expandedTableId===id ? null : id;
      renderAll(); setActiveTabViewOnly('tables');
    });
  });
  el.querySelectorAll('[data-del-table]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const id = b.dataset.delTable;
      const table = findTable(id);
      if (!confirm('Delete this table? Any hubs, links or satellites sourced from it will also be removed.')) return;
      pushUndo(`delete table "${table ? table.name : id}"`);
      const removed = pruneDownstreamModel({ dropTableIds:[id] });
      state.tables = state.tables.filter(t=>t.id!==id);
      if (expandedTableId===id) expandedTableId = null;
      renderAll(); setActiveTabViewOnly('tables');
      const extra = removedModelCount(removed) ? ` Removed ${modelRemovalSummary(removed)}.` : '';
      toastUndo(`Deleted table "${table ? table.name : id}".${extra}`);
    });
  });
  state.tables.forEach(t=>{
    if (expandedTableId===t.id) renderTableDetail(document.getElementById('tbody-'+t.id), t);
  });
}

function tableIncrementalConfigurationHtml(t){
  if (!FEATURE_INCREMENTAL) return '';
  const candidates = incrementalColumnCandidates(t);
  const options = incrementalColumnOptions(t);
  const configuredCol = t.incrementCol || '';
  const configuredExists = options.some(c=>c.name===configuredCol);
  const status = configuredCol && !configuredExists
    ? 'The selected Incremental column is no longer a staged timestamp/datetime column. Choose a supported temporal column before deploying.'
    : !configuredCol
      ? 'Not configured. Choose a timestamp/datetime column here, then decide in Data Vault Hub whether incremental loading should be used.'
      : incrementalActive(t)
        ? `Configured and enabled${t.incrementalDeploymentPending || t.incrementalConfigPending?' · workbook deployment required':''}. You can change the column here or in Data Vault Hub.`
        : `Configured using ${configuredCol}. Incremental loading is currently off; enable it from Data Vault Hub whenever you want.`;
  const tag = !configuredCol
    ? 'not configured'
    : incrementalActive(t)
      ? (t.incrementalDeploymentPending || t.incrementalConfigPending ? 'enabled · deploy required' : 'enabled')
      : (t.incrementalDeploymentPending || t.incrementalConfigPending ? 'disabled · deploy required' : 'disabled');
  return `
    <div class="panel" style="margin:14px 0;padding:12px 14px;box-shadow:none;">
      <div class="panel-head" style="margin:0 0 8px;"><h3>Incremental loading</h3><span class="tag" style="text-transform:none;">${tag}</span></div>
      <div class="grid cols-2" style="align-items:end;">
        <div class="field">
          <label>Incremental column</label>
          <select data-table-increment-col="${t.id}">
            <option value="">Not configured</option>
            ${configuredCol && !configuredExists ? `<option value="${escapeHtml(configuredCol)}" selected disabled>${escapeHtml(configuredCol)} (unsupported or not staged)</option>` : ''}
            ${candidates.length ? `<optgroup label="Timestamp / datetime columns">${candidates.map(c=>`<option value="${escapeHtml(c.name)}" ${c.name===configuredCol?'selected':''}>${escapeHtml(c.name)} · ${escapeHtml(incrementalColumnTypeLabel(c))}</option>`).join('')}</optgroup>` : ''}
          </select>
        </div>
        <p class="hint mb0">${escapeHtml(status)}</p>
      </div>
      ${candidates.length===0 ? `<p class="hint mt mb0">No staged timestamp/datetime column is available. Incremental loading currently supports timestamp/datetime columns only.</p>` : ''}
    </div>`;
}

function renderTableDetail(el, t){
  el.innerHTML = `
    <div class="field"><label>Description</label><input type="text" data-tf="description" maxlength="${pdiMetaMaxLength('sourceTableDescription')}" value="${t.description}"></div>

    ${tableIncrementalConfigurationHtml(t)}

    <div class="panel-head" style="margin:16px -14px 0;"><h3>Columns <span class="badge-count">&nbsp;·&nbsp;${stagedColumns(t).length} of ${t.columns.length} staged</span></h3><button class="btn small" data-profiletable="${t.id}" ${isDatabasePackDialect(state.vault.dialect)?'disabled':''} title="${isDatabasePackDialect(state.vault.dialect)?'Database Pack sources retain JDBC-declared nullability; use manual review or AI Assist where source constraints are incomplete.':'Profile every column in this table'}">Profile table</button></div>
    <p class="hint">The Stage checkbox is the same setting shown on Step 3. Untick it here or in Staging to exclude that source column from the staging output and the Vault design. Staging keeps source nullability unless profiling finds blanks or nulls.</p>
    <table class="data">
      <tr><th style="width:70px">Stage</th><th>Source name</th><th>Staging name</th><th>Type</th><th style="width:70px" title="Checked means the source allows NULL">Null</th><th style="width:110px">PK</th><th></th></tr>
      ${t.columns.map(c=>{
        const showProfile = columnProfileIsUserRequested(c);
        return `
      <tr style="${isColumnStaged(c)?'':'opacity:.55;'}">
        <td><input type="checkbox" data-stage-col="${c.id}" ${isColumnStaged(c)?'checked':''}></td>
        <td><input type="text" data-col="${c.id}" data-cf="name" value="${c.name}"></td>
        <td><input type="text" data-col="${c.id}" data-cf="targetName" value="${targetColumnName(c)}" title="PostgreSQL-safe name used in staging and Vault outputs"></td>
        <td><input type="text" data-col="${c.id}" data-cf="type" value="${c.type}"></td>
        <td><input type="checkbox" data-col="${c.id}" data-cf="nullable" ${c.nullable?'checked':''} title="Source allows NULL. Profiling can relax NOT NULL for blanks or nulls."></td>
        <td><input type="checkbox" data-col="${c.id}" data-cf="pk" ${c.pk?'checked':''}></td>
        <td style="white-space:nowrap;"><button class="btn small danger" data-delcol="${c.id}">&times;</button></td>
      </tr>
      <tr style="${showProfile?'':'display:none;'}" data-profilerow="${c.id}"><td colspan="7" class="hint" data-profilecell="${c.id}" style="padding:6px 10px;">${showProfile?escapeHtml(columnProfileSummary(c)):''}</td></tr>`;
      }).join('')}
    </table>
    <button class="btn small mt" id="btn-add-col">+ Add column</button>
    <p class="hint mt">The incremental column is source-table configuration and is set here. Load order and key derivations live in the <b>Staging</b> step; activation is managed later from <b>Data Vault Hub</b>.</p>
  `;

  el.querySelectorAll('[data-profiletable]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const columns = (t.columns||[]).map(c=>c.name).filter(Boolean);
      if (!columns.length) return;
      const originalText = b.textContent;
      b.disabled = true;
      b.textContent = 'Profiling table…';
      try {
        const v = state.vault;
        const schema = v.dialect==='mysql' ? v.srcDatabase : v.sourceSchema;
        const resp = await localFetch(`/api/profile-table`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({...sourceConnectionPayload(),schema,table:t.name,columns}),
        });
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error || 'Profile failed.');
        const applied = applyManualTableProfiles(t, data.profiles);
        expandedTableId = t.id;
        renderAll(); setActiveTabViewOnly('tables');
        toast(`Profiled ${applied} column(s) in ${t.name}.`, 'ok');
      } catch(err){
        b.disabled = false;
        b.textContent = originalText;
        toast(`Table profile failed: ${err.message}`, 'err');
      }
    });
  });

  wireStagingColumnToggles(el, t, 'tables');
  const incrementalSelect = el.querySelector('[data-table-increment-col]');
  if (incrementalSelect) incrementalSelect.addEventListener('change', e=>{
    const changed = configureIncrementalColumn(t, e.target.value);
    if (changed){
      invalidateStagingConfirmation();
      if (typeof scheduleAutosave === 'function') scheduleAutosave();
      toast(e.target.value
        ? `${t.name}: Incremental column set to ${e.target.value}. Choose whether to use it from Data Vault Hub.`
        : `${t.name}: incremental loading configuration removed.`, 'ok');
    }
    expandedTableId = t.id;
    renderAll(); setActiveTabViewOnly('tables');
  });
  el.querySelectorAll('[data-tf]').forEach(inp=>{
    const key = inp.dataset.tf;
    inp.addEventListener('input', e=>{ t[key] = e.target.value; });
  });
  el.querySelectorAll('[data-col]').forEach(inp=>{
    inp.addEventListener('input', e=>{
      const col = findCol(t, inp.dataset.col);
      const key = inp.dataset.cf;
      const oldName = col.name;
      if (key==='targetName'){
        const clean = targetIdentifierBase(e.target.value);
        col.targetName = clean;
        col.targetNameAuto = false;
        if (e.target.value!==clean) e.target.value = clean;
      } else if (key==='pk'){
        col.pk = inp.checked;
        if (col.pk) col.nullable = false;
      } else if (key==='nullable'){
        col.nullable = inp.checked;
        if (col.nullable) col.pk = false;
      } else {
        col[key] = inp.type==='checkbox' ? inp.checked : e.target.value;
      }
      if (key==='name'){
        if (oldName!==col.name){
          col.profile = null;
          if (t.incrementCol===oldName) configureIncrementalColumn(t, col.name);
        }
        t.derivations.forEach(d=>{
          const names = derivationSourceColumns(d).map(name=>name===oldName ? col.name : name);
          d.column = names[0] || '';
          if (Array.isArray(d.columns)) d.columns = names;
        });
        if (col.targetNameAuto!==false){ col.targetName=''; ensureTableTargetNames(t); }
      }
      if (key==='pk' || key==='nullable' || key==='name' || key==='targetName'){ renderAll(); setActiveTabViewOnly('tables'); expandedTableId=t.id; }
    });
  });
  el.querySelectorAll('[data-delcol]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const colId = b.dataset.delcol;
      const col = findCol(t, colId);
      pushUndo(`delete column "${col ? col.name : colId}" on "${t.name}"`);
      if (col && t.incrementCol===col.name) configureIncrementalColumn(t, '');
      t.columns = t.columns.filter(c=>c.id!==colId);
      t.derivations = t.derivations.filter(d=>!derivationUsesColumn(d, col&&col.name));
      const removed = pruneDownstreamModel({ dropExcluded:true });
      renderAll(); setActiveTabViewOnly('tables'); expandedTableId=t.id;
      if (removedModelCount(removed)) toastUndo(`Removed downstream model objects that referenced the deleted column: ${modelRemovalSummary(removed)}.`);
    });
  });
  el.querySelector('#btn-add-col').addEventListener('click', ()=>{
    t.columns.push(newColumn('', 'varchar(255)'));
    renderAll(); setActiveTabViewOnly('tables'); expandedTableId=t.id;
  });
}

function derivationOutputLabel(table,d){
  const names=[];
  if(d.kind==='hash'||d.kind==='both') names.push(hashColumnNameForDerivation(table,d));
  if(d.kind==='bk'||d.kind==='both') names.push(businessKeyColumnName(derivationCanonicalSpec(table,d).entity));
  return names.join(' + ');
}

function addManualKeyDerivation(table,column,entity,role,kind){
  if(!table) return {ok:false,reason:'Table not found'};
  const col=stagedColumns(table).find(c=>c.name===column);
  if(!col) return {ok:false,reason:'Pick a staged source column'};
  if(!String(entity||'').trim()) return {ok:false,reason:'Enter a target Hub'};
  repairForeignKeyDerivations(table);
  const before=(table.derivations||[]).length;
  const applied=ensureDerivationWithoutCollision(table,String(entity).trim(),column,kind,String(role||'').trim());
  if(!applied.ok) return applied;
  const reconciled=repairForeignKeyDerivations(table);
  const after=(table.derivations||[]).length;
  const derivation=(table.derivations||[]).find(d=>sameColumnList(derivationSourceColumns(d),[column])&&
    (d.kind==='hash'||d.kind==='both'||kind==='bk'))||applied.derivation;
  return {ok:true,changed:!!applied.changed||after>before||reconciled>0,added:after>before,merged:after<=before&&(!applied.changed||reconciled>0),derivation};
}
function renderDerivRows(el, t, container){
  if (t.derivations.length===0){ el.innerHTML = `<div class="hint">No derivations yet.</div>`; return; }
  el.innerHTML = `<div class="deriv-row hint" style="font-size:10px;text-transform:uppercase;"><span>Source key</span><span>Target hub</span><span>Role</span><span>Output</span><span>Type</span><span></span></div>` + t.derivations.map(d=>{
    const spec=derivationCanonicalSpec(t,d);
    return `<div class="deriv-row">
      <span class="mono" style="font-size:11.5px;">${escapeHtml(derivationSourceColumns(d).join(' + '))}</span>
      <span class="mono" style="font-size:11.5px;color:var(--sat)">${escapeHtml(spec.entity)}</span>
      <span class="mono" style="font-size:11.5px;">${escapeHtml(spec.role)}</span>
      <span class="mono" style="font-size:11px;">${escapeHtml(derivationOutputLabel(t,d))}</span>
      <span class="tag">${d.kind}</span>
      <button class="btn small danger" data-deldrv="${d.id}">&times;</button>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-deldrv]').forEach(b=>{
    b.addEventListener('click', ()=>{
      t.derivations = t.derivations.filter(d=>d.id!==b.dataset.deldrv);
      renderAll(); setActiveTabViewOnly('staging');
    });
  });
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
