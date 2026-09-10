/* =========================================================================
   AUTOSAVE & CRASH RECOVERY — the whole model used to live only in memory;
   a refresh or crash lost everything since the last manual JSON save.
   Now: every input/change event (plus a periodic safety net) snapshots
   {state, uidCounter} into localStorage, debounced. On startup, if a
   non-trivial autosave exists, offer to restore it once per snapshot.
   Passwords are stripped from autosaves — localStorage is not a vault.
   ========================================================================= */
const AUTOSAVE_KEY = 'vaultStudioAutosave';
const AUTOSAVE_DISMISS_KEY = 'vaultStudioAutosaveDismissed';
let autosaveTimer = null;
let lastAutosavedJson = '';
let lastCommittedSnapshot = modelSnapshot(); // updated on explicit save/load/new/restore

function projectIsTrivial(s){
  const noModel = s.tables.length===0 && s.hubs.length===0 && s.links.length===0
    && s.hubSats.length===0 && s.linkSats.length===0;
  if (!noModel) return false;
  if (isDemoRuntime()){
    return s.vault.name==='sak' && s.vault.prefix==='sak' && s.vault.tenantId==='SAK'
      && s.vault.srcCod==='SAK' && s.vault.srcDescription==='sakila';
  }
  return !s.vault.name && !s.vault.prefix && !s.vault.tenantId
    && !s.vault.srcCod && !s.vault.srcDescription;
}
function buildAutosavePayload(){
  const stateCopy = JSON.parse(JSON.stringify(state));
  stateCopy.vault.srcPassword = '';
  stateCopy.vault.dvPassword = '';
  stateCopy.vault.vaultPassword = '';
  if (stateCopy.externalTables){ stateCopy.externalTables.password = ''; stateCopy.externalTables.studioPassword = ''; }
  stripDatabasePackPasswordsFromState(stateCopy);
  return { state: stateCopy, uidCounter, importedProjectConnectionsRequireConfirmation, savedAt: new Date().toISOString() };
}
function writeAutosaveNow(){
  try {
    if (projectIsTrivial(state)) return;
    const payload = buildAutosavePayload();
    const json = JSON.stringify(payload);
    // Compare without the timestamp so idle tabs don't churn localStorage.
    const comparable = JSON.stringify({ state: payload.state, uidCounter: payload.uidCounter, importedProjectConnectionsRequireConfirmation:payload.importedProjectConnectionsRequireConfirmation });
    if (comparable === lastAutosavedJson) return;
    localStorage.setItem(AUTOSAVE_KEY, json);
    lastAutosavedJson = comparable;
  } catch(_){ /* storage full/blocked — autosave is best-effort */ }
}
function scheduleAutosave(){
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(writeAutosaveNow, 800);
}
// Every field edit anywhere in the app (capture phase — fields are re-created
// constantly by renderAll, so a delegated listener is the only stable hook).
document.addEventListener('input', scheduleAutosave, true);
document.addEventListener('change', scheduleAutosave, true);
// Safety net for programmatic mutations that don't come from a form event
// (AI apply, suggestions, drift merges, undo).
setInterval(writeAutosaveNow, 10000);

function readAutosave(){
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.state || projectIsTrivial(parsed.state)) return null;
    return parsed;
  } catch(_){ return null; }
}
function restoreAutosave(parsed){
  Object.assign(state, parsed.state);
  importedProjectConnectionsRequireConfirmation=parsed.importedProjectConnectionsRequireConfirmation===true;
  confirmedImportedConnectionTargets.clear();
  if (!state.sourceMeta) state.sourceMeta = { foreignKeys: [], approxRows: {}, relationshipSuggestions: [], hopCapabilities: null };
  if (!state.sourceMeta.relationshipSuggestions) state.sourceMeta.relationshipSuggestions=[];
  if (!state.vault.sourcePackValues) state.vault.sourcePackValues={};
  if (state.vault.sourceCatalog==null) state.vault.sourceCatalog='';
  if (!state.externalTables.packValues) state.externalTables.packValues={};
  const migratedLegacySqlServer=migrateLegacySqlServerSourceToPack();
  const migratedLegacySqlServerTarget=migrateLegacySqlServerTargetToPack();
  enforceRuntimeConnections(false);
  const normalized = applyFeatureGates();
  uidCounter = parsed.uidCounter || uidCounter;
  pruneDownstreamModel({ dropExcluded:true });
  stagingConfirmedFingerprint = '';
  expandedStagingTableId = undefined;
  lastCommittedSnapshot = modelSnapshot();
  activeTab = 'connections'; appMode = 'designer';
  renderAll();
  const repairs = [];
  if (migratedLegacySqlServer) repairs.push('legacy SQL Server source moved to its installed Database Pack');
  if (migratedLegacySqlServerTarget) repairs.push('legacy SQL Server target moved to its installed Database Pack');
  if (normalized.repairedJunctionDerivations) repairs.push(`${normalized.repairedJunctionDerivations} relationship-key derivation(s)`);
  if (normalized.repairedForeignKeyDerivations) repairs.push(`${normalized.repairedForeignKeyDerivations} foreign-key derivation(s)`);
  if (normalized.repairedSatelliteDerivations) repairs.push(`${normalized.repairedSatelliteDerivations} satellite parent-key derivation(s)`);
  toast(`Unsaved work restored from autosave${repairs.length?`; repaired ${repairs.join(' and ')}`:''}.${isDemoRuntime()?' Demo credentials were restored automatically.':''}`, 'ok');
}
function maybeOfferAutosaveRestore(){
  const parsed = readAutosave();
  if (!parsed) return;
  let dismissed = '';
  try { dismissed = localStorage.getItem(AUTOSAVE_DISMISS_KEY) || ''; } catch(_){}
  if (dismissed === parsed.savedAt) return; // already declined this exact snapshot
  const when = parsed.savedAt ? new Date(parsed.savedAt).toLocaleString() : 'an earlier session';
  const name = parsed.state.vault.name || '(unnamed vault)';
  if (confirm(`Restore unsaved work from ${when}?\n\nProject: ${name} — ${parsed.state.tables.length} table(s), ${parsed.state.hubs.length} hub(s).\n\nCancel keeps the autosave but won't ask again for this saved version (Load project still works as usual).`)){
    restoreAutosave(parsed);
  } else {
    try { localStorage.setItem(AUTOSAVE_DISMISS_KEY, parsed.savedAt || 'dismissed'); } catch(_){}
  }
}

// Warn before closing a tab with unsaved, non-trivial changes. Autosave
// makes this recoverable anyway, but the prompt prevents the surprise.
window.addEventListener('beforeunload', (e)=>{
  writeAutosaveNow();
  if (!projectIsTrivial(state) && modelSnapshot() !== lastCommittedSnapshot){
    e.preventDefault();
    e.returnValue = '';
  }
});

