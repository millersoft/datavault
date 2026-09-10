const HASH_ALGORITHMS = {
  md5: { label: 'MD5', width: 32, sqlLabel: 'VARCHAR(32)', note: 'Reserved for a future vault-wide compatibility option.' },
  sha256: { label: 'SHA-256', width: 64, sqlLabel: 'BYTEA (binary)', note: 'Canonical v0.2 hashing: PostgreSQL converts the key text to UTF-8 and applies built-in sha256(). Source databases never hash Vault keys.' },
};
// LOCKED to SHA-256 for now. Source adapters do not implement this choice;
// PostgreSQL staging views own the canonical hash representation.
function hashAlgo(){ return 'sha256'; }
function hashWidth(){ return HASH_ALGORITHMS[hashAlgo()].width; }
function hashSqlType(){ return hashAlgo()==='sha256' ? 'BYTEA' : `VARCHAR(${hashWidth()})`; }

const state = {
  vault: {
    name: '', prefix: '', sourceSchema: 'public', sourceCatalog: '', sourcePackValues: {}, tenantId: '', dialect: 'postgresql',
    sourcePreset: '', // '' manual | 'demo' packaged MySQL sakila container
    targetPreset: '', // '' external | 'internal' packaged Postgres container
    vaultDbName: '', vaultDescription: '', srcCod: '', srcDescription: '',
    hashAlgorithm: 'sha256', // locked to sha256 for now — see hashAlgo()
    mappingBaseName: 'metadata_spreadsheet', // final filename is always <this>_1.xls — see mappingWorkbookFilename()
    stagingDaysToLoadDefault: 30, // source_systems.staging_days_to_load_default — shared by all incremental source tables
    incrementalSettingsDeploymentPending: false,
    // Connection details are used for live Studio/runtime connectivity. Non-secret
    // connection metadata is also used for ref_connections SQL export, but real
    // passwords are never written to ref_connections. Never sent to the AI assistant.
    srcHost: '', srcPort: '', srcDatabase: '', srcUser: '', srcPassword: '', srcRuntimeHost: '', srcRuntimePort: '',
    dvHost: 'localhost', dvPort: '5432', dvDatabase: '', dvUser: '', dvPassword: '', vaultPassword: '',
  },
  // Optional: store hub/link/satellite tables as Postgres foreign tables via
  // jdbc_fdw, instead of native tables. _err tables and all pdi_meta
  // reference tables always stay native regardless of this setting.
  // jdbc_fdw's CREATE SERVER/USER MAPPING options are fixed by the extension
  // itself (not arbitrary key/value pairs) — see pgspider/jdbc_fdw.
  externalTables: {
    enabled: false,
    serverName: '',
    drivername: '',      // e.g. 'org.postgresql.Driver', 'com.mysql.cj.jdbc.Driver'
    url: '',             // URL used by jdbc_fdw from inside the packaged Postgres container
    jarfile: '',         // container path, normally /opt/jdbc-drivers/<driver>.jar
    querytimeout: '30',
    maxheapsize: '',
    username: '',        // remote JDBC user mapped to local role data_vault
    password: '',
    remoteDialect: 'postgresql',
    remoteDatabase: '',
    remoteSchema: '',
    // Studio connects from the host, not from inside the Postgres container.
    // These values default from the JDBC URL but remain independently editable.
    studioHost: '',
    studioPort: '',
    studioDatabase: '',
    studioSchema: '',
    studioUser: '',
    studioPassword: '',
    studioConnectionOverridden: false,
    fdwUrlOverridden: false,
    deploymentAcknowledged: false,
    // JDBC-discovered physical target capabilities. Saved with the project so
    // DDL stays reproducible; cleared whenever the target connection changes.
    targetProfile: null,
    packValues: {},
  },
  // Captured on introspection: source foreign keys + approximate row counts.
  // Powers deterministic key/Vault-table detection and the row-count
  // column on the Tables step. Saved with the project like everything else.
  sourceMeta: { foreignKeys: [], approxRows: {}, relationshipSuggestions: [], hopCapabilities: null },
  tables: [],   // {id,name,objectType:'table'|'view',description,included,incremental,incrementCol,incrementalReady,incrementalReadyRunId,incrementalReadyAfterRunId,incrementalConfiguredAt,incrementalConfigPending,incrementalDeploymentPending,incrementalAutoDetectDismissed,loadGroup,columns:[{...,staged}],derivations:[]}
  hubs: [],     // {id,entity,description,tableId,pkColId,keyColIds,statusSat}
  links: [],    // {id,entity,description,tableId,hubs:[{hubId,colId,colIds,role}]}
  hubSats: [],  // {id,entity,concern,description,hubId,tableId,attrs:[{colId,target}]}
  linkSats: [], // {id,entity,concern,description,linkId,tableId,attrs:[{colId,target}]}
};

// Demo mode starts with the packaged services. Production mode starts with
// the packaged PostgreSQL target selected but leaves the source user-defined.
enforceRuntimeConnections(true);



function findTable(id){ return state.tables.find(t=>t.id===id); }
function findHub(id){ return state.hubs.find(h=>h.id===id); }
function findLink(id){ return state.links.find(l=>l.id===id); }
function findCol(table, colId){ return table ? table.columns.find(c=>c.id===colId) : null; }
function selectedValues(select){ return Array.from((select && select.selectedOptions) || []).map(o=>o.value).filter(Boolean); }

function includedTables(){
  return state.tables.filter(t=>t.included!==false);
}
function normalizeSourceObjectType(value){
  return String(value||'').toLowerCase().includes('view') ? 'view' : 'table';
}
function isSourceView(table){
  return normalizeSourceObjectType(table && table.objectType)==='view';
}
function tableHasVaultObjects(tableId){
  return state.hubs.some(h=>h.tableId===tableId)
    || state.links.some(l=>l.tableId===tableId)
    || state.hubSats.some(s=>s.tableId===tableId)
    || state.linkSats.some(s=>s.tableId===tableId);
}
function applyDetectedObjectType(table, value){
  const typeWasUnknown = !table.objectType;
  table.objectType = normalizeSourceObjectType(value);
  if (typeWasUnknown && isSourceView(table) && table.included!==false && !tableHasVaultObjects(table.id)){
    table.included = false;
    return true;
  }
  return false;
}
function isColumnStaged(col){ return !!col && col.staged!==false; }
function stagedColumns(table){
  if (!table) return [];
  ensureTableTargetNames(table);
  return (table.columns||[]).filter(isColumnStaged);
}
function isIncrementalTemporalColumn(col){
  if (!col) return false;
  // Incremental v1 is intentionally restricted to timestamp/datetime-style
  // source columns. Plain DATE/TIME values and arbitrary numeric/string
  // cursors are not exposed yet. Database Packs retain JDBC semantic/native
  // evidence while PostgreSQL/MySQL expose Studio-normalised SQL types.
  const semantic = String(col.semanticType||'').toUpperCase();
  const type = String(col.type||'').toLowerCase();
  const nativeType = String(col.nativeType||'').toLowerCase();
  if (['TIMESTAMP','TIMESTAMP_TZ','DATETIME'].includes(semantic)) return true;
  return /(^|[^a-z])(timestamp(?:tz)?|timestamptz|datetime(?:2|offset)?|smalldatetime)([^a-z]|$)/i.test(`${type} ${nativeType}`);
}
function isRecommendedIncrementalColumn(col){
  return isIncrementalTemporalColumn(col);
}
function incrementalColumnCandidates(table){
  if (!table) return [];
  return stagedColumns(table).filter(isIncrementalTemporalColumn);
}
// Auto-detection deliberately prioritises change timestamps by NAME rather
// than choosing the first timestamp. Use stems instead of an exact-name list
// so normal source conventions such as ModifiedDate, CustomerModifiedDate,
// row_updated_at and LastUpdateTimestamp are all recognised. The temporal
// type check remains the hard gate, so names such as ModifiedBy or UpdateCount
// can never be selected just because they contain one of these words.
const AUTO_INCREMENTAL_NAME_STEMS = [
  { stem:'lastmodified', score:100 },
  { stem:'lastupdated',  score:98 },
  { stem:'lastupdate',   score:96 },
  { stem:'lastchanged',  score:94 },
  { stem:'lastchange',   score:92 },
  { stem:'modified',     score:90 },
  { stem:'modification', score:88 },
  { stem:'updated',      score:86 },
  { stem:'update',       score:84 },
  { stem:'changed',      score:82 },
  { stem:'change',       score:80 },
];
function normalizedIncrementalColumnName(name){
  return String(name||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
}
function incrementalAutoDetectNameScore(name){
  const normalized = normalizedIncrementalColumnName(name);
  let best = 0;
  AUTO_INCREMENTAL_NAME_STEMS.forEach(rule=>{
    if (normalized.includes(rule.stem)) best = Math.max(best, rule.score);
  });
  return best;
}
function detectedIncrementalColumn(table){
  if (!table) return null;
  const cols = stagedColumns(table).filter(c=>!c.pk && isIncrementalTemporalColumn(c));
  const ranked = cols
    .map((col,index)=>({ col, index, score:incrementalAutoDetectNameScore(col.name) }))
    .filter(item=>item.score>0)
    .sort((a,b)=>b.score-a.score || a.index-b.index);
  return ranked.length ? ranked[0].col : null;
}
function autoConfigureIncrementalColumn(table){
  if (!FEATURE_INCREMENTAL || !table || table.incrementalAutoDetectDismissed) return false;
  if (table.incrementCol && incrementalConfigured(table)) return false;
  // A configuration saved by an older build may point at an unsupported or
  // no-longer-staged column. Schema detection is allowed to repair that stale
  // automatic state and look for a valid timestamp/datetime replacement.
  if (table.incrementCol) configureIncrementalColumn(table, '', { auto:true });
  const col = detectedIncrementalColumn(table);
  if (!col) return false;
  return configureIncrementalColumn(table, col.name, { auto:true });
}
function incrementalDaysToLoadDefault(){
  const raw = Number(state.vault && state.vault.stagingDaysToLoadDefault);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 30;
}
function configureIncrementalDaysToLoad(value){
  const text = String(value==null?'':value).trim();
  const raw = Number(text);
  if (!text || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) return false;
  const next = raw;
  if (next === incrementalDaysToLoadDefault()) return false;
  state.vault.stagingDaysToLoadDefault = next;
  state.vault.incrementalSettingsDeploymentPending = true;
  return true;
}
function incrementalColumnOptions(table){
  return table ? stagedColumns(table).filter(isIncrementalTemporalColumn) : [];
}
function incrementalColumnTypeLabel(col){
  if (!col) return '';
  const type=String(col.type||col.nativeType||'').trim();
  const semantic=String(col.semanticType||'').trim().toUpperCase();
  if (semantic && semantic!=='UNKNOWN') return type ? `${type} · ${semantic}` : semantic;
  return type || String(col.nativeType||'').trim() || 'source column';
}
function incrementalConfigured(table){
  if (!FEATURE_INCREMENTAL || !table || !table.incrementCol) return false;
  // v1 only emits a configured incremental column when it is still staged and
  // is a supported timestamp/datetime-style source column.
  return !!incrementalColumnOptions(table).find(c=>c.name===table.incrementCol);
}
function incrementalReady(table){
  return incrementalConfigured(table) && table.incrementalReady===true;
}
function incrementalActive(table){
  // Runtime activation is an explicit user choice. Previous staging history is
  // informational only and must never block the toggle.
  return incrementalConfigured(table) && table.incremental===true;
}
function configureIncrementalColumn(table, columnName, options = {}){
  if (!table) return false;
  const next = String(columnName||'');
  if (next && !incrementalColumnOptions(table).some(c=>c.name===next)) return false;
  const current = String(table.incrementCol||'');
  if (next===current) return false;
  table.incrementCol = next;
  table.incrementalAutoDetectDismissed = !next && options.auto!==true;
  // Changing the column is a metadata change, not a readiness transition. Keep
  // any known staging history for display. Clearing the column necessarily
  // disables incremental execution; switching between valid temporal columns
  // preserves the user's current on/off choice.
  if (!next) table.incremental = false;
  table.incrementalConfiguredAt = '';
  table.incrementalConfigPending = !!next;
  table.incrementalDeploymentPending = true;
  return true;
}
function markIncrementalWorkbookDeployed(){
  if (!FEATURE_INCREMENTAL) return 0;
  const deployedAt = new Date().toISOString();
  let changed = 0;
  (state.tables||[]).forEach(table=>{
    if (table.incrementalConfigPending && incrementalConfigured(table)){
      table.incrementalConfiguredAt = deployedAt;
      table.incrementalConfigPending = false;
      changed++;
    }
    if (table.incrementalDeploymentPending){
      table.incrementalDeploymentPending = false;
      changed++;
    }
  });
  if (state.vault && state.vault.incrementalSettingsDeploymentPending){
    state.vault.incrementalSettingsDeploymentPending = false;
    changed++;
  }
  return changed;
}
function markIncrementalReady(table, run){
  // Historical staging evidence is informational only. It can be recorded even
  // before the current incremental settings have been deployed.
  if (!incrementalConfigured(table)) return false;
  const runId = Number(run && run.id_run || 0) || null;
  const readyAt = String((run && (run.date_end || run.date_start)) || new Date().toISOString());
  const changed = !table.incrementalReady || table.incrementalReadyRunId!==runId;
  table.incrementalReady = true;
  table.incrementalReadyRunId = runId;
  table.incrementalReadyAt = readyAt;
  return changed;
}
function findStagedColumn(table, colId){
  const col = findCol(table, colId);
  return isColumnStaged(col) ? col : null;
}
function findIncludedTableByName(name){
  return includedTables().find(t=>t.name===name);
}
function pruneDownstreamModel(options = {}){
  // Keeps the vault model consistent with the Tables and Staging tabs. This
  // removes objects that depend on tables that were deleted/excluded or on
  // columns explicitly excluded from the selected staging columns.
  state.tables.forEach(t=>{
    t.derivations = (t.derivations||[]).filter(d=>{
      const names = derivationSourceColumns(d);
      return names.length>0 && names.every(name=>isColumnStaged((t.columns||[]).find(c=>c.name===name)));
    });
  });
  const dropTableIds = new Set(options.dropTableIds || []);
  const validTableIds = new Set(state.tables
    .filter(t => !dropTableIds.has(t.id) && (!options.dropExcluded || t.included!==false))
    .map(t => t.id));
  const before = {
    hubs: state.hubs.length,
    links: state.links.length,
    hubSats: state.hubSats.length,
    linkSats: state.linkSats.length,
  };

  state.hubs = state.hubs.filter(h=>{
    const table = findTable(h.tableId);
    return validTableIds.has(h.tableId) && hubKeyColIds(h).length>0 && hubKeyColIds(h).every(id=>!!findStagedColumn(table,id));
  });
  const validHubIds = new Set(state.hubs.map(h=>h.id));

  state.links = state.links.filter(l=>{
    const table = findTable(l.tableId);
    return validTableIds.has(l.tableId)
      && l.hubs.length >= 2
      && l.hubs.every(x => validHubIds.has(x.hubId) && linkHubColIds(x).length>0 && linkHubColIds(x).every(id=>!!findStagedColumn(table,id)));
  });
  const validLinkIds = new Set(state.links.map(l=>l.id));

  state.hubSats = state.hubSats.map(s=>{
    const table = findTable(s.tableId);
    return { ...s, attrs: (s.attrs||[]).filter(a=>!!findStagedColumn(table, a.colId)) };
  }).filter(s=> validTableIds.has(s.tableId) && validHubIds.has(s.hubId) && s.attrs.length>0);

  state.linkSats = state.linkSats.map(s=>{
    const table = findTable(s.tableId);
    return { ...s, attrs: (s.attrs||[]).filter(a=>!!findStagedColumn(table, a.colId)) };
  }).filter(s=> validTableIds.has(s.tableId) && validLinkIds.has(s.linkId) && s.attrs.length>0);

  return {
    hubs: before.hubs - state.hubs.length,
    links: before.links - state.links.length,
    hubSats: before.hubSats - state.hubSats.length,
    linkSats: before.linkSats - state.linkSats.length,
  };
}
function removedModelCount(r){
  return (r.hubs||0) + (r.links||0) + (r.hubSats||0) + (r.linkSats||0);
}
function modelRemovalSummary(r){
  const part = (n, one, many) => n ? `${n} ${n===1?one:many}` : '';
  return [part(r.hubs,'hub','hubs'), part(r.links,'link','links'), part(r.hubSats,'hub satellite','hub satellites'), part(r.linkSats,'link satellite','link satellites')]
    .filter(Boolean).join(', ');
}

function dialectCfg(){ return DIALECTS[state.vault.dialect] || DIALECTS.postgresql; }

function isBooleanType(typeStr){
  const t = (typeStr||'').trim().toLowerCase();
  return dialectCfg().boolTypes.some(bt => t === bt || t.startsWith(bt));
}
function isJsonLikeType(typeStr){
  const t = (typeStr||'').trim().toLowerCase();
  return dialectCfg().jsonTypes.some(jt => t === jt || t.startsWith(jt));
}
function isUnboundedTextType(typeStr){
  const t = (typeStr||'').trim().toLowerCase().replace(/\s+/g,' ');
  return t === 'text' || t === 'ntext' || t === 'xml' || t === 'clob' || t === 'nclob' ||
    t === 'tinytext' || t === 'mediumtext' || t === 'longtext' ||
    t === 'json' || t === 'jsonb' ||
    /^(?:n?varchar|n?char)\s*\(\s*max\s*\)$/.test(t);
}

/* naming helpers */
function hubName(entity){ return targetIdentifierBase(`hub_${state.vault.name}_${entity}`,'hub'); }
function hubKey(entity){ return targetIdentifierBase(`hub_${state.vault.name}_${entity}_id`,'hub_id'); }
function linkNameOf(entity){ return targetIdentifierBase(`link_${state.vault.name}_${entity}`,'link'); }
function linkKeyOf(entity){ return targetIdentifierBase(`link_${state.vault.name}_${entity}_id`,'link_id'); }
function satName(entity, concern){ return targetIdentifierBase(`sat_${state.vault.name}_${entity}${concern?'_'+concern:''}`,'satellite'); }
function lsatName(entity, concern){ return targetIdentifierBase(`lsat_${state.vault.name}_${entity}${concern?'_'+concern:''}`,'link_satellite'); }
function businessKeyColumnName(entity){ return targetIdentifierBase(`${entity}_bk`,'business_key'); }
function stableNameHash(value){
  let h = 2166136261;
  for (const ch of String(value||'')){ h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h>>>0).toString(36).slice(0,6);
}
function targetIdentifierBase(raw, fallback='column'){
  let base = String(raw||'').trim().toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
  if (!base) base = fallback;
  if (/^[0-9]/.test(base)) base = `c_${base}`;
  if (RESERVED_SQL_WORDS.has(base)) base = `${base}_value`;
  if (typeof RESERVED_TARGET_COLUMNS!=='undefined' && RESERVED_TARGET_COLUMNS.has(base)) base = `${base}_source`;
  if (base.length>55) base = `${base.slice(0,48)}_${stableNameHash(raw)}`;
  return base;
}
function ensureTableTargetNames(table){
  if (!table) return;
  const used = new Set();
  (table.columns||[]).forEach((col,index)=>{
    let name = String(col.targetName||'').trim();
    if (!name || col.targetNameAuto!==false){
      const base = targetIdentifierBase(col.name, `column_${index+1}`);
      name = base;
      let n = 2;
      while (used.has(name)) name = `${base}_${n++}`;
      col.targetName = name;
      if (typeof col.targetNameAuto!=='boolean') col.targetNameAuto = true;
    }
    used.add(String(col.targetName).toLowerCase());
  });
}
function targetColumnName(col){
  return col ? (col.targetName || targetIdentifierBase(col.name)) : '';
}
function stagingTableName(tableName){ return targetIdentifierBase(`stg_${state.vault.prefix}_${tableName}`,'staging_table'); }
function stagingViewName(tableName){ return targetIdentifierBase(`${stagingTableName(tableName)}_vw`,'staging_view'); }
function sourceConcat(tableName){ return `${state.vault.srcDescription}.${tableName}`; }

/* toast */
function toast(msg, kind, action){
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' '+kind : '');
  el.textContent = msg;
  // Optional inline action ({label, fn}) — used for "Undo" after
  // destructive operations. Action toasts linger longer.
  if (action && action.label && typeof action.fn==='function'){
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.style.cssText = 'margin-left:10px;padding:2px 10px;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;font:inherit;font-weight:700;cursor:pointer;';
    btn.addEventListener('click', ()=>{ el.remove(); action.fn(); });
    el.appendChild(btn);
  }
  wrap.appendChild(el);
  const life = action ? 8000 : 3600;
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, life);
}

