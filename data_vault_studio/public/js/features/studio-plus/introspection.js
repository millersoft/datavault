/* Studio Plus — query helper, schema introspection and schema summaries for AI prompts. */
async function spQuery(sql){
  await ensureLocalServerReachable();
  const resp = await localFetch(`/api/query`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({...spConnectionPayload(),sql}),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Query failed.');
  return data.rows || [];
}

let spLastSchemaSignature = '';
function spSchemaSignature(){
  return [spConn.dialect,spConn.host,spConn.port,spConn.database,spConn.schema].map(v=>String(v||'').toLowerCase()).join('|');
}
async function spIntrospectSchema(options={}){
  if(!options.preserveDraft){
    spSchemaStatus='loading';spConnectionSectionOpen=true;
    const btn=document.getElementById('btn-sp-introspect');if(btn)btn.textContent='Introspecting…';
    if(options.auto&&typeof appMode!=='undefined'&&appMode==='studioplus')renderAll();
  }
  try{
    const health=await localFetch('/api/health').catch(()=>null);
    if(!health||!health.ok)throw new Error(`Local server not reachable at ${localServerUrl} — is it running?`);
    const response=await localFetch('/api/introspect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(spIntrospectionPayload())});
    const data=await response.json();if(!data.ok)throw new Error(data.error||'Schema introspection failed.');
    const candidates=(data.tables||[]).filter(t=>!/_err$/i.test(t.name));
    if(!candidates.length)throw new Error(`Connected, but found no non-_err tables or views in ${spConn.schema||spConn.database}.`);
    // Keep the Raw Vault schema and the business layer schema separate. Raw
    // Vault objects are valid Business Model inputs; managed Business Models
    // themselves are not silently fed back into AI planning.
    spSchemaTables=candidates.map(t=>({name:t.name,objectType:t.objectType||'table',columns:t.columns||[],rowCount:t.approxRows==null?null:Number(t.approxRows),schema:spConn.schema||spConn.database}));
    spExcludedEmptyTables=spSchemaTables.filter(t=>t.rowCount===0&&t.objectType!=='view').map(t=>t.name);

    try{ await spEnsureBusinessSchemaOnInfer(); }
    catch(schemaErr){
      spBusinessSchemaTables=[];spBusinessSchemaExists=false;spBusinessSchemaStatus='error';spBusinessSchemaError=schemaErr.message;
    }

    const rawVisible=new Map(spSchemaTables.map(t=>[String(t.name).toLowerCase(),t.objectType||'table']));
    const businessVisible=new Map(spBusinessSchemaTables.map(t=>[String(t.name).toLowerCase(),t.objectType||'table']));
    spManagedViews().filter(v=>!spIsTechnicalViewName(v.name)).forEach(v=>{
      const deployedName=String(v.deployedName||v.name).toLowerCase();
      const expected=(v.deployedMaterialization||v.materialization||'view')==='table'?'table':'view';
      const businessType=businessVisible.get(deployedName),rawType=rawVisible.get(deployedName);
      if(!v.deployedAt)return;
      if(businessType===expected){
        v.deployedSchema=spBusinessSchemaName();
        if(v.status==='error'&&/previously deployed|not found|schema/i.test(String(v.lastError||''))){v.status=(v.deployedName&&v.deployedName!==v.name)?'modified':'deployed';v.lastError='';}
      }else if(rawType===expected){
        // Existing projects may have Business Models in data_vault from older
        // Studio Plus builds. Keep them usable but flag them for migration.
        v.deployedSchema=spConn.schema||spConn.database;v.status='modified';
        v.lastError=`Currently deployed in ${v.deployedSchema}. Redeploy to move this Business Model into ${spBusinessSchemaName()}.`;
      }else{
        v.status='error';v.lastError=`The previously deployed ${expected} was not found in ${spBusinessSchemaName()}${rawType===expected?' or the legacy Raw Vault schema':''}.`;
      }
    });
    spManagedBvObjects().forEach(v=>{
      const deployedName=String(v.deployedName||v.name).toLowerCase();
      const businessType=businessVisible.get(deployedName),rawType=rawVisible.get(deployedName);
      if(!v.deployedAt)return;
      if(businessType==='table'){
        v.deployedSchema=spBusinessSchemaName();
        if(v.status==='error'&&/previously deployed|not found|schema/i.test(String(v.lastError||''))){v.status=(v.deployedName&&v.deployedName!==v.name)?'modified':'deployed';v.lastError='';}
      }else if(rawType==='table'){
        v.deployedSchema=spConn.schema||spConn.database;v.status='modified';
        v.lastError=`Currently deployed in ${v.deployedSchema}. Redeploy to move this Business Vault table into ${spBusinessSchemaName()}.`;
      }else{
        v.status='error';v.lastError=`The previously deployed Business Vault table was not found in ${spBusinessSchemaName()} or the legacy Raw Vault schema.`;
      }
    });
    const allowed=new Set(spDefaultReportingSourceNames());
    const kept=[...spReportingSources].filter(n=>allowed.has(n));
    spReportingSources=new Set(kept.length?kept:[...allowed]);
    spSchemaStatus='ok';spSchemaError='';if(!options.preserveDraft)spConnectionSectionOpen=false;
    // Deploys and deletes refresh the schema quietly; they must not discard the
    // AI plan or an unsaved report. Only a different target/schema resets them.
    const signature=spSchemaSignature();
    const targetChanged=signature!==spLastSchemaSignature;
    spLastSchemaSignature=signature;
    if(!options.preserveDraft&&targetChanged){
      spResetReportPlan();
      spAiRecommendStatus=null;spAiRecommendError='';spAiRecommendations=null;spPersistPlan();
    }
    if(!options.quiet){
      const businessText=spBusinessSchemaStatus==='ready'?` ${spBusinessSchemaName()} is ready with ${spBusinessSchemaTables.length} managed object(s).`:spBusinessSchemaStatus==='missing'?` ${SP_BUSINESS_SCHEMA} is not present.`:spBusinessSchemaStatus==='error'?` ${SP_BUSINESS_SCHEMA} could not be checked.`:'';
      toast(`Introspected ${spSchemaTables.length} Raw Vault object(s) from ${spSqlDialectLabel()}.${businessText}`,'ok');
    }
  }catch(err){
    spSchemaStatus='error';spSchemaError=err.message;spConnectionSectionOpen=true;spSchemaTables=[];spBusinessSchemaTables=[];spExcludedEmptyTables=[];spReportingSources=new Set();
    if(!options.quiet)toast('Could not introspect the schema — see details below.','err');
  }
  renderAll();
}

function spSchemaSummaryText(){
  // Column lists on satellites can be long — cap per-table to keep the
  // prompt a reasonable size without losing the shape of the schema.
  // Types are included (not just names) so the model knows, for example,
  // that a numeric-looking column is actually stored as character varying
  // and needs an explicit cast before SUM/AVG — this is a real, recurring
  // vault design quirk here, not a hypothetical.
  return spSelectedSchemaTables().map(t=>{
    const cols = t.columns.map(c=>`${c.name}:${c.type}`);
    const shown = cols.length > 25 ? cols.slice(0,25).concat(`…(+${cols.length-25} more)`) : cols;
    const managed=spManagedViews().find(v=>v.name===t.name);
    const schema=(managed&&managed.deployedSchema)||t.schema||spBusinessSchemaName();
    return `${t.name}[qualified:${spQualifiedTableInSchema(t.name,schema)}; rows:${t.rowCount==null?'unknown':t.rowCount}](${shown.join(', ')})`;
  }).join('\n');
}

// Derives the actual join graph from the introspected schema, instead of
// leaving the model to reverse-engineer it from table/column naming
// conventions alone — which is exactly where the recurring "read a column
// off the wrong table's alias" bugs have come from. Fully domain-generic:
// this only ever looks at which column names are literally shared between
// tables, never at what any of it means, so it works identically whether
// this vault is retail, CRM, financial, or anything else.
//
// Every hub table's own hash key is named exactly `<hub_table_name>_id` by
// this framework's convention, and any other table that also carries that
// exact column name is joinable to that hub through it — a link joins two
// (or more) hubs this way, a satellite joins exactly one. Generic
// housekeeping columns that happen to appear on nearly every table
// (tenant_id, load_dts, record_source_id) are deliberately excluded here
// since "shares a column" isn't the same thing as "is a join key" — only
// columns matching an actual hub table's own key are treated as one.
function spComputeJoinMap(){
  const scopedTables = spSelectedSchemaTables();
  const hubTables = scopedTables.filter(t=>/^hub_/i.test(t.name));
  const lines = [];
  hubTables.forEach(hub=>{
    const keyCol = `${hub.name}_id`;
    if (!hub.columns.some(c=>c.name===keyCol)) return; // sanity check — skip if this hub doesn't even have its own expected key column
    scopedTables.forEach(t=>{
      if (t.name===hub.name) return;
      if (t.columns.some(c=>c.name===keyCol)) lines.push(`${t.name} joins to ${hub.name} via ${keyCol}`);
    });
  });
  return lines.join('\n');
}

function spSchemaSummaryWithJoinsText(){
  const joinMap = spComputeJoinMap();
  return spSchemaSummaryText() + (joinMap
    ? `\n\nKnown joins, derived directly from shared hash-key columns above (this is the complete, authoritative join list — every valid join path is in it; do not join two tables on any column not listed here, and do not invent a join that isn't in this list):\n${joinMap}`
    : '');
}

// Studio Plus routes through the same provider-agnostic helper as the
// Designer's AI Assist — OpenAI, Anthropic, or a custom endpoint.
async function spCallOpenAI(rules, userMsg, temperature){
  return aiChat(rules, userMsg, temperature);
}
