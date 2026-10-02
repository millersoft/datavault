/* =========================================================================
   DATA VAULT STUDIO PLUS — optional Business Vault structures + business models + reporting

   v1 product split:
   - Raw Vault physical objects (Hub/Link/Sat/Link Sat) are deployed through normal Studio deployment.
   - Studio Plus can optionally create/deploy PIT and Bridge acceleration tables after Raw Vault deployment.
   - Studio Plus creates and manages CURATED DATASETS over the deployed Vault and optional helpers.
   - AI may PROPOSE a dataset definition, but never saves or deploys it until the
     user explicitly accepts the proposal, reviews it, saves it, and deploys it.
   - Reporting is scoped only to managed deployed business models selected by the
     user. It does not infer reporting scope from arbitrary database objects.
   ========================================================================= */

function spEnsureBusinessViews(){
  if(!Array.isArray(state.businessViews)) state.businessViews=[];
  return state.businessViews;
}
function spManagedViews(){ return spEnsureBusinessViews(); }
function spEnsureReports(){
  if(!Array.isArray(state.reports)) state.reports=[];
  return state.reports;
}
function spManagedReports(){ return spEnsureReports(); }
function spFindReport(id){ return spManagedReports().find(r=>r.id===id); }
function spEnsureBusinessVaultObjects(){
  if(!Array.isArray(state.businessVaultObjects)) state.businessVaultObjects=[];
  return state.businessVaultObjects;
}
function spManagedBvObjects(){ return spEnsureBusinessVaultObjects(); }
function spFindManagedBvObject(id){ return spManagedBvObjects().find(v=>v.id===id); }
let spBvSectionOpen=false;
let spBvBuilderOpen=false; // the structure editor stays collapsed until the user starts or opens one
let spBvDraft={id:null,type:'pit',name:'',label:'',description:'',parentHub:'',satellites:[],links:[]};
let spBvPreview=null;
let spBvDeployingId=null;
let spBvDeployAllBusy=false;
let spDeployAllBusy=false;
function spResetBvDraft(type='pit'){
  spBvDraft={id:null,type,name:'',label:'',description:'',parentHub:'',satellites:[],links:[]};
  spBvPreview=null;
}
function spBvHubTables(){ return spSchemaTables.filter(t=>(t.objectType||'table')==='table' && /^hub_/i.test(t.name)); }
function spBvPitParentTables(){ return spSchemaTables.filter(t=>(t.objectType||'table')==='table' && /^(?:hub_|link_)/i.test(t.name)); }
function spBvSatelliteTables(){ return spSchemaTables.filter(t=>(t.objectType||'table')==='table' && /^(?:sat_|lsat_)/i.test(t.name)); }
function spBvLinkTables(){ return spSchemaTables.filter(t=>(t.objectType||'table')==='table' && /^link_/i.test(t.name)); }
function spBvColumnNames(t){ return new Set((t&&t.columns||[]).map(c=>c.name)); }
function spBvParentKeyForTable(t){
  if(!t)return '';
  const exact=`${t.name}_id`;
  const names=spBvColumnNames(t);
  if(names.has(exact))return exact;
  const found=(t.columns||[]).find(c=>/^hub_.+_id$/i.test(c.name));
  return found?found.name:'';
}
function spBvLinkHubKeys(t){ return (t&&t.columns||[]).map(c=>c.name).filter(n=>/^hub_.+_id$/i.test(n)); }
function spBvCompatibleSatellites(hubName){
  const hub=spSchemaTables.find(t=>t.name===hubName);const key=spBvParentKeyForTable(hub);if(!key)return [];
  return spBvSatelliteTables().filter(t=>{const names=spBvColumnNames(t);return names.has(key)&&names.has('load_dts');});
}
function spBvSharedHubKeys(a,b){
  const right=new Set(spBvLinkHubKeys(b));return spBvLinkHubKeys(a).filter(k=>right.has(k));
}
function spBvTenantJoin(leftAlias,rightAlias,leftTable,rightTable){
  const l=spBvColumnNames(leftTable),r=spBvColumnNames(rightTable);
  return l.has('tenant_id')&&r.has('tenant_id')?` AND ${rightAlias}.${spQuoteIdentifier('tenant_id')} = ${leftAlias}.${spQuoteIdentifier('tenant_id')}`:'';
}
function spBuildPitSelect(def=spBvDraft){
  const hub=spSchemaTables.find(t=>t.name===def.parentHub);if(!hub)throw new Error('Choose the Hub or Link that this PIT belongs to.');
  const key=spBvParentKeyForTable(hub);if(!key)throw new Error(`${hub.name} does not expose a recognisable parent hash-key column.`);
  const sats=(def.satellites||[]).map(n=>spSchemaTables.find(t=>t.name===n)).filter(Boolean);
  if(!sats.length)throw new Error('Select at least one compatible Satellite.');
  for(const sat of sats){const names=spBvColumnNames(sat);if(!names.has(key)||!names.has('load_dts'))throw new Error(`${sat.name} is not compatible with ${hub.name}: expected ${key} and load_dts.`);}
  const hubHasTenant=spBvColumnNames(hub).has('tenant_id');
  const snapshots=sats.map((sat,i)=>{
    const alias=`s${i+1}`;const satTenant=spBvColumnNames(sat).has('tenant_id');
    const tenantSelect=hubHasTenant?`, h.${spQuoteIdentifier('tenant_id')} AS ${spQuoteIdentifier('tenant_id')}`:'';
    const tenantJoin=hubHasTenant&&satTenant?` AND ${alias}.${spQuoteIdentifier('tenant_id')} = h.${spQuoteIdentifier('tenant_id')}`:'';
    return `SELECT h.${spQuoteIdentifier(key)} AS ${spQuoteIdentifier(key)}${tenantSelect}, ${alias}.${spQuoteIdentifier('load_dts')} AS ${spQuoteIdentifier('snapshot_dts')}\n    FROM ${spQualifiedTable(hub.name)} h\n    JOIN ${spQualifiedTable(sat.name)} ${alias} ON ${alias}.${spQuoteIdentifier(key)} = h.${spQuoteIdentifier(key)}${tenantJoin}`;
  });
  const pointerCols=[];const pointerJoins=[];
  sats.forEach((sat,i)=>{
    const alias=`p${i+1}`;const names=spBvColumnNames(sat);const satTenant=names.has('tenant_id');
    const tenant=hubHasTenant&&satTenant?` AND ${alias}.${spQuoteIdentifier('tenant_id')} = p.${spQuoteIdentifier('tenant_id')}`:'';
    const base=`${alias}.${spQuoteIdentifier(key)} = p.${spQuoteIdentifier(key)}${tenant}`;
    if(names.has('load_end_dts')){
      pointerJoins.push(`LEFT JOIN ${spQualifiedTable(sat.name)} ${alias} ON ${base} AND ${alias}.${spQuoteIdentifier('load_dts')} <= p.${spQuoteIdentifier('snapshot_dts')} AND (${alias}.${spQuoteIdentifier('load_end_dts')} > p.${spQuoteIdentifier('snapshot_dts')} OR ${alias}.${spQuoteIdentifier('load_end_dts')} IS NULL)`);
      pointerCols.push(`  ${alias}.${spQuoteIdentifier('load_dts')} AS ${spQuoteIdentifier(`${sat.name}_load_dts`)}`);
    }else{
      pointerCols.push(`  (SELECT MAX(${alias}.${spQuoteIdentifier('load_dts')}) FROM ${spQualifiedTable(sat.name)} ${alias} WHERE ${base} AND ${alias}.${spQuoteIdentifier('load_dts')} <= p.${spQuoteIdentifier('snapshot_dts')}) AS ${spQuoteIdentifier(`${sat.name}_load_dts`)}`);
    }
  });
  const selectTenant=hubHasTenant?`,\n  p.${spQuoteIdentifier('tenant_id')}`:'';
  return `SELECT DISTINCT\n  p.${spQuoteIdentifier(key)}${selectTenant},\n  p.${spQuoteIdentifier('snapshot_dts')},\n${pointerCols.join(',\n')}\nFROM (\n  ${snapshots.join('\n  UNION\n  ')}\n) p${pointerJoins.length?'\n'+pointerJoins.join('\n'):''}`;
}
function spBuildBridgeSelect(def=spBvDraft){
  const links=(def.links||[]).map(n=>spSchemaTables.find(t=>t.name===n)).filter(Boolean);
  if(!links.length)throw new Error('Select at least one Link for the Bridge.');
  const ordered=[links[0]], joins=[];
  const remaining=links.slice(1);
  while(remaining.length){
    let foundIndex=-1,foundPrev=null,foundKeys=null;
    for(let i=0;i<remaining.length&&foundIndex<0;i++){
      for(let j=0;j<ordered.length;j++){
        const keys=spBvSharedHubKeys(ordered[j],remaining[i]);
        if(keys.length){foundIndex=i;foundPrev=j;foundKeys=keys;break;}
      }
    }
    if(foundIndex<0)throw new Error('The selected Links do not form one connected path. Remove disconnected Links or create a separate Bridge.');
    const next=remaining.splice(foundIndex,1)[0];
    joins.push({table:next,prevIndex:foundPrev,keys:foundKeys});ordered.push(next);
  }
  const aliases=ordered.map((_,i)=>`l${i+1}`);
  const from=`FROM ${spQualifiedTable(ordered[0].name)} ${aliases[0]}`;
  const joinSql=joins.map((j,idx)=>{
    const nextIndex=idx+1;const prevAlias=aliases[j.prevIndex],nextAlias=aliases[nextIndex];
    const conditions=j.keys.map(k=>`${nextAlias}.${spQuoteIdentifier(k)} = ${prevAlias}.${spQuoteIdentifier(k)}`);
    if(spBvColumnNames(j.table).has('tenant_id')&&spBvColumnNames(ordered[j.prevIndex]).has('tenant_id'))conditions.push(`${nextAlias}.${spQuoteIdentifier('tenant_id')} = ${prevAlias}.${spQuoteIdentifier('tenant_id')}`);
    return `JOIN ${spQualifiedTable(j.table.name)} ${nextAlias} ON ${conditions.join(' AND ')}`;
  }).join('\n');
  const selected=[];const seen=new Set();
  ordered.forEach((t,i)=>{
    const alias=aliases[i];
    (t.columns||[]).forEach(c=>{
      const n=c.name;
      if(/^(?:hub_|link_).+_id$/i.test(n) && !seen.has(n)){selected.push(`  ${alias}.${spQuoteIdentifier(n)} AS ${spQuoteIdentifier(n)}`);seen.add(n);}
    });
    if(spBvColumnNames(t).has('load_dts'))selected.push(`  ${alias}.${spQuoteIdentifier('load_dts')} AS ${spQuoteIdentifier(`${t.name}_load_dts`)}`);
  });
  if(spBvColumnNames(ordered[0]).has('tenant_id'))selected.push(`  ${aliases[0]}.${spQuoteIdentifier('tenant_id')} AS ${spQuoteIdentifier('tenant_id')}`);
  if(!selected.length)throw new Error('No Hub/Link key columns were found on the selected Links.');
  return `SELECT DISTINCT\n${selected.join(',\n')}\n${from}${joinSql?'\n'+joinSql:''}`;
}
function spBuildBvSelect(def=spBvDraft){ return def.type==='bridge'?spBuildBridgeSelect(def):spBuildPitSelect(def); }
function spBvDraftNameIssue(){
  const name=String(spBvDraft.name||'').trim();if(!name)return 'Enter a Business Vault table name.';
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))return 'Names may contain letters, numbers and underscores and cannot start with a number.';
  if(spBvDraft.type==='pit'&&!/^pit[_-]/i.test(name))return 'PIT table names should start with pit_.';
  if(spBvDraft.type==='bridge'&&!/^(?:br|bridge)[_-]/i.test(name))return 'Bridge table names should start with br_.';
  const dupe=spManagedBvObjects().find(v=>v.name.toLowerCase()===name.toLowerCase()&&v.id!==spBvDraft.id);if(dupe)return `A managed Business Vault object named ${name} already exists.`;
  const curated=spManagedViews().find(v=>v.name.toLowerCase()===name.toLowerCase());if(curated)return `A business model named ${name} already exists.`;
  const existing=spAllIntrospectedTables().find(t=>String(t.name).toLowerCase()===name.toLowerCase());
  const editing=spBvDraft.id?spFindManagedBvObject(spBvDraft.id):null;
  const owns=editing&&[editing.name,editing.deployedName].filter(Boolean).some(n=>String(n).toLowerCase()===name.toLowerCase());
  if(existing&&!owns)return `The target already contains ${existing.objectType||'an object'} named ${name}. Choose another name.`;
  return '';
}
// Editors sit below their libraries, so Edit/Review actions would otherwise
// look like they did nothing. Bring the editor into view once it has rendered.
function spRevealEditor(containerId,focusId){
  const go=()=>{
    try{
      const box=document.getElementById(containerId);if(!box)return;
      if(typeof box.scrollIntoView==='function')box.scrollIntoView({behavior:'smooth',block:'start'});
      const field=focusId?document.getElementById(focusId):null;
      if(field&&typeof field.focus==='function')field.focus({preventScroll:true});
    }catch(_err){ /* purely cosmetic */ }
  };
  if(typeof requestAnimationFrame==='function')requestAnimationFrame(go);else setTimeout(go,0);
}
function spBvStatusLabel(obj){if(obj.status==='deployed')return 'Deployed';if(obj.status==='modified')return 'Modified — redeploy';if(obj.status==='error')return 'Deploy error';return 'Draft';}
function spSaveBvDraft(options){
  const deploy=!!(options&&options.deploy===true);
  const issue=spBvDraftNameIssue();if(issue){toast(issue,'err');return null;}
  let sql='';try{sql=spBuildBvSelect(spBvDraft);}catch(err){toast(err.message,'err');return null;}
  pushUndo(spBvDraft.id?'edit Business Vault table':'create Business Vault table');
  const existing=spBvDraft.id?spFindManagedBvObject(spBvDraft.id):null;
  const next={id:existing?existing.id:uid('bvobj'),type:spBvDraft.type,name:String(spBvDraft.name).trim(),label:String(spBvDraft.label||'').trim()||String(spBvDraft.name).trim(),description:String(spBvDraft.description||'').trim(),parentHub:spBvDraft.parentHub||'',satellites:[...new Set(spBvDraft.satellites||[])],links:[...new Set(spBvDraft.links||[])],sql,status:existing&&existing.deployedAt?'modified':'draft',deployedAt:existing?existing.deployedAt:null,deployedName:existing?(existing.deployedName||existing.name):null,deployedSchema:existing?(existing.deployedSchema||null):null,lastError:''};
  if(existing)Object.assign(existing,next);else spManagedBvObjects().push(next);
  spBvDraft={...next,satellites:[...next.satellites],links:[...next.links]};spBvPreview=null;scheduleAutosave();
  if(!deploy)toast(existing?'Business Vault table saved. Redeploy to apply changes.':'Business Vault table saved as a draft.','ok');
  renderAll();
  if(deploy)spDeployBvObject(next.id);
  return next.id;
}
function spEditBvObject(id){const obj=spFindManagedBvObject(id);if(!obj)return;spBvDraft={id:obj.id,type:obj.type,name:obj.name,label:obj.label||'',description:obj.description||'',parentHub:obj.parentHub||'',satellites:[...(obj.satellites||[])],links:[...(obj.links||[])]};spBvPreview=null;spBvSectionOpen=true;spBvBuilderOpen=true;renderAll();spRevealEditor('sp-bv-builder','sp-bv-name');}
function spShortStableHash(value){
  let h=2166136261;
  for(const ch of String(value||'')){ h^=ch.charCodeAt(0); h=Math.imul(h,16777619); }
  return (h>>>0).toString(36).slice(0,6);
}
function spBvIndexName(obj,suffix){
  const base=`ix_${String(obj.name||'bv').replace(/[^A-Za-z0-9_]+/g,'_')}_${suffix}`.toLowerCase();
  // PostgreSQL index names are schema-scoped. Long similarly named Bridges used
  // to collide after truncation, especially after "Add all". Preserve a stable
  // hash suffix so every managed Business Vault table gets unique index names.
  const hash=spShortStableHash(`${obj.name||'bv'}:${suffix}`);
  return `${base.slice(0,Math.max(1,53-hash.length))}_${hash}`;
}
function spBvIndexDdls(obj){
  const cols=[];
  if(obj.type==='pit'){
    const hub=spSchemaTables.find(t=>t.name===obj.parentHub),key=spBvParentKeyForTable(hub);
    if(key)cols.push([key,'snapshot_dts']);
  }else{
    const seen=new Set();
    (obj.links||[]).map(n=>spSchemaTables.find(t=>t.name===n)).filter(Boolean).forEach(t=>spBvLinkHubKeys(t).forEach(k=>{if(!seen.has(k)){seen.add(k);cols.push([k]);}}));
  }
  return cols.slice(0,6).map((fields,i)=>`CREATE INDEX ${spQuoteIdentifier(spBvIndexName(obj,String(i+1)))} ON ${spBusinessQualifiedTable(obj.name)} (${fields.map(spQuoteIdentifier).join(', ')});`);
}
function spBvDeployDdl(obj){
  const q=spBusinessQualifiedTable(obj.name),sql=String(obj.sql||spBuildBvSelect(obj)).trim().replace(/;\s*$/,'');
  const indexes=spBvIndexDdls(obj);const suffix=indexes.length?`\n${indexes.join('\n')}`:'';
  if(spIsSqlServerDialect())return `DROP TABLE IF EXISTS ${q};\nSELECT * INTO ${q} FROM (\n${sql}\n) AS _sp_bv_materialized;${suffix}`;
  return `DROP TABLE IF EXISTS ${q};\nCREATE TABLE ${q} AS\n${sql};${suffix}`;
}
async function spDeployBvObject(id,options={}){
  const obj=spFindManagedBvObject(id);if(!obj)return false;
  const schemaIssue=spBusinessSchemaDeployIssue();if(schemaIssue){if(!options.quiet)toast(schemaIssue,'err');return false;}
  spBvDeployingId=id;if(!options.quiet)renderAll();
  try{
    obj.sql=spBuildBvSelect(obj);await spQuery(spValidationSql(obj.sql));
    const previousSchema=obj.deployedSchema||spConn.schema;
    const previousName=obj.deployedName||obj.name;
    await spExecuteViewDdl(spBvDeployDdl(obj),{timeoutSeconds:SP_MATERIALISE_TIMEOUT_SECONDS});
    if(obj.deployedAt && (previousName!==obj.name || previousSchema!==spBusinessSchemaName())){
      await spExecuteViewDdl(`DROP TABLE IF EXISTS ${spQualifiedTableInSchema(previousName,previousSchema)};`).catch(()=>{});
    }
    obj.status='deployed';obj.deployedAt=new Date().toISOString();obj.deployedName=obj.name;obj.deployedSchema=spBusinessSchemaName();obj.lastError='';scheduleAutosave();
    if(!options.quiet)toast(`${obj.name} deployed to ${spSqlDialectLabel()}.`,'ok');
    if(!options.skipIntrospect)await spIntrospectSchema({quiet:true,preserveDraft:true});
    return true;
  }catch(err){const explained=spExplainDeployError(err.message);obj.status='error';obj.lastError=explained;if(!options.quiet)toast(`Could not deploy ${obj.name}: ${explained}`,'err');return false;}
  finally{spBvDeployingId=null;if(!options.quiet)renderAll();}
}
async function spDeployAllBv(){
  const pending=spManagedBvObjects().filter(o=>o.status!=='deployed'||!o.deployedAt);if(!pending.length){toast('No Business Vault tables need deployment.','ok');return;}
  spBvDeployAllBusy=true;renderAll();let ok=0;
  for(const obj of pending)if(await spDeployBvObject(obj.id,{quiet:true,skipIntrospect:true}))ok++;
  await spIntrospectSchema({quiet:true,preserveDraft:true});spBvDeployAllBusy=false;toast(`Deployed ${ok} of ${pending.length} Business Vault table(s).`,ok===pending.length?'ok':'err');renderAll();
}
// Dependency-ordered batch deploy: Business Vault tables first, then the
// Business Models that may read them. Objects are deployed quietly and the
// schema is re-read once at the end rather than after every object.
async function spRunDeployBatch(items){
  spDeployAllBusy=true;renderAll();
  const done=[],failed=[],skipped=[];
  try{
    const ordered=[...items.filter(i=>i.kind==='bv'),...items.filter(i=>i.kind==='model')];
    for(const item of ordered){
      const obj=item.obj;
      if(item.kind==='model'){
        const dependency=spBusinessModelDependencyIssue(obj);
        if(dependency){obj.lastError=dependency;skipped.push(`${obj.name}: ${dependency}`);continue;}
      }
      const ok=item.kind==='bv'
        ?await spDeployBvObject(obj.id,{quiet:true,skipIntrospect:true})
        :await spDeployManagedView(obj.id,{quiet:true,skipIntrospect:true});
      if(ok)done.push(obj.name);else failed.push(`${obj.name}: ${obj.lastError||'deployment failed'}`);
    }
    if(done.length)await spIntrospectSchema({quiet:true,preserveDraft:true});
    scheduleAutosave();
  }finally{spDeployAllBusy=false;}
  const problems=[...failed,...skipped];
  toast(problems.length
    ?`Deployed ${done.length} of ${items.length}. ${problems.length} need attention — first: ${problems[0]}`
    :`Deployed ${done.length} object${done.length===1?'':'s'} to ${spSqlDialectLabel()}.`,problems.length?'err':'ok');
  renderAll();
  return {done,failed,skipped};
}
async function spDeployPending(kind){
  if(spDeployAllBusy)return null;
  const pending=spPendingDeployItems().filter(i=>!kind||i.kind===kind);
  const items=pending.filter(i=>i.kind==='bv'||String(i.obj.sql||'').trim());
  const withoutSql=pending.length-items.length;
  if(!items.length){toast(withoutSql?'Pending Business Models still need SQL before they can be deployed.':'Nothing is waiting to be deployed.',withoutSql?'err':'ok');return null;}
  const schemaIssue=spBusinessSchemaDeployIssue();if(schemaIssue){toast(schemaIssue,'err');return null;}
  const label=i=>i.kind==='bv'?(i.obj.type==='bridge'?'Bridge':'PIT'):'Business Model';
  const list=items.map(i=>`  • ${label(i)}: ${i.obj.name}${i.obj.deployedAt?' (rebuild)':''}`).join('\n');
  const extra=withoutSql?`\n\n${withoutSql} Business Model(s) without SQL will be skipped.`:'';
  if(!confirm(`Deploy ${items.length} object${items.length===1?'':'s'} to ${spSqlDialectLabel()}? Business Vault tables are deployed first, then Business Models.\n\n${list}${extra}`))return null;
  return spRunDeployBatch(items);
}
function spDeployAllPending(){ return spDeployPending(null); }
function spDeployAllModels(){ return spDeployPending('model'); }
async function spDeleteBvObject(id){
  const obj=spFindManagedBvObject(id);if(!obj)return;
  const deps=spManagedViews().filter(v=>(v.sourceObjects||[]).includes(obj.name));
  const depText=deps.length?`\n\nUsed by business models: ${deps.map(v=>v.name).join(', ')}.`:'';
  if(!confirm(`Delete ${obj.name}?${obj.deployedAt?' This will DROP the deployed table.':''}${depText}`))return;
  try{if(obj.deployedAt)await spExecuteViewDdl(`DROP TABLE IF EXISTS ${spQualifiedTableInSchema(obj.deployedName||obj.name,obj.deployedSchema||spBusinessSchemaName())};`);pushUndo('delete Business Vault structure');state.businessVaultObjects=spManagedBvObjects().filter(v=>v.id!==id);if(spBvDraft.id===id)spResetBvDraft();scheduleAutosave();if(obj.deployedAt)await spIntrospectSchema({quiet:true,preserveDraft:true});toast(`${obj.name} deleted.`,'ok');}catch(err){toast(`Could not delete ${obj.name}: ${err.message}`,'err');}renderAll();
}
async function spPreviewBvDraft(){
  let sql='';try{sql=spBuildBvSelect(spBvDraft);}catch(err){toast(err.message,'err');return;}
  spBvPreview={loading:true,rows:[],fields:[],error:'',sql};renderAll();
  try{const rows=await spQuery(spSelectLimit(sql,10));spBvPreview={loading:false,rows,fields:rows[0]?Object.keys(rows[0]):[],error:'',sql};}catch(err){spBvPreview={loading:false,rows:[],fields:[],error:err.message,sql};}renderAll();
}
function spBvRecommendations(){
  const recs=[];
  spBvPitParentTables().forEach(h=>{const sats=spBvCompatibleSatellites(h.name);if(sats.length>=2)recs.push({type:'pit',label:`PIT for ${h.name}`,parentHub:h.name,satellites:sats.map(s=>s.name),links:[]});});
  const links=spBvLinkTables();
  for(let i=0;i<links.length;i++)for(let j=i+1;j<links.length;j++)if(spBvSharedHubKeys(links[i],links[j]).length)recs.push({type:'bridge',label:`Bridge ${links[i].name} + ${links[j].name}`,parentHub:'',satellites:[],links:[links[i].name,links[j].name]});
  return recs.slice(0,8);
}
function spBvRecommendationNameStem(sourceName){
  let stem=String(sourceName||'').replace(/^(?:hub_|link_)/i,'');
  const vault=String((state.vault&&state.vault.name)||'').trim().replace(/[^A-Za-z0-9_]+/g,'_').replace(/^_+|_+$/g,'').toLowerCase();
  if(vault&&stem.toLowerCase().startsWith(`${vault}_`))stem=stem.slice(vault.length+1);
  return stem;
}
function spBvRecommendationDraft(rec){
  const stem=rec.type==='pit'?spBvRecommendationNameStem(rec.parentHub||'pit'):(rec.links||[]).map(spBvRecommendationNameStem).filter(Boolean).join('_');
  const prefix=rec.type==='bridge'?'br':'pit';
  return {id:null,type:rec.type,name:`${prefix}_${stem}`.replace(/[^A-Za-z0-9_]+/g,'_').toLowerCase(),label:rec.label,description:'',parentHub:rec.parentHub||'',satellites:[...(rec.satellites||[])],links:[...(rec.links||[])]};
}
function spUseBvRecommendation(index){
  const rec=spBvRecommendations()[Number(index)];if(!rec)return;
  spBvDraft=spBvRecommendationDraft(rec);spBvPreview=null;spBvSectionOpen=true;spBvBuilderOpen=true;renderAll();spRevealEditor('sp-bv-builder','sp-bv-name');
}
function spAddAllBvRecommendations(){
  const recommendations=spBvRecommendations();
  if(!recommendations.length){toast('No Business Vault tables are currently recommended.','ok');return;}
  const managedNames=new Set(spManagedBvObjects().map(o=>String(o.name).toLowerCase()));
  const databaseNames=new Set(spSchemaTables.map(t=>String(t.name).toLowerCase()));
  const curatedNames=new Set(spManagedViews().map(v=>String(v.name).toLowerCase()));
  const additions=[];
  for(const rec of recommendations){
    const draft=spBvRecommendationDraft(rec);const key=draft.name.toLowerCase();
    if(managedNames.has(key)||databaseNames.has(key)||curatedNames.has(key))continue;
    try{
      const sql=spBuildBvSelect(draft);
      additions.push({id:uid('bvobj'),type:draft.type,name:draft.name,label:draft.label||draft.name,description:'',parentHub:draft.parentHub||'',satellites:[...new Set(draft.satellites||[])],links:[...new Set(draft.links||[])],sql,status:'draft',deployedAt:null,deployedName:null,lastError:''});
      managedNames.add(key);
    }catch(_err){ /* Skip recommendations that are no longer valid against the current schema. */ }
  }
  if(!additions.length){toast('All recommended Business Vault tables are already managed or already exist on the target.','ok');return;}
  pushUndo('add recommended Business Vault tables');
  spManagedBvObjects().push(...additions);scheduleAutosave();spBvSectionOpen=true;
  toast(`Added ${additions.length} recommended Business Vault table${additions.length===1?'':'s'} as draft${additions.length===1?'':'s'}. Review them before deployment.`,'ok');
  renderAll();
}
