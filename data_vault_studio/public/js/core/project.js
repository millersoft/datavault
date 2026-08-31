/* =========================================================================
   PROJECT SAVE / LOAD + INIT
   ========================================================================= */
function saveProject(){
  const includePasswords = confirm(
    'Include database passwords in the saved file?\n\n' +
    'Choose Cancel (recommended) to save without them — you\'ll just need to ' +
    're-enter passwords after loading this project back in. Choose OK only if ' +
    'you\'re storing this file somewhere you trust as much as your password manager.'
  );
  const stateCopy = JSON.parse(JSON.stringify(state));
  if (!includePasswords){
    stateCopy.vault.srcPassword = '';
    stateCopy.vault.dvPassword = '';
    stateCopy.vault.vaultPassword = '';
    if (stateCopy.externalTables){
      stateCopy.externalTables.password = '';
      stateCopy.externalTables.studioPassword = '';
    }
  }
  const payload = JSON.stringify({ state: stateCopy, uidCounter }, null, 2);
  downloadBlob(payload, `${state.vault.name||'vault'}_project.json`, 'application/json');
  lastCommittedSnapshot = modelSnapshot();
  toast(includePasswords ? 'Project saved (includes passwords — keep this file secure).' : 'Project saved without passwords.', 'ok');
}
function loadProjectFromFile(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    try {
      const data = JSON.parse(e.target.result);
      if (!data.state) throw new Error('Not a Data Vault Studio project file.');
      Object.assign(state, data.state);
      if (!state.sourceMeta) state.sourceMeta = { foreignKeys: [], approxRows: {}, relationshipSuggestions: [], hopCapabilities: null }; // older project files predate this field
      if (!state.sourceMeta.relationshipSuggestions) state.sourceMeta.relationshipSuggestions=[];
      if (!state.vault.sourcePackValues) state.vault.sourcePackValues={};
      if (state.vault.sourceCatalog==null) state.vault.sourceCatalog='';
      if (!state.externalTables.packValues) state.externalTables.packValues={};
      const migratedLegacySqlServer=migrateLegacySqlServerSourceToPack();
      const migratedLegacySqlServerTarget=migrateLegacySqlServerTargetToPack();
      enforceRuntimeConnections(false);
      // Builds that briefly exposed two target passwords stored the service
      // password in vaultPassword. The GUI now has one target password; prefer
      // the visible target password and fall back to the legacy value only when
      // loading a file that has no dvPassword.
      if (!state.vault.dvPassword && typeof state.vault.vaultPassword === 'string') state.vault.dvPassword = state.vault.vaultPassword;
      state.vault.vaultPassword = state.vault.dvPassword || '';
      delete state.vault.bootstrapUseTarget; delete state.vault.bootstrapUser; delete state.vault.bootstrapPassword;
      const normalized = applyFeatureGates();
      uidCounter = data.uidCounter || uidCounter;
      const removed = pruneDownstreamModel({ dropExcluded:true });
      stagingConfirmedFingerprint = '';
      expandedStagingTableId = undefined;
      lastCommittedSnapshot = modelSnapshot();
      activeTab = 'connections'; appMode = 'designer';
      renderAll();
      const notes = [];
      if (removedModelCount(removed)) notes.push(`cleaned up stale downstream model objects: ${modelRemovalSummary(removed)}`);
      if (normalized.repairedJunctionDerivations) notes.push(`repaired ${normalized.repairedJunctionDerivations} relationship-key derivation(s)`);
      if (normalized.repairedForeignKeyDerivations) notes.push(`reconciled ${normalized.repairedForeignKeyDerivations} foreign-key derivation(s)`);
      if (normalized.repairedSatelliteDerivations) notes.push(`repaired ${normalized.repairedSatelliteDerivations} satellite parent-key derivation(s)`);
      if (normalized.normalizedColumnFlags) notes.push(`defaulted ${normalized.normalizedColumnFlags} existing column(s) to included in staging`);
      if (normalized.normalizedLoadGroups) notes.push(`defaulted ${normalized.normalizedLoadGroups} staging load group(s) to 2000`);
      if (migratedLegacySqlServer) notes.push('migrated the legacy SQL Server source to the installed SQL Server Database Pack');
      if (migratedLegacySqlServerTarget) notes.push('migrated the legacy SQL Server physical target to the installed SQL Server Database Pack');
      toast(notes.length ? `Project loaded; ${notes.join('; ')}.` : 'Project loaded.','ok');
    } catch(err){
      toast('Could not load that file: ' + err.message, 'err');
    }
  };
  reader.readAsText(file);
}

function startNewProject(skipConfirm){
  if (!skipConfirm && !confirm('Start a new project? This clears everything currently on screen — save your project first if you want to keep it.')) return;
  Object.assign(state.vault, {
    name:'', prefix:'', sourceSchema:'public', sourceCatalog:'', sourcePackValues:{}, tenantId:'', dialect:'postgresql',
    sourcePreset:'', targetPreset:'',
    hashAlgorithm:'sha256',
    vaultDbName:'', vaultDescription:'', srcCod:'', srcDescription:'',
    stagingDaysToLoadDefault:30, incrementalSettingsDeploymentPending:false,
    srcHost:'', srcPort:'', srcDatabase:'', srcUser:'', srcPassword:'', srcRuntimeHost:'', srcRuntimePort:'',
    dvHost:'localhost', dvPort:'5432', dvDatabase:'', dvUser:'', dvPassword:'', vaultPassword:'',
  });
  enforceRuntimeConnections(true);
  state.tables = []; state.hubs = []; state.links = []; state.hubSats = []; state.linkSats = [];
  state.sourceMeta = { foreignKeys: [], approxRows: {}, relationshipSuggestions: [], hopCapabilities: null };
  Object.assign(state.externalTables, {
    enabled:false, serverName:'', drivername:'', url:'', jarfile:'',
    querytimeout:'30', maxheapsize:'', username:'', password:'',
    remoteDialect:'postgresql', remoteDatabase:'', remoteSchema:'',
    studioHost:'', studioPort:'', studioDatabase:'', studioSchema:'', studioUser:'', studioPassword:'',
    studioConnectionOverridden:false, deploymentAcknowledged:false, targetProfile:null, packValues:{},
  });
  externalPreflightResult = null; externalDeployResult = null; externalStorageBusy = false;
  externalTargetConnStatus = null; externalTargetConnError = ''; externalTargetDbExists = null; externalTargetIdentity = null; externalTargetDbCreating = false;
  discoveredSchemas = []; sourceConnStatus = null; targetConnStatus = null; targetDbExists = null;
  expandedTableId = null; expandedStagingTableId = undefined; stagingConfirmedFingerprint = '';
  modelSub = 'hubs'; activeTab = 'connections'; appMode = 'designer';
  try { localStorage.removeItem('vaultStudioAutosave'); } catch(_){}
  lastCommittedSnapshot = modelSnapshot();
  renderAll();
  toast('New project started.', 'ok');
}
document.getElementById('btn-new-project').addEventListener('click', ()=> startNewProject(false));
document.getElementById('btn-save-project').addEventListener('click', saveProject);
document.getElementById('btn-load-project').addEventListener('click', ()=> document.getElementById('file-load-project').click());

function syncThemeSwitchInput(){
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.getElementById('theme-switch-input').checked = isDark;
}
document.getElementById('theme-switch-input').addEventListener('change', e=>{
  const next = e.target.checked ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('vaultStudioTheme', next); } catch(_) {}
});
syncThemeSwitchInput();
document.getElementById('file-load-project').addEventListener('change', (e)=>{
  if (e.target.files[0]) loadProjectFromFile(e.target.files[0]);
  e.target.value = '';
});

