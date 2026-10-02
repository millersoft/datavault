/* Studio Plus — Business Model drafts, AI plan actions, SQL formatting and Business Model deployment. */
let spViewDraft = { id:null, name:'', label:'', type:'current', materialization:'table', description:'', sourceObjects:[], sql:'' };
let spViewBuilderOpen = false; // the editor stays collapsed until the user starts or opens a Business Model
let spViewSourceSearch = '';
let spViewAiStatus = null; // null | loading | error | ok
let spViewAiError = '';
let spViewAiProposal = null;
let spViewPreview = null; // {rows,fields,error}
let spViewDeployingId = null;

// Cross-layer AI recommendations are transient planning suggestions. They are
// deliberately not persisted: a user must open a suggestion in the normal
// Business Vault / Business Models builder and explicitly save it as a draft.
let spAiRecommendStatus = null; // null | loading | ok | error
let spAiRecommendError = '';
let spAiRecommendPrompt = '';
let spAiRecommendations = null; // {summary,businessVault,curatedDatasets}
let spAiSelectedBv = new Set();
let spAiSelectedCurated = new Set();
let spAiPlanApplying = false;
let spAiReviewCuratedIndex = null; // individual AI Plan Review currently generating SQL
let spWorkflowStep = 'plan'; // plan | bv | curated | lineage | reporting
let spLineageSelection = '';
let spLineageZoom = 1;
let spLineageSearch = '';
let spLineageMode = 'focus'; // focus | concept | entire | matrix
let spLineageDirection = 'both'; // up | down | both
let spLineageLayerFilter = new Set(['source','staging','raw','bv','curated','report']);

function spBusinessObjectKind(table){
  const originalName=String((table&&table.name)||'');
  const managed=spManagedBvObjects().find(o=>String(o.name).toLowerCase()===originalName.toLowerCase() || String(o.deployedName||'').toLowerCase()===originalName.toLowerCase());
  if(managed)return managed.type==='bridge'?'Bridge':'PIT';
  const name = originalName.toLowerCase();
  if (/^pit[_-]|[_-]pit(?:[_-]|$)/.test(name)) return 'PIT';
  if (/^(?:br|bridge)[_-]|[_-]bridge(?:[_-]|$)/.test(name)) return 'Bridge';
  if (/^(hub_|link_|sat_|lsat_)/.test(name)) return 'Raw Vault';
  if (/^(stg_|stage_|staging_)/.test(name)) return 'Staging';
  if ((table&&table.objectType)==='view') return 'View';
  return 'Other';
}
function spViewTypeLabel(type){ return ({current:'Current entity',history:'Entity history','360':'Entity 360',relationship:'Relationship',custom:'Custom'})[type]||'Custom'; }
function spViewStatusLabel(view){
  if(view.status==='deployed') return 'Deployed';
  if(view.status==='modified') return 'Modified — redeploy';
  if(view.status==='error') return 'Deploy error';
  return 'Draft';
}
function spUndeployedBvDependencies(view){
  const sourceNames=new Set((view&&view.sourceObjects||[]).map(n=>String(n).toLowerCase()));
  return spManagedBvObjects().filter(obj=>{
    const names=[obj.name,obj.deployedName].filter(Boolean).map(n=>String(n).toLowerCase());
    if(!names.some(n=>sourceNames.has(n)))return false;
    return obj.status!=='deployed'||!obj.deployedAt;
  });
}
function spBusinessModelDependencyIssue(view){
  const pending=spUndeployedBvDependencies(view);
  return pending.length?`Deploy required Business Vault object(s) first: ${pending.map(o=>o.name).join(', ')}`:'';
}
function spManagedReportingTables(){
  const out=[];
  spManagedViews().filter(v=>!spIsTechnicalViewName(v.name) && v.deployedAt && v.status!=='error').forEach(view=>{
    const expected=(view.materialization||'view')==='table'?'table':'view';
    const key=String(view.deployedName||view.name).toLowerCase();
    const business=spBusinessSchemaTables.find(t=>String(t.name).toLowerCase()===key && (t.objectType||'table')===expected);
    const legacy=spSchemaTables.find(t=>String(t.name).toLowerCase()===key && (t.objectType||'table')===expected);
    const found=business||legacy;
    if(found)out.push({...found,name:view.name,schema:business?spBusinessSchemaName():(spConn.schema||spConn.database)});
  });
  return out;
}

function spDefaultReportingSourceNames(){ return spManagedReportingTables().map(t=>t.name); }
function spSelectedSchemaTables(){
  return spManagedReportingTables().filter(t=>spReportingSources.has(t.name));
}
function spResetReportPlan(){
  spDashboardPlanStatus=null; spDashboardPlan=null; spSectionsIncluded=new Set();
  spGenerateStatus=null; spGenerated=null; spGenerateStage='';
  spOverrides={}; spExpanded={}; spSectionOverrides={}; spViewValidation={}; spSectionValidation={};
}
function spResetViewDraft(){
  spViewDraft={id:null,name:'',label:'',type:'current',materialization:'table',description:'',sourceObjects:[],sql:''};
  spViewAiStatus=null; spViewAiError=''; spViewAiProposal=null; spViewPreview=null;
}
function spIsTechnicalViewName(name){ return /^vw_/i.test(String(name||'')); }
function spViewSourceTables(){
  // Business Models are terminal/reporting-facing objects by default. Keep them
  // out of the source picker so AI cannot quietly build one Business Model on
  // top of another. Inputs are Raw Vault objects plus deployed PIT/Bridge tables.
  const modelNames=new Set(spManagedViews().flatMap(v=>[v.name,v.deployedName].filter(Boolean)).map(n=>String(n).toLowerCase()));
  const raw=spSchemaTables.filter(t=>!spIsTechnicalViewName(t.name) && !modelNames.has(String(t.name).toLowerCase()) && ['Raw Vault','PIT','Bridge'].includes(spBusinessObjectKind(t)));
  const bv=spBusinessSchemaTables.filter(t=>!spIsTechnicalViewName(t.name) && !modelNames.has(String(t.name).toLowerCase()) && ['PIT','Bridge'].includes(spBusinessObjectKind(t)));
  const seen=new Set();return [...raw,...bv].filter(t=>{const key=String(t.name).toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});
}
function spViewSourceTable(name){ return spViewSourceTables().find(t=>t.name===name); }
function spSchemaSummaryForNames(names){
  const wanted=new Set(names||[]);
  return spViewSourceTables().filter(t=>wanted.has(t.name)).map(t=>`${t.name}[qualified:${spSourceQualifiedTable(t.name)}; ${t.objectType||'table'}; rows:${t.rowCount==null?'unknown':t.rowCount}](${(t.columns||[]).map(c=>`${c.name}:${c.type}`).join(', ')})`).join('\n');
}
function spComputeJoinMapForTables(tables){
  const scoped=tables||[];
  const hubs=scoped.filter(t=>/^hub_/i.test(t.name));
  const lines=[];
  hubs.forEach(h=>{
    const key=`${h.name}_id`;
    if(!(h.columns||[]).some(c=>c.name===key)) return;
    scoped.forEach(t=>{ if(t.name!==h.name && (t.columns||[]).some(c=>c.name===key)) lines.push(`${t.name} joins to ${h.name} via ${key}`); });
  });
  return lines.join('\n');
}
function spViewDraftStarterSql(){
  const source=spViewDraft.sourceObjects[0];
  if(!source) return '';
  return `SELECT *\nFROM ${spSourceQualifiedTable(source)}`;
}
function spFormatSqlForEditor(sql){
  const raw=String(sql||'').trim();
  if(!raw)return '';

  // Protect literals, quoted identifiers and comments so formatting only changes
  // insignificant whitespace in the SQL structure. This is intentionally a
  // conservative display formatter rather than a SQL parser.
  const protectedParts=[];
  const tokenFor=text=>{const token=`\u0001${protectedParts.length}\u0002`;protectedParts.push(text);return token;};
  let masked='',i=0;
  while(i<raw.length){
    const ch=raw[i],next=raw[i+1];
    if(ch==="'"||ch==='\"'||ch==='`'){
      const quote=ch;let j=i+1;
      while(j<raw.length){
        if(raw[j]===quote){if(raw[j+1]===quote){j+=2;continue;}j++;break;}
        j++;
      }
      masked+=tokenFor(raw.slice(i,j));i=j;continue;
    }
    if(ch==='['){
      let j=i+1;
      while(j<raw.length){if(raw[j]===']'){if(raw[j+1]===']'){j+=2;continue;}j++;break;}j++;}
      masked+=tokenFor(raw.slice(i,j));i=j;continue;
    }
    if(ch==='-'&&next==='-'){
      let j=i+2;while(j<raw.length&&raw[j]!=='\n')j++;
      masked+=tokenFor(raw.slice(i,j));i=j;continue;
    }
    if(ch==='/'&&next==='*'){
      let j=i+2;while(j<raw.length-1&&!(raw[j]==='*'&&raw[j+1]==='/'))j++;j=Math.min(raw.length,j+2);
      masked+=tokenFor(raw.slice(i,j));i=j;continue;
    }
    if(ch==='$'){
      const match=raw.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if(match){const tag=match[0],end=raw.indexOf(tag,i+tag.length);if(end>=0){const j=end+tag.length;masked+=tokenFor(raw.slice(i,j));i=j;continue;}}
    }
    masked+=ch;i++;
  }

  masked=masked.replace(/\s+/g,' ').trim();

  // Put the major SELECT clauses and joins on their own lines. The replacements
  // are whitespace-only, so the executable query remains unchanged.
  masked=masked
    .replace(/\s+SELECT\s+/gi,'\nSELECT ')
    .replace(/\s+(UNION\s+ALL|UNION|INTERSECT|EXCEPT)\s+/gi,'\n$1\n')
    .replace(/\s+(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|QUALIFY|LIMIT|OFFSET|FETCH)\s+/gi,'\n$1 ')
    .replace(/\s+(LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|FULL\s+OUTER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|JOIN|CROSS\s+APPLY|OUTER\s+APPLY)\s+/gi,'\n$1 ')
    .replace(/\s+ON\s+/gi,'\n  ON ');

  // Break top-level comma-separated lists (SELECT, GROUP BY, ORDER BY, CTEs)
  // without touching function arguments or IN lists inside parentheses.
  let formatted='',depth=0;
  for(let k=0;k<masked.length;k++){
    const ch=masked[k];
    if(ch==='(')depth++;
    else if(ch===')')depth=Math.max(0,depth-1);
    if(ch===','&&depth===0){
      formatted+=',\n  ';
      while(k+1<masked.length&&/[ \t]/.test(masked[k+1]))k++;
    }else formatted+=ch;
  }

  formatted=formatted.split('\n').map(line=>line.replace(/[ \t]+$/,'')).join('\n').replace(/\n{3,}/g,'\n\n').trim();
  formatted=formatted.replace(/\u0001(\d+)\u0002/g,(_m,n)=>protectedParts[Number(n)]||'');
  return formatted;
}
function spDraftViewNameIssue(){
  const name=String(spViewDraft.name||'').trim();
  if(!name) return 'Enter a Business Model name.';
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'Names may contain letters, numbers and underscores and cannot start with a number.';
  const duplicate=spManagedViews().find(v=>v.name.toLowerCase()===name.toLowerCase() && v.id!==spViewDraft.id);
  if(duplicate) return `A Business Model named ${name} already exists.`;
  const databaseObject=spAllIntrospectedTables().find(t=>String(t.name).toLowerCase()===name.toLowerCase());
  const editing=spViewDraft.id?spFindManagedView(spViewDraft.id):null;
  const ownsDatabaseObject=editing && [editing.name,editing.deployedName].filter(Boolean).some(n=>String(n).toLowerCase()===name.toLowerCase());
  if(databaseObject && !ownsDatabaseObject) return `The target already contains ${databaseObject.objectType||'an object'} named ${name}. Choose another Business Model name.`;
  return '';
}
function spEditManagedView(id){
  const view=spFindManagedView(id); if(!view)return;
  spViewBuilderOpen=true;
  spViewDraft={id:view.id,name:view.name,label:view.label||'',type:view.type||'custom',materialization:view.materialization||'view',description:view.description||'',sourceObjects:[...(view.sourceObjects||[])],sql:spFormatSqlForEditor(view.sql||'')};
  spViewAiStatus=null;spViewAiError='';spViewAiProposal=null;spViewPreview=null;renderAll();
  spRevealEditor('sp-view-builder','sp-view-name');
}
function spSaveViewDraft(options){
  const deploy=!!(options&&options.deploy===true);
  const nameIssue=spDraftViewNameIssue(); if(nameIssue){toast(nameIssue,'err');return null;}
  const sqlIssue=spSingleSelectIssue(spViewDraft.sql); if(sqlIssue){toast(sqlIssue,'err');return null;}
  if(!spViewDraft.sourceObjects.length){toast('Select at least one Vault object used by this model.','err');return null;}
  const allowedSources=new Set(spViewSourceTables().map(t=>t.name));
  const invalidSources=spViewDraft.sourceObjects.filter(n=>!allowedSources.has(n));
  if(invalidSources.length){toast(`Business Models cannot use other Business Models as hidden inputs. Remove or replace: ${invalidSources.join(', ')}`,'err');return null;}
  pushUndo(spViewDraft.id?'edit business model':'create business model');
  const existing=spViewDraft.id?spFindManagedView(spViewDraft.id):null;
  const next={
    id:existing?existing.id:uid('bvview'),
    name:String(spViewDraft.name).trim(),
    label:String(spViewDraft.label||'').trim()||String(spViewDraft.name).trim(),
    type:spViewDraft.type||'custom',
    materialization:spViewDraft.materialization||'table',
    description:String(spViewDraft.description||'').trim(),
    sourceObjects:[...new Set(spViewDraft.sourceObjects)],
    sql:spFormatSqlForEditor(String(spViewDraft.sql||'').trim().replace(/;\s*$/,'')),
    status:existing&&existing.deployedAt?'modified':'draft',
    deployedAt:existing?existing.deployedAt:null,
    deployedName:existing?(existing.deployedName||existing.name):null,
    deployedMaterialization:existing?(existing.deployedMaterialization||existing.materialization||'view'):null,
    deployedSchema:existing?(existing.deployedSchema||null):null,
    lastError:'',
  };
  if(existing) Object.assign(existing,next); else spManagedViews().push(next);
  spViewDraft={...next,sourceObjects:[...next.sourceObjects]};
  spViewAiProposal=null;spViewPreview=null;
  scheduleAutosave();
  if(!deploy)toast(existing?'Business Model saved. Redeploy to apply database changes.':'Business Model saved as a draft.','ok');
  renderAll();
  if(deploy)spDeployManagedView(next.id);
  return next.id;
}
function spAcceptAiViewProposal(){
  if(!spViewAiProposal)return;
  spViewDraft.name=spViewAiProposal.name||spViewDraft.name;
  spViewDraft.label=spViewAiProposal.label||spViewDraft.label||spViewAiProposal.name||'';
  spViewDraft.description=spViewAiProposal.description||spViewDraft.description;
  spViewDraft.sql=spFormatSqlForEditor(spViewAiProposal.sql||spViewDraft.sql);
  spViewAiProposal=null;spViewAiStatus=null;spViewPreview=null;
  toast('AI proposal copied into the editor. Review it, preview it, then Save Draft — nothing has been created or loaded yet.','ok');
  renderAll();
}
function spAiRecommendationSchemaText(){
  const tables=spViewSourceTables().slice(0,120);
  return tables.map(t=>{
    const cols=(t.columns||[]).slice(0,24).map(c=>`${c.name}:${c.type||'unknown'}`);
    const extra=(t.columns||[]).length>24?`, ...(+${(t.columns||[]).length-24})`:'';
    return `${t.name} [${spBusinessObjectKind(t)}; qualified=${spSourceQualifiedTable(t.name)}] (${cols.join(', ')}${extra})`;
  }).join('\n');
}
function spAiRecommendationCandidateText(){
  return spBvRecommendations().map((r,i)=>{
    if(r.type==='pit')return `${i}: PIT parent=${r.parentHub}; satellites=${(r.satellites||[]).join(',')}`;
    return `${i}: Bridge links=${(r.links||[]).join(',')}`;
  }).join('\n');
}
function spAiSafeDatasetName(raw,fallback='curated_dataset'){
  let base=String(raw||fallback).trim().toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
  if(!base||/^\d/.test(base))base=`dataset_${base||'curated'}`;
  const used=new Set([...spManagedViews().map(v=>v.name),...spManagedBvObjects().map(v=>v.name),...spAllIntrospectedTables().map(t=>t.name)].map(n=>String(n).toLowerCase()));
  let name=base,i=2;while(used.has(name)){name=`${base}_${i++}`;}return name;
}
function spNormalizeAiRecommendations(parsed){
  const candidates=spBvRecommendations();
  const seenBv=new Set();
  const businessVault=[];
  for(const item of Array.isArray(parsed&&parsed.business_vault)?parsed.business_vault:[]){
    const index=Number(item&&item.candidate_index);
    if(!Number.isInteger(index)||index<0||index>=candidates.length||seenBv.has(index))continue;
    const candidate=candidates[index];
    // Revalidate the deterministic candidate against the current schema before
    // exposing it. AI chooses from candidates; it never invents PIT/Bridge SQL.
    try{spBuildBvSelect(spBvRecommendationDraft(candidate));}catch(_err){continue;}
    seenBv.add(index);
    businessVault.push({candidateIndex:index,definition:spBvRecommendationDraft(candidate),reason:String(item.reason||'').trim()||'Recommended from the deployed Vault structure.'});
  }
  const allowedSources=new Set(spViewSourceTables().map(t=>t.name));
  const allowedTypes=new Set(['current','history','360','relationship','custom']);
  const curatedDatasets=[];const seenCurated=new Set();
  for(const item of Array.isArray(parsed&&parsed.curated_datasets)?parsed.curated_datasets:[]){
    const sources=[...new Set((Array.isArray(item&&item.source_objects)?item.source_objects:[]).filter(n=>allowedSources.has(n)))];
    if(!sources.length)continue;
    let name=spAiSafeDatasetName(item.name||item.label||'curated_dataset');
    while(seenCurated.has(name))name=spAiSafeDatasetName(`${name}_next`);
    seenCurated.add(name);
    curatedDatasets.push({
      name,
      label:String(item.label||name).trim()||name,
      type:allowedTypes.has(item.type)?item.type:'custom',
      materialization:item.materialization==='view'?'view':'table',
      description:String(item.description||'').trim(),
      sourceObjects:sources,
      reason:String(item.reason||'').trim()||'Suggested from the deployed Vault metadata and requested business outcome.',
    });
  }
  return {summary:String(parsed&&parsed.summary||'').trim(),businessVault,curatedDatasets};
}
async function spAiSuggestArchitecture(){
  if(!spSchemaTables.length){toast('Infer the deployed Vault schema first.','err');return;}
  spAiRecommendStatus='loading';spAiRecommendError='';spAiRecommendations=null;spPersistPlan();renderAll();
  const candidateText=spAiRecommendationCandidateText();
  const rules=`You are a senior Data Vault 2.0 and analytics architect. Recommend a SMALL, useful set of optional Business Vault structures and business models for the user's stated analytical outcome. Do not recommend PIT or Bridge tables merely because they exist as patterns. PIT is useful when point-in-time history across multiple satellites will materially simplify repeated querying. Bridge is useful for reusable multi-link relationship traversal. Business models should be business-facing and persisted by default for historical, trend, 360, or multi-join workloads.

CRITICAL SAFETY/CONTROL RULES:
- You may choose Business Vault structures ONLY by candidate_index from the supplied deterministic candidate list. Never invent a PIT/Bridge definition.
- Business model source_objects must be exact Raw Vault or Business Vault object names from the supplied deployed schema. Managed Business Models are NOT valid inputs to another Business Model unless a future explicit composition feature is enabled. Never invent a table or column. Combine multiple objects only when the supplied authoritative join list supports the relationship.
- Do not write SQL. This is a recommendation/planning pass only.
- Keep recommendations minimal; zero Business Vault structures is valid.

Respond ONLY with minified JSON matching exactly:
{"summary":"short recommendation summary","business_vault":[{"candidate_index":0,"reason":"why this helper is useful for the requested outcome"}],"curated_datasets":[{"name":"snake_case_name","label":"Business label","type":"current|history|360|relationship|custom","materialization":"table|view","description":"what this model should contain","source_objects":["exact_name"],"reason":"why this model is useful"}]}`;
  const recommendationSources=spViewSourceTables().filter(t=>!['Staging','View'].includes(spBusinessObjectKind(t)));
  const joinText=spComputeJoinMapForTables(recommendationSources);
  const user=`Requested outcome: ${spAiRecommendPrompt.trim()||'Review this deployed Vault and suggest the most useful business-facing analytical datasets.'}

Deployed Vault objects:
${spAiRecommendationSchemaText()||'(none)'}

Authoritative joins derived from the deployed schema:
${joinText||'(No shared Hub-key joins were detected; do not invent cross-object relationships.)'}

Valid deterministic Business Vault candidates (choose only these indices; an empty list means recommend no PIT/Bridge objects):
${candidateText||'(none)'}`;
  try{
    const parsed=await spCallOpenAI(rules,user,0.2);
    spAiRecommendations=spNormalizeAiRecommendations(parsed);
    spAiSelectedBv=new Set(spAiRecommendations.businessVault.map((_,i)=>i));
    spAiSelectedCurated=new Set(spAiRecommendations.curatedDatasets.map((_,i)=>i));
    if(!spAiRecommendations.businessVault.length&&!spAiRecommendations.curatedDatasets.length)spAiRecommendations.summary=spAiRecommendations.summary||'No additional Business Vault structures or business models were strongly indicated by this model and prompt.';
    spAiRecommendStatus='ok';spPersistPlan();
  }catch(err){spAiRecommendStatus='error';spAiRecommendError=err.message;toast('Could not generate AI recommendations: '+err.message,'err');}
  renderAll();
}
function spOpenAiBvRecommendation(index){
  const rec=spAiRecommendations&&spAiRecommendations.businessVault&&spAiRecommendations.businessVault[Number(index)];if(!rec)return;
  spBvBuilderOpen=true;
  spBvDraft={...rec.definition,satellites:[...(rec.definition.satellites||[])],links:[...(rec.definition.links||[])],description:rec.reason||''};
  spBvPreview=null;spBvSectionOpen=true;spWorkflowStep='build';toast('Recommendation opened in the Business Vault builder. Review it and Save Draft if you want to keep it.','ok');renderAll();spRevealEditor('sp-bv-builder','sp-bv-name');
}
async function spOpenAiCuratedRecommendation(index){
  const rec=spAiRecommendations&&spAiRecommendations.curatedDatasets&&spAiRecommendations.curatedDatasets[Number(index)];if(!rec)return;
  const recIndex=Number(index);
  spAiReviewCuratedIndex=recIndex;spViewBuilderOpen=true;renderAll();
  try{
    const generated=await spAiGenerateCuratedSql(rec);
    spViewDraft={id:null,name:rec.name,label:rec.label,type:rec.type,materialization:rec.materialization||'table',description:generated.description||rec.description||rec.reason||'',sourceObjects:[...(rec.sourceObjects||[])],sql:generated.sql||''};
    spViewAiStatus=generated.targetError?'error':null;spViewAiError=generated.targetError?`The target rejected the generated SQL: ${generated.targetError}`:'';spViewAiProposal=null;spViewPreview=null;spWorkflowStep='build';
    toast(generated.targetError?'Recommendation opened, but the target rejected its generated SQL. Review and correct it before deploying.':'Recommendation opened in Business Models with generated SQL ready to review. Nothing has been saved or deployed yet.',generated.targetError?'err':'ok');
  }catch(err){
    spViewDraft={id:null,name:rec.name,label:rec.label,type:rec.type,materialization:rec.materialization||'table',description:rec.description||rec.reason||'',sourceObjects:[...(rec.sourceObjects||[])],sql:''};
    spViewAiStatus='error';spViewAiError=`AI SQL generation needs review: ${err.message}`;spViewAiProposal=null;spViewPreview=null;spWorkflowStep='build';
    toast('The recommendation opened, but its SQL could not be generated automatically. Review the sources and regenerate with AI.','err');
  }finally{spAiReviewCuratedIndex=null;renderAll();spRevealEditor('sp-view-builder','sp-view-name');}
}
function spExistingManagedName(name){
  const key=String(name||'').toLowerCase();
  return spManagedBvObjects().some(o=>String(o.name).toLowerCase()===key) || spManagedViews().some(v=>String(v.name).toLowerCase()===key) || spAllIntrospectedTables().some(t=>String(t.name).toLowerCase()===key);
}
function spCleanGeneratedSql(text){
  return String(text||'').trim().replace(/^```(?:sql)?\s*/i,'').replace(/\s*```$/,'').trim().replace(/;\s*$/,'');
}
// Models routinely invent a column that sits on a different object type (for
// example load_end_dts on a Hub). State the rule where the model can't miss it.
function spBusinessModelColumnRules(){
  return 'COLUMN RULES: only Satellites (sat_) and Link Satellites (lsat_) have load_end_dts; Hubs and Links have load_dts but no load_end_dts. Before finishing, check every column in SELECT/JOIN/WHERE/GROUP BY against the supplied column list of the table its alias points to.';
}
// The generated SELECT is only "valid" once the target agrees, so ask it.
async function spBusinessModelTargetError(sql){
  try{await spQuery(spValidationSql(sql));return '';}
  catch(err){return String(err&&err.message||'The target rejected this SQL.');}
}
// Connectivity, permission and timeout errors are not something an SQL rewrite can fix.
function spIsRepairableTargetError(message){
  return !/not reachable|failed to fetch|econnrefused|network|statement timeout|lock timeout|timed out|timeout expired|authentication|password|permission denied/i.test(String(message||''));
}
async function spRepairBusinessModelSql(sql,sourceObjects,targetError,context=''){
  const tables=spViewSourceTables().filter(t=>(sourceObjects||[]).includes(t.name));
  const joins=spComputeJoinMapForTables(tables);
  const rules=`The connected ${spSqlDialectLabel()} database rejected a generated Business Model SELECT. Repair it using the actual database error. Return ONLY minified JSON in the exact shape {"sql":"SELECT ..."}. Keep the same business meaning. Use ONLY the supplied allowed source objects, columns, qualified names and authoritative joins. Return exactly one read-only SELECT or WITH … SELECT statement; no DDL/DML, setup statements, markdown fences or trailing semicolon.\n\n${spBusinessModelColumnRules()}\n\n${spSqlDialectPromptRules()}`;
  const input=JSON.stringify({context:context||'',target_error:targetError,sql,allowed_source_objects:spSchemaSummaryForNames(sourceObjects||[]),authoritative_joins:joins||'(none)'});
  const repaired=await spCallOpenAI(rules,input,0);
  const fixed=spCleanGeneratedSql(repaired&&repaired.sql);
  return fixed&&!spSingleSelectIssue(fixed)?fixed:'';
}
// options.validateOnTarget also runs the SELECT against the target (zero rows)
// and gives the AI one repair pass with the real database error. A failure that
// survives is reported through options.report.targetError rather than thrown,
// so the SQL is still available for the person to correct.
async function spPrepareGeneratedBusinessModelSql(sql,sourceObjects,context='',options={}){
  let prepared=spCleanGeneratedSql(sql);
  let issue=spSingleSelectIssue(prepared);
  if(issue){
    const tables=spViewSourceTables().filter(t=>(sourceObjects||[]).includes(t.name));
    const joins=spComputeJoinMapForTables(tables);
    const repairRules=`You repair ONE generated Business Model SELECT for ${spSqlDialectLabel()}. Return ONLY minified JSON in the exact shape {"sql":"SELECT ..."}. Keep the same business meaning. Use ONLY the supplied allowed source objects, columns, qualified names and authoritative joins. Return exactly one read-only SELECT or WITH … SELECT statement; no DDL/DML, setup statements, markdown fences or trailing semicolon.\n\n${spSqlDialectPromptRules()}`;
    const repairInput=JSON.stringify({context:context||'',error:issue,sql:prepared,allowed_source_objects:spSchemaSummaryForNames(sourceObjects||[]),authoritative_joins:joins||'(none)'});
    const repaired=await spCallOpenAI(repairRules,repairInput,0);
    prepared=spCleanGeneratedSql(repaired&&repaired.sql);
    issue=spSingleSelectIssue(prepared);
    if(issue)throw new Error(`Generated Business Model SQL still does not match ${spSqlDialectLabel()}: ${issue}`);
  }
  if(options.validateOnTarget){
    const targetError=await spBusinessModelTargetError(prepared);
    if(targetError){
      let resolved=false;
      if(spIsRepairableTargetError(targetError)){
        try{
          const fixed=await spRepairBusinessModelSql(prepared,sourceObjects,targetError,context);
          if(fixed&&!(await spBusinessModelTargetError(fixed))){prepared=fixed;resolved=true;}
        }catch(_err){ /* keep the original SQL and report the database error below */ }
      }
      if(!resolved&&options.report)options.report.targetError=targetError;
    }
  }
  return spFormatSqlForEditor(prepared);
}
let spViewFixingId = null;
// Repair a model that failed to deploy, using the recorded database error. The
// result is loaded into the editor unsaved so the person reviews it first.
async function spAiFixManagedView(id){
  const view=spFindManagedView(id);if(!view||spViewFixingId)return;
  if(!String(view.sql||'').trim()){toast('This Business Model has no SQL to repair yet.','err');return;}
  spViewFixingId=id;spViewBuilderOpen=true;renderAll();
  try{
    const fixed=await spRepairBusinessModelSql(view.sql,view.sourceObjects,view.lastError||'The target rejected this SQL.',view.description||view.label||view.name);
    if(!fixed)throw new Error('AI did not return usable SQL for this error.');
    const stillFailing=await spBusinessModelTargetError(fixed);
    spViewDraft={id:view.id,name:view.name,label:view.label||'',type:view.type||'custom',materialization:view.materialization||'table',description:view.description||'',sourceObjects:[...(view.sourceObjects||[])],sql:spFormatSqlForEditor(fixed)};
    spViewAiStatus=stillFailing?'error':null;spViewAiError=stillFailing?`The proposed fix still fails on the target: ${stillFailing}`:'';spViewAiProposal=null;spViewPreview=null;spWorkflowStep='build';
    toast(stillFailing?'A fix was loaded into the editor but the target still rejects it. Review the SQL.':'Proposed fix loaded into the editor. Review it, then Save & deploy — nothing has been saved yet.',stillFailing?'err':'ok');
  }catch(err){toast('Could not repair the SQL: '+err.message,'err');}
  finally{spViewFixingId=null;renderAll();spRevealEditor('sp-view-builder','sp-view-name');}
}
async function spAiGenerateCuratedSql(rec){
  const tables=spViewSourceTables().filter(t=>(rec.sourceObjects||[]).includes(t.name));
  const joins=spComputeJoinMapForTables(tables);
  const dialect=spSqlDialectLabel();
  const rules=`You are designing ONE reusable curated business dataset over a Data Vault. Use ONLY the supplied source objects and columns. Use each object's supplied qualified name exactly so Raw Vault objects resolve from their Raw Vault schema and PIT/Bridge objects resolve from the Business Vault schema. Return a safe ${dialect} SELECT query as JSON; never emit DDL. Never invent tables, aliases-to-nonexistent-columns, or relationships. Respect temporal history when the requested type is History. Prefer readable business columns and explicit aliases. Do not use pg_input_is_valid() or other version-specific helper functions; prefer broadly supported SQL for the configured target version.\n\n${spBusinessModelColumnRules()}\n\n${spSqlDialectPromptRules()}
Respond ONLY with minified JSON matching: {"description":"short description","sql":"SELECT ..."}`;
  const user=`Dataset: ${rec.label||rec.name}
Type: ${spViewTypeLabel(rec.type)}
Requirement: ${rec.description||rec.reason||'(none)'}

Allowed source objects:
${spSchemaSummaryForNames(rec.sourceObjects)}

Authoritative joins:
${joins||'(No shared Hub-key joins were found; do not invent one.)'}`;
  const proposal=await spCallOpenAI(rules,user,0.2);
  if(!proposal||!proposal.sql)throw new Error('AI response did not contain a Business Model SELECT.');
  const report={};
  const preparedSql=await spPrepareGeneratedBusinessModelSql(proposal.sql,rec.sourceObjects,rec.description||rec.reason||rec.label||rec.name||'',{validateOnTarget:true,report});
  return {sql:preparedSql,description:String(proposal.description||rec.description||rec.reason||'').trim(),targetError:report.targetError||''};
}
function spUpdateAiPlanSelectionUi(root){
  const selected=spAiSelectedBv.size+spAiSelectedCurated.size;
  const count=root.querySelector('#sp-ai-selected-count');if(count)count.textContent=`${selected} selected`;
  const apply=root.querySelector('#btn-sp-ai-apply');if(apply)apply.disabled=!(selected&&!spAiPlanApplying);
}
async function spApplyAiPlan(){
  if(!spAiRecommendations)return;
  const bv=spAiRecommendations.businessVault.filter((_,i)=>spAiSelectedBv.has(i));
  const curated=spAiRecommendations.curatedDatasets.filter((_,i)=>spAiSelectedCurated.has(i));
  if(!bv.length&&!curated.length){toast('Select at least one recommendation to apply.','err');return;}
  spAiPlanApplying=true;renderAll();
  pushUndo('apply Studio Plus AI plan');
  let bvAdded=0,curatedAdded=0,sqlFailed=0,firstCurated=null;
  try{
    for(const rec of bv){
      const d=rec.definition;if(spExistingManagedName(d.name))continue;
      let sql='';try{sql=spBuildBvSelect(d);}catch(_err){continue;}
      spManagedBvObjects().push({id:uid('bvobj'),type:d.type,name:d.name,label:d.label||d.name,description:rec.reason||'',parentHub:d.parentHub||'',satellites:[...(d.satellites||[])],links:[...(d.links||[])],sql,status:'draft',deployedAt:null,deployedName:null,deployedSchema:null,lastError:''});
      bvAdded++;
    }
    for(const rec of curated){
      if(spExistingManagedName(rec.name))continue;
      let sql='',description=rec.description||rec.reason||'',lastError='';
      try{const generated=await spAiGenerateCuratedSql(rec);sql=generated.sql;description=generated.description||description;if(generated.targetError){lastError=`The target rejected the generated SQL: ${generated.targetError}`;sqlFailed++;}}
      catch(err){lastError=`AI SQL generation needs review: ${err.message}`;sqlFailed++;}
      const created={id:uid('bvview'),name:rec.name,label:rec.label||rec.name,type:rec.type||'custom',materialization:rec.materialization||'table',description,sourceObjects:[...(rec.sourceObjects||[])],sql,status:'draft',deployedAt:null,deployedName:null,deployedMaterialization:null,deployedSchema:null,lastError};
      spManagedViews().push(created);if(!firstCurated)firstCurated=created;
      curatedAdded++;
    }
    scheduleAutosave();
    if(firstCurated)spViewDraft={id:firstCurated.id,name:firstCurated.name,label:firstCurated.label,type:firstCurated.type,materialization:firstCurated.materialization,description:firstCurated.description,sourceObjects:[...(firstCurated.sourceObjects||[])],sql:firstCurated.sql||''};
    if(bvAdded)spBvSectionOpen=true;
    spWorkflowStep=(bvAdded||curatedAdded)?'build':'plan';
    toast(`Applied AI plan: ${bvAdded} Business Vault draft${bvAdded===1?'':'s'}, ${curatedAdded} business model draft${curatedAdded===1?'':'s'}${sqlFailed?` (${sqlFailed} need SQL review)`:''}. Nothing was deployed.`,'ok');
  }finally{spAiPlanApplying=false;renderAll();}
}

async function spAiSuggestView(){
  if(!spViewDraft.sourceObjects.length){toast('Select the Vault objects the AI is allowed to use first.','err');return;}
  spViewAiStatus='loading';spViewAiError='';spViewAiProposal=null;renderAll();
  const tables=spViewSourceTables().filter(t=>spViewDraft.sourceObjects.includes(t.name));
  const joins=spComputeJoinMapForTables(tables);
  const dialect=spSqlDialectLabel();
  const rules=`You are designing ONE reusable curated business dataset over a Data Vault. The user has explicitly selected the only source objects you may use. Use each object's supplied qualified name exactly. Return a safe ${dialect} SELECT query only as data inside JSON; do not emit CREATE VIEW or any DDL. Never invent tables or columns. Prefer business-readable output columns and unique aliases. Respect Data Vault history: for a Current entity view, choose the latest/current satellite rows using available load_dts/load_end_dts style fields; for History preserve useful temporal history; for Entity 360 combine only relationships evidenced by the supplied authoritative join list. If the requested type cannot be safely produced from the selected metadata, keep the SQL conservative and explain the limitation in description. Do not use pg_input_is_valid() or other version-specific helper functions; prefer broadly supported SQL for the configured target version.\n\n${spBusinessModelColumnRules()}\n\n${spSqlDialectPromptRules()}\nRespond with ONLY minified JSON matching: {"name":"snake_case_view_name","label":"Business label","description":"what the view represents","sql":"SELECT ...","columns":["..."]}`;
  const user=`Requested dataset type: ${spViewTypeLabel(spViewDraft.type)}\nUser description: ${spViewDraft.description||'(none)'}\nPreferred name: ${spViewDraft.name||'(choose one)'}\n\nAllowed source objects:\n${spSchemaSummaryForNames(spViewDraft.sourceObjects)}\n\nAuthoritative joins:\n${joins||'(No shared Hub-key joins were found; do not invent one.)'}`;
  try{
    const proposal=await spCallOpenAI(rules,user,0.2);
    if(!proposal||!proposal.name||!proposal.sql)throw new Error('AI response did not contain a valid Business Model proposal.');
    const report={};
    proposal.sql=await spPrepareGeneratedBusinessModelSql(proposal.sql,spViewDraft.sourceObjects,spViewDraft.description||spViewDraft.label||spViewDraft.name||'',{validateOnTarget:true,report});
    proposal.targetError=report.targetError||'';
    spViewAiProposal=proposal;spViewAiStatus='ok';
  }catch(err){spViewAiStatus='error';spViewAiError=err.message;toast('Could not propose the Business Model: '+err.message,'err');}
  renderAll();
}
async function spPreviewViewDraft(){
  const issue=spSingleSelectIssue(spViewDraft.sql); if(issue){toast(issue,'err');return;}
  spViewPreview={loading:true,rows:[],fields:[],error:''};renderAll();
  try{
    const rows=await spQuery(spSelectLimit(spViewDraft.sql,10));
    spViewPreview={loading:false,rows,fields:rows[0]?Object.keys(rows[0]):[],error:''};
  }catch(err){spViewPreview={loading:false,rows:[],fields:[],error:err.message};}
  renderAll();
}
function spViewQualifiedName(view){ return spBusinessQualifiedTable(view.name); }
function spMaterializationLabel(view){ return (view.materialization||'view')==='table'?'Persisted table':'Live view'; }
function spViewDeployDdl(view){
  const sql=String(view.sql||'').trim().replace(/;\s*$/,'');
  const q=spViewQualifiedName(view);
  if((view.materialization||'view')==='table'){
    if(spIsSqlServerDialect()) return `DROP TABLE IF EXISTS ${q};\nSELECT * INTO ${q} FROM (\n${sql}\n) AS _sp_materialized;`;
    return `DROP TABLE IF EXISTS ${q};\nCREATE TABLE ${q} AS\n${sql};`;
  }
  if(spIsSqlServerDialect()) return `CREATE OR ALTER VIEW ${q} AS\n${sql};`;
  return `CREATE OR REPLACE VIEW ${q} AS\n${sql};`;
}
function spViewDropDdl(view,nameOverride,materializationOverride,schemaOverride=spBusinessSchemaName()){
  const materialization=materializationOverride||view.materialization||'view';
  return `${materialization==='table'?'DROP TABLE':'DROP VIEW'} IF EXISTS ${spQualifiedTableInSchema(nameOverride||view.name,schemaOverride)};`;
}
// options.timeoutSeconds raises the server-side statement timeout for builds
// that materialise a table (CREATE TABLE AS SELECT); the server clamps it.
async function spExecuteViewDdl(sql,options={}){
  await ensureLocalServerReachable();
  const timeoutSeconds=options.timeoutSeconds?{timeoutSeconds:options.timeoutSeconds}:{};
  if(spConn.managedTarget || spConn.dialect!=='postgresql'){
    return externalApi('/api/external-execute-sql',{...spConnectionPayload(),schema:spConn.schema,sql,...timeoutSeconds});
  }
  const response=await localFetch('/api/execute-sql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...spConnectionPayload(),sql,...timeoutSeconds})});
  const data=await response.json();if(!data.ok)throw new Error(data.error||'View deployment failed.');return data;
}
// Turn the raw database error into something the person can act on.
function spExplainDeployError(message){
  const text=String(message||'Deployment failed.');
  if(/statement timeout|timed out|timeout expired/i.test(text)){
    return `${text} — the build ran longer than ${Math.round(SP_MATERIALISE_TIMEOUT_SECONDS/60)} minutes. Restrict the SELECT (for example current Satellite rows only, or fewer columns), or switch this model to a Live view.`;
  }
  if(/column .* does not exist|invalid column name|unknown column/i.test(text)){
    return `${text} — the SQL uses a column that is not on that table. Edit the SQL, or use Fix with AI to repair it against the real error.`;
  }
  return text;
}
async function spDeployManagedView(id,options={}){
  const view=spFindManagedView(id);if(!view)return false;
  const schemaIssue=spBusinessSchemaDeployIssue();if(schemaIssue){if(!options.quiet)toast(schemaIssue,'err');return false;}
  const dependencyIssue=spBusinessModelDependencyIssue(view);if(dependencyIssue){if(!options.quiet)toast(dependencyIssue,'err');return false;}
  const issue=spSingleSelectIssue(view.sql);
  if(issue){if(options.quiet){view.status='error';view.lastError=issue;}else toast(issue,'err');return false;}
  spViewDeployingId=id;if(!options.quiet)renderAll();
  try{
    await spQuery(spValidationSql(view.sql));
    const previousName=view.deployedName||view.name;
    const previousMaterialization=view.deployedMaterialization||view.materialization||'view';
    const previousSchema=view.deployedSchema||spConn.schema;
    const nextMaterialization=view.materialization||'table';
    const nextSchema=spBusinessSchemaName();
    // A type change at the same qualified name must be dropped first. Name or
    // schema migrations can be created first and the legacy object removed only
    // after the new deployment succeeds.
    if(view.deployedAt && previousName===view.name && previousSchema===nextSchema && previousMaterialization!==nextMaterialization){
      await spExecuteViewDdl(spViewDropDdl(view,previousName,previousMaterialization,previousSchema));
    }
    await spExecuteViewDdl(spViewDeployDdl(view),{timeoutSeconds:SP_MATERIALISE_TIMEOUT_SECONDS});
    if(view.deployedAt && (previousName!==view.name || previousSchema!==nextSchema)){
      await spExecuteViewDdl(spViewDropDdl(view,previousName,previousMaterialization,previousSchema)).catch(()=>{});
    }
    view.status='deployed';view.deployedAt=new Date().toISOString();view.deployedName=view.name;view.deployedMaterialization=nextMaterialization;view.deployedSchema=nextSchema;view.lastError='';
    scheduleAutosave();
    if(!options.quiet)toast(`${view.name} ${(view.materialization||'table')==='table'?'loaded into a persisted table':'deployed as a live view'} on ${spSqlDialectLabel()}.`,'ok');
    if(!options.skipIntrospect)await spIntrospectSchema({quiet:true,preserveDraft:true});
    return true;
  }catch(err){const explained=spExplainDeployError(err.message);view.status='error';view.lastError=explained;if(!options.quiet)toast(`Could not deploy ${view.name}: ${explained}`,'err');return false;}
  finally{spViewDeployingId=null;if(!options.quiet)renderAll();}
}

async function spDeleteManagedView(id){
  const view=spFindManagedView(id);if(!view)return;
  const deployed=!!view.deployedAt;
  const msg=deployed?`Delete ${view.name}? This will DROP the deployed ${spMaterializationLabel(view).toLowerCase()} and remove it from the Studio Plus project.`:`Delete draft ${view.name}?`;
  if(!confirm(msg))return;
  try{
    if(deployed) await spExecuteViewDdl(spViewDropDdl(view,view.deployedName||view.name,view.deployedMaterialization||view.materialization||'view',view.deployedSchema||spBusinessSchemaName()));
    pushUndo('delete business model');
    state.businessViews=spManagedViews().filter(v=>v.id!==id);
    spReportingSources.delete(view.name);
    spResetReportPlan();
    if(spViewDraft.id===id)spResetViewDraft();
    scheduleAutosave();toast(`${view.name} deleted.`,'ok');
    if(deployed) await spIntrospectSchema({quiet:true,preserveDraft:true});
  }catch(err){toast(`Could not delete ${view.name}: ${err.message}`,'err');}
  renderAll();
}
