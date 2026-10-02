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
    stripDatabasePackPasswordsFromState(stateCopy);
  }
  const payload = JSON.stringify({ state: stateCopy, uidCounter }, null, 2);
  downloadBlob(payload, `${state.vault.name||'vault'}_project.json`, 'application/json');
  lastCommittedSnapshot = modelSnapshot();
  toast(includePasswords ? 'Project saved (includes passwords — keep this file secure).' : 'Project saved without passwords.', 'ok');
}
function projectStateShapeIssue(candidate){
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return 'Project state must be an object.';
  if (!candidate.vault || typeof candidate.vault !== 'object' || Array.isArray(candidate.vault)) return 'Project state is missing its vault settings.';
  for (const key of ['tables','hubs','links','hubSats','linkSats','businessViews','businessVaultObjects','reports']){
    if (candidate[key] != null && !Array.isArray(candidate[key])) return `Project field "${key}" must be an array.`;
    if (Array.isArray(candidate[key]) && candidate[key].some(item=>!item || typeof item!=='object' || Array.isArray(item))) return `Project field "${key}" contains an invalid item.`;
  }
  for(const table of candidate.tables || []) if(table.columns!=null && !Array.isArray(table.columns)) return `Project table "${table.name||'?'}" has invalid columns.`;
  for(const link of candidate.links || []) if(link.hubs!=null && !Array.isArray(link.hubs)) return `Project link "${link.entity||'?'}" has invalid hubs.`;
  for(const sat of [...(candidate.hubSats||[]),...(candidate.linkSats||[])]) if(sat.attrs!=null && !Array.isArray(sat.attrs)) return `Project satellite "${sat.entity||'?'}" has invalid attributes.`;
  return '';
}

// Validate saved values against the same downstream limits used by the live GUI.
// These are correctable import issues: we report them but never truncate text or
// delete extra Hub roles from an older project behind the user's back.
function projectLimitIssues(candidate){
  const issues=[];
  const v=(candidate && candidate.vault) || {};
  const add=(fieldKey,value,label)=>{ const issue=pdiMetaLengthIssue(fieldKey,value,label); if(issue) issues.push(issue); };
  add('vaultShortName',v.name,'Vault short name');
  add('dataVaultName',v.vaultDbName,'Target data vault database name');
  add('dataVaultDescription',v.vaultDescription,'Data vault description');
  add('sourceSystemCode',v.srcCod,'Source system code');
  add('sourceSystemDescription',v.srcDescription,'Source system description');
  add('connectionHost',v.srcHost,'Source connection host');
  add('connectionDatabase',v.srcDatabase,'Source connection database');
  add('connectionUser',v.srcUser,'Source connection username');
  add('connectionHost',v.dvHost,'Data Vault connection host');
  add('connectionDatabase',v.dvDatabase,'Data Vault connection database');
  add('connectionUser',v.dvUser,'Data Vault connection username');
  const prefixIssue=studioLengthIssue('stagingPrefix',v.prefix,'Staging prefix');
  if(prefixIssue) issues.push(prefixIssue);
  const tenantIssue=studioLengthIssue('tenantId',v.tenantId,'Tenant ID literal');
  if(tenantIssue) issues.push(tenantIssue);
  [
    ['vaultShortName',v.name,'Vault short name'],
    ['stagingPrefix',v.prefix,'Staging prefix'],
    ['tenantId',v.tenantId,'Tenant ID literal'],
    ['sourceSystemCode',v.srcCod,'Source system code'],
    ['sourceSystemDescription',v.srcDescription,'Source system description'],
  ].forEach(([fieldKey,value,label])=>{ const issue=studioInputIssue(fieldKey,value,label); if(issue) issues.push(issue); });
  [`${v.name||''}_source`,`${v.name||''}_staging`,`${v.name||''}_datavault`].forEach(name=>add('connectionName',name,`Generated connection name "${name}"`));

  (Array.isArray(candidate && candidate.tables) ? candidate.tables : []).forEach(t=>{
    const name=String((t && t.name)||'');
    add('sourceTableName',name,`Source table "${name}" name`);
    add('sourceTableDescription',t && t.description,`Source table "${name}" description`);
    add('sourceConcat',sourceConcat(t),`Generated source_concat for "${sourceTableLabel(t)}"`);
    add('incrementDateColumn',t && t.incrementCol,`Increment date column for "${name}"`);
    if(t && typeof t.customOverride==='string') add('stagingSqlOverride',t.customOverride,`Custom staging SQL override for "${name}"`);
  });
  (Array.isArray(candidate && candidate.hubs) ? candidate.hubs : []).forEach(h=>add('hubDescription',h && h.description,`Hub "${(h&&h.entity)||'?'}" description`));
  (Array.isArray(candidate && candidate.links) ? candidate.links : []).forEach(l=>{
    add('linkDescription',l && l.description,`Link "${(l&&l.entity)||'?'}" description`);
    const countIssue=pdiMetaItemCountIssue('linkHubs',l && l.hubs,`Link "${(l&&l.entity)||'?'}"`);
    if(countIssue) issues.push(countIssue);
  });
  [...(Array.isArray(candidate && candidate.hubSats) ? candidate.hubSats : []), ...(Array.isArray(candidate && candidate.linkSats) ? candidate.linkSats : [])]
    .forEach(s=>add('satelliteDescription',s && s.description,`Satellite "${(s&&s.entity)||'?'}" description`));
  return [...new Set(issues)];
}
// Backwards-compatible name retained for tests/older integrations; this now
// includes Studio-only limits as well as pdi_meta limits.
function projectPdiMetaIssues(candidate){ return projectLimitIssues(candidate); }

function loadProjectFromFile(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    try {
      const data = JSON.parse(e.target.result);
      if (!data.state) throw new Error('Not a Data Vault Studio project file.');
      const shapeIssue=projectStateShapeIssue(data.state);
      if (shapeIssue) throw new Error(shapeIssue);
      const importLimitIssues=projectLimitIssues(data.state);
      Object.assign(state, data.state);
      importedProjectConnectionsRequireConfirmation = true;
      confirmedImportedConnectionTargets.clear();
      if (!state.sourceMeta) state.sourceMeta = { foreignKeys: [], approxRows: {}, relationshipSuggestions: [], hopCapabilities: null }; // older project files predate this field
      if (!Array.isArray(state.businessViews)) state.businessViews=[];
      if (!Array.isArray(state.businessVaultObjects)) state.businessVaultObjects=[];
      if (!Array.isArray(state.reports)) state.reports=[];
      if (!state.studioPlus || typeof state.studioPlus!=='object' || Array.isArray(state.studioPlus)) state.studioPlus={ goal:'', plan:null };
      if (typeof studioPlusResetSession==='function') studioPlusResetSession();
      if (!state.sourceMeta.relationshipSuggestions) state.sourceMeta.relationshipSuggestions=[];
      if (!state.vault.sourcePackValues) state.vault.sourcePackValues={};
      if (!Array.isArray(state.vault.sourceSchemas)) state.vault.sourceSchemas=state.vault.sourceSchema?[state.vault.sourceSchema]:[];
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
      if (importLimitIssues.length){
        const first=importLimitIssues[0];
        toast(`Project loaded with ${importLimitIssues.length} validation issue${importLimitIssues.length===1?'':'s'}. No data was truncated or removed. Fix before export/deploy. First issue: ${first}`,'err');
      } else {
        toast(notes.length ? `Project loaded; ${notes.join('; ')}.` : 'Project loaded.','ok');
      }
    } catch(err){
      toast('Could not load that file: ' + err.message, 'err');
    }
  };
  reader.readAsText(file);
}

function startNewProject(skipConfirm){
  if (!skipConfirm && !confirm('Start a new project? This clears everything currently on screen — save your project first if you want to keep it.')) return;
  importedProjectConnectionsRequireConfirmation = false;
  confirmedImportedConnectionTargets.clear();
  Object.assign(state.vault, {
    name:'', prefix:'', sourceSchema:'public', sourceSchemas:[], sourceCatalog:'', sourcePackValues:{}, tenantId:'', dialect:'postgresql',
    sourcePreset:'', targetPreset:'',
    hashAlgorithm:'sha256',
    vaultDbName:'', vaultDescription:'', srcCod:'', srcDescription:'',
    stagingDaysToLoadDefault:30, incrementalSettingsDeploymentPending:false,
    srcHost:'', srcPort:'', srcDatabase:'', srcUser:'', srcPassword:'', srcRuntimeHost:'', srcRuntimePort:'',
    dvHost:'localhost', dvPort:'5432', dvDatabase:'', dvUser:'', dvPassword:'', vaultPassword:'',
  });
  enforceRuntimeConnections(true);
  state.tables = []; state.hubs = []; state.links = []; state.hubSats = []; state.linkSats = []; state.businessViews = []; state.businessVaultObjects = []; state.reports = []; state.studioPlus = { goal:'', plan:null };
  if (typeof studioPlusResetSession==='function') studioPlusResetSession();
  state.sourceMeta = { foreignKeys: [], approxRows: {}, relationshipSuggestions: [], hopCapabilities: null };
  Object.assign(state.externalTables, {
    enabled:false, serverName:'', drivername:'', url:'', jarfile:'',
    querytimeout:'30', maxheapsize:'', username:'', password:'',
    remoteDialect:'postgresql', remoteDatabase:'', remoteSchema:'',
    studioHost:'', studioPort:'', studioDatabase:'', studioSchema:'', studioUser:'', studioPassword:'',
    studioConnectionOverridden:false, fdwUrlOverridden:false, deploymentAcknowledged:false, targetProfile:null, packValues:{},
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
document.getElementById('btn-import-hopper').addEventListener('click', openHopperImport);

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
