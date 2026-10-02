/* Studio Plus — report SQL guards, report state, saved-report library and persisted plan/goal. */
// Report-generation SQL goes through a stricter client-side gate before it
// ever reaches /api/query. Models occasionally wrap SQL in markdown fences,
// append a trailing semicolon, or emit a SET/temp-table statement before the
// SELECT. The read-only endpoint intentionally rejects those shapes; normalise
// harmless presentation noise here and surface/repair genuinely multi-statement
// SQL while the report is still being generated.
function spNormalizeReportSql(sql){
  let text=String(sql||'').trim();
  text=text.replace(/^```(?:sql)?\s*/i,'').replace(/\s*```$/,'').trim();
  text=text.replace(/^(?:sql|query)\s*:\s*/i,'').trim();
  return text.replace(/;\s*$/,'').trim();
}
function spReportSqlIssue(sql){
  const text=spNormalizeReportSql(sql);
  if(!text)return 'Generated report SQL is empty.';
  if(!/^(SELECT|WITH)\s/i.test(text))return 'Report datasets must contain exactly one SELECT (or WITH … SELECT) statement.';
  const masked=text
    .replace(/'(?:''|[^'])*'/g,"''")
    .replace(/"(?:""|[^"])*"/g,'""')
    .replace(/--[^\n\r]*/g,' ')
    .replace(/\/\*[\s\S]*?\*\//g,' ');
  if(masked.includes(';'))return 'Report datasets must contain one SQL statement only; multiple statements are not allowed.';
  if(/\b(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|SET|DECLARE|EXEC(?:UTE)?|CALL)\b/i.test(masked))return 'Report datasets must be read-only SELECT queries without setup, DDL or DML statements.';
  return spSqlDialectIssue(text);
}
function spExcelSheetName(name){
  const cleaned=String(name||'').replace(/[\[\]*?:/\\]/g,' ').replace(/'+/g,'').replace(/\s+/g,' ').trim();
  return (cleaned||'Sheet').slice(0,31);
}
function spViewsWithExcelSheetNames(views){
  const used=new Set(['instructions']);
  return (views||[]).map(view=>{
    const base=spExcelSheetName(view.sheet_name||view.view_name||'Sheet');
    let name=base;
    let n=2;
    while(used.has(name.toLowerCase())){
      const suffix='_'+n;
      name=base.slice(0,31-suffix.length)+suffix;
      n++;
    }
    used.add(name.toLowerCase());
    return {...view,sheet_name:name};
  });
}
async function spPrepareGeneratedReportViews(views){
  let prepared=spViewsWithExcelSheetNames((views||[]).map(v=>({...v,sql:spNormalizeReportSql(v.sql)})));
  const invalid=prepared.filter(v=>spReportSqlIssue(v.sql));
  if(!invalid.length)return prepared;

  const repairRules=`You repair generated ${spSqlDialectLabel()} reporting SQL. Return ONLY minified JSON in the exact shape {"views":[{"view_name":"same_name","sql":"SELECT ..."}]}. For every supplied view: return exactly ONE read-only SELECT or WITH … SELECT statement; do not use SET, DECLARE, CREATE, temp tables, DDL, DML, stored procedures, or multiple statements; do not wrap SQL in markdown fences; do not append a semicolon. Preserve the requested output columns and business meaning. Use ONLY the supplied approved Business Models, columns, and authoritative joins.\n\n${spSqlDialectPromptRules()}`;
  const repairInput=JSON.stringify({
    approved_schema_and_joins:spSchemaSummaryWithJoinsText(),
    invalid_views:invalid.map(v=>({view_name:v.view_name||v.sheet_name,columns:v.columns||[],purpose:v.purpose||'',sql:v.sql,error:spReportSqlIssue(v.sql)})),
  });
  const repaired=await spCallOpenAI(repairRules,repairInput,0);
  if(!repaired||!Array.isArray(repaired.views))throw new Error('Generated report SQL was not a single SELECT and the automatic repair pass returned no views.');
  const byName=new Map(repaired.views.map(v=>[String(v.view_name||''),spNormalizeReportSql(v.sql)]));
  prepared=prepared.map(v=>{
    const name=String(v.view_name||v.sheet_name||'');
    return byName.has(name)?{...v,sql:byName.get(name)}:v;
  });
  const remaining=prepared.map(v=>({v,issue:spReportSqlIssue(v.sql)})).filter(x=>x.issue);
  if(remaining.length)throw new Error(`Could not reduce generated report SQL to a single safe SELECT for ${remaining.map(x=>x.v.view_name||x.v.sheet_name).join(', ')}: ${remaining.map(x=>x.issue).join('; ')}`);
  return prepared;
}
async function spRepairReportViewsAfterTargetValidation(views,validation){
  const failed=(views||[]).filter(v=>{
    const result=validation&&validation[spViewKey(v)];
    return result&&!result.ok;
  });
  if(!failed.length)return {views,validation,repaired:false};
  const repairRules=`The connected ${spSqlDialectLabel()} database rejected generated reporting SQL. Repair ONLY the failed queries using the actual target error supplied for each query. Return ONLY minified JSON in the exact shape {"views":[{"view_name":"same_name","sql":"SELECT ..."}]}. Preserve the intended output columns and business meaning. Use ONLY the supplied approved Business Models, columns and authoritative joins. Return exactly one read-only SELECT or WITH … SELECT per view; no setup statements, DDL/DML, markdown fences, multiple statements or trailing semicolons.\n\n${spSqlDialectPromptRules()}`;
  const repairInput=JSON.stringify({
    approved_schema_and_joins:spSchemaSummaryWithJoinsText(),
    failed_views:failed.map(v=>({view_name:v.view_name||v.sheet_name,columns:v.columns||[],purpose:v.purpose||'',sql:spNormalizeReportSql(v.sql),target_error:validation[spViewKey(v)].error||'Target validation failed.'})),
  });
  const repaired=await spCallOpenAI(repairRules,repairInput,0);
  if(!repaired||!Array.isArray(repaired.views))throw new Error(`The ${spSqlDialectLabel()} target rejected generated SQL and the automatic dialect repair returned no views.`);
  const byName=new Map(repaired.views.map(v=>[String(v.view_name||''),spNormalizeReportSql(v.sql)]));
  const prepared=(views||[]).map(v=>{
    const name=String(v.view_name||v.sheet_name||'');
    return byName.has(name)?{...v,sql:byName.get(name)}:v;
  });
  const remaining=prepared.map(v=>({v,issue:spReportSqlIssue(v.sql)})).filter(x=>x.issue);
  if(remaining.length)throw new Error(`Automatic ${spSqlDialectLabel()} repair still produced invalid SQL for ${remaining.map(x=>x.v.view_name||x.v.sheet_name).join(', ')}: ${remaining.map(x=>x.issue).join('; ')}`);
  const revalidation=await spValidateViewList(prepared);
  return {views:prepared,validation:revalidation,repaired:true};
}

let spSchemaStatus = null; // null | loading | ok | error
let spConnectionSectionOpen = true; // expanded until successful inference; user can reopen it
let spSchemaError = '';
let spSchemaTables = []; // [{ name, objectType, columns:[{name,type}], rowCount }]
let spExcludedEmptyTables = [];
let spReportingSources = new Set(); // user-selected MANAGED business models only
let spDashboardPlanStatus = null;
let spDashboardPlan = null;
let spSectionsIncluded = new Set();
let spCustomDirection = '';
let spGenerateStatus = null;
let spGenerated = null;
let spExpanded = {};
let spOverrides = {};
let spViewValidation = {};
let spSectionValidation = {};
let spValidating = false;
let spSectionOverrides = {};
let spBusinessReady = true;
let spResultAwareDesign = true;
const SP_AI_SAMPLE_ROWS = 30;
const SP_AI_SAMPLE_COLUMNS = 24;
const SP_AI_SAMPLE_STRING = 180;
const SP_AI_SAMPLE_TOTAL_CHARS = 32000;
let spGenerateStage = '';
let spEditingReportId = null;
let spReportScopeOpen = false; // model selection stays collapsed until the user wants to change it

function spCurrentReportTitle(){
  return String((spGenerated&&spGenerated.report_title)||(spDashboardPlan&&spDashboardPlan.title)||'Business report').trim()||'Business report';
}
function spReportFilenameBase(){
  const clean=spCurrentReportTitle().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  return clean||'business_report';
}
function spFinalGeneratedSnapshot(){
  if(!spGenerated)return null;
  return {
    ...JSON.parse(JSON.stringify(spGenerated)),
    report_title:spCurrentReportTitle(),
    views:(spGenerated.views||[]).map(v=>({...JSON.parse(JSON.stringify(v)),sql:spGetViewSql(v)})),
    sections:(spGenerated.sections||[]).map((section,i)=>({...JSON.parse(JSON.stringify(section)),render_js:spSectionOverrides[i]!=null?spSectionOverrides[i]:(section.render_js||'')})),
  };
}
function spReportStatusLabel(report){
  const missing=(report.sourceModels||[]).filter(name=>!spManagedViews().some(v=>v.name===name&&v.deployedAt&&v.status!=='error'));
  return missing.length?`Needs review · ${missing.length} missing model${missing.length===1?'':'s'}`:'Saved';
}
function spSaveCurrentReport(){
  if(!spGenerated){toast('Generate a report before saving it.','err');return;}
  const title=spCurrentReportTitle();
  if(!title){toast('Give the report a name before saving it.','err');return;}
  const now=new Date().toISOString();
  const generated=spFinalGeneratedSnapshot();
  const existing=spEditingReportId?spFindReport(spEditingReportId):null;
  const report={
    id:existing?existing.id:uid('report'),
    name:title,
    sourceModels:[...spReportingSources],
    businessReady:spBusinessReady,
    resultAwareDesign:spResultAwareDesign,
    customDirection:spCustomDirection,
    dashboardPlan:spDashboardPlan?JSON.parse(JSON.stringify(spDashboardPlan)):null,
    sectionsIncluded:[...spSectionsIncluded],
    generated,
    createdAt:existing&&existing.createdAt?existing.createdAt:now,
    updatedAt:now,
  };
  pushUndo(existing?'update saved report':'save report');
  if(existing)Object.assign(existing,report);else spManagedReports().push(report);
  spEditingReportId=report.id;
  scheduleAutosave();
  toast(existing?'Report updated.':'Report saved to the Report Library.','ok');
  renderAll();
}
function spNewReport(){
  spEditingReportId=null;
  spReportingSources=new Set(spDefaultReportingSourceNames());
  spCustomDirection='';spDashboardPlanStatus=null;spDashboardPlan=null;spSectionsIncluded=new Set();spGenerateStatus=null;spGenerated=null;spGenerateStage='';spOverrides={};spExpanded={};spSectionOverrides={};spViewValidation={};spSectionValidation={};
  spPrefillReportDirection();
  renderAll();
}
// The goal typed on the Plan step is the best default for "what should the
// report answer?", so carry it across rather than asking twice.
let spDirectionFromGoal = false;
function spPrefillReportDirection(){
  if(String(spCustomDirection||'').trim())return;
  const goal=String(spAiRecommendPrompt||'').trim();
  if(goal){spCustomDirection=goal;spDirectionFromGoal=true;}
}
function spDirectionIsGoal(){
  return spDirectionFromGoal&&String(spCustomDirection||'').trim()===String(spAiRecommendPrompt||'').trim();
}
// Scope and mode changes reset the generated report. Only ask when that would
// throw away work that exists nowhere else.
function spConfirmDiscardReport(){
  if(!spGenerated)return true;
  const unsaved=!spEditingReportId||Object.keys(spOverrides).length>0||Object.keys(spSectionOverrides).length>0;
  if(!unsaved)return true;
  return confirm('This will discard the generated report, which has unsaved work. Continue?');
}

function spEnsureStudioPlusState(){
  if(!state.studioPlus||typeof state.studioPlus!=='object'||Array.isArray(state.studioPlus))state.studioPlus={goal:'',plan:null};
  return state.studioPlus;
}
function spPersistPlan(){
  const saved=spEnsureStudioPlusState();
  saved.goal=spAiRecommendPrompt;
  saved.plan=spAiRecommendations?{recommendations:JSON.parse(JSON.stringify(spAiRecommendations)),selectedBv:[...spAiSelectedBv],selectedCurated:[...spAiSelectedCurated]}:null;
  scheduleAutosave();
}
function spRestorePlan(){
  const saved=state.studioPlus;
  if(!saved||typeof saved!=='object')return;
  if(!spAiRecommendPrompt&&saved.goal)spAiRecommendPrompt=String(saved.goal);
  const plan=saved.plan;
  if(!spAiRecommendations&&plan&&plan.recommendations&&Array.isArray(plan.recommendations.businessVault)&&Array.isArray(plan.recommendations.curatedDatasets)){
    spAiRecommendations=JSON.parse(JSON.stringify(plan.recommendations));
    spAiSelectedBv=new Set(plan.selectedBv||[]);
    spAiSelectedCurated=new Set(plan.selectedCurated||[]);
    spAiRecommendStatus='ok';
  }
}
// A different project (new, loaded or restored) must not inherit the previous
// project's in-memory plan or report.
function studioPlusResetSession(){
  spAiRecommendPrompt='';spAiRecommendations=null;spAiRecommendStatus=null;spAiRecommendError='';
  spAiSelectedBv=new Set();spAiSelectedCurated=new Set();
  spEditingReportId=null;spCustomDirection='';spDirectionFromGoal=false;
  spResetReportPlan();
  spResetViewDraft();spResetBvDraft();
  spViewBuilderOpen=false;spBvBuilderOpen=false;
  spReportingSources=new Set();
}
function spOpenReport(id){
  const report=spFindReport(id);if(!report)return;
  spEditingReportId=report.id;
  spReportingSources=new Set((report.sourceModels||[]).filter(name=>spManagedViews().some(v=>v.name===name)));
  spBusinessReady=report.businessReady!==false;
  spResultAwareDesign=report.resultAwareDesign!==false;
  spCustomDirection=report.customDirection||'';
  spDashboardPlan=report.dashboardPlan?JSON.parse(JSON.stringify(report.dashboardPlan)):null;
  spSectionsIncluded=new Set(report.sectionsIncluded||[]);
  spGenerated=report.generated?JSON.parse(JSON.stringify(report.generated)):null;
  spGenerateStatus=spGenerated?'ok':null;spGenerateStage='';spOverrides={};spExpanded={};spSectionOverrides={};spViewValidation={};spSectionValidation={};
  if(spGenerated) spRefreshSectionValidation();
  spWorkflowStep='reporting';
  renderAll();
  spRevealEditor(spGenerated?'sp-report-editor':'sp-report-build','sp-report-name');
}
function spDuplicateReport(id){
  const report=spFindReport(id);if(!report)return;
  pushUndo('duplicate report');
  const copy=JSON.parse(JSON.stringify(report));copy.id=uid('report');copy.name=`${report.name} Copy`;if(copy.generated)copy.generated.report_title=copy.name;if(copy.dashboardPlan)copy.dashboardPlan.title=copy.name;copy.createdAt=new Date().toISOString();copy.updatedAt=copy.createdAt;
  spManagedReports().push(copy);scheduleAutosave();toast('Report duplicated.','ok');renderAll();
}
function spDeleteReport(id){
  const report=spFindReport(id);if(!report)return;
  if(!confirm(`Delete saved report "${report.name}"?`))return;
  pushUndo('delete saved report');state.reports=spManagedReports().filter(r=>r.id!==id);if(spEditingReportId===id)spEditingReportId=null;scheduleAutosave();toast('Report deleted.','ok');renderAll();
}
