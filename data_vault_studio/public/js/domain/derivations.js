/* =========================================================================
   Derivations — the link between "a source column" and "a computed staging
   column" (hash_<entity>_id / <entity>_bk). Hubs, links and satellites all
   read/write these per-table.
   ========================================================================= */
function derivationSourceColumns(d){
  if (d && Array.isArray(d.columns) && d.columns.length) return d.columns.slice();
  return d && d.column ? [d.column] : [];
}
function derivationUsesColumn(d, column){
  return derivationSourceColumns(d).includes(column);
}
function sameColumnList(a, b){
  return JSON.stringify(a||[])===JSON.stringify(b||[]);
}
function stableHashAlias(entity, role, columns){
  const names=(columns||[]).map(c=>typeof c==='string'?c:c&&c.name).filter(Boolean);
  const base=sqlNamePart(role || entity || (names.length===1?names[0]:'key'));
  return targetIdentifierBase(`hash_${base}_id`,'hash_key');
}

// Return the canonical Hub/role already wired to these source columns in the
// Vault model. This lets Staging and Vault share one derivation even when FK
// metadata was unavailable during source import.
function linkRelationshipForSourceColumns(table, columns){
  const names=(columns||[]).filter(Boolean);
  if(!table||!names.length) return null;
  const matches=[];
  (state.links||[]).filter(l=>l.tableId===table.id).forEach(link=>{
    (link.hubs||[]).forEach(linkHub=>{
      const cols=linkHubCols(table,linkHub).map(c=>c.name);
      if(!sameColumnList(cols,names)) return;
      const hub=findHub(linkHub.hubId);
      if(!hub) return;
      matches.push({
        entity:sqlNamePart(hub.entity),
        role:sqlNamePart(linkHub.role||linkHubRoleFromSource(table,linkHub)),
        linkId:link.id,
      });
    });
  });
  const unique=[];
  matches.forEach(m=>{
    if(!unique.some(x=>x.entity===m.entity&&x.role===m.role)) unique.push(m);
  });
  return unique.length===1?unique[0]:null;
}
function knownDerivationEntities(){
  const values=[];
  includedTables().forEach(t=>values.push(entityForTable(t.name)));
  (state.hubs||[]).forEach(h=>values.push(sqlNamePart(h.entity)));
  return Array.from(new Set(values.filter(Boolean)));
}
// When FK constraints were not imported (for example a pasted DDL), role-like
// AI labels such as billing_address/original_language can still be reconciled
// to a known source entity. Exact matches win; otherwise only one unambiguous
// suffix match is accepted.
function inferTargetEntityFromRole(entity, role, columns){
  const known=knownDerivationEntities();
  const exact=sqlNamePart(entity||'');
  if(exact&&known.includes(exact)) return exact;
  const names=(columns||[]).filter(Boolean);
  const sourceRole=names.length===1?sqlNamePart(names[0]).replace(/_id$/,''):'';
  const roleName=sqlNamePart(role||entity||sourceRole);
  const candidates=known.filter(k=>roleName===k||roleName.endsWith(`_${k}`));
  candidates.sort((a,b)=>b.length-a.length||a.localeCompare(b));
  if(candidates.length===1) return candidates[0];
  if(candidates.length>1&&candidates[0].length>candidates[1].length) return candidates[0];
  return exact||'';
}
function derivationPreferenceScore(table,d){
  const spec=derivationCanonicalSpec(table,d);
  let score=0;
  if(spec.foreignKey) score+=100;
  const link=linkRelationshipForSourceColumns(table,spec.columns);
  if(link&&link.entity===spec.entity) score+=80;
  if(knownDerivationEntities().includes(spec.entity)) score+=40;
  if(d&&d.role) score+=5;
  return score;
}
// Convert any caller (AI, deterministic suggestion, manual edit or saved
// project) to one canonical derivation shape. A declared/inferred FK decides
// the target Hub; the source-column role is stored separately and controls
// the physical hash alias. An AI role such as "original_language" must never
// become a second Hub when the FK points to "language".
function canonicalDerivationSpec(table, entity, columns, kind='hash', role=''){
  const names=(columns||[]).map(c=>typeof c==='string'?c:c&&c.name).filter(Boolean);
  const requestedKind=['hash','bk','both'].includes(kind)?kind:'hash';
  const plan=tableRelationshipPlan(table);
  const fk=plan.foreignKeyGroups.find(g=>sameColumnList(g.columns,names)) || null;
  const linkRelationship=linkRelationshipForSourceColumns(table,names);
  const own=names.length && sameColumnList(plan.ownKeyColumns.map(c=>c.name),names);
  let canonicalEntity=sqlNamePart(entity || (own?plan.ownEntity:(fk?fk.refEntity:plan.ownEntity)));
  let canonicalRole=role ? sqlNamePart(role) : '';

  // A known source relationship is authoritative. AI may suggest a role-like
  // label as the target entity, but that must never create a second Hub.
  if(requestedKind==='hash'){
    if(fk){
      canonicalEntity=sqlNamePart(fk.refEntity);
      canonicalRole=sqlNamePart(fk.role);
    } else if(linkRelationship){
      canonicalEntity=linkRelationship.entity;
      canonicalRole=linkRelationship.role;
    } else {
      const inferred=inferTargetEntityFromRole(canonicalEntity,canonicalRole,names);
      if(inferred&&inferred!==canonicalEntity){
        if(!canonicalRole) canonicalRole=canonicalEntity;
        canonicalEntity=inferred;
      }
    }
  }
  if(own && requestedKind!=='hash'){
    canonicalEntity=sqlNamePart(plan.ownEntity);
    canonicalRole=sqlNamePart(plan.ownEntity);
  }
  if(!canonicalRole){
    if(fk) canonicalRole=sqlNamePart(fk.role);
    else if(linkRelationship) canonicalRole=linkRelationship.role;
    else if(requestedKind==='hash'&&names.length===1){
      const stem=sqlNamePart(names[0]).replace(/_id$/,'');
      canonicalRole=stem||canonicalEntity;
    } else canonicalRole=canonicalEntity;
  }
  return {
    entity:canonicalEntity,
    role:canonicalRole,
    columns:names,
    column:names[0]||'',
    kind:requestedKind,
    targetAlias:(requestedKind==='hash'||requestedKind==='both')?stableHashAlias(canonicalEntity,canonicalRole,names):'',
    foreignKey:fk,
    linkRelationship,
    ownKey:own,
  };
}
function derivationCanonicalSpec(table, d){
  return canonicalDerivationSpec(table,d&&d.entity,derivationSourceColumns(d),d&&d.kind,d&&d.role);
}
function sameDerivationIdentity(table, d, spec){
  const current=derivationCanonicalSpec(table,d);
  return current.entity===spec.entity && current.role===spec.role && sameColumnList(current.columns,spec.columns);
}
function normaliseDerivationRecord(table, d){
  const spec=derivationCanonicalSpec(table,d);
  const out=Object.assign({},d,{
    entity:spec.entity,
    role:spec.role,
    column:spec.column,
    kind:spec.kind,
  });
  if (spec.columns.length>1) out.columns=spec.columns.slice(); else delete out.columns;
  return out;
}
function ensureKeyDerivation(table, entity, columns, kind='both', role=''){
  const spec=canonicalDerivationSpec(table,entity,columns,kind,role);
  if (!spec.columns.length) return null;
  let d=(table.derivations||[]).find(x=>sameDerivationIdentity(table,x,spec));
  let matchedPhysicalOnly=false;
  if (!d && (spec.kind==='hash'||spec.kind==='both')){
    // Saved projects and old AI responses can file the same FK under its role
    // instead of its target Hub. Merge when source columns and emitted alias
    // are identical; do not merge legitimate alternate hashes with a distinct
    // role/alias (for example a cross-table satellite parent key).
    d=(table.derivations||[]).find(x=>{
      const current=derivationCanonicalSpec(table,x);
      const roleEntityEquivalent=current.entity===spec.role || spec.entity===current.role || current.entity===spec.entity;
      return sameColumnList(current.columns,spec.columns) &&
        (current.kind==='hash'||current.kind==='both') &&
        current.targetAlias===spec.targetAlias &&
        (!!current.foreignKey || !!spec.foreignKey || roleEntityEquivalent);
    });
    matchedPhysicalOnly=!!d;
  }
  if (!d){
    d={id:uid('drv'),entity:spec.entity,role:spec.role,column:spec.column,kind:spec.kind};
    if(spec.columns.length>1) d.columns=spec.columns.slice();
    table.derivations.push(d);
  } else {
    if(!matchedPhysicalOnly){
      d.entity=spec.entity;
      d.role=spec.role;
      d.column=spec.column;
      if(spec.columns.length>1) d.columns=spec.columns.slice(); else delete d.columns;
    }
    d.kind=mergeDerivationKind(d.kind,spec.kind);
  }
  return d;
}
function ensureDerivation(table, entity, column, kind, role=''){
  return ensureKeyDerivation(table,entity,[column],kind,role);
}
function mergeDerivationKind(current, requested){
  if (current===requested) return current;
  if (current==='both' || requested==='both') return 'both';
  return current!==requested ? 'both' : current;
}
function derivationTargetCounts(table, derivations){
  const probe=Object.assign({},table,{derivations:derivations||table.derivations||[]});
  const counts={};
  probe.derivations.forEach(d=>{
    if(d.kind==='hash'||d.kind==='both'){
      const name=hashColumnNameForDerivation(probe,d);
      counts[name]=(counts[name]||0)+1;
    }
    if(d.kind==='bk'||d.kind==='both'){
      const name=businessKeyColumnName(derivationCanonicalSpec(probe,d).entity);
      counts[name]=(counts[name]||0)+1;
    }
  });
  return counts;
}
function duplicateDerivationTargets(table, derivations){
  return Object.entries(derivationTargetCounts(table,derivations))
    .filter(([,count])=>count>1)
    .map(([name,count])=>({name,count}));
}
function ensureKeyDerivationWithoutCollision(table, entity, columns, kind, role=''){
  const beforeRows=(table.derivations||[]).map(d=>Object.assign({},d,{columns:Array.isArray(d.columns)?d.columns.slice():undefined}));
  const before=derivationTargetCounts(table,beforeRows);
  const beforeSnapshot=JSON.stringify(beforeRows.map(d=>[d.entity,d.role,derivationSourceColumns(d),d.kind]));
  const derivation=ensureKeyDerivation(table,entity,columns,kind,role);
  const after=derivationTargetCounts(table,table.derivations);
  const introduced=Object.entries(after).find(([name,count])=>count>1&&count>(before[name]||0));
  if(introduced){
    table.derivations=beforeRows;
    return {ok:false,reason:`would create ${introduced[1]} derivations targeting "${introduced[0]}"`};
  }
  const changed=beforeSnapshot!==JSON.stringify((table.derivations||[]).map(d=>[d.entity,d.role,derivationSourceColumns(d),d.kind]));
  return {ok:true,changed,derivation};
}
function ensureDerivationWithoutCollision(table, entity, column, kind, role=''){
  return ensureKeyDerivationWithoutCollision(table,entity,[column],kind,role);
}
function tableHasHash(table, entity){
  return table && table.derivations.some(d => d.entity===entity && (d.kind==='hash'||d.kind==='both'));
}
function tableHasHashForColumn(table, entity, column){
  return tableHasHashForColumns(table,entity,[column]);
}
function tableHasHashForColumns(table, entity, columns, role=''){
  const names=(columns||[]).filter(Boolean);
  if(!table||!names.length) return false;
  const wanted=canonicalDerivationSpec(table,entity,names,'hash',role);
  return table.derivations.some(d=>{
    const current=derivationCanonicalSpec(table,d);
    return sameColumnList(current.columns,names) && current.entity===wanted.entity && current.role===wanted.role && (d.kind==='hash'||d.kind==='both');
  });
}
function tableHasHubHashOnTable(table, hub){
  const cols = stagedSourceColumnsForHub(table, hub);
  return !!(table && hub && cols.length && tableHasHashForColumns(table, hub.entity, cols.map(c=>c.name), hub.entity));
}
function tableHasLinkHubHash(table, linkHub, link){
  const hub = linkHub && findHub(linkHub.hubId);
  const cols = table && linkHub ? linkHubCols(table, linkHub) : [];
  const derivationEntity = linkHubDerivationEntity(link, linkHub);
  return !!(table && hub && cols.length && tableHasHashForColumns(table, derivationEntity, cols.map(c=>c.name), linkHub.role || linkHubRoleFromSource(table,linkHub)));
}
function sqlNamePart(s){
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'key';
}
function hashAliasBase(entity, column, table, role=''){
  const spec=canonicalDerivationSpec(table,entity,[column],'hash',role);
  return sqlNamePart(spec.role||spec.entity);
}
function hashColumnNameFor(entity, column, table, role=''){
  const spec=canonicalDerivationSpec(table,entity,[column],'hash',role);
  return spec.targetAlias;
}
function hashColumnNameForDerivation(table, d){
  const spec=derivationCanonicalSpec(table,d);
  return spec.targetAlias || stableHashAlias(spec.entity,spec.role,spec.columns);
}
// Resolve the staged hash-column NAME for a Hub reference from the canonical
// derivation on those source columns. The Hub and relationship role are kept
// separate, so repeated-parent and self-referencing FKs remain unambiguous.
function hashColumnNameFromDerivations(table, entity, colName, role=''){
  const names=Array.isArray(colName)?colName.filter(Boolean):(colName?[colName]:[]);
  if(table&&names.length){
    const wanted=canonicalDerivationSpec(table,entity,names,'hash',role);
    const exact=table.derivations.find(d=>{
      const current=derivationCanonicalSpec(table,d);
      return sameColumnList(current.columns,names) && current.entity===wanted.entity && current.role===wanted.role && (d.kind==='hash'||d.kind==='both');
    });
    if(exact) return hashColumnNameForDerivation(table,exact);
    const sameColumns=table.derivations.find(d=>sameColumnList(derivationSourceColumns(d),names)&&(d.kind==='hash'||d.kind==='both'));
    if(sameColumns) return hashColumnNameForDerivation(table,sameColumns);
    return wanted.targetAlias;
  }
  return stableHashAlias(entity,role||entity,names);
}
function hubKeyColIds(hub){
  if (!hub) return [];
  if (Array.isArray(hub.keyColIds) && hub.keyColIds.length) return hub.keyColIds.slice();
  return hub.pkColId ? [hub.pkColId] : [];
}
function hubKeyCols(hub){
  const table = hub && findTable(hub.tableId);
  return hubKeyColIds(hub).map(id=>findCol(table,id)).filter(Boolean);
}
function hashColumnNameForHub(table, hub){
  const cols = table && hub && table.id!==hub.tableId ? stagedSourceColumnsForHub(table,hub) : hubKeyCols(hub);
  return hashColumnNameFromDerivations(table, hub ? hub.entity : '', cols.map(c=>c.name), hub ? hub.entity : '');
}
function linkHubColIds(linkHub){
  if (!linkHub) return [];
  if (Array.isArray(linkHub.colIds) && linkHub.colIds.length) return linkHub.colIds.slice();
  return linkHub.colId ? [linkHub.colId] : [];
}
function linkHubCols(table, linkHub){ return linkHubColIds(linkHub).map(id=>findCol(table,id)).filter(Boolean); }
function hashColumnNameForLinkHub(table, linkHub, link){
  const hub = linkHub ? findHub(linkHub.hubId) : null;
  const cols = linkHub && table ? linkHubCols(table, linkHub) : [];
  if (!hub) return '';
  return hashColumnNameFromDerivations(table, linkHubDerivationEntity(link, linkHub), cols.map(c=>c.name), linkHub.role || linkHubRoleFromSource(table,linkHub));
}

// A link may reference the same hub more than once in different business
// roles (for example Sakila film.language_id and film.original_language_id
// both point to hub_language). The source column supplies a stable role name
// so the physical link columns remain distinct while the logical hub remains
// the same.
function linkHubRoleFromSource(table, linkHub){
  const hub = linkHub ? findHub(linkHub.hubId) : null;
  const col = linkHub && table ? linkHubCols(table, linkHub)[0] : null;
  const fallback = hub ? sqlNamePart(hub.entity) : 'hub';
  const colName = col ? sqlNamePart(col.name) : '';
  return (colName.endsWith('_id') ? colName.slice(0, -3) : colName) || fallback;
}
// Composite references to the same Hub need the role in the staging hash
// alias. A single-column repeated reference can already derive a unique alias
// from its source column, so existing projects keep their established names.
function linkHubDerivationEntity(link, linkHub){
  const hub = linkHub ? findHub(linkHub.hubId) : null;
  if (!hub) return '';
  const sameHubCount = (link && link.hubs ? link.hubs : []).filter(h=>h.hubId===linkHub.hubId).length;
  const table = link ? findTable(link.tableId) : null;
  const sourceColumns = table ? linkHubCols(table, linkHub) : [];
  if (sameHubCount>1 && sourceColumns.length>1){
    return sqlNamePart(linkHub.role || linkHubRoleFromSource(table, linkHub));
  }
  return hub.entity;
}
function normalizeLinkHubRows(table, rows){
  const counts = {};
  (rows||[]).forEach(r=>{ counts[r.hubId] = (counts[r.hubId]||0) + 1; });
  return (rows||[]).map(r=>{
    const ids = Array.isArray(r.colIds) && r.colIds.length ? r.colIds.slice() : (r.colId ? [r.colId] : []);
    const out = { hubId:r.hubId, colId:ids[0]||'', colIds:ids };
    if (counts[r.hubId] > 1){
      out.role = sqlNamePart(r.role || linkHubRoleFromSource(table, r));
    } else if (r.role){
      out.role = sqlNamePart(r.role);
    }
    return out;
  });
}
function linkHubKeyColumnName(link, linkHub){
  const hub = linkHub ? findHub(linkHub.hubId) : null;
  if (!hub) return '';
  const sameHubCount = (link && link.hubs ? link.hubs : []).filter(h=>h.hubId===linkHub.hubId).length;
  if (sameHubCount <= 1) return hubKey(hub.entity);
  const table = link ? findTable(link.tableId) : null;
  const role = sqlNamePart(linkHub.role || linkHubRoleFromSource(table, linkHub));
  return targetIdentifierBase(`hub_${state.vault.name}_${role}_id`,'hub_role_id');
}
function linkHubRowsIssue(entity, table, rows){
  const seenPairs = new Set();
  for (const r of rows){
    const ids = Array.isArray(r.colIds) && r.colIds.length ? r.colIds : [r.colId];
    const pair = `${r.hubId}:${ids.join(',')}`;
    if (seenPairs.has(pair)) return `link "${entity}" contains the same hub/source-column pair more than once`;
    seenPairs.add(pair);
  }
  const probe = { entity, tableId:table.id, hubs:normalizeLinkHubRows(table, rows) };
  const names = probe.hubs.map(h=>linkHubKeyColumnName(probe, h));
  const duplicate = names.find((name, i)=>name && names.indexOf(name)!==i);
  return duplicate ? `link "${entity}" would generate duplicate column "${duplicate}"; use distinct source-role columns` : '';
}

