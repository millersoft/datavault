function sourceDialectOptionsHtml(){
  if(isDemoRuntime()) return '<option value="mysql" selected>MySQL Demo</option>';
  const available=orderedDatabasePacks(databasePacks.filter(p=>(!p.source||p.source.enabled!==false)));
  const commonIds=new Set(PREFERRED_DATABASE_PACK_IDS);
  const optionFor=pack=>{
    const value=databasePackDialectValue(pack);
    return `<option value="${escapeHtml(value)}" ${state.vault.dialect===value?'selected':''}>${escapeHtml(pack.label)}</option>`;
  };
  const common=available.filter(pack=>commonIds.has(pack.id)).map(optionFor).join('');
  const others=available.filter(pack=>!commonIds.has(pack.id)).map(optionFor).join('');
  const legacySqlServer=state.vault.dialect==='sqlserver' ? '<option value="sqlserver" selected disabled>SQL Server — add database type to continue</option>' : '';
  return `<optgroup label="Common databases">${common}</optgroup><optgroup label="Other databases">${others}${legacySqlServer}<option value="__add_database_type__">＋ Add database type…</option></optgroup>`;
}

function sourceSchemaPickerHtml(v, readOnly=''){
  if (v.dialect==='mysql') return '';
  const known=(discoveredSchemas||[]).map(x=>typeof x==='object' ? x.schema : x).filter(Boolean);
  if (!known.length) return `<p class="hint mt">Test the source connection to discover schemas for multi-schema import.</p>`;
  const selected=new Set((Array.isArray(v.sourceSchemas)&&v.sourceSchemas.length?v.sourceSchemas:[v.sourceSchema]).filter(Boolean));
  return `<div class="field mt"><label>Schemas to import <span class="hint">(one source connection)</span></label>
    <select id="f-source-schemas" multiple size="${Math.min(8,Math.max(3,known.length))}" ${readOnly}>
      ${known.map(schema=>`<option value="${escapeHtml(String(schema))}" ${selected.has(String(schema))?'selected':''}>${escapeHtml(String(schema))}</option>`).join('')}
    </select><p class="hint" style="margin-top:5px;">Select one or more schemas. Each table remains schema-qualified in the mapping workbook.</p></div>`;
}

function renderConnections(el){
  const v=state.vault;
  const ext=state.externalTables;
  const demo=isDemoRuntime();
  const targetInternal=v.targetPreset==='internal';
  if(!targetInternal && ext.enabled) ext.enabled=false;
  if(ext.enabled) applyExternalTargetDefaults(false);

  const readOnly=demo?'readonly aria-readonly="true"':'';
  const disabled=demo?'disabled aria-disabled="true"':'';
  const sourceDialectOptions=sourceDialectOptionsHtml();
  const sourcePack=databasePackForDialect(v.dialect);
  if(sourcePack) seedPackConnectionValues(sourcePack,'source');
  const sourceSchemaField=v.dialect==='mysql'
    ? `<div class="field"><label>Schema</label><input type="text" value="${escapeHtml(v.srcDatabase)}" readonly><p class="hint" style="margin-top:5px;">MySQL uses the database as its schema.</p></div>`
    : `<div class="field"><label>Schema</label><input type="text" id="f-source-schema" value="${escapeHtml(v.sourceSchema||'public')}" ${readOnly}></div>`;

  const builtinSourcePanel=`
    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Source connection <span class="badge-count">&nbsp;·&nbsp;${v.name||'&lt;name&gt;'}_source</span></h3></div>
      <div class="flex-between" style="margin-bottom:14px;gap:10px;">
        <div><label class="mb0">${demo?'MySQL Demo':'Source database'}</label><p class="hint mb0">${demo?'Packaged Sakila container.':'User-defined source read by the Hop engine.'}</p></div>
        <button class="btn primary" id="btn-connect-source">${demo?'Start and connect':'Test connection'}</button>
      </div>
      <div id="src-container-status"></div>
      <div class="grid cols-3">
        <div class="field"><label>Database engine</label><select id="f-dialect" ${disabled}>${sourceDialectOptions}</select>${demo?'<p class="hint" style="margin-top:6px;">Fixed to the packaged MySQL demo.</p>':''}</div>
        <div class="field"><label>Host</label><input type="text" id="f-src-host" maxlength="${pdiMetaMaxLength('connectionHost')}" value="${escapeHtml(v.srcHost)}" ${readOnly}></div>
        <div class="field"><label>Port</label><input type="text" id="f-src-port" value="${escapeHtml(v.srcPort)}" ${readOnly}></div>
      </div>
      <div class="grid cols-2 mt">
        <div class="field"><label>Database</label><input type="text" id="f-src-db" maxlength="${pdiMetaMaxLength('connectionDatabase')}" value="${escapeHtml(v.srcDatabase)}" ${readOnly}></div>
        ${sourceSchemaField}
      </div>
      <div class="grid cols-2 mt">
        <div class="field"><label>Username</label><input type="text" id="f-src-user" maxlength="${pdiMetaMaxLength('connectionUser')}" value="${escapeHtml(v.srcUser)}" ${readOnly}></div>
        <div class="field"><label>Password</label><input type="password" id="f-srcpass" value="${escapeHtml(v.srcPassword)}" ${readOnly} ${demo?'placeholder="Configured server-side in .env"':''} autocomplete="off">${demo?'<p class="hint" style="margin-top:5px;">The password remains server-side and is never returned to this page.</p>':''}</div>
      </div>
      <div id="conn-status-wrap">${renderConnStatusHtml()}</div>
      ${sourceSchemaPickerHtml(v, readOnly)}
      ${jdbcDriverSectionHtml(v)}
    </div>`;
  const sourceHop=sourcePack?resolveHopDatabaseType(sourcePack):null;
  const packSourcePanel=sourcePack?`
    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Source connection <span class="badge-count">&nbsp;·&nbsp;${escapeHtml(sourcePack.label)}</span></h3></div>
      <div class="flex-between" style="margin-bottom:14px;gap:10px;">
        <div><label class="mb0">${escapeHtml(sourcePack.label)} source</label><p class="hint mb0">Studio supplies safe defaults; this database type only adds the JDBC details and vendor exceptions it needs.</p></div>
        <button class="btn primary" id="btn-connect-source">Test connection</button>
      </div>
      <div class="grid cols-2">
        <div class="field"><label>Database engine</label><select id="f-dialect">${sourceDialectOptions}</select></div>
        <div class="field"><label>Adapter status</label><div class="ai-status ${sourcePack.driverPresent?'ok':'err'}"><span>${sourcePack.driverPresent?'JDBC driver found':'JDBC driver missing'} · ${escapeHtml(packDriverDisplay(sourcePack))}<br><span class="hint">Hop: ${sourceHop.strategy==='native'?`Native · ${escapeHtml(sourceHop.pluginName)}`:'Generic JDBC fallback'}</span></span></div></div>
      </div>
      <div class="grid cols-3 mt">${packConnectionFieldsHtml(sourcePack,'source')}</div>
      ${packConnectionExtrasHtml(sourcePack,'source')}
      <div id="conn-status-wrap">${renderConnStatusHtml()}</div>
      ${sourceSchemaPickerHtml(v)}
      ${['mysql','postgresql'].includes(v.dialect)?jdbcDriverSectionHtml(v):''}
    </div>`:'';
  // Demo stays deliberately locked and credential-reference based in the UI.
  // The server still resolves the bundled MySQL Pack for the actual JDBC work.
  const sourcePanel=demo?builtinSourcePanel:(sourcePack?packSourcePanel:builtinSourcePanel);

  const selectedTarget=selectedDeploymentTarget();
  const targetModeField=demo
    ? `<div class="field"><label>Deployment target</label><input type="text" value="Internal PostgreSQL" readonly><p class="hint" style="margin-top:6px;">Demo mode is locked to the packaged PostgreSQL service.</p></div>`
    : `<div class="field"><label>Deployment target</label><select id="f-target-mode">
        <optgroup label="PostgreSQL deployment">
          <option value="internal-postgres" ${selectedTarget==='internal-postgres'?'selected':''}>Internal PostgreSQL</option>
          <option value="postgres" ${selectedTarget==='postgres'?'selected':''}>PostgreSQL</option>
        </optgroup>
        ${databasePackTargetOptionsGroupedHtml()}
      </select><p class="hint" style="margin-top:6px;">Installed Database Packs can be selected directly. For Pack targets, Studio discovers physical SQL types from JDBC metadata and uses Pack target settings only as explicit overrides.</p>${deploymentTargetGatewayNoticeHtml(selectedTarget)}</div>`;

  const targetPanel=targetInternal?`
    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Data Vault PostgreSQL <span class="badge-count">&nbsp;·&nbsp;internal container</span></h3></div>
      ${targetModeField}
      <div class="flex-between mt" style="margin-bottom:14px;gap:10px;">
        <div><label class="mb0">Packaged PostgreSQL</label><p class="hint mb0">The engine connection and all local Vault support objects live here.</p></div>
        <button class="btn primary" id="${ext.enabled?'btn-start-fdw-postgres':'btn-connect-target'}">Start and connect${ext.enabled?' FDW image':''}</button>
      </div>
      <div id="tgt-container-status"></div>
      <div class="grid cols-4">
        <div class="field"><label>Host</label><input type="text" value="${escapeHtml(v.dvHost)}" readonly></div>
        <div class="field"><label>Port</label><input type="text" value="${escapeHtml(v.dvPort)}" readonly></div>
        <div class="field"><label>Database name</label><input type="text" id="f-dvdb" maxlength="${pdiMetaMaxLength('connectionDatabase')}" value="${escapeHtml(v.dvDatabase)}" ${demo?'readonly':''}></div>
        <div class="field"><label>Target username</label><input type="text" value="${escapeHtml(v.dvUser)}" readonly></div>
      </div>
      <div class="grid cols-2 mt"><div class="field"><label>Target password</label><input type="password" value="" placeholder="Configured server-side in .env" readonly autocomplete="off"><p class="hint" style="margin-top:5px;">The password remains server-side and is never returned to this page.</p></div></div>
      <div id="target-status-wrap">${renderTargetStatusHtml()}</div>
    </div>`:`
    <div class="panel">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Data Vault PostgreSQL <span class="badge-count">&nbsp;·&nbsp;external server</span></h3></div>
      ${targetModeField}
      <div class="flex-between mt" style="margin-bottom:14px;gap:10px;">
        <div><label class="mb0">External PostgreSQL</label><p class="hint mb0">All staging, metadata and Data Vault objects are deployed natively to this PostgreSQL database. FDW is not offered for this target mode.</p></div>
        <button class="btn primary" id="btn-connect-target">Test connection</button>
      </div>
      <div class="grid cols-3">
        <div class="field"><label>Host</label><input type="text" id="f-dv-host" maxlength="${pdiMetaMaxLength('connectionHost')}" value="${escapeHtml(v.dvHost)}"></div>
        <div class="field"><label>Port</label><input type="text" id="f-dv-port" value="${escapeHtml(v.dvPort||'5432')}"></div>
        <div class="field"><label>Database name</label><input type="text" id="f-dvdb" maxlength="${pdiMetaMaxLength('connectionDatabase')}" value="${escapeHtml(v.dvDatabase)}"></div>
      </div>
      <div class="grid cols-2 mt">
        <div class="field"><label>Username</label><input type="text" id="f-dv-user" maxlength="${pdiMetaMaxLength('connectionUser')}" value="${escapeHtml(v.dvUser)}"></div>
        <div class="field"><label>Password</label><input type="password" id="f-dvpass" value="${escapeHtml(v.dvPassword)}" autocomplete="off"></div>
      </div>
      <div id="target-status-wrap">${renderTargetStatusHtml()}</div>
      ${externalLocalhostWarningHtml()}
    </div>`;

  let physicalTargetPanel='';
  if(ext.enabled){
    const targetPack=databasePackForDialect(ext.remoteDialect);
    if(targetPack && !demo){
      seedPackConnectionValues(targetPack,'target');
      physicalTargetPanel=`
        <div class="panel">
          <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Physical storage target <span class="badge-count">&nbsp;·&nbsp;${escapeHtml(targetPack.label)} Pack ${escapeHtml(targetPack.version)}</span></h3></div>
          <div class="flex-between" style="margin-bottom:14px;gap:10px;"><div><label class="mb0">${escapeHtml(targetPack.label)} target</label><p class="hint mb0">Core Hub/Link/Satellite tables are stored here. Studio discovers the target SQL type system from the JDBC driver and keeps PostgreSQL as the engine/FDW gateway.</p></div><button class="btn primary" id="btn-connect-external-target">Test connection &amp; map types</button></div>
          <div class="grid cols-3">${packConnectionFieldsHtml(targetPack,'target')}</div>
          ${packConnectionExtrasHtml(targetPack,'target')}
          ${renderTargetProfileSummaryHtml(targetPack)}
          <div id="target-jdbc-driver-wrap">${targetJdbcDriverSectionHtml()}</div>
          <div id="external-target-status-wrap">${renderExternalTargetStatusHtml()}</div>
        </div>`;
    }else{

    const lockSelect=demo?'disabled aria-disabled="true"':'';
    const lockInput=demo?'readonly aria-readonly="true"':'';
    const engineLabel=(DIALECTS[ext.remoteDialect]||{}).label||'External database';
    physicalTargetPanel=`
      <div class="panel">
        <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Physical storage target <span class="badge-count">&nbsp;·&nbsp;core Vault tables</span></h3></div>
        <div class="flex-between" style="margin-bottom:14px;gap:10px;">
          <div><label class="mb0">${escapeHtml(engineLabel)} target</label><p class="hint mb0">Only the core Hub, Link, Satellite and Link Satellite tables are stored here.</p></div>
          <button class="btn primary" id="btn-connect-external-target">Test connection</button>
        </div>
        <div class="grid cols-3">
          <div class="field"><label>Database engine</label><input type="text" value="${escapeHtml(engineLabel)}" readonly></div>
          <div class="field"><label>Host from Studio</label><input type="text" id="f-external-host" value="${escapeHtml(ext.studioHost)}" ${lockInput}></div>
          <div class="field"><label>Port</label><input type="text" id="f-external-port" value="${escapeHtml(ext.studioPort)}" ${lockInput}></div>
        </div>
        <div class="grid cols-2 mt">
          <div class="field"><label>${ext.remoteDialect==='mysql'?'Database / schema':'Database'}</label><input type="text" id="f-external-db" value="${escapeHtml(ext.studioDatabase||ext.remoteDatabase)}" ${lockInput}></div>
          ${ext.remoteDialect==='mysql'
            ? `<div class="field"><label>Schema</label><input type="text" value="${escapeHtml(ext.studioDatabase||ext.remoteDatabase||'datavault')}" readonly><p class="hint" style="margin-top:5px;">MySQL uses the database as its schema.</p></div>`
            : `<div class="field"><label>Schema</label><input type="text" id="f-external-schema" value="${escapeHtml(ext.studioSchema||ext.remoteSchema||'data_vault')}" ${lockInput}></div>`}
        </div>
        <div class="grid cols-2 mt">
          <div class="field"><label>Target username</label><input type="text" id="f-external-user" value="${escapeHtml(ext.studioUser||ext.username)}" ${lockInput}></div>
          <div class="field"><label>Target password</label><input type="password" id="f-external-password" value="${escapeHtml(ext.studioPassword||ext.password)}" ${lockInput} autocomplete="off"></div>
        </div>
        <p class="hint mt">${demo?'Demo values are fixed to the packaged MySQL service and Sakila account.':'These are the physical target credentials used for target DDL, both PostgreSQL FDW user mappings, and Studio Plus defaults.'}</p>
        <div class="ai-status busy mt" style="align-items:flex-start;"><span><b>Required permissions:</b> the target account must be able to create/use <span class="mono">${escapeHtml(ext.studioDatabase||ext.remoteDatabase||'datavault')}</span>, create and alter the core tables, and read/write them.</span></div>
        <div id="target-jdbc-driver-wrap">${targetJdbcDriverSectionHtml()}</div>
        <div id="external-target-status-wrap">${renderExternalTargetStatusHtml()}</div>
      </div>`;
    }
  }
  el.innerHTML=`
    <div class="flex-between">
      <div><h2 class="section-title">Step 1 — Connections</h2><p class="section-desc mb0">${demo?'Run the complete feature set against the locked demonstration containers.':'Configure the source and choose PostgreSQL, a built-in FDW target, or any installed Database Pack as the physical Data Vault target.'}</p></div>
      <span class="tag ${demo?'sat':'hub'}">${demo?'Demo mode':'Production mode'}</span>
    </div>
    <div class="panel mt">
      <div class="panel-head" style="margin:-18px -20px 16px;"><h3>Naming</h3></div>
      <div class="grid cols-3">
        <div class="field"><label>Vault short name</label><input type="text" id="f-name" maxlength="${pdiMetaMaxLength('vaultShortName')}" value="${escapeHtml(v.name)}" placeholder="sales" ${readOnly}><p class="field-validation" id="f-name-warn"></p></div>
        <div class="field"><label>Staging prefix</label><input type="text" id="f-prefix" maxlength="${studioMaxLength('stagingPrefix')}" value="${escapeHtml(v.prefix)}" placeholder="sales" ${readOnly}><p class="field-validation" id="f-prefix-warn"></p></div>
        <div class="field"><label>Tenant ID literal</label><input type="text" id="f-tenant" maxlength="${studioMaxLength('tenantId')}" value="${escapeHtml(v.tenantId)}" placeholder="SALES" ${readOnly}><p class="field-validation" id="f-tenant-warn"></p></div>
        <div class="field"><label>Source system code</label><input type="text" id="f-cod" maxlength="${pdiMetaMaxLength('sourceSystemCode')}" value="${escapeHtml(v.srcCod)}" placeholder="SALES" ${readOnly}><p class="field-validation" id="f-cod-warn"></p></div>
        <div class="field"><label>Source system description</label><input type="text" id="f-srcdesc" maxlength="${pdiMetaMaxLength('sourceSystemDescription')}" value="${escapeHtml(v.srcDescription)}" placeholder="sales_data" ${readOnly}><p class="field-validation" id="f-srcdesc-warn"></p></div>
      </div>
      ${demo?'<p class="hint mb0">Naming values are locked to the packaged demo project.</p>':''}
    </div>
    ${sourcePanel}
    ${targetPanel}
    ${physicalTargetPanel}
    ${(targetInternal||demo)?`<div class="panel mt" style="padding:14px 16px;"><div class="flex-between" style="gap:12px;flex-wrap:wrap;"><span class="hint mb0"><b>Container resources:</b> CPU and memory limits for the packaged Hop engine and database containers are managed separately from connection details.</span><button class="btn ghost" id="btn-open-runtime-resources">Adjust in Data Vault Hub →</button></div></div>`:''}
    ${ext.enabled?'<div id="ext-storage-mount" class="mt"></div>':''}
    <div class="flex-between mt"><span></span><button class="btn primary" id="btn-next-connections">Next: Choose Tables →</button></div>`;

  const namingValidation={
    'f-name':{rule:'vaultShortName',label:'Vault short name',maxLength:pdiMetaMaxLength('vaultShortName'),reserved:true},
    'f-prefix':{rule:'stagingPrefix',label:'Staging prefix',maxLength:studioMaxLength('stagingPrefix'),reserved:true},
    'f-tenant':{rule:'tenantId',label:'Tenant ID literal',maxLength:studioMaxLength('tenantId')},
    'f-cod':{rule:'sourceSystemCode',label:'Source system code',maxLength:pdiMetaMaxLength('sourceSystemCode')},
    'f-srcdesc':{rule:'sourceSystemDescription',label:'Source system description',maxLength:pdiMetaMaxLength('sourceSystemDescription')},
  };
  const updateNamingValidation=(id)=>{
    const cfg=namingValidation[id], node=el.querySelector('#'+id), message=el.querySelector('#'+id+'-warn');
    if(!cfg||!node||!message) return true;
    const value=node.value||'';
    let issue=studioInputIssue(cfg.rule,value,cfg.label);
    if(!issue&&cfg.reserved) issue=identifierIssue(value)||'';
    const actual=Array.from(value).length;
    if(!issue&&cfg.maxLength&&actual>cfg.maxLength) issue=`${cfg.label} is ${actual} characters; maximum ${cfg.maxLength}.`;
    const reached=!issue&&cfg.maxLength&&actual===cfg.maxLength ? `Maximum ${cfg.maxLength} characters reached.` : '';
    node.classList.toggle('field-invalid',!!issue);
    message.textContent=issue||reached;
    message.classList.toggle('limit-reached',!issue&&!!reached);
    return !issue;
  };
  const bindValue=(id,obj,key,{mirror='',rerender=false,clearSourceCaps=false}={})=>{
    const node=el.querySelector('#'+id); if(!node)return;
    node.addEventListener('input',e=>{
      obj[key]=e.target.value;if(mirror)obj[mirror]=e.target.value;
      if(namingValidation[id]) updateNamingValidation(id);
      if(clearSourceCaps&&state.sourceMeta) state.sourceMeta.hopCapabilities=null;
      if(rerender){renderAll();setActiveTabViewOnly('connections');}
    });
  };
  Object.keys(namingValidation).forEach(updateNamingValidation);
  if(!demo){
    ['name','prefix','tenantId','srcCod','srcDescription'].forEach((key,i)=>bindValue(['f-name','f-prefix','f-tenant','f-cod','f-srcdesc'][i],v,key));
    bindValue('f-src-host',v,'srcHost',{clearSourceCaps:true}); bindValue('f-src-port',v,'srcPort',{clearSourceCaps:true}); bindValue('f-src-db',v,'srcDatabase',{clearSourceCaps:true});
    bindValue('f-source-schema',v,'sourceSchema',{clearSourceCaps:true}); bindValue('f-src-user',v,'srcUser',{clearSourceCaps:true}); bindValue('f-srcpass',v,'srcPassword',{clearSourceCaps:true});
    const schemas=el.querySelector('#f-source-schemas');
    if(schemas) schemas.addEventListener('change',()=>{
      v.sourceSchemas=selectedValues(schemas);
      if(v.sourceSchemas.length) v.sourceSchema=v.sourceSchemas[0];
      if(state.sourceMeta) state.sourceMeta.hopCapabilities=null;
    });
    const dialect=el.querySelector('#f-dialect');
    if(dialect) dialect.addEventListener('change',e=>{
      if(e.target.value==='__add_database_type__'){
        e.target.value=v.dialect;
        openDatabaseTypeWizard();
        return;
      }
      const oldPack=databasePackForDialect(v.dialect);
      const oldPort=String((oldPack&&oldPack.jdbc&&oldPack.jdbc.defaultPort)||(DIALECTS[v.dialect]&&DIALECTS[v.dialect].defaultPort)||'');
      v.dialect=e.target.value; v.sourcePreset='';
      const pack=databasePackForDialect(v.dialect);
      if(pack){
        const nextPort=String((pack.jdbc&&pack.jdbc.defaultPort)||'');
        if(!v.srcPort||String(v.srcPort)===oldPort)v.srcPort=nextPort;
        v.sourcePackValues={}; v.sourcePackOptions=[]; v.sourceManualUrl=''; v.sourceCatalog='';
        if(v.dialect==='mysql') v.sourceSchema=v.srcDatabase;
        else if(!v.sourceSchema||v.sourceSchema===v.srcDatabase) v.sourceSchema=pack.namespace?.defaultSchema||'public';
        seedPackConnectionValues(pack,'source',{reset:true});
      }else{
        if(!v.srcPort||v.srcPort===oldPort)v.srcPort=(DIALECTS[v.dialect]||{}).defaultPort||'';
        v.sourceSchema=v.dialect==='mysql'?v.srcDatabase:(v.sourceSchema==='dbo'?'public':(v.sourceSchema||'public'));
      }
      sourceConnStatus=null; discoveredSchemas=[]; discoveredCatalogs=[]; targetJdbcDriverStatus=null;
      if(state.sourceMeta) state.sourceMeta.hopCapabilities=null;
      renderAll();setActiveTabViewOnly('connections');
    });
    const targetMode=el.querySelector('#f-target-mode');
    if(targetMode) targetMode.addEventListener('change',e=>{
      applyDeploymentTarget(e.target.value);
      renderAll();setActiveTabViewOnly('connections');
    });
  }

  if(sourcePack && !demo) wirePackConnectionFields(el,sourcePack,'source');
  const jdbcFolderInput=el.querySelector('#f-jdbc-folder'); if(jdbcFolderInput)jdbcFolderInput.addEventListener('input',e=>jdbcDriverFolder=e.target.value);
  const jdbcDeployBtn=el.querySelector('#btn-deploy-jdbc-driver'); if(jdbcDeployBtn)jdbcDeployBtn.addEventListener('click',()=>deployJdbcDriver('source'));
  detectDbInitPath(); refreshJdbcDriverStatus(); wireTargetJdbcDriverActions(el);

  const sourceBtn=el.querySelector('#btn-connect-source'); if(sourceBtn)sourceBtn.addEventListener('click',()=>demo?startAndConnectContainer('source'):testSourceConnection());
  const internalTargetBtn=el.querySelector('#btn-connect-target');
  if(internalTargetBtn)internalTargetBtn.addEventListener('click',()=>targetInternal?startAndConnectContainer('target'):testTargetConnection());
  const gatewayBtn=el.querySelector('#btn-start-fdw-postgres'); if(gatewayBtn)gatewayBtn.addEventListener('click',()=>startAndConnectContainer('target'));
  const extConnect=el.querySelector('#btn-connect-external-target'); if(extConnect)extConnect.addEventListener('click',testExternalTargetConnection);
  const resourcesBtn=el.querySelector('#btn-open-runtime-resources'); if(resourcesBtn)resourcesBtn.addEventListener('click',()=>{ appMode='dashboard'; renderAll(); });
  el.querySelector('#btn-next-connections').addEventListener('click',()=>{
    const invalid=Object.keys(namingValidation).filter(id=>!updateNamingValidation(id));
    if(invalid.length){ const first=el.querySelector('#'+invalid[0]); if(first) first.focus(); return; }
    navigateDesignerTab('tables');
  });

  bindValue('f-dvdb',v,'dvDatabase');
  if(!targetInternal){bindValue('f-dv-host',v,'dvHost');bindValue('f-dv-port',v,'dvPort');bindValue('f-dv-user',v,'dvUser');bindValue('f-dvpass',v,'dvPassword');}
  const createDbBtn=el.querySelector('#btn-create-db');if(createDbBtn)createDbBtn.addEventListener('click',createTargetDatabase);
  const createExtBtn=el.querySelector('#btn-create-external-db');if(createExtBtn)createExtBtn.addEventListener('click',createExternalTargetDatabase);
  wireFdwServiceUserActions(el);

  if(ext.enabled){
    const markExternal=()=>{ext.studioConnectionOverridden=true;ext.deploymentAcknowledged=false;ext.targetProfile=null;externalPreflightResult=null;externalDeployResult=null;externalTargetConnStatus=null;externalTargetDbExists=null;externalTargetIdentity=null;targetJdbcDriverStatus=null;};
    const bindExt=(id,key,mirror='')=>{const node=el.querySelector('#'+id);if(!node)return;node.addEventListener('input',e=>{ext[key]=e.target.value;if(mirror)ext[mirror]=e.target.value;markExternal();});};
    const targetPack=databasePackForDialect(ext.remoteDialect);
    if(targetPack) wirePackConnectionFields(el,targetPack,'target');
    else {bindExt('f-external-host','studioHost');bindExt('f-external-port','studioPort');bindExt('f-external-db','studioDatabase','remoteDatabase');bindExt('f-external-schema','studioSchema','remoteSchema');bindExt('f-external-user','studioUser','username');bindExt('f-external-password','studioPassword','password');}
    renderExternalSub(document.getElementById('ext-storage-mount'));
  }
}
