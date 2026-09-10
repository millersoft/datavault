async function fetchIntrospection(profileColumns=false){
  const v = state.vault;
  const effectiveSchema = v.dialect==='mysql' ? v.srcDatabase : v.sourceSchema;
  // The bundled demo intentionally keeps its MySQL password server-side.
  // MySQL is now Pack-backed, but its Pack body must not replace the fixed
  // packaged credential reference used by demo-mode endpoints.
  const usePackBody=!demoSourceActive();
  const packBody=usePackBody ? databasePackConnectionBody('source') : null;
  const body=confirmImportedConnectionTarget(packBody || sourceConnectionPayload());
  // Database Packs own their namespace model. Do not overwrite it with the
  // PostgreSQL-oriented sourceSchema state (normally "public"). When a pack
  // has no explicit catalog/schema, the JDBC bridge scopes metadata to the
  // catalog/schema of the connection opened by the pack URL.
  if(!packBody){ body.schema=effectiveSchema; body.catalog=v.sourceCatalog||body.catalog||''; }
  body.profileColumns=profileColumns;
  const resp = await localFetch(`/api/introspect`, {
    method: 'POST', headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Source table detection failed.');
  return data;
}

// Store the FK / row-count extras that ride along with introspection.
function captureSourceMeta(data){
  if (!state.sourceMeta) state.sourceMeta = { foreignKeys: [], approxRows: {}, relationshipSuggestions: [], hopCapabilities: null };
  if (!state.sourceMeta.relationshipSuggestions) state.sourceMeta.relationshipSuggestions=[];
  if (data.sourceCapabilities && typeof data.sourceCapabilities==='object'){
    const existing=state.sourceMeta.hopCapabilities;
    // Do not downgrade a driver-wide JDBC type-info profile to the narrower
    // evidence from whichever tables happened to be introspected.
    if(!(existing&&existing.basis==='jdbc-type-info'&&data.sourceCapabilities.basis!=='jdbc-type-info')){
      state.sourceMeta.hopCapabilities={...data.sourceCapabilities};
    }
  }
  if (Array.isArray(data.foreignKeys)) {
    const preserved=(state.sourceMeta.foreignKeys||[]).filter(f=>['manual','ai'].includes(f.provenance));
    const incoming=data.foreignKeys.map(f=>({...f,provenance:f.provenance||'declared'}));
    const key=f=>[f.table,f.column,f.refTable,f.refColumn].map(x=>String(x||'').toLowerCase()).join('|');
    const seen=new Set(incoming.map(key));
    state.sourceMeta.foreignKeys=incoming.concat(preserved.filter(f=>!seen.has(key(f))));
  }
  const counts = {};
  (data.tables||[]).forEach(t=>{ if (t.approxRows!=null) counts[t.name] = t.approxRows; });
  state.sourceMeta.approxRows = counts;
}

function profileFromIntrospection(column){
  const p = column && column.profile;
  if (!p || typeof p!=='object') return null;
  return {
    totalRows:Number(p.totalRows||0),
    distinctValues:p.distinctValues==null ? null : Number(p.distinctValues||0),
    nullValues:Number(p.nullValues||0),
    blankValues:Number(p.blankValues||0),
    profiledAt:new Date().toISOString(),
    source:p.source||'infer-schema',
  };
}

function applyManualTableProfiles(table, profiles){
  if (!table || !Array.isArray(profiles)) return 0;
  let applied = 0;
  profiles.forEach(p=>{
    const col = (table.columns||[]).find(c=>c.name===p.column);
    if (!col) return;
    col.profile = {
      totalRows:Number(p.totalRows||0),
      distinctValues:Number(p.distinctValues||0),
      nullValues:Number(p.nullValues||0),
      blankValues:Number(p.blankValues||0),
      profiledAt:new Date().toISOString(),
      source:'manual',
    };
    applied++;
  });
  return applied;
}

async function introspectDatabase(){
  const v = state.vault;
  if (!['postgresql','mysql'].includes(v.dialect) && !isDatabasePackDialect(v.dialect)){ toast('Install a Database Pack for this source before running Infer Schema.','err'); return; }
  // MySQL has no separate schema layer — "schema" there just means the
  // database itself. Compute this directly rather than trusting
  // v.sourceSchema, in case someone jumps straight to introspecting
  // without running Test & Connect first (which is what normally keeps
  // the two in sync).
  const effectiveSchema = v.dialect==='mysql' ? v.srcDatabase : v.sourceSchema;
  const btn = document.getElementById('btn-introspect');
  if (btn){ btn.disabled = true; btn.textContent = 'Detecting Source Tables…'; }
  try {
    const data = await fetchIntrospection(true);
    const invalidTableName=(data.tables||[]).map(t=>pdiMetaLengthIssue('sourceTableName',t.name,`Source table "${t.name}" name`)).find(Boolean);
    if(invalidTableName) throw new Error(`Source schema cannot be imported into PDI metadata: ${invalidTableName}`);
    captureSourceMeta(data);
    let added = 0, updated = 0, viewsFound = 0, viewsAutoExcluded = 0, incrementalDetected = 0;
    data.tables.forEach(rt=>{
      const objectType = normalizeSourceObjectType(rt.objectType);
      if (objectType==='view') viewsFound++;
      const existing = state.tables.find(t=>t.name===rt.name);
      if (existing){
        // Older saved projects predate object types and may have reporting
        // views included only because introspection treated them as tables.
        // Migrate those safely, while preserving any view that already has
        // explicit Vault objects (evidence that it was intentionally used).
        if (applyDetectedObjectType(existing, objectType)) viewsAutoExcluded++;
        // Merge by column NAME rather than replacing wholesale — hubs
        // store a column ID (pkColId) that must keep resolving after a
        // refresh, so a column that still exists by name keeps its
        // original id and only has its type/nullable/pk fields updated.
        // Only genuinely new source columns get a freshly-generated id;
        // columns removed from the source are left in place rather than
        // deleted, since deleting could orphan a hub/derivation that
        // still references them — safer to let the person remove those
        // themselves if they actually want to.
        rt.columns.forEach(rc=>{
          const existingCol = existing.columns.find(c=>c.name===rc.name);
          if (existingCol){
            existingCol.type = rc.type;
            existingCol.nullable = rc.pk ? false : rc.nullable;
            existingCol.pk = rc.pk;
            if(rc.nativeType!=null) existingCol.nativeType=rc.nativeType;
            if(rc.jdbcType!=null) existingCol.jdbcType=rc.jdbcType;
            if(rc.semanticType!=null) existingCol.semanticType=rc.semanticType;
            existingCol.typeReviewRequired=!!rc.typeReviewRequired;
            // Infer Schema automatically refreshes profiles for columns that
            // can produce a staging NOT NULL constraint. Clear a stale profile
            // when that live scan could not be completed so old counts cannot
            // silently drive new DDL.
            if (rc.pk || rc.nullable===false) existingCol.profile = profileFromIntrospection(rc);
          } else {
            existing.columns.push(Object.assign(newColumn(rc.name, rc.type), {
              nullable: rc.pk ? false : rc.nullable,
              pk: rc.pk,
              profile: profileFromIntrospection(rc),
              nativeType:rc.nativeType||'', jdbcType:rc.jdbcType||'', semanticType:rc.semanticType||'', typeReviewRequired:!!rc.typeReviewRequired,
            }));
          }
        });
        updated++;
      } else {
        const t = newTable(rt.name);
        t.objectType = objectType;
        t.included = objectType!=='view';
        if (objectType==='view') viewsAutoExcluded++;
        t.columns = rt.columns.map(c=> Object.assign(newColumn(c.name, c.type), {
          nullable: c.pk ? false : c.nullable,
          pk: c.pk,
          profile: profileFromIntrospection(c),
          nativeType:c.nativeType||'', jdbcType:c.jdbcType||'', semanticType:c.semanticType||'', typeReviewRequired:!!c.typeReviewRequired,
        }));
        state.tables.push(t);
        added++;
      }
    });
    if (FEATURE_INCREMENTAL){
      data.tables.forEach(rt=>{
        const table = state.tables.find(t=>t.name===rt.name);
        if (table && table.included!==false && autoConfigureIncrementalColumn(table)) incrementalDetected++;
      });
    }
    if (viewsAutoExcluded) pruneDownstreamModel({ dropExcluded:true });
    const declaredCount=(state.sourceMeta.foreignKeys||[]).filter(f=>f.provenance==='declared').length;
    // Keep source FK metadata in the same model used by the existing Tables /
    // Staging workflow. Database Packs must not create a second relationship
    // editor or silently apply AI relationships during introspection.
    state.sourceMeta.relationshipSuggestions=[];
    renderAll(); setActiveTabViewOnly('tables');
    const location = isDatabasePackDialect(v.dialect)
      ? [data.catalog||v.srcDatabase, data.schema].filter(Boolean).join('.')
      : (v.dialect==='mysql' ? v.srcDatabase : `${v.srcDatabase}.${effectiveSchema}`);
    const tableCount = data.tables.length - viewsFound;
    const viewSummary = viewsFound ? ` and ${viewsFound} view(s)${viewsAutoExcluded?` (${viewsAutoExcluded} left unselected)`:''}` : '';
    const ps = data.profileSummary || {};
    const warningText = Array.isArray(ps.warnings) && ps.warnings.length
      ? ` Some source checks could not be completed; source nullability was retained.`
      : '';
    const infoText = Array.isArray(ps.infos) && ps.infos.length
      ? ` ${String(ps.infos[0])}`
      : '';
    const relationshipText=declaredCount?` ${declaredCount} declared FK relationship(s) found.`:` No declared FKs found; existing key detection and AI Assist remain available in the normal modelling workflow.`;
    const toastKind=ps.warnings&&ps.warnings.length?'err':(ps.infos&&ps.infos.length?'info':'ok');
    const incrementalText = FEATURE_INCREMENTAL && incrementalDetected
      ? ` Suggested incremental column for ${incrementalDetected} table(s); review them on Tables before deployment.`
      : '';
    toast(`Detected ${tableCount} source table(s)${viewSummary} from ${location} — ${added} added, ${updated} updated.${relationshipText}${incrementalText}${warningText}${infoText}`, toastKind);
  } catch(err){
    toast('Source table detection failed: ' + err.message, 'err');
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = 'Detect Source Tables'; }
  }
}
