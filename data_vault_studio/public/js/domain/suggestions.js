/* =========================================================================
   SUGGEST FROM KEYS — deterministic Data Vault proposal driven by the
   source's own primary/foreign keys (captured during introspection), with
   a naming-convention fallback ("customer_id" → table "customers") when no
   real FK constraints exist. No API key, no network call, fully repeatable.
   ========================================================================= */
function singularizeTableName(name){
  const n = String(name||'');
  if (/ies$/i.test(n) && n.length>4) return n.replace(/ies$/i,'y');
  if (/(ss|us|is)es$/i.test(n)) return n.replace(/es$/i,'');
  if (/(ches|shes|xes|zes|ses)$/i.test(n)) return n.replace(/es$/i,'');
  if (/s$/i.test(n) && !/ss$/i.test(n)) return n.replace(/s$/i,'');
  return n;
}
function entityForTable(name){
  return singularizeTableName(name).toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
}
// A plain table name remains the friendly default.  If that name occurs in
// multiple selected schemas it cannot safely imply a shared business entity,
// so make the proposed Hub names distinct.  A modeller can still explicitly
// approve either table as an additional feed into one shared Hub afterwards.
function entityForSourceTable(table){
  const name=table&&table.name;
  const base=entityForTable(name);
  const duplicates=includedTables().filter(t=>String(t.name).toLowerCase()===String(name||'').toLowerCase());
  if(duplicates.length<2) return base;
  const schema=sourceTableSchema(table);
  return schema ? `${sqlNamePart(schema)}_${base}` : base;
}
// FK list per table — real constraints first, then a name-based fallback
// (<singular>_id or <table>_id matching another included table).
function effectiveForeignKeys(){
  const declared = (state.sourceMeta && state.sourceMeta.foreignKeys) || [];
  const tables = includedTables();
  const result = [];
  const seen = new Set();
  // Keep a declared composite FK only when every source component is
  // selected for staging. Treating one remaining component as the full FK
  // would create a different relationship and a different hash.
  const declaredGroups = new Map();
  declared.forEach((fk,index)=>{
    const table=findIncludedSourceTable(fk.tableSchema,fk.table);
    const refTable=findIncludedSourceTable(fk.refSchema,fk.refTable);
    if (!table || !refTable) return;
    const groupKey = fk.constraintName
      ? `${table.id}:${fk.constraintName}`
      : `${table.id}:column:${fk.column}:${index}`;
    if (!declaredGroups.has(groupKey)) declaredGroups.set(groupKey, []);
    declaredGroups.get(groupKey).push(fk);
  });
  declaredGroups.forEach(rows=>{
    const table = findIncludedSourceTable(rows[0].tableSchema,rows[0].table);
    if (!rows.every(fk=>stagedColumns(table).some(c=>c.name===fk.column))) return;
    rows.forEach(fk=>{
      const key = `${table.id}.${fk.column}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push({
        table:fk.table,
        tableId:table.id,
        column:fk.column,
        refTable:fk.refTable,
        refTableId:findIncludedSourceTable(fk.refSchema,fk.refTable).id,
        refColumn:fk.refColumn||'',
        constraintName:fk.constraintName||'',
        ordinalPosition:fk.ordinalPosition==null?null:Number(fk.ordinalPosition),
      });
    });
  });
  // Fallback inference by column name, only for columns not already covered.
  tables.forEach(t=>{
    stagedColumns(t).forEach(c=>{
      const key = `${t.id}.${c.name}`;
      if (seen.has(key)) return;
      const m = c.name.match(/^(.*)_id$/i);
      if (!m || !m[1]) return;
      if (c.pk && stagedColumns(t).filter(x=>x.pk).length===1) return;
      const base = m[1].toLowerCase();
      const candidates=tables.filter(x=> x.id!==t.id && (x.name.toLowerCase()===base || entityForTable(x.name)===base));
      // Do not infer across duplicate names/entities: this needs modeller
      // input, whereas a JDBC-declared FK above carries schema identity.
      const target=candidates.length===1 ? candidates[0] : null;
      if (target){
        const targetPk = stagedColumns(target).find(x=>x.pk);
        seen.add(key);
        result.push({ table:t.name, tableId:t.id, column:c.name, refTable:target.name, refTableId:target.id, refColumn:targetPk?targetPk.name:'', constraintName:`inferred:${c.name}`, ordinalPosition:1 });
      }
    });
  });
  return result;
}
const AUDIT_COLUMN_RE = /^(created?_(at|on|date|by)|updated?_(at|on|date|by)|modified_(at|on|date|by)|last_update[d]?(_at)?|deleted_(at|on)|row_version|etl_.*)$/i;

function foreignKeyRoleName(fk){
  const refEntity = entityForSourceTable(findTable(fk && fk.refTableId) || {name:fk && fk.refTable});
  const col = sqlNamePart(fk && fk.column);
  const role = col.endsWith('_id') ? col.slice(0, -3) : col;
  return role || refEntity || 'related';
}
function foreignKeyGroupRole(columns, refEntity){
  const stems=(columns||[]).map(name=>sqlNamePart(name).replace(/_id$/,''));
  if(stems.length<=1) return stems[0]||refEntity||'related';
  const tokenLists=stems.map(s=>s.split('_'));
  const common=[];
  for(let i=0;;i++){
    const token=tokenLists[0][i];
    if(!token||!tokenLists.every(parts=>parts[i]===token)) break;
    common.push(token);
  }
  return common.join('_')||refEntity||stems[0];
}
function groupForeignKeysForTable(table, allForeignKeys){
  const rows=(allForeignKeys||effectiveForeignKeys()).filter(f=>f.tableId===table.id);
  const groups=new Map();
  rows.forEach((f,index)=>{
    const key=f.constraintName ? `${f.refTable}:${f.constraintName}` : `${f.refTable}:column:${f.column}:${index}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(f);
  });
  return Array.from(groups.values()).map(rows=>{
    rows.sort((a,b)=>(a.ordinalPosition||0)-(b.ordinalPosition||0));
    const first=rows[0];
    return {
      table:table.name,
      columns:rows.map(r=>r.column),
      refTable:first.refTable,
      refTableId:first.refTableId,
      refColumns:rows.map(r=>r.refColumn||''),
      refEntity:entityForSourceTable(findTable(first.refTableId) || {name:first.refTable}),
      role:foreignKeyGroupRole(rows.map(r=>r.column),entityForSourceTable(findTable(first.refTableId) || {name:first.refTable})),
      constraintName:first.constraintName||'',
      rows,
    };
  });
}

function binaryRelationshipEntity(ownEntity, refEntity, role){
  const own = sqlNamePart(ownEntity);
  const ref = sqlNamePart(refEntity);
  const r = sqlNamePart(role || ref);
  if (own===ref) return `${own}_${r===own?'related':r}`;
  return `${own}_${r!==ref?r:ref}`;
}

// Central relationship planner used by deterministic suggestions, AI
// normalisation and coverage checks. It separates entity tables from tables
// whose key is made entirely from two or more foreign-key roles. Descriptive
// columns on a relationship table are assigned to a Link Satellite.
function tableRelationshipPlan(t, allForeignKeys){
  const allFks = allForeignKeys || effectiveForeignKeys();
  const foreignKeys = allFks.filter(f=>f.tableId===t.id).map(f=>({
    table:f.table,
    column:f.column,
    refTable:f.refTable,
    refColumn:f.refColumn||'',
    constraintName:f.constraintName||'',
    ordinalPosition:f.ordinalPosition==null?null:f.ordinalPosition,
    refEntity:entityForSourceTable(findTable(f.refTableId) || {name:f.refTable}),
    role:foreignKeyRoleName(f),
  }));
  const foreignKeyGroups=groupForeignKeysForTable(t,allFks);
  const allPrimaryKeyColumns=(t.columns||[]).filter(c=>c.pk);
  const selectedPrimaryKeyColumns=allPrimaryKeyColumns.filter(isColumnStaged);
  const primaryKeyComplete=allPrimaryKeyColumns.length===selectedPrimaryKeyColumns.length;
  const primaryKeyColumns=primaryKeyComplete?selectedPrimaryKeyColumns:[];
  const fkColumns=new Set(foreignKeyGroups.flatMap(g=>g.columns));
  // An entity-extension table can use its parent key as both its PK and an
  // FK (AdventureWorks Sales.Store.BusinessEntityID is exactly that), while
  // also carrying other foreign keys.  Only a *composite* PK made entirely of
  // FKs is enough evidence that the table itself is a relationship/link.
  const primaryKeyIsRelationship=primaryKeyColumns.length>=2&&primaryKeyColumns.every(c=>fkColumns.has(c.name));
  const relationshipTable=foreignKeyGroups.length>=2&&(allPrimaryKeyColumns.length===0||primaryKeyIsRelationship);
  const ownKeyColumns=relationshipTable?[]:primaryKeyColumns.slice();
  const ownKey=ownKeyColumns.length===1?ownKeyColumns[0]:null;
  const type=relationshipTable?'relationship':(foreignKeyGroups.length?'entity_with_relationships':'entity');
  const attributes=stagedColumns(t).filter(c=>!c.pk&&!fkColumns.has(c.name));
  const groups=[];
  const ownEntity=entityForSourceTable(t);

  if(relationshipTable){
    groups.push({
      kind:'relationship_table',
      entity:ownEntity||foreignKeyGroups.map(f=>f.refEntity).join('_'),
      pairs:foreignKeyGroups.map(f=>({
        hub:f.refEntity,
        column:f.columns[0],
        columns:f.columns.slice(),
        role:f.role,
        refTable:f.refTable,
        refTableId:f.refTableId,
        refColumns:f.refColumns.slice(),
      })),
      attributes,
    });
  } else if(ownKeyColumns.length){
    foreignKeyGroups.forEach(f=>groups.push({
      kind:'foreign_key',
      entity:binaryRelationshipEntity(ownEntity,f.refEntity,f.role),
      pairs:[
        {hub:ownEntity,column:ownKeyColumns[0].name,columns:ownKeyColumns.map(c=>c.name),role:ownEntity,refTable:t.name,own:true},
        {hub:f.refEntity,column:f.columns[0],columns:f.columns.slice(),role:f.role,refTable:f.refTable,refTableId:f.refTableId,refColumns:f.refColumns.slice()},
      ],
      attributes:[],
      foreignKey:f,
    }));
  }
  return {table:t,type,ownEntity,ownKey,ownKeyColumns,primaryKeyColumns,allPrimaryKeyColumns,primaryKeyComplete,foreignKeys,foreignKeyGroups,attributes,groups};
}

// Kept as an internal compatibility alias for saved-project repair code and
// older tests. "Relationship table" is the user-facing concept.
function tableIsJunction(t){
  return tableRelationshipPlan(t).type==='relationship';
}

function relationshipPairSignature(pairs){
  return (pairs||[]).flatMap(p=>Array.isArray(p.columns)&&p.columns.length?p.columns:[p.column])
    .map(String).filter(Boolean).sort().join('|');
}
function linkRelationshipSignature(link){
  const table = link && findTable(link.tableId);
  if (!table) return '';
  return relationshipPairSignature((link.hubs||[]).map(h=>{
    const col = findCol(table, h.colId);
    return { columns:linkHubCols(table,h).map(c=>c.name), column:col ? col.name : '' };
  }));
}
function findLinkForRelationshipGroup(table, group){
  const signature = relationshipPairSignature(group && group.pairs);
  return state.links.find(l=>l.tableId===table.id && linkRelationshipSignature(l)===signature) || null;
}
function aiLinkMatchesRelationshipPlan(proposal){
  const table = findIncludedTableByName(proposal && proposal.table);
  if (!table) return { ok:false, reason:`included table "${proposal&&proposal.table}" not found` };
  const plan = tableRelationshipPlan(table);
  const signature = relationshipPairSignature((proposal.hubs||[]).map(h=>({ column:h.column, columns:h.columns })));
  const group = plan.groups.find(g=>relationshipPairSignature(g.pairs)===signature);
  if (!group){
    if (plan.type==='entity_with_relationships'){
      return { ok:false, reason:`link "${proposal.entity}" combines unrelated foreign-key relationships on "${table.name}"; one binary link is required per foreign key` };
    }
    if (plan.type==='relationship'){
      return { ok:false, reason:`link "${proposal.entity}" does not contain the complete set of relationship roles for "${table.name}"` };
    }
    return { ok:false, reason:`table "${table.name}" has no planned foreign-key relationship for link "${proposal.entity}"` };
  }
  return { ok:true, group };
}
function hubForSourceTable(tableName, tableId){
  return state.hubs.find(h=>{
    const source = findTable(h.tableId);
    return source && (tableId ? source.id===tableId : source.name===tableName);
  }) || null;
}
function uniqueLinkEntity(base){
  let candidate = sqlNamePart(base);
  let n = 2;
  while (state.links.some(l=>l.entity===candidate)) candidate = `${sqlNamePart(base)}_${n++}`;
  return candidate;
}
function hubMatchesPlan(hub, plan){
  return !!(hub && plan && hub.tableId===plan.table.id && sameColumnList(hubKeyColIds(hub), plan.ownKeyColumns.map(c=>c.id)));
}
function hubForPlan(plan){ return state.hubs.find(h=>hubMatchesPlan(h,plan)) || null; }

// Deterministically completes the structural part of a proposal. AI may
// suggest names and satellite grouping, but it may not omit an entity Hub,
// collapse self-references, or merge independent FKs into one Link.
function ensurePlannedVaultStructure(){
  const skipped = [];
  let hubsAdded = 0, linksAdded = 0;
  const plans = includedTables().map(t=>tableRelationshipPlan(t));

  plans.forEach(plan=>{
    if (!plan.ownKeyColumns.length || plan.type==='relationship') return;
    if (hubForPlan(plan)) return;
    const r = addHubProgrammatic(plan.ownEntity, plan.table, plan.ownKeyColumns.map(c=>c.name), true);
    if (r.ok) hubsAdded++; else if (!/already exists/.test(r.reason)) skipped.push(r.reason);
  });

  plans.forEach(plan=>{
    plan.groups.forEach(group=>{
      if (findLinkForRelationshipGroup(plan.table, group)) return;
      const pairs = [];
      for (const pair of group.pairs){
        const hub = pair.own ? hubForPlan(plan) : hubForSourceTable(pair.refTable, pair.refTableId);
        if (!hub){
          skipped.push(`"${plan.table.name}": no Hub is available for relationship role "${pair.role}"`);
          return;
        }
        pairs.push({ hub:hub.entity, column:pair.column, columns:pair.columns||[pair.column], role:pair.role });
      }
      const baseEntity = group.kind==='relationship_table'
        ? group.entity
        : binaryRelationshipEntity(pairs[0].hub, pairs[1].hub, group.foreignKey && group.foreignKey.role);
      const r = addLinkProgrammatic(uniqueLinkEntity(baseEntity), plan.table, pairs);
      if (r.ok) linksAdded++; else skipped.push(r.reason);
    });
  });
  return { hubsAdded, linksAdded, skipped };
}

function repairJunctionDerivations(table){
  const plan=table&&tableRelationshipPlan(table);
  if(!table||!plan||plan.type!=='relationship') return 0;
  const expected=plan.groups[0].pairs.map(p=>({entity:p.hub,role:p.role||p.hub,columns:(p.columns||[p.column]).filter(Boolean)}));
  const repaired=[];
  let changes=0;
  (table.derivations||[]).forEach(d=>{
    const names=derivationSourceColumns(d);
    let match=expected.find(x=>sameColumnList(x.columns,names));
    if(!match&&names.length===1) match=expected.find(x=>x.columns.includes(names[0]));
    if(match){
      if(match.columns.length>1&&names.length===1){ changes++; return; }
      const existing=repaired.find(x=>x.entity===match.entity&&(x.role||x.entity)===match.role&&sameColumnList(derivationSourceColumns(x),match.columns));
      if(!existing) repaired.push(Object.assign({},d,{entity:match.entity,role:match.role,column:match.columns[0],columns:match.columns.length>1?match.columns.slice():undefined,kind:'hash'}));
      if(d.entity!==match.entity||(d.role||'')!==match.role||d.kind!=='hash'||!sameColumnList(names,match.columns)||existing) changes++;
      return;
    }
    if(d.kind==='bk'){changes++;return;}
    if(d.kind==='both'){repaired.push(Object.assign({},d,{kind:'hash'}));changes++;return;}
    repaired.push(d);
  });
  // Ensure every relationship role has exactly one hash derivation.
  expected.forEach(x=>{
    if(!repaired.some(d=>d.entity===x.entity&&(d.role||d.entity)===x.role&&sameColumnList(derivationSourceColumns(d),x.columns)&&(d.kind==='hash'||d.kind==='both'))){
      repaired.push({id:uid('drv'),entity:x.entity,role:x.role,column:x.columns[0],columns:x.columns.length>1?x.columns.slice():undefined,kind:'hash'});
      changes++;
    }
  });
  if(changes) table.derivations=repaired;
  return changes;
}
function repairAllJunctionDerivations(){
  return (state.tables||[]).reduce((sum,t)=>sum+repairJunctionDerivations(t), 0);
}

function repairForeignKeyDerivations(table){
  if(!table||!(table.derivations||[]).length) return 0;
  const repaired=[];
  let changes=0;
  (table.derivations||[]).forEach(d=>{
    const normalized=normaliseDerivationRecord(table,d);
    const spec=derivationCanonicalSpec(table,normalized);
    const sameIdentity=repaired.find(x=>sameDerivationIdentity(table,x,spec));
    // Two rows over the same source key that emit the same physical hash are
    // always duplicates, even when the source import did not include FK
    // constraints. Keep distinct aliases (valid alternate relationship roles),
    // but merge exact physical duplicates immediately.
    const samePhysical=!sameIdentity&&(spec.kind==='hash'||spec.kind==='both')
      ? repaired.find(x=>{
          const current=derivationCanonicalSpec(table,x);
          return sameColumnList(current.columns,spec.columns)&&
            (current.kind==='hash'||current.kind==='both')&&
            current.targetAlias===spec.targetAlias;
        })
      : null;
    const existing=sameIdentity||samePhysical;
    if(existing){
      const merged=mergeDerivationKind(existing.kind,normalized.kind);
      const existingScore=derivationPreferenceScore(table,existing);
      const normalizedScore=derivationPreferenceScore(table,normalized);
      if(normalizedScore>existingScore){
        existing.entity=normalized.entity;
        existing.role=normalized.role;
        existing.column=normalized.column;
        if(normalized.columns&&normalized.columns.length>1) existing.columns=normalized.columns.slice();
        else delete existing.columns;
      }
      existing.kind=merged;
      changes++;
      return;
    }
    if(JSON.stringify([d.entity,d.role||'',derivationSourceColumns(d),d.kind])!==JSON.stringify([normalized.entity,normalized.role||'',derivationSourceColumns(normalized),normalized.kind])) changes++;
    repaired.push(normalized);
  });
  if(changes) table.derivations=repaired;
  return changes;
}
function repairAllForeignKeyDerivations(){
  return (state.tables||[]).reduce((sum,t)=>sum+repairForeignKeyDerivations(t),0);
}

function normalizeAiStagingDerivation(table, proposal){
  const names=(Array.isArray(proposal.columns)&&proposal.columns.length?proposal.columns:[proposal.column]).filter(Boolean);
  const cols=names.map(name=>stagedColumns(table).find(c=>c.name===name));
  if(!names.length||cols.some(c=>!c)) return {ok:false,reason:`"${table.name}": source key column(s) "${names.join(', ')}" not found`};
  const requestedKind=['hash','bk','both'].includes(proposal.kind)?proposal.kind:'hash';
  const proposedEntity=(proposal.targetEntity||proposal.entity) ? sqlNamePart(proposal.targetEntity||proposal.entity) : '';
  const proposedRole=proposal.role ? sqlNamePart(proposal.role) : '';
  const plan=tableRelationshipPlan(table);
  const relationshipPair=plan.groups.flatMap(g=>g.pairs).find(p=>sameColumnList((p.columns||[p.column]),names));
  const fk=plan.foreignKeyGroups.find(g=>sameColumnList(g.columns,names));

  if(plan.type==='relationship'){
    if(!relationshipPair) return {ok:false,reason:`"${table.name}": "${names.join(' + ')}" is not a complete relationship key`};
    const normalized={columns:names,column:names[0],entity:relationshipPair.hub,role:relationshipPair.role,kind:'hash'};
    const changed=requestedKind!=='hash'||proposedEntity!==normalized.entity||proposedRole!==normalized.role;
    const adjusted=changed?`"${table.name}"."${names.join(' + ')}" used the source relationship target ${normalized.entity} with role ${normalized.role}`:'';
    return {ok:true,value:normalized,adjusted};
  }

  const ownNames=plan.ownKeyColumns.map(c=>c.name);
  if(sameColumnList(names,ownNames)){
    const normalized={columns:names,column:names[0],entity:plan.ownEntity,role:plan.ownEntity,kind:requestedKind==='hash'?'hash':'both'};
    const changes=[];
    if(requestedKind==='bk') changes.push('business keys also require their hash, so kind was changed to both');
    if(proposedEntity&&proposedEntity!==normalized.entity) changes.push(`target entity was changed to ${normalized.entity}`);
    if(proposedRole&&proposedRole!==normalized.role) changes.push(`role was changed to ${normalized.role}`);
    return {ok:true,value:normalized,adjusted:changes.length?`"${table.name}"."${names.join(' + ')}": ${changes.join('; ')}`:''};
  }
  if(ownNames.length>1&&names.some(name=>ownNames.includes(name))){
    return {ok:false,reason:`"${table.name}": composite business key columns must be supplied together in source order (${ownNames.join(' + ')})`};
  }

  if(fk){
    const normalized={columns:names,column:names[0],entity:fk.refEntity,role:fk.role,kind:'hash'};
    const changes=[];
    if(requestedKind!=='hash') changes.push('foreign keys are hash-only');
    if(proposedEntity&&proposedEntity!==fk.refEntity) changes.push(`target Hub "${proposedEntity}" was replaced by the source relationship target "${fk.refEntity}"`);
    if(proposedRole&&proposedRole!==fk.role) changes.push(`role "${proposedRole}" was replaced by the source role "${fk.role}"`);
    return {ok:true,value:normalized,adjusted:changes.length?`"${table.name}"."${names.join(' + ')}": ${changes.join('; ')}`:''};
  }

  if(names.length===1){
    const entity=proposedEntity||plan.ownEntity;
    const role=proposedRole||entity;
    return {ok:true,value:{columns:names,column:names[0],entity,role,kind:requestedKind},adjusted:''};
  }
  return {ok:false,reason:`"${table.name}": "${names.join(' + ')}" is not a recognised complete business or foreign key`};
}

function ensureStagingKeyCoverage(){
  let derivations=0;
  const skipped=[];
  includedTables().map(t=>tableRelationshipPlan(t)).forEach(plan=>{
    repairForeignKeyDerivations(plan.table);
    if(plan.type!=='relationship'&&plan.ownKeyColumns.length){
      const ownNames=plan.ownKeyColumns.map(c=>c.name);
      if(ownNames.length>1){
        const beforeCount=plan.table.derivations.length;
        plan.table.derivations=plan.table.derivations.filter(d=>{
          const names=derivationSourceColumns(d);
          const partial=names.some(name=>ownNames.includes(name))&&!sameColumnList(names,ownNames);
          return !(partial&&(d.kind==='bk'||d.kind==='both')&&d.entity===plan.ownEntity);
        });
        derivations += beforeCount-plan.table.derivations.length;
      }
      const before=JSON.stringify(plan.table.derivations.map(d=>[d.entity,derivationSourceColumns(d),d.kind]));
      ensureKeyDerivation(plan.table,plan.ownEntity,ownNames,'both');
      if(before!==JSON.stringify(plan.table.derivations.map(d=>[d.entity,derivationSourceColumns(d),d.kind]))) derivations++;
    }
    plan.groups.forEach(group=>group.pairs.forEach(pair=>{
      if(pair.own) return;
      const names=(pair.columns||[pair.column]).filter(Boolean);
      const before=JSON.stringify(plan.table.derivations.map(d=>[d.entity,derivationSourceColumns(d),d.kind]));
      ensureKeyDerivation(plan.table,pair.hub,names,'hash',pair.role||pair.hub);
      if(before!==JSON.stringify(plan.table.derivations.map(d=>[d.entity,derivationSourceColumns(d),d.kind]))) derivations++;
    }));
  });
  return {derivations,skipped};
}

// Staging-page suggestion is deliberately scoped to staging only. It adds
// key derivations (and, when the feature is enabled, incremental columns)
// but never creates or changes hubs, links, or satellites.
function suggestStagingFromKeys(){
  const completed=ensureStagingKeyCoverage();
  let incremental=0;
  if(FEATURE_INCREMENTAL) includedTables().forEach(t=>{
    if(t.incrementCol) return;
    const col=detectedIncrementalColumn(t);
    if(col){configureIncrementalColumn(t,col.name);incremental++;}
  });
  return {derivations:completed.derivations,incremental,skipped:completed.skipped,usedDeclaredFks:((state.sourceMeta&&state.sourceMeta.foreignKeys)||[]).length>0};
}

// Builds the proposal AND applies it via the same programmatic builders the
// AI path uses (so duplicate/consistency guards all apply). Returns counts +
// skipped reasons. Call pushUndo() before this if you want it reversible.
function suggestModelFromKeys(){
  pruneDownstreamModel({ dropExcluded:true });
  const skipped = [];
  let hubs=0, links=0, hubSats=0, linkSats=0, incremental=0, satAttrsAdded=0;
  const tables = includedTables();
  const fks = effectiveForeignKeys();
  const plans = tables.map(t=>tableRelationshipPlan(t, fks));

  // --- Hubs --- relationship tables do not become Hubs. Ordinary entity
  // tables keep their own Hub even when they also carry several independent
  // foreign-key relationships.
  plans.forEach(plan=>{
    if (plan.type==='relationship'||!plan.ownKeyColumns.length) return;
    const r=addHubProgrammatic(plan.ownEntity,plan.table,plan.ownKeyColumns.map(c=>c.name),true);
    if(r.ok) hubs++; else if(!/already exists/.test(r.reason)) skipped.push(r.reason);
  });

  // --- Links --- each planned group is independent. A relationship table
  // produces one multi-role Link; an entity table produces one binary Link
  // per FK. Self-references retain their source-column roles.
  plans.forEach(plan=>{
    plan.groups.forEach(group=>{
      if (findLinkForRelationshipGroup(plan.table, group)) return;
      const pairs = [];
      for (const pair of group.pairs){
        const hub = pair.own ? hubForPlan(plan) : hubForSourceTable(pair.refTable, pair.refTableId);
        if (!hub){ skipped.push(`"${plan.table.name}": no Hub is available for relationship role "${pair.role}"`); return; }
        pairs.push({ hub:hub.entity, column:pair.column, columns:pair.columns||[pair.column], role:pair.role });
      }
      const baseEntity = group.kind==='relationship_table'
        ? group.entity
        : binaryRelationshipEntity(pairs[0].hub, pairs[1].hub, group.foreignKey && group.foreignKey.role);
      const r = addLinkProgrammatic(uniqueLinkEntity(baseEntity), plan.table, pairs);
      if (r.ok) links++; else skipped.push(r.reason);
    });
  });

  // --- Satellites --- every selected non-key/non-FK column is carried. On a
  // relationship table it belongs to a Link Satellite; on an entity table it
  // belongs to the table's Hub Satellite. Existing default satellites are
  // extended when schema drift adds columns.
  const extendSatWithNewAttrs = (sat, t, attrs) => {
    const covered = new Set();
    state.hubSats.concat(state.linkSats)
      .filter(s=> s.tableId===t.id && ((sat.hubId && s.hubId===sat.hubId) || (sat.linkId && s.linkId===sat.linkId)))
      .forEach(s=> s.attrs.forEach(a=> covered.add(a.colId)));
    let added = 0;
    attrs.forEach(a=>{
      const col = stagedColumns(t).find(c=>c.name===a.column);
      if (!col || covered.has(col.id)) return;
      sat.attrs.push({ colId: col.id, target:targetIdentifierBase(a.target || targetColumnName(col)) });
      covered.add(col.id);
      added++;
    });
    return added;
  };

  plans.forEach(plan=>{
    const attrs = plan.attributes.map(c=>({ column:c.name, target:targetColumnName(c) }));
    if (!attrs.length) return;
    if (plan.type==='relationship'){
      if (!FEATURE_LINK_SATELLITES || !plan.groups.length) return;
      const link = findLinkForRelationshipGroup(plan.table, plan.groups[0]);
      if (!link){ skipped.push(`"${plan.table.name}": relationship attributes could not be placed because its Link is missing`); return; }
      const existing = state.linkSats.find(s=>s.linkId===link.id && s.tableId===plan.table.id && (s.concern||'')==='');
      if (existing){ satAttrsAdded += extendSatWithNewAttrs(existing, plan.table, attrs); return; }
      const r = addLinkSatProgrammatic(link.entity, '', plan.table, link.entity, attrs);
      if (r.ok) linkSats++; else skipped.push(r.reason);
      return;
    }
    const hub = hubForPlan(plan);
    if (!hub) return;
    const existing = state.hubSats.find(s=>s.hubId===hub.id && s.tableId===plan.table.id && (s.concern||'')==='');
    if (existing){ satAttrsAdded += extendSatWithNewAttrs(existing, plan.table, attrs); return; }
    const r = addHubSatProgrammatic(hub.entity, '', plan.table, hub.entity, attrs);
    if (r.ok) hubSats++; else skipped.push(r.reason);
  });

  if (FEATURE_INCREMENTAL) tables.forEach(t=>{
    if (t.incrementCol) return;
    const col = detectedIncrementalColumn(t);
    if (col){ configureIncrementalColumn(t, col.name); incremental++; }
  });

  return { hubs, links, hubSats, linkSats, incremental, satAttrsAdded, skipped, usedDeclaredFks: ((state.sourceMeta&&state.sourceMeta.foreignKeys)||[]).length>0 };
}

function runSuggestFromKeys(targetTab){
  if (includedTables().length===0){ toast('Include at least one table first.','err'); return; }
  const stagingOnly = targetTab === 'staging';
  pushUndo(stagingOnly ? 'detect staging hash keys' : 'detect vault tables');
  const summary = stagingOnly ? suggestStagingFromKeys() : suggestModelFromKeys();
  renderAll(); setActiveTabViewOnly(targetTab || 'vault');
  const src = summary.usedDeclaredFks ? 'declared foreign keys' : 'column-name conventions (no FK constraints found — run Detect Source Tables again to pick up declared FKs)';
  if (stagingOnly){
    toastUndo(`Detected hash keys from ${src}: ${summary.derivations} key derivation(s)${FEATURE_INCREMENTAL?`, ${summary.incremental} incremental column(s)`:''}. Vault hubs, links, and satellites were not changed.`);
  } else {
    const extended = summary.satAttrsAdded ? `, ${summary.satAttrsAdded} new attribute(s) added to existing satellites` : '';
    toastUndo(`Detected Vault tables from ${src}: ${summary.hubs} hub(s), ${summary.links} link(s), ${summary.hubSats + summary.linkSats} satellite(s)${FEATURE_INCREMENTAL?`, ${summary.incremental} incremental column(s)`:''}${extended}.`);
  }
  if (summary.skipped.length) console.info('Suggest-from-keys skipped:', summary.skipped);
}
