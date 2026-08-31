/* =========================================================================
   UNDO — snapshot-based, for destructive model operations (table delete,
   exclude-with-prune, column delete, AI/suggestion bulk-apply, drift merge).
   Call pushUndo('label') BEFORE mutating; offer toastUndo() after.
   ========================================================================= */
const undoStack = [];
const UNDO_LIMIT = 20;
function modelSnapshot(){
  return JSON.stringify({ state, uidCounter });
}

// Identifier hygiene — catch bad names at entry, not as a DDL error 4 steps later.
const RESERVED_SQL_WORDS = new Set(['select','from','where','table','user','order','group','join','create',
  'drop','alter','index','view','grant','primary','default','check','column','constraint','and','or','not',
  'null','case','when','then','else','end','union','all','into','values','insert','update','delete','as',
  'on','in','is','like','between','having','limit','offset','cast','current_date','current_time']);
const RESERVED_TARGET_COLUMNS = new Set(['tenant_id','load_dts','load_end_dts','record_source_id','sat_key','sat_attributes_concat','etl_err_date','etl_id_run','etl_err_noe','etl_err_desc','etl_err_col','etl_err_cod']);
function sanitizeIdentifier(raw){
  return String(raw||'').toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^[_0-9]+/,'');
}
function identifierIssue(name){
  if (!name) return null;
  if (RESERVED_SQL_WORDS.has(name)) return `"${name}" is a SQL reserved word — pick another name.`;
  return null;
}
function targetIdentifierIssue(name){
  if (!/^[a-z_][a-z0-9_]*$/.test(String(name||''))) return `"${name}" is not a valid target name. Use lowercase letters, numbers and underscores.`;
  if (String(name).length>63) return `"${name}" is longer than PostgreSQL's 63-character identifier limit.`;
  return identifierIssue(String(name));
}

// Fingerprint of the design (passwords excluded) — used to detect when the
// model changed after a deployment-status check, so stale results can't be applied.
function designFingerprint(){
  const c = JSON.parse(JSON.stringify(state));
  c.vault.srcPassword = ''; c.vault.dvPassword = ''; c.vault.vaultPassword = '';
  const sourcePack=databasePackForDialect(c.vault.dialect);
  if(sourcePack&&c.vault.sourcePackValues){
    (sourcePack.connectionFields||[]).filter(f=>f.mapsTo==='password').forEach(f=>{c.vault.sourcePackValues[f.key]='';});
  }
  if (c.externalTables){
    c.externalTables.password = ''; c.externalTables.studioPassword = '';
    c.externalTables.targetProfile = null;
    c.externalTables.deploymentAcknowledged = false;
    c.externalTables.studioConnectionOverridden = false;
    const targetPack=databasePackForDialect(c.externalTables.remoteDialect);
    if(targetPack){
      // These are derived from the installed Pack/JDBC discovery during deploy;
      // refreshing them must not make the model itself look edited.
      c.externalTables.drivername = '';
      c.externalTables.jarfile = '';
      c.externalTables.url = '';
      if(c.externalTables.packValues){
        (targetPack.connectionFields||[]).filter(f=>f.mapsTo==='password').forEach(f=>{c.externalTables.packValues[f.key]='';});
      }
    }
  }
  return JSON.stringify(c);
}

// Flag destructive statements in user-editable SQL before it hits the target.
function destructiveSqlKeywords(sql){
  const noComments = String(sql||'').replace(/--[^\n]*/g,' ').replace(/\/\*[\s\S]*?\*\//g,' ');
  return (noComments.match(/\b(DROP|TRUNCATE|DELETE)\b/gi) || []).map(k=>k.toUpperCase());
}
function pushUndo(label){
  undoStack.push({ label, snapshot: modelSnapshot(), at: Date.now() });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}
function undoLast(){
  const entry = undoStack.pop();
  if (!entry) { toast('Nothing to undo.', 'err'); return false; }
  const parsed = JSON.parse(entry.snapshot);
  // Rebuild in place — everything else holds references to `state`.
  Object.keys(state).forEach(k=> delete state[k]);
  Object.assign(state, parsed.state);
  uidCounter = parsed.uidCounter;
  if (typeof renderAll==='function') renderAll();
  toast(`Undid: ${entry.label}.`, 'ok');
  return true;
}
function toastUndo(msg){
  toast(msg, 'ok', { label:'Undo', fn: undoLast });
}

