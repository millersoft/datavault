/* Studio Plus — page render and event wiring, plus generated-report row markup. */
function renderStudioPlus(el){
  spRestorePlan();
  spEnsureBusinessViews();
  spEnsureBusinessVaultObjects();
  spEnsureReports();
  if (spConn.autoDefault!==false) spConn = studioPlusDefaultConnection();
  const managedTarget=!!spConn.managedTarget;
  const dialectLabel=spSqlDialectLabel();
  const selectedCount=spSelectedSchemaTables().length;
  el.innerHTML = `
    <h2 class="section-title">Data Vault Studio Plus</h2>
    <p class="section-desc">Plan the business layer, build and deploy Business Models, then generate reports — all on top of the deployed Vault.</p>
    ${spStatusBarHtml()}

    <details class="panel sp-connect-section" id="sp-connect-section" ${(!spSchemaTables.length||spConnectionSectionOpen||spSchemaStatus==='loading'||spSchemaStatus==='error')?'open':''}>
      <summary><span><strong>Connection &amp; schema</strong></span><span class="hint">${spSchemaTables.length&&spSchemaStatus==='ok'?`✓ ${escapeHtml(dialectLabel)} · ${escapeHtml(spConn.database||'target')} · ${spSchemaTables.length} Raw Vault objects · click to change`:'Connect to the deployed Vault and infer its schema'}</span></summary>
      <div class="sp-connect-section-body">
      ${managedTarget?`<div class="ai-status ok mb">Using the physical ${escapeHtml(dialectLabel)} target configured in Studio. Change target credentials in Connections.</div>`:''}
      <div class="grid cols-4">
        <div class="field"><label>Database type</label><select id="sp-dialect" ${managedTarget?'disabled':''}><option value="${escapeHtml(spConn.dialect)}" selected>${escapeHtml(dialectLabel)}</option>${!managedTarget&&spConn.dialect!=='postgresql'?'<option value="postgresql">PostgreSQL</option>':''}</select></div>
        <div class="field"><label>Host</label><input type="text" id="sp-host" value="${escapeHtml(spConn.host)}" ${managedTarget?'disabled':''}></div>
        <div class="field"><label>Port</label><input type="text" id="sp-port" value="${escapeHtml(spConn.port)}" ${managedTarget?'disabled':''}></div>
        <div class="field"><label>Database</label><input type="text" id="sp-database" value="${escapeHtml(spConn.database)}" ${managedTarget?'disabled':''}></div>
      </div>
      <div class="grid cols-3 mt"><div class="field"><label>Raw Vault schema</label><input type="text" id="sp-schema" value="${escapeHtml(spConn.schema)}" ${managedTarget?'disabled':''}></div><div class="field"><label>Username</label><input type="text" id="sp-user" value="${escapeHtml(spConn.user)}" ${managedTarget?'disabled':''}></div><div class="field"><label>Password</label><input type="password" id="sp-password" value="${escapeHtml(spConn.password)}" ${managedTarget?'disabled':''}></div></div>
      <div class="mt"><button class="btn primary" id="btn-sp-introspect">${spSchemaStatus==='loading'?'Introspecting…':'Infer Schema'}</button></div>
      ${spSchemaStatus==='error'?`<div class="ai-status err mt">${escapeHtml(spSchemaError)}</div>`:''}
      ${spSchemaTables.length?`<p class="hint mt">${spViewSourceTables().length} Raw/Business Vault object(s) available as Business Model inputs. Managed Business Models are excluded as sources.</p>`:''}
      ${spExcludedEmptyTables.length?`<p class="hint mt">${spExcludedEmptyTables.length} empty physical table(s) are kept out of AI/report planning until they contain data.</p>`:''}
      </div>
    </details>
    ${spBusinessSchemaNoticeHtml()}

    ${spWorkflowTabsHtml()}
    ${spSchemaTables.length?'':`<p class="hint">${spSchemaStatus==='loading'?'Reading the deployed Vault…':'Infer the schema above to unlock the workflow.'}</p>`}
    ${spAiSettingsPanelHtml()}
    ${spSchemaTables.length && spWorkflowStep==='plan' ? spAiRecommendationsHtml() : ''}
    ${spSchemaTables.length && spWorkflowStep==='build' ? spBuildStepHtml() : ''}
    ${spSchemaTables.length && spWorkflowStep==='lineage' ? spLineageHtml() : ''}
    ${spSchemaTables.length && spWorkflowStep==='reporting' ? spReportingScopeHtml() : ''}

    ${spSchemaTables.length && spWorkflowStep==='reporting' && spManagedReportingTables().length && selectedCount ? `
    <div class="panel" id="sp-report-build">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Build Report</h3></div>
      <p class="section-desc">Suggestions and generated report queries can use only the ${selectedCount} business model(s) selected above. SQL is generated for <strong>${escapeHtml(spSqlDialectLabel())}</strong> and checked for obvious cross-dialect syntax before it reaches the query endpoint.</p>
      <div class="panel" style="margin-top:10px;background:var(--panel-2);">
        <label class="checkbox-row" style="align-items:flex-start;"><input type="checkbox" id="sp-business-ready" ${spBusinessReady?'checked':''}><span><strong>Business-ready report</strong><br><span class="hint">Use a BI-consultant planning pass before SQL so the report is organised around business questions and decision-useful analysis.</span></span></label>
        <label class="checkbox-row mt" style="align-items:flex-start;"><input type="checkbox" id="sp-result-aware" ${spResultAwareDesign?'checked':''} ${spBusinessReady?'':'disabled'}><span><strong>Result-aware design review</strong><br><span class="hint">After SQL validates, Studio Plus samples up to ${SP_AI_SAMPLE_ROWS} rows per dataset to improve visual and analytical choices.</span></span></label>
      </div>
      <div class="field mt"><label>What should the report answer? <span class="hint">(optional${spDirectionIsGoal()?' — prefilled from your plan goal':''})</span></label><textarea id="sp-custom-direction" rows="3" placeholder="e.g. focus on the last 12 months, break revenue down by store">${escapeHtml(spCustomDirection)}</textarea></div>
      <button class="btn mt" id="btn-sp-suggest">${spDashboardPlanStatus==='loading'?'Thinking…':spDashboardPlan?(spBusinessReady?'Suggest different sub reports':'Suggest a different dashboard'):(spBusinessReady?'Suggest sub reports':'Suggest a comprehensive dashboard')}</button>
      <p class="hint mt">The planning pass receives the text above plus the selected business models, their columns, row counts and valid joins.</p>
      ${spDashboardPlan ? `<div class="panel" style="margin-top:10px;background:var(--panel-2);"><div style="font-family:var(--font-display);font-weight:700;font-size:14px;margin-bottom:10px;color:var(--brand-deep);">${escapeHtml(spDashboardPlan.title)}</div>${spDashboardPlan.sections.map((s,i)=>`<label class="sp-suggestion-row"><input type="checkbox" data-secidx="${i}" ${spSectionsIncluded.has(i)?'checked':''}><div><div style="font-weight:600;">${escapeHtml(s.name)}</div>${s.analysis_type?`<div class="hint" style="margin:2px 0;color:var(--brand-deep);font-weight:600;">${escapeHtml(s.analysis_type)}</div>`:''}${s.business_question?`<div class="hint" style="margin:2px 0;"><strong>Business question:</strong> ${escapeHtml(s.business_question)}</div>`:''}<p class="hint" style="margin:2px 0 0;">${escapeHtml(s.description)}</p></div></label>`).join('')}</div>` : ''}
      <button class="btn primary mt" id="btn-sp-generate" ${spGenerateStatus==='loading'?'disabled':''}>${spGenerateStatus==='loading'?(spGenerateStage||'Generating…'):(spBusinessReady?'Generate business-ready report':'Generate report')}</button>
    </div>` : ''}

    ${spWorkflowStep==='reporting' && spGenerated ? `<div class="panel" id="sp-report-editor">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>${spEditingReportId?'Saved report':'Generated report'}</h3></div>
      <div class="grid cols-2"><div class="field"><label>Report name</label><input type="text" id="sp-report-name" value="${escapeHtml(spCurrentReportTitle())}" placeholder="Business report"></div><div class="field"><label>Download filenames</label><input type="text" id="sp-report-filename-preview" value="${escapeHtml(spReportFilenameBase())}.xlsx / .html" disabled></div></div>
      ${spGenerated.notes?`<p class="hint mt">${escapeHtml(spGenerated.notes)}</p>`:''}
      <div class="sp-bv-actions mt"><button class="btn primary" id="btn-sp-save-report">${spEditingReportId?'Update Report In Library':'Save Report'}</button><button class="btn ghost" id="btn-sp-regenerate" ${spGenerateStatus==='loading'?'disabled':''}>Regenerate with AI</button><button class="btn ghost" id="btn-sp-validate" title="Runs every query against the target with zero rows returned, and compiles each section script the same way the downloaded HTML will. It does not test row-level data errors or speed.">${spValidating?'Validating…':'Validate SQL Syntax'}</button></div>
      <div class="grid cols-3 mt"><button class="btn primary" id="btn-sp-dl-html-data" title="Runs the queries now and embeds the results, so the file opens fully populated. You can still load a refreshed workbook into it later.">⬇ HTML report with current data</button><button class="btn ghost" id="btn-sp-dl-excel">↻ Rerun SQL & download Excel</button><button class="btn ghost" id="btn-sp-dl-html" title="An empty report shell that needs an Excel workbook loaded into it.">⬇ HTML report (load Excel later)</button></div>
      <p class="hint mt">The report name suggested by AI is reused for both saved-report identity and download filenames. Edit it above if you want a different name.</p>
      <div class="field mt"><label>Already have a workbook you want fresh data in?</label><input type="file" id="sp-refresh-file" accept=".xlsx,.xls"></div><div id="sp-refresh-status"></div>
      <div class="export-file-list mt">${spGenerated.views.map(v=>spViewRowHtml(v)).join('')}</div><p class="hint mt" style="margin-top:18px;">Report sections — editable rendering code:</p><div class="export-file-list mt">${spGenerated.sections.map((s,i)=>spSectionRowHtml(s,i)).join('')}</div>
    </div>` : ''}
  `;

  const bindSp=(id,key,eventName='input')=>{const node=document.getElementById(id);if(node&&!node.disabled)node.addEventListener(eventName,e=>{spConn[key]=e.target.value;spConn.autoDefault=false;spConn.managedTarget=false;});};
  bindSp('sp-dialect','dialect','change');bindSp('sp-host','host');bindSp('sp-port','port');bindSp('sp-database','database');bindSp('sp-schema','schema');bindSp('sp-user','user');bindSp('sp-password','password');
  const introspect=document.getElementById('btn-sp-introspect');if(introspect)introspect.addEventListener('click',()=>spIntrospectSchema());
  const createBusinessSchema=document.getElementById('btn-sp-create-business-schema');if(createBusinessSchema)createBusinessSchema.addEventListener('click',spCreateBusinessSchema);
  const spConnectSection=document.getElementById('sp-connect-section');if(spConnectSection)spConnectSection.addEventListener('toggle',()=>{spConnectionSectionOpen=spConnectSection.open;});
  el.querySelectorAll('[data-sp-workflow-step]').forEach(b=>b.addEventListener('click',()=>spGoToStep(b.dataset.spWorkflowStep)));
  const chipTarget=document.getElementById('sp-chip-target');if(chipTarget)chipTarget.addEventListener('click',()=>{spConnectionSectionOpen=true;renderAll();spRevealEditor('sp-connect-section');});
  const chipAi=document.getElementById('sp-chip-ai');if(chipAi)chipAi.addEventListener('click',()=>{spAiSettingsOpen=true;renderAll();spRevealEditor('sp-ai-settings');});
  const deployPending=document.getElementById('btn-sp-deploy-pending');if(deployPending)deployPending.addEventListener('click',spDeployAllPending);
  const deployBv=document.getElementById('btn-sp-deploy-bv');if(deployBv)deployBv.addEventListener('click',()=>spDeployPending('bv'));
  const deployModels=document.getElementById('btn-sp-deploy-models');if(deployModels)deployModels.addEventListener('click',spDeployAllModels);
  const bvOpen=document.getElementById('btn-sp-bv-open');if(bvOpen)bvOpen.addEventListener('click',()=>{spBvSectionOpen=true;renderAll();});
  el.querySelectorAll('[data-sp-view-fix]').forEach(b=>b.addEventListener('click',()=>spAiFixManagedView(b.dataset.spViewFix)));
  el.querySelectorAll('[data-sp-view-lineage]').forEach(b=>b.addEventListener('click',()=>spShowModelLineage(b.dataset.spViewLineage)));

  const aiRecPrompt=document.getElementById('sp-ai-recommend-prompt');if(aiRecPrompt)aiRecPrompt.addEventListener('input',e=>{spAiRecommendPrompt=e.target.value;spEnsureStudioPlusState().goal=e.target.value;});
  const aiRecommend=document.getElementById('btn-sp-ai-recommend');if(aiRecommend)aiRecommend.addEventListener('click',spAiSuggestArchitecture);
  el.querySelectorAll('[data-sp-ai-bv-select]').forEach(cb=>cb.addEventListener('change',e=>{const i=Number(e.target.dataset.spAiBvSelect);if(e.target.checked)spAiSelectedBv.add(i);else spAiSelectedBv.delete(i);spPersistPlan();spUpdateAiPlanSelectionUi(el);}));
  el.querySelectorAll('[data-sp-ai-curated-select]').forEach(cb=>cb.addEventListener('change',e=>{const i=Number(e.target.dataset.spAiCuratedSelect);if(e.target.checked)spAiSelectedCurated.add(i);else spAiSelectedCurated.delete(i);spPersistPlan();spUpdateAiPlanSelectionUi(el);}));
  const aiApply=document.getElementById('btn-sp-ai-apply');if(aiApply)aiApply.addEventListener('click',spApplyAiPlan);
  el.querySelectorAll('[data-sp-ai-bv]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();spOpenAiBvRecommendation(b.dataset.spAiBv);}));
  el.querySelectorAll('[data-sp-ai-curated]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();spOpenAiCuratedRecommendation(b.dataset.spAiCurated);}));

  const bvType=document.getElementById('sp-bv-type');if(bvType)bvType.addEventListener('change',e=>{spResetBvDraft(e.target.value);spBvSectionOpen=true;spBvBuilderOpen=true;renderAll();});
  const bvBuilder=document.getElementById('sp-bv-builder');if(bvBuilder)bvBuilder.addEventListener('toggle',()=>{spBvBuilderOpen=bvBuilder.open;});
  const reportScope=document.getElementById('sp-report-scope');if(reportScope)reportScope.addEventListener('toggle',()=>{spReportScopeOpen=reportScope.open;});
  const viewBuilder=document.getElementById('sp-view-builder');if(viewBuilder)viewBuilder.addEventListener('toggle',()=>{spViewBuilderOpen=viewBuilder.open;});
  const bvName=document.getElementById('sp-bv-name');if(bvName)bvName.addEventListener('input',e=>{spBvDraft.name=e.target.value;spBvPreview=null;});
  const bvLabel=document.getElementById('sp-bv-label');if(bvLabel)bvLabel.addEventListener('input',e=>{spBvDraft.label=e.target.value;});
  const bvDesc=document.getElementById('sp-bv-description');if(bvDesc)bvDesc.addEventListener('input',e=>{spBvDraft.description=e.target.value;});
  const bvHub=document.getElementById('sp-bv-hub');if(bvHub)bvHub.addEventListener('change',e=>{spBvDraft.parentHub=e.target.value;const allowed=new Set(spBvCompatibleSatellites(e.target.value).map(t=>t.name));spBvDraft.satellites=spBvDraft.satellites.filter(n=>allowed.has(n));spBvPreview=null;renderAll();});
  el.querySelectorAll('[data-sp-bv-sat]').forEach(cb=>cb.addEventListener('change',e=>{const set=new Set(spBvDraft.satellites);if(e.target.checked)set.add(e.target.dataset.spBvSat);else set.delete(e.target.dataset.spBvSat);spBvDraft.satellites=[...set];spBvPreview=null;}));
  el.querySelectorAll('[data-sp-bv-link]').forEach(cb=>cb.addEventListener('change',e=>{const set=new Set(spBvDraft.links);if(e.target.checked)set.add(e.target.dataset.spBvLink);else set.delete(e.target.dataset.spBvLink);spBvDraft.links=[...set];spBvPreview=null;}));
  const bvAddAll=document.getElementById('btn-sp-bv-add-all');if(bvAddAll)bvAddAll.addEventListener('click',()=>{if(spBvDraft.type==='bridge')spBvDraft.links=spBvLinkTables().map(t=>t.name);else spBvDraft.satellites=spBvCompatibleSatellites(spBvDraft.parentHub).map(t=>t.name);spBvPreview=null;renderAll();});
  const bvClear=document.getElementById('btn-sp-bv-clear');if(bvClear)bvClear.addEventListener('click',()=>{if(spBvDraft.type==='bridge')spBvDraft.links=[];else spBvDraft.satellites=[];spBvPreview=null;renderAll();});
  const bvNew=document.getElementById('btn-sp-bv-new');if(bvNew)bvNew.addEventListener('click',()=>{spResetBvDraft(spBvDraft.type);spBvSectionOpen=true;spBvBuilderOpen=true;renderAll();});
  const bvPreview=document.getElementById('btn-sp-bv-preview');if(bvPreview)bvPreview.addEventListener('click',spPreviewBvDraft);
  const bvSave=document.getElementById('btn-sp-bv-save');if(bvSave)bvSave.addEventListener('click',()=>spSaveBvDraft());
  const bvSaveDeploy=document.getElementById('btn-sp-bv-save-deploy');if(bvSaveDeploy)bvSaveDeploy.addEventListener('click',()=>spSaveBvDraft({deploy:true}));
  const bvDeployAll=document.getElementById('btn-sp-bv-deploy-all');if(bvDeployAll)bvDeployAll.addEventListener('click',spDeployAllBv);
  const bvAddRecommended=document.getElementById('btn-sp-bv-add-recommended');if(bvAddRecommended)bvAddRecommended.addEventListener('click',spAddAllBvRecommendations);
  el.querySelectorAll('[data-sp-bv-rec]').forEach(b=>b.addEventListener('click',()=>spUseBvRecommendation(b.dataset.spBvRec)));
  el.querySelectorAll('[data-sp-bv-edit]').forEach(b=>b.addEventListener('click',()=>spEditBvObject(b.dataset.spBvEdit)));
  el.querySelectorAll('[data-sp-bv-deploy]').forEach(b=>b.addEventListener('click',()=>spDeployBvObject(b.dataset.spBvDeploy)));
  el.querySelectorAll('[data-sp-bv-delete]').forEach(b=>b.addEventListener('click',()=>spDeleteBvObject(b.dataset.spBvDelete)));

  const draftField=(id,key,event='input')=>{const n=document.getElementById(id);if(n)n.addEventListener(event,e=>{spViewDraft[key]=e.target.value;spViewPreview=null;});};
  draftField('sp-view-name','name');draftField('sp-view-label','label');draftField('sp-view-type','type','change');draftField('sp-view-materialization','materialization','change');draftField('sp-view-description','description');draftField('sp-view-sql','sql');
  el.querySelectorAll('[data-sp-view-source]').forEach(cb=>cb.addEventListener('change',e=>{const name=e.target.dataset.spViewSource;const set=new Set(spViewDraft.sourceObjects);if(e.target.checked)set.add(name);else set.delete(name);spViewDraft.sourceObjects=[...set];spViewPreview=null;spUpdateViewSourceUi(el);}));
  const sourceSearch=document.getElementById('sp-view-source-search');if(sourceSearch)sourceSearch.addEventListener('input',e=>{spViewSourceSearch=String(e.target.value||'');const q=spViewSourceSearch.trim().toLowerCase();el.querySelectorAll('[data-sp-source-row]').forEach(row=>{row.style.display=!q||String(row.dataset.spSourceSearch||'').includes(q)?'':'none';});});
  const setSourceKind=kind=>{const set=new Set(spViewDraft.sourceObjects);spViewSourceTables().filter(t=>spBusinessObjectKind(t)===kind).forEach(t=>set.add(t.name));spViewDraft.sourceObjects=[...set];spViewPreview=null;renderAll();};
  const allPits=document.getElementById('btn-sp-source-pits');if(allPits)allPits.addEventListener('click',()=>setSourceKind('PIT'));
  const allBridges=document.getElementById('btn-sp-source-bridges');if(allBridges)allBridges.addEventListener('click',()=>setSourceKind('Bridge'));
  const clearSources=document.getElementById('btn-sp-source-clear');if(clearSources)clearSources.addEventListener('click',()=>{spViewDraft.sourceObjects=[];spViewPreview=null;renderAll();});
  const viewNew=document.getElementById('btn-sp-view-new');if(viewNew)viewNew.addEventListener('click',()=>{spResetViewDraft();spViewBuilderOpen=true;renderAll();});
  const starter=document.getElementById('btn-sp-view-starter');if(starter)starter.addEventListener('click',()=>{spViewDraft.sql=spFormatSqlForEditor(spViewDraftStarterSql());spViewPreview=null;renderAll();});
  const formatSql=document.getElementById('btn-sp-view-format');if(formatSql)formatSql.addEventListener('click',()=>{spViewDraft.sql=spFormatSqlForEditor(spViewDraft.sql);spViewPreview=null;renderAll();});
  const viewAi=document.getElementById('btn-sp-view-ai');if(viewAi)viewAi.addEventListener('click',spAiSuggestView);
  const aiAccept=document.getElementById('btn-sp-view-ai-accept');if(aiAccept)aiAccept.addEventListener('click',spAcceptAiViewProposal);
  const aiDiscard=document.getElementById('btn-sp-view-ai-discard');if(aiDiscard)aiDiscard.addEventListener('click',()=>{spViewAiProposal=null;spViewAiStatus=null;renderAll();});
  const viewPreview=document.getElementById('btn-sp-view-preview');if(viewPreview)viewPreview.addEventListener('click',spPreviewViewDraft);
  const viewSave=document.getElementById('btn-sp-view-save');if(viewSave)viewSave.addEventListener('click',()=>spSaveViewDraft());
  const viewSaveDeploy=document.getElementById('btn-sp-view-save-deploy');if(viewSaveDeploy)viewSaveDeploy.addEventListener('click',()=>spSaveViewDraft({deploy:true}));
  el.querySelectorAll('[data-sp-view-edit]').forEach(b=>b.addEventListener('click',()=>spEditManagedView(b.dataset.spViewEdit)));
  el.querySelectorAll('[data-sp-view-deploy]').forEach(b=>b.addEventListener('click',()=>spDeployManagedView(b.dataset.spViewDeploy)));
  el.querySelectorAll('[data-sp-view-delete]').forEach(b=>b.addEventListener('click',()=>spDeleteManagedView(b.dataset.spViewDelete)));

  el.querySelectorAll('[data-sp-lineage-mode]').forEach(b=>b.addEventListener('click',()=>{spLineageMode=b.dataset.spLineageMode;spLineageZoom=1;renderAll();}));
  const lineageFocus=document.getElementById('sp-lineage-focus');if(lineageFocus)lineageFocus.addEventListener('change',e=>{spLineageSelection=e.target.value;spLineageZoom=1;renderAll();});
  const lineageSearch=document.getElementById('sp-lineage-search');if(lineageSearch)lineageSearch.addEventListener('input',e=>{spLineageSearch=e.target.value;spApplyLineageSearchDom(el);});
  el.querySelectorAll('[data-sp-lineage-layer]').forEach(cb=>cb.addEventListener('change',e=>{const k=e.target.dataset.spLineageLayer;if(e.target.checked)spLineageLayerFilter.add(k);else spLineageLayerFilter.delete(k);renderAll();}));
  el.querySelectorAll('[data-sp-lineage-node]').forEach(node=>{const select=()=>{if(spLineageMode==='focus'&&node.dataset.spLineageKind!=='curated')return;spLineageSelection=node.dataset.spLineageNode;if(spLineageMode==='focus')renderAll();else if(spLineageMode==='entire')spApplyLineageSelectionDom(el);};node.addEventListener('click',select);node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});});
  const linIn=document.getElementById('btn-sp-lineage-in');if(linIn)linIn.addEventListener('click',()=>{spLineageZoom=Math.min(2.5,Math.round((spLineageZoom+.15)*100)/100);spApplyLineageZoomDom(el);});
  const linOut=document.getElementById('btn-sp-lineage-out');if(linOut)linOut.addEventListener('click',()=>{spLineageZoom=Math.max(.55,Math.round((spLineageZoom-.15)*100)/100);spApplyLineageZoomDom(el);});
  const linReset=document.getElementById('btn-sp-lineage-reset');if(linReset)linReset.addEventListener('click',()=>{spLineageZoom=1;spLineageSearch='';spLineageDirection='both';spLineageLayerFilter=new Set(['source','staging','raw','bv','curated','report']);renderAll();});

  const setReporting=names=>{if(!spConfirmDiscardReport())return;spReportingSources=new Set(names);spResetReportPlan();renderAll();};
  const newReportBtn=document.getElementById('btn-sp-report-new');if(newReportBtn)newReportBtn.addEventListener('click',spNewReport);
  el.querySelectorAll('[data-sp-report-open]').forEach(b=>b.addEventListener('click',()=>spOpenReport(b.dataset.spReportOpen)));
  el.querySelectorAll('[data-sp-report-duplicate]').forEach(b=>b.addEventListener('click',()=>spDuplicateReport(b.dataset.spReportDuplicate)));
  el.querySelectorAll('[data-sp-report-delete]').forEach(b=>b.addEventListener('click',()=>spDeleteReport(b.dataset.spReportDelete)));
  const allReport=document.getElementById('btn-sp-report-all');if(allReport)allReport.addEventListener('click',()=>setReporting(spManagedReportingTables().map(t=>t.name)));
  const noReport=document.getElementById('btn-sp-report-none');if(noReport)noReport.addEventListener('click',()=>setReporting([]));
  el.querySelectorAll('[data-sp-report-view]').forEach(cb=>cb.addEventListener('change',e=>{if(!spConfirmDiscardReport()){renderAll();return;}const name=e.target.dataset.spReportView;if(e.target.checked)spReportingSources.add(name);else spReportingSources.delete(name);spResetReportPlan();renderAll();}));

  if(spSchemaTables.length)wireAiSettings(el,'sp',()=>renderAll());
  const aiDetails=document.getElementById('sp-ai-settings');if(aiDetails)aiDetails.addEventListener('toggle',()=>{spAiSettingsOpen=aiDetails.open;});
  const businessReadyEl=document.getElementById('sp-business-ready');if(businessReadyEl)businessReadyEl.addEventListener('change',e=>{if(!spConfirmDiscardReport()){renderAll();return;}spBusinessReady=e.target.checked;if(!spBusinessReady)spResultAwareDesign=false;else if(!spResultAwareDesign)spResultAwareDesign=true;spDashboardPlan=null;spSectionsIncluded=new Set();spGenerated=null;spGenerateStage='';renderAll();});
  const resultAwareEl=document.getElementById('sp-result-aware');if(resultAwareEl)resultAwareEl.addEventListener('change',e=>{spResultAwareDesign=e.target.checked;});
  const suggestBtn=document.getElementById('btn-sp-suggest');if(suggestBtn)suggestBtn.addEventListener('click',spSuggestDashboardPlan);
  el.querySelectorAll('[data-secidx]').forEach(cb=>cb.addEventListener('change',e=>{const i=Number(e.target.dataset.secidx);if(e.target.checked)spSectionsIncluded.add(i);else spSectionsIncluded.delete(i);}));
  const customDirEl=document.getElementById('sp-custom-direction');if(customDirEl)customDirEl.addEventListener('input',e=>spCustomDirection=e.target.value);
  const genBtn=document.getElementById('btn-sp-generate');if(genBtn)genBtn.addEventListener('click',spGenerateReport);
  const reportNameEl=document.getElementById('sp-report-name');if(reportNameEl)reportNameEl.addEventListener('input',e=>{if(spGenerated)spGenerated.report_title=e.target.value;if(spDashboardPlan)spDashboardPlan.title=e.target.value;const preview=document.getElementById('sp-report-filename-preview');if(preview)preview.value=`${spReportFilenameBase()}.xlsx / .html`;});
  const saveReportBtn=document.getElementById('btn-sp-save-report');if(saveReportBtn)saveReportBtn.addEventListener('click',spSaveCurrentReport);
  const dlExcelBtn=document.getElementById('btn-sp-dl-excel');if(dlExcelBtn)dlExcelBtn.addEventListener('click',spDownloadWorkbook);
  const dlHtmlBtn=document.getElementById('btn-sp-dl-html');if(dlHtmlBtn)dlHtmlBtn.addEventListener('click',spDownloadReportHtml);
  const dlHtmlDataBtn=document.getElementById('btn-sp-dl-html-data');if(dlHtmlDataBtn)dlHtmlDataBtn.addEventListener('click',spDownloadReportHtmlWithData);
  const validateBtn=document.getElementById('btn-sp-validate');if(validateBtn)validateBtn.addEventListener('click',spValidateGeneratedViews);
  const refreshFileEl=document.getElementById('sp-refresh-file');if(refreshFileEl)refreshFileEl.addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];if(f)spRefreshUploadedWorkbook(f);});
  const regenBtn=document.getElementById('btn-sp-regenerate');if(regenBtn)regenBtn.addEventListener('click',spGenerateReport);
  el.querySelectorAll('[data-sptoggle]').forEach(b=>b.addEventListener('click',()=>{spExpanded[b.dataset.sptoggle]=!spExpanded[b.dataset.sptoggle];renderAll();}));
  el.querySelectorAll('[data-speditor]').forEach(ta=>ta.addEventListener('input',e=>{spOverrides[e.target.dataset.speditor]=e.target.value;delete spViewValidation[e.target.dataset.speditor];}));
  el.querySelectorAll('[data-spreset]').forEach(b=>b.addEventListener('click',()=>{delete spOverrides[b.dataset.spreset];renderAll();}));
  el.querySelectorAll('[data-seceditor]').forEach(ta=>ta.addEventListener('input',e=>{const index=Number(e.target.dataset.seceditor);spSectionOverrides[index]=e.target.value;delete spSectionValidation[index];}));
  el.querySelectorAll('[data-secreset]').forEach(b=>b.addEventListener('click',()=>{delete spSectionOverrides[Number(b.dataset.secreset)];renderAll();}));
}

function spSectionRowHtml(s, i){
  const key = `sec:${i}`;
  const validation = spSectionValidation[i];
  const failed = validation && !validation.ok;
  const expanded = !!spExpanded[key] || failed;
  const current = spSectionOverrides[i] != null ? spSectionOverrides[i] : (s.render_js||'');
  const edited = spSectionOverrides[i] != null;
  return `
    <div class="export-file-row ${expanded?'expanded':''}" style="${failed?'border-left:3px solid var(--err);':''}">
      <div class="export-file-row-head">
        <button class="export-file-toggle" data-sptoggle="${key}" aria-expanded="${expanded}">
          <span class="export-file-caret">${expanded?'▾':'▸'}</span>
          <span class="export-file-label">${escapeHtml(s.title||s.view_name)}</span>
          <span class="hint">(section · reads ${escapeHtml(s.view_name)})</span>
          ${edited ? `<span class="badge-count">edited</span>` : ''}
          ${validation ? (validation.ok ? `<span class="badge-count sp-validation-badge ok">✓ validated</span>` : `<span class="badge-count sp-validation-badge err">✕ failed</span>`) : ''}
        </button>
      </div>
      ${expanded ? `
      <div class="export-file-body">
        ${failed ? `<div class="ai-status err mb">${escapeHtml(validation.error)}</div>` : ''}
        <textarea class="code-edit" data-seceditor="${i}" spellcheck="false" wrap="off">${escapeHtml(current)}</textarea>
        <div class="export-file-body-actions">
          <p class="hint mb0">${edited ? 'Edited — used in the downloaded report.' : 'Generated by the model — edit above to override it.'} Receives rows (array of row objects), el (empty container element), and echarts (Apache ECharts when available). The script is compiled before download.</p>
          ${edited ? `<button class="btn small ghost" data-secreset="${i}">Reset to generated</button>` : ''}
        </div>
      </div>` : ''}
    </div>`;
}

// Runs immediately after generation (and again on demand via the "Validate
// SQL now" button) so a broken view — wrong alias, wrong column, whatever —
// surfaces right here, rather than only being discovered later when
// someone tries to populate the workbook. Wraps each view in a LIMIT-0
// subquery so it's a pure syntax/execution check: Postgres still has to
// parse and plan the real query, but no actual rows come back.
async function spValidateGeneratedViews(){
  if (!spGenerated) return;
  spValidating = true;
  renderAll();
  spViewValidation = await spValidateViewList(spGenerated.views);
  spRefreshSectionValidation();
  spValidating = false;
  renderAll();
  const failed = Object.values(spViewValidation).filter(r=>!r.ok).length;
  const sectionFailed = Object.values(spSectionValidation).filter(r=>!r.ok).length;
  if (failed && sectionFailed) toast(`${failed} view(s) failed SQL validation and ${sectionFailed} section script(s) failed JavaScript validation.`, 'err');
  else if (failed) toast(`${failed} of ${spGenerated.views.length} view(s) failed validation — expand the red one(s) below to see the error.`, 'err');
  else if (sectionFailed) toast(`${sectionFailed} section script(s) failed JavaScript validation — expand the failed section(s) below.`, 'err');
  else toast(`All ${spGenerated.views.length} view(s) and ${(spGenerated.sections||[]).length} section script(s) validated.`, 'ok');
}

function spViewKey(v){ return v.view_name || v.sheet_name; }
function spGetViewSql(v){
  const key = spViewKey(v);
  return spOverrides[key] != null ? spOverrides[key] : (v.sql||'');
}
function spExcelNameForView(v){
  const views = (spGenerated && spGenerated.views) || [];
  const named = spViewsWithExcelSheetNames(views);
  const index = views.indexOf(v);
  if (index >= 0 && named[index]) return named[index].sheet_name;
  return spExcelSheetName(v.sheet_name || v.view_name || 'Sheet');
}
function spViewRowHtml(v){
  const key = spViewKey(v);
  const validation = spViewValidation[key];
  const failed = validation && !validation.ok;
  const expanded = !!spExpanded[key] || failed; // auto-expand failed views so the error is impossible to miss
  const edited = spOverrides[key] != null;
  const excelName = spExcelNameForView(v);
  const shortened = String(v.sheet_name || '') !== excelName;
  return `
    <div class="export-file-row ${expanded?'expanded':''}" style="${failed?'border-left:3px solid var(--err);':''}">
      <div class="export-file-row-head">
        <button class="export-file-toggle" data-sptoggle="${key}" aria-expanded="${expanded}">
          <span class="export-file-caret">${expanded?'▾':'▸'}</span>
          <span class="export-file-label">${escapeHtml(excelName)}</span>
          <span class="hint">(sheet${shortened?' · shortened for Excel':''} · ${escapeHtml((v.columns||[]).join(', '))})</span>
          ${edited ? `<span class="badge-count">edited</span>` : ''}
          ${validation ? (validation.ok ? `<span class="badge-count sp-validation-badge ok">✓ validated</span>` : `<span class="badge-count sp-validation-badge err">✕ failed</span>`) : ''}
        </button>
      </div>
      ${expanded ? `
      <div class="export-file-body">
        ${failed ? `<div class="ai-status err mb">${escapeHtml(validation.error)}</div>` : ''}
        <textarea class="code-edit" data-speditor="${key}" spellcheck="false" wrap="off">${escapeHtml(spGetViewSql(v))}</textarea>
        <div class="export-file-body-actions">
          <p class="hint mb0">${edited ? 'Edited — this version is used in the downloaded workbook.' : 'Generated by the model — edit above to override it.'}</p>
          ${edited ? `<button class="btn small ghost" data-spreset="${key}">Reset to generated</button>` : ''}
        </div>
      </div>` : ''}
    </div>`;
}
