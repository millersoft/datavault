function buildWorkbookRows(){
  const v = state.vault;
  const rows = {};

  rows.data_vault = [[1, v.vaultDbName, v.vaultDescription, 1]];

  rows.connections = [
    [`${v.name}_source`, `Source connection for ${v.name}`],
    [`${v.name}_staging`, `Staging connection for ${v.name}`],
    [`${v.name}_datavault`, `Data vault connection for ${v.name}`],
  ];

  rows.source_systems = [[1, v.srcCod, v.srcDescription, `${v.name}_source`, `${v.name}_staging`, incrementalDaysToLoadDefault(), 0]];

  rows.source_tables = includedTables().map(t=>[
    v.srcDescription, t.name, t.description, stagingViewName(t.name), sourceConcat(t.name),
    // Keep the configured incremental column in metadata independently of the
    // runtime toggle. The user controls ind_staging_is_incremental directly in
    // Data Vault Hub; previous staging history is informational only.
    1, incrementalActive(t)?1:0, FEATURE_INCREMENTAL&&incrementalConfigured(t)?(t.incrementCol||''):'', t.loadGroup, effectiveOverride(t), '',
  ]);

  rows.hubs = state.hubs.map(h=>{
    const table = findTable(h.tableId);
    return [ hubName(h.entity), h.description, hubKey(h.entity), businessKeyColumnName(h.entity), sourceConcat(table.name),
      hashColumnNameForHub(table, h), businessKeyColumnName(h.entity), '', 1, 1, 0, h.statusSat?1:0, '' ];
  });

  rows.links = state.links.map(l=>{
    const table = findTable(l.tableId);
    const row = [ linkNameOf(l.entity), linkKeyOf(l.entity), l.description, 1, sourceConcat(table.name), 1 ];
    for (let i=0;i<10;i++){
      const h = l.hubs[i];
      if (h){
        const hub = findHub(h.hubId);
        const physicalKey = linkHubKeyColumnName(l, h);
        const explicitKey = hub && physicalKey !== hubKey(hub.entity) ? physicalKey : '';
        row.push(hubName(hub.entity), explicitKey, hashColumnNameForLinkHub(table, h, l));
      }
      else row.push('', '', '');
    }
    row.push('', '', 0, 0, '', '', '');
    return row;
  });

  rows.link_attributes = [];

  rows.hub_satellites = [];
  state.hubSats.forEach(s=>{
    const table = findTable(s.tableId); const hub = findHub(s.hubId);
    s.attrs.forEach((a,i)=>{
      const col = findCol(table, a.colId);
      if (i===0){
        rows.hub_satellites.push([ satName(s.entity,s.concern), 'sat_key', s.description, hubName(hub.entity), 1,
          sourceConcat(table.name), hashColumnNameForHub(table, hub), 1, col?targetColumnName(col):'', a.target, 0, '' ]);
      } else {
        rows.hub_satellites.push([ '', '', '', '', '', '', '', i+1, col?targetColumnName(col):'', a.target, 0, '' ]);
      }
    });
  });

  rows.link_satellites = [];
  state.linkSats.forEach(s=>{
    const table = findTable(s.tableId); const link = findLink(s.linkId);
    s.attrs.forEach((a,i)=>{
      const col = findCol(table, a.colId);
      if (i===0){
        const row = [ lsatName(s.entity,s.concern), 'sat_key', s.description, linkNameOf(link.entity), 1, sourceConcat(table.name) ];
        for (let j=0;j<10;j++){ const h=link.hubs[j]; row.push(h?hashColumnNameForLinkHub(table, h, link):''); }
        for (let j=0;j<5;j++) row.push('');
        row.push(1, col?targetColumnName(col):'', a.target, '');
        rows.link_satellites.push(row);
      } else {
        const row = ['', '', '', '', '', ''];
        for (let j=0;j<10;j++) row.push('');
        for (let j=0;j<5;j++) row.push('');
        row.push(i+1, col?targetColumnName(col):'', a.target, '');
        rows.link_satellites.push(row);
      }
    });
  });

  // Base template compatibility sheet. Kept empty apart from the header.
  rows.Sheet10 = [];

  return rows;
}

function downloadBlob(content, filename, mime){
  const blob = new Blob([content], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}

function mappingWorkbookFilename(){
  // Enforced convention: <base>_1.xls — the base name is the only
  // adjustable part; "_1" and the .xls extension are always appended.
  const base = (state.vault.mappingBaseName || 'metadata_spreadsheet').trim() || 'metadata_spreadsheet';
  return `${base}_1.xls`;
}

function buildMappingWorkbook(){
  const rows = buildWorkbookRows();
  const wb = XLSX.utils.book_new();
  Object.keys(SHEET_HEADERS).forEach(sheet=>{
    const aoa = [SHEET_HEADERS[sheet], ...(rows[sheet]||[])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, sheet);
  });
  return wb;
}

function downloadWorkbook(){
  const wb = buildMappingWorkbook();
  // Genuine legacy .xls (bookType 'biff8') silently truncates any cell
  // string over 255 characters — confirmed directly, and it's exactly
  // what corrupted the payment/rental staging_sql_override values (both
  // have several FK-derived hash columns, making their override text
  // long enough to cross that limit). Writing modern xlsx content with a
  // .xls filename avoids that entirely; virtually everything that reads
  // Excel files (including Apache POI, which Hop's own Excel Input step
  // is built on) detects the real format from content, not the
  // extension, so this is safe in exchange for not silently losing data.
  XLSX.writeFile(wb, mappingWorkbookFilename(), { bookType: 'xlsx' });
}

/* ---- validation, mirrors scripts/validate_mapping_workbook.py at a structural level ---- */
