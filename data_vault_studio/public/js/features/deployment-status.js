/* =========================================================================
   DEPLOYMENT STATUS BOARD — no manifest, no local state: everything is
   derived live by probing the target database and the project's deployment files
   files, then compared against what the current design would generate.
   States: missing (not deployed) | stale (out of date) | current | unknown.
   ========================================================================= */
let deployStatus = null;      // { rows:[{key,label,state,detail,action}], probedAt, error, fingerprint }
let deployProbing = false;
let deployApplying = false;

// One busy flag for the whole board — no action can start while any other
// probe/apply is in flight (prevents double-fire and interleaved deploys).
function deployBusy(){
  return deployProbing || deployApplying ||
    !!(deployStatus && deployStatus.rows && deployStatus.rows.some(r=>r.state==='busy'));
}

// Guard 2: the board reflects the design as it was when status was checked. If the
// model changed since, applying from it would act on stale conclusions.
function deployBoardIsStale(){
  return !!(deployStatus && !deployStatus.error && deployStatus.fingerprint &&
            deployStatus.fingerprint !== designFingerprint());
}
let exportAdvancedOpen = false;

// Pure: derive the board row for a generated deployment FILE from the
// server's file-status info. JSON files compare content directly.
function deriveFileRow(key, label, info, generatedContent){
  const norm = s => String(s == null ? '' : s).trim();
  if (!info || !info.exists){
    return { key, label, state: 'missing', detail: 'not deployed yet' };
  }
  if (info.content != null && generatedContent != null && norm(info.content) !== norm(generatedContent)){
    return { key, label, state: 'stale', detail: 'deployed file differs from the current design' };
  }
  const when = info.mtimeMs ? new Date(info.mtimeMs).toLocaleString() : '';
  return { key, label, state: 'current', detail: when ? `written ${when}` : 'present' };
}

// Pure: derive the board row for a set of database objects (staging or
// data_vault) from expected objects, live columns and live single-column
// indexes. Indexes are compared by table + column, not by index name, so an
// equivalent existing index satisfies the requirement without duplication.
function deriveDbObjectsRow(key, label, expected, liveCols, liveIndexes, schema, liveRelations=null){
  const delta = computeTargetDelta(
    expected,
    liveCols.filter(r => String(r.table_schema).toLowerCase() === schema),
    liveIndexes == null ? null : liveIndexes.filter(r => String(r.table_schema).toLowerCase() === schema),
    liveRelations == null ? null : liveRelations.filter(r => String(r.table_schema).toLowerCase() === schema)
  );
  const present = expected.length - delta.missingTables.length;
  if (present === 0){
    return { key, label, state: 'missing', detail: `0 of ${expected.length} relations`, delta };
  }
  if (delta.missingTables.length || delta.missingColumns.length || delta.missingIndexes.length || delta.obsoleteColumns.length || delta.relationKindMismatches.length){
    return { key, label, state: 'stale',
      detail: `${present} of ${expected.length} relations · ${delta.missingTables.length} relation(s), ${delta.missingColumns.length} column(s), ${delta.missingIndexes.length} index(es) to add, ${delta.relationKindMismatches.length} relation-kind collision(s), and ${delta.obsoleteColumns.length} obsolete Link Satellite column(s)`, delta };
  }
  const mm = delta.typeMismatches.length ? ` · ${delta.typeMismatches.length} type difference(s) — see Advanced` : '';
  return { key, label, state: 'current', detail: `${expected.length} of ${expected.length} relations${mm}`, delta };
}

async function probeDeploymentStatus(){
  if (deployProbing || deployApplying) return;
  const v = state.vault;
  if (!v.dvHost || !v.dvDatabase || !v.dvUser){
    deployStatus = { rows: [], error: 'Set the target connection (host, database, user) on the Connections step first.' };
    renderAll(); setActiveTabViewOnly('export');
    return;
  }
  deployProbing = true; renderAll(); setActiveTabViewOnly('export');
  const esc = s => String(s || '').replace(/'/g, "''");
  const rows = [];
  let externalWorkflowAssigned = false;
  const attachExternalWorkflow = row => {
    if (state.externalTables.enabled && !externalWorkflowAssigned && row && !['current','unknown'].includes(row.state)){
      row.apply = applyExternalStorageWorkflow;
      row.applyLabel = 'Deploy route';
      row.workflow = 'external-route';
      externalWorkflowAssigned = true;
    }
    return row;
  };
  try {
    await ensureLocalServerReachable();

    // 1 · target database
    const dbResp = await localFetch(`/api/db-status`, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ host: v.dvHost, port: v.dvPort, database: v.dvDatabase, user: v.dvUser, password: v.dvPassword }) }).then(r=>r.json());
    if (!dbResp.ok) throw new Error(dbResp.error || 'Could not check the target database.');
    const dbExists = dbResp.exists === true;
    const postgresDatabaseRole=state.externalTables.enabled?'gateway':'target';
    const gatewayDbRow = { key: 'database', label: `PostgreSQL ${postgresDatabaseRole} database "${v.dvDatabase}"`,
      state: dbExists ? 'current' : 'missing', detail: dbExists ? 'exists' : 'not created yet' };
    if (!dbExists){
      if (state.externalTables.enabled) attachExternalWorkflow(gatewayDbRow);
      else gatewayDbRow.apply = async ()=>{
        const r = await localFetch(`/api/create-database`, { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ host: v.dvHost, port: v.dvPort, database: v.dvDatabase, user: v.dvUser, password: v.dvPassword }) }).then(x=>x.json());
        if (!r.ok) throw new Error(r.error || 'Create failed.');
        const verify = await localFetch(`/api/db-status`, { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ host: v.dvHost, port: v.dvPort, database: v.dvDatabase, user: v.dvUser, password: v.dvPassword }) }).then(x=>x.json());
        if (!verify.ok || !verify.exists) throw new Error(verify.error || `Database "${v.dvDatabase}" was not visible after creation.`);
      };
    }
    rows.push(gatewayDbRow);

    // 2 · physical output database and core tables when FDW mode is enabled.
    // Only one row receives the ordered workflow action, so Apply all executes
    // the route once rather than re-running it for every derived status row.
    if (state.externalTables.enabled){
      const ext=state.externalTables;
      try {
        const remoteDb=await externalTargetDatabaseStatus();
        externalTargetConnStatus='ok'; externalTargetDbExists=!!remoteDb.exists; externalTargetConnError='';
        externalTargetIdentity=remoteDb;
        const namespaceReady=remoteDb.exists && remoteDb.schemaExists!==false;
        const dbRow=attachExternalWorkflow({
          key:'external-database',
          label:`Physical output database "${ext.studioDatabase||ext.remoteDatabase}"`,
          state:namespaceReady?'current':'missing',
          detail:namespaceReady
            ? `${(DIALECTS[ext.remoteDialect]||{}).label||ext.remoteDialect} database/schema exists${remoteDb.currentUser?` · ${remoteDb.serverHostname||ext.studioHost}:${remoteDb.serverPort||ext.studioPort} · ${remoteDb.currentUser}`:''}`
            : (remoteDb.exists?`database exists; schema ${remoteDb.selectedSchema||ext.studioSchema||ext.remoteSchema||'(selected)'} is missing and will be created by the ordered deployment`:'not created yet; ordered deployment creates and verifies it'),
        });
        rows.push(dbRow);

        if (externalCoreTableCount()===0){
          rows.push({key:'external-core',label:'Physical Hub/Link/Sat/LSat tables',state:'missing',detail:'no core Data Vault tables exist in the model yet'});
        } else if (!namespaceReady){
          rows.push({key:'external-core',label:'Physical Hub/Link/Sat/LSat tables',state:'missing',detail:remoteDb.exists?`waiting for schema ${remoteDb.selectedSchema||ext.studioSchema||ext.remoteSchema}; created by the same ordered deployment`:`waiting for ${ext.studioDatabase||ext.remoteDatabase}; created by the same ordered deployment`});
        } else {
          const payload=externalConnectionPayload(ext.studioDatabase||ext.remoteDatabase);
          const tableStatus=await externalApi('/api/external-table-status',{...payload,schema:ext.studioSchema||ext.remoteSchema,tables:externalCoreTableNames()});
          const missing=tableStatus.missing||[];
          rows.push(attachExternalWorkflow({
            key:'external-core',
            label:'Physical Hub/Link/Sat/LSat tables',
            state:missing.length?'stale':'current',
            detail:missing.length
              ? `${externalCoreTableCount()-missing.length} of ${externalCoreTableCount()} tables; missing ${missing.join(', ')}`
              : `${externalCoreTableCount()} of ${externalCoreTableCount()} tables`,
          }));
        }
      } catch(err){
        externalTargetConnStatus='error'; externalTargetConnError=err.message; externalTargetDbExists=null;
        rows.push({key:'external-database',label:'Physical output database',state:'unknown',detail:`could not check the selected target — ${err.message}`});
        rows.push({key:'external-core',label:'Physical Hub/Link/Sat/LSat tables',state:'unknown',detail:'physical database status is unknown'});
      }
    }

    // 3 · runtime secrets in the root .env. SOURCE_PASSWORD is always
    // synchronised from Connections. Native external PostgreSQL additionally
    // synchronises its bootstrap username/password and VAULT_PASSWORD. The
    // internal DB_* values remain administrator-controlled and untouched.
    const credentialProblem = runtimeCredentialValidationMessage();
    if (credentialProblem){
      rows.push({ key:'credentials', label:'Runtime secrets (.env)', state:'missing', detail:credentialProblem });
    } else {
      try {
        const payload=runtimeCredentialPayload();
        const c = await localFetch('/api/env-credentials/status', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload) }).then(r=>r.json());
        if (!c.ok) throw new Error(c.error || 'runtime secret check failed');
        const current = c.found && c.sourceMatches && (!payload.externalPostgres || (c.targetMatches && c.targetUserMatches));
        const row = { key:'credentials', label:'Runtime secrets (.env)',
          state: current ? 'current' : (c.found ? 'stale' : 'missing'),
          detail: current
            ? (payload.externalPostgres ? 'source and external PostgreSQL secrets match Connections' : 'source password matches Connections; internal PostgreSQL settings are unchanged')
            : (!c.found ? 'root .env not found' : 'runtime secrets differ from Connections') };
        if (!current) row.apply=async()=>{ await deployRuntimeCredentials({silent:true}); };
        row.reapply=async()=>{ await deployRuntimeCredentials(); };
        rows.push(row);
      } catch(err){
        rows.push({ key:'credentials', label:'Runtime secrets (.env)', state:'unknown', detail:`could not read .env — ${err.message}` });
      }
    }

    // 3 · local jdbc_fdw infrastructure. This is checked separately from
    // the foreign-table relations so a missing server or user mapping cannot
    // be reported as fully deployed.
    if (state.externalTables.enabled){
      let infrastructureRow;
      if (!dbExists){
        infrastructureRow={key:'fdw-infrastructure',label:'PostgreSQL FDW server and mapping',state:'missing',detail:'waiting for the PostgreSQL gateway database'};
      } else if (!state.externalTables.serverName){
        infrastructureRow={key:'fdw-infrastructure',label:'PostgreSQL FDW server and mapping',state:'missing',detail:'foreign server name is not configured'};
      } else {
        try{
          const infrastructure=await localFdwInfrastructureStatus();
          const missing=fdwInfrastructureMissing(infrastructure);
          infrastructureRow={
            key:'fdw-infrastructure',
            label:'PostgreSQL FDW server and mapping',
            state:missing.length?'stale':'current',
            detail:missing.length?`missing: ${missing.join(', ')}`:`${state.externalTables.serverName}; data_vault and pdi_meta mappings are ready`,
          };
        }catch(err){
          infrastructureRow={key:'fdw-infrastructure',label:'PostgreSQL FDW server and mapping',state:'unknown',detail:`could not inspect FDW infrastructure — ${err.message}`};
        }
      }
      attachExternalWorkflow(infrastructureRow);
      rows.push(infrastructureRow);
    }

    // 4+5 · staging / vault tables
    let liveCols = [];
    let liveIndexes = [];
    let liveRelations = [];
    let liveColsOk = !dbExists; // no DB yet -> "no tables" is a true fact, not a read failure
    if (dbExists){
      try {
        liveCols = await queryTarget(`SELECT table_schema, table_name, column_name, data_type,
          character_maximum_length, numeric_precision, numeric_scale, udt_name
          FROM information_schema.columns WHERE table_schema IN ('staging','data_vault')`);
        liveIndexes = await queryTarget(singleColumnIndexCatalogSql());
        liveRelations = await queryTarget(`SELECT n.nspname AS table_schema, c.relname AS table_name, c.relkind
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('staging','data_vault')`);
        liveColsOk = true;
      } catch(_){ liveCols = []; liveIndexes = []; liveRelations = []; liveColsOk = false; }
    }
    // Staging always remains an ordinary PostgreSQL schema.
    if (!liveColsOk){
      rows.push({ key:'staging', label:'Staging tables', state:'unknown', detail:'could not read the target schema — fix the connection, then re-check' });
    } else {
      const expected=expectedStagingObjects();
      const row=deriveDbObjectsRow('staging','Staging relations',expected,liveCols,liveIndexes,'staging',liveRelations);
      if (row.state==='missing') row.apply=async()=>{ await executeSqlAgainstTarget(getExportSql('staging')); };
      else if (row.state==='stale') row.apply=async()=>{ await executeSqlAgainstTarget(buildIncrementalSql(row.delta)); };
      rows.push(row);
    }

    if (state.externalTables.enabled){
      // External mode has two distinct PostgreSQL object groups. Do not merge
      // them into a misleading "98 Vault tables" count: the core relations are
      // foreign-table bindings, while only *_err tables and the view are local.
      if (!liveColsOk){
        rows.push({key:'vault-support',label:'PostgreSQL local Vault support objects',state:'unknown',detail:'could not read the data_vault schema — fix the connection, then re-check'});
        rows.push({key:'fdw-foreign-tables',label:'PostgreSQL foreign-table bindings',state:'unknown',detail:'could not read the data_vault schema — fix the connection, then re-check'});
      } else {
        const supportExpected=parseGeneratedDdlObjects(buildDataVaultLocalSupportDdl());
        const supportRow=deriveDbObjectsRow('vault-support','PostgreSQL local Vault support objects',supportExpected,liveCols,liveIndexes,'data_vault',liveRelations);
        const viewReady=liveRelations.some(r=>String(r.table_schema).toLowerCase()==='data_vault' && String(r.table_name).toLowerCase()==='vw_information_schema_columns_data_vault' && r.relkind==='v');
        if (!viewReady){
          if (supportRow.state==='current') supportRow.state='stale';
          supportRow.detail += ' · verification view missing';
        } else {
          supportRow.detail += ' · verification view present';
        }
        supportRow.detail += ' · these are local *_err tables, not a second copy of the core Vault';
        attachExternalWorkflow(supportRow);
        rows.push(supportRow);

        const foreignExpected=parseGeneratedDdlObjects(buildFdwForeignTablesDdl());
        const foreignRow=deriveDbObjectsRow('fdw-foreign-tables','PostgreSQL foreign-table bindings',foreignExpected,liveCols,liveIndexes,'data_vault',liveRelations);
        if(foreignRow.state==='current' && externalCoreTableNames().length){
          const smoke=externalCoreTableNames()[0];
          try{
            await smokeTestFdwForeignTable('data_vault',smoke);
            await smokeTestFdwForeignTable('pdi_meta',smoke);
            foreignRow.detail += ` · cursor route verified as data_vault and pdi_meta through ${smoke}`;
          }catch(err){
            foreignRow.state='stale';
            foreignRow.detail += ` · bindings exist but cursor runtime check failed`;
            foreignRow.error=err.message;
          }
        }else{
          foreignRow.detail += ' · created last, after the physical target tables and FDW server/mapping are verified';
        }
        attachExternalWorkflow(foreignRow);
        rows.push(foreignRow);
      }
    } else {
      // Non-external mode keeps the original native Vault deployment/status.
      if (!liveColsOk){
        rows.push({key:'vault',label:'Vault tables',state:'unknown',detail:'could not read the target schema — fix the connection, then re-check'});
      } else {
        const expected=parseGeneratedDdlObjects(getExportSql('datavault'));
        const row=deriveDbObjectsRow('vault','Vault tables',expected,liveCols,liveIndexes,'data_vault',liveRelations);
        if (row.state==='missing') row.apply=async()=>{ await executeSqlAgainstTarget(getExportSql('datavault')); };
        else if (row.state==='stale') row.apply=async()=>{ await executeSqlAgainstTarget(buildIncrementalSql(row.delta)); };
        rows.push(row);
      }
    }

    // 5 · pdi_meta reference rows for THIS vault
    let pdiRow = { key: 'pdimeta', label: 'Data Vault metadata', state: 'missing', detail: 'target database missing' };
    if (dbExists){
      try {
        const r = await queryTarget(`SELECT
          (SELECT COUNT(*) FROM pdi_meta.ref_connections WHERE name IN ('${esc(v.name)}_source','${esc(v.name)}_staging','${esc(v.name)}_datavault')) AS conns,
          (SELECT COUNT(*) FROM pdi_meta.ref_data_vaults WHERE data_vault_name = '${esc(v.vaultDbName)}') AS dv,
          (SELECT COUNT(*) FROM pdi_meta.ref_source_systems WHERE cod_srcsys = '${esc(v.srcCod)}') AS ss`);
        const c = r[0] || {};
        const total = Number(c.conns || 0) + Number(c.dv || 0) + Number(c.ss || 0);
        if (total >= 5) pdiRow = { key:'pdimeta', label:'Data Vault metadata', state:'current', detail:"settings for this vault are present" };
        else if (total === 0) pdiRow = { key:'pdimeta', label:'Data Vault metadata', state:'missing', detail:'settings for this vault have not been added yet' };
        else pdiRow = { key:'pdimeta', label:'Data Vault metadata', state:'stale', detail:`partly configured — ${total} of 5 required records` };
      } catch(_){
        // Schema read above succeeded -> the failure is almost certainly the
        // pdi_meta tables not existing yet. If even the schema read failed,
        // this is a connection problem: unknown, and nothing offered.
        pdiRow = liveColsOk
          ? { key:'pdimeta', label:'Data Vault metadata', state:'missing', detail:'metadata tables have not been set up yet', frameworkMissing:true }
          : { key:'pdimeta', label:'Data Vault metadata', state:'unknown', detail:'could not read the target — fix the connection, then check again' };
      }
    }
    if (pdiRow.frameworkMissing){
      const internalTarget = v.targetPreset === 'internal';
      pdiRow.detail = internalTarget
        ? 'metadata tables not found in this internal database — rebuild the packaged PostgreSQL container without removing its data volume, set up metadata here, then add this vault\'s reference rows. This does not start the data load.'
        : 'metadata tables not found on the external target — set up the target metadata, then this vault\'s reference rows will be added in the same step. This uses the target username and password from the Connections step and does not start the data load.';
      pdiRow.applyLabel = 'Set up metadata';
      pdiRow.apply = async ()=>{
        let r;
        if (internalTarget){
          r = await localFetch('/api/docker/bootstrap', { method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ mode:'internal', database:v.dvDatabase, fdw:state.externalTables.enabled===true }) }).then(x=>x.json());
        } else {
          // The external metadata setup container reads its TARGET from hop/postgres-
          // environment.json on disk, so deploy the current design's config first.
          await deployRuntimeCredentials({ silent:true });
          await deployHopConfig({ silent:true });
          r = await localFetch('/api/docker/bootstrap', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }).then(x=>x.json());
        }
        if (!r.ok) throw new Error(explainBootstrapError(r));
        // Bootstrap creates the shared metadata structure. Register this vault's
        // reference rows in the same click instead of requiring a second Deploy.
        await executeSqlAgainstTarget(getExportSql('pdimeta'));
      };
    }
    else if (pdiRow.state !== 'current' && pdiRow.state !== 'unknown') pdiRow.apply = async ()=>{ await executeSqlAgainstTarget(getExportSql('pdimeta')); };
    rows.push(pdiRow);

    // 6-8 · deployment files (workbook, engine config, source connection)
    const wbName = mappingWorkbookFilename();
    const fResp = await localFetch(`/api/file-status`, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ files: [
        { root:'mappings', name: wbName },
        { root:'hop', name: 'postgres-environment.json' },
        { root:'rdbms', name: 'source.json' },
      ] }) }).then(r=>r.json());
    if (!fResp.ok){
      const why = fResp.error ? String(fResp.error) : 'file check failed';
      [['workbook','Metadata spreadsheet'], ['engineconfig','Engine config (hop/)'],
       ['sourceconn', `Source connection (${DIALECTS[v.dialect].label})`]].forEach(([key,label])=>
        rows.push({ key, label, state:'unknown', detail: `could not check project files — ${why}` }));
    }
    if (fResp.ok){
      const by = {}; fResp.files.forEach(f=>{ by[f.root] = f; });
      const wbRow = deriveFileRow('workbook', 'Metadata spreadsheet', by.mappings, null);
      if (wbRow.state === 'current') wbRow.detail = `${wbName} · ${wbRow.detail}`;
      if (wbRow.state !== 'current') wbRow.apply = async ()=>{ await deployMappingWorkbook(); };
      wbRow.reapply = async ()=>{ await deployMappingWorkbook(); }; // Apply All also refreshes it every time
      rows.push(wbRow);
      const cfgRow = deriveFileRow('engineconfig', 'Engine config (hop/)', by.hop, buildHopEnvironmentJson());
      if (cfgRow.state !== 'current') cfgRow.apply = async ()=>{ await deployHopConfig({ silent:true }); };
      rows.push(cfgRow);
      const scRow = deriveFileRow('sourceconn', `Source connection (${DIALECTS[v.dialect].label})`, by.rdbms, buildHopSourceConnectionJson());
      if (scRow.state !== 'current') scRow.apply = async ()=>{ await deployHopSourceConnection(); };
      rows.push(scRow);
    }

    deployStatus = { rows, probedAt: new Date(), error: null, fingerprint: designFingerprint() };
  } catch(err){
    deployStatus = { rows: [], error: err.message };
  }
  deployProbing = false;
  renderAll(); setActiveTabViewOnly('export');
}

function deployChip(stateK){
  const m = {
    current: ['var(--ok)', 'Deployed ✓'],
    stale:   ['var(--hub)', 'Out of date'],
    missing: ['var(--err)', 'Not deployed'],
    unknown: ['var(--muted)', 'Unknown'],
    busy:    ['var(--brand)', 'Applying…'],
    fail:    ['var(--err)', 'Failed'],
  }[stateK] || ['var(--muted)', stateK];
  return `<span class="tag" style="border-color:${m[0]};color:${m[0]};white-space:nowrap;">${m[1]}</span>`;
}

function deployRowGroup(row){
  const key=String((row&&row.key)||'');
  if(state.externalTables.enabled){
    if(['external-database','external-core'].includes(key)) return '1 · Physical target';
    if(['database','fdw-infrastructure','vault-support','fdw-foreign-tables'].includes(key)) return '2 · PostgreSQL gateway';
    return '3 · Engine and project';
  }
  if(['database','staging','vault','pdimeta'].includes(key)) return '1 · Database';
  return '2 · Engine and project';
}

function deployStageDefinitions(){
  return state.externalTables.enabled
    ? [
        {id:'physical-target',label:'1 · Physical target'},
        {id:'postgres-gateway',label:'2 · PostgreSQL gateway'},
        {id:'engine-project',label:'3 · Engine and project'},
      ]
    : [
        {id:'database',label:'1 · Database'},
        {id:'engine-project',label:'2 · Engine and project'},
      ];
}

function deployStageState(stageRows){
  const priority={current:0,stale:1,missing:2,unknown:3,fail:4,busy:5};
  return (stageRows||[]).reduce((worst,row)=>
    (priority[row.state]||0)>(priority[worst]||0)?row.state:worst,'current');
}

function deployStageSummary(stage, stageRows){
  const byKey=Object.fromEntries((stageRows||[]).map(r=>[r.key,r]));
  const stateK=deployStageState(stageRows);
  if(stage.id==='physical-target'){
    const ext=state.externalTables;
    const engine=(DIALECTS[ext.remoteDialect]||{}).label||ext.remoteDialect||'Target';
    const name=ext.studioDatabase||ext.remoteDatabase||'target';
    const total=externalCoreTableCount();
    const dbReady=byKey['external-database']&&byKey['external-database'].state==='current';
    const coreReady=byKey['external-core']&&byKey['external-core'].state==='current';
    if(dbReady&&coreReady) return `${engine} ${name} · ${total}/${total} core Vault tables`;
    if(dbReady) return `Target database ready · core Vault tables need attention`;
    return `Target database or core Vault tables need attention`;
  }
  if(stage.id==='postgres-gateway'){
    const total=externalCoreTableCount();
    if(stateK==='current') return `FDW ready · ${total}/${total} bindings · local support ready`;
    const short={
      database:'gateway database',
      'fdw-infrastructure':'FDW connection and roles',
      'vault-support':'local support objects',
      'fdw-foreign-tables':'foreign-table bindings',
    };
    const pending=stageRows.filter(r=>r.state!=='current').map(r=>short[r.key]||r.label);
    return `${pending.join(', ') || 'Gateway checks'} ${pending.length===1?'needs':'need'} attention`;
  }
  if(stage.id==='engine-project'){
    if(stateK==='current') return `Staging, metadata and project files are current`;
    const pending=stageRows.filter(r=>r.state!=='current').length;
    const ready=stageRows.length-pending;
    return `${pending} check${pending===1?'':'s'} need attention · ${ready} ready`;
  }
  if(stage.id==='database'){
    if(stateK==='current') return `Database objects are current`;
    return `${stageRows.filter(r=>r.state!=='current').length} database check(s) need attention`;
  }
  return stateK==='current'?'Project files are current':'Project files need attention';
}

function deployMiniIcon(stateK){
  const marks={current:'✓',stale:'!',missing:'×',unknown:'?',busy:'…',fail:'×'};
  const labels={current:'Deployed',stale:'Out of date',missing:'Not deployed',unknown:'Unknown',busy:'Applying',fail:'Failed'};
  return `<span class="deploy-check-icon ${stateK}" title="${labels[stateK]||stateK}">${marks[stateK]||'?'}</span>`;
}

function deployBoardHtml(){
  if (deployProbing) return `<div class="ai-status busy mt"><span class="dot"></span>Checking the target database and project files…</div>`;
  if (!deployStatus) return `<p class="hint mt">Status has not been checked yet — press "Check status".</p>`;
  if (deployStatus.error) return `<div class="ai-status err mt">${escapeHtml(deployStatus.error)}</div>`;
  const stale = deployBoardIsStale();
  const busy = deployBusy();
  const pending = deployStatus.rows.filter(r=>r.apply).length;
  const grouped=new Map(deployStageDefinitions().map(stage=>[stage.label,{...stage,rows:[]} ]));
  deployStatus.rows.forEach(row=>{
    const label=deployRowGroup(row);
    if(!grouped.has(label)) grouped.set(label,{id:'other',label,rows:[]});
    grouped.get(label).rows.push(row);
  });
  const stages=[...grouped.values()].filter(stage=>stage.rows.length);
  const stageHtml=stages.map(stage=>{
    const stateK=deployStageState(stage.rows);
    const open=stateK!=='current';
    const children=stage.rows.map(r=>{
      const detail=String(r.detail||'');
      const error=String(r.error||'');
      const showError=error && !detail.toLowerCase().includes(error.toLowerCase());
      return `<div class="deploy-check">
      ${deployMiniIcon(r.state)}
      <div class="deploy-check-label">${escapeHtml(r.label)}</div>
      <div class="deploy-check-detail">${escapeHtml(detail)}${showError?` · <span class="deploy-check-error">${escapeHtml(error)}</span>`:''}</div>
      <div>${stale?'':(r.apply?`<button class="btn small primary" data-deploy-row="${r.key}" ${busy?'disabled':''}>${r.applyLabel||(r.state==='stale'?'Update':'Deploy')}</button>`:(r.reapply?`<button class="btn small ghost" data-deploy-row="${r.key}" ${busy?'disabled':''}>Re-deploy</button>`:''))}</div>
    </div>`;
    }).join('');
    return `<details class="deploy-stage" data-deploy-group="${stage.id}" ${open?'open':''}>
      <summary class="deploy-stage-summary">
        <span class="deploy-stage-caret">▶</span>
        <span class="deploy-stage-title">${escapeHtml(stage.label)}</span>
        <span class="deploy-stage-summary-text">${escapeHtml(deployStageSummary(stage,stage.rows))}</span>
        ${deployChip(stateK)}
      </summary>
      <div class="deploy-stage-body">${children}</div>
    </details>`;
  }).join('');
  return `
    ${stale ? `<div class="ai-status err mt">The design changed since this check — press "Check status" again before applying anything.</div>` : ''}
    <div class="deploy-stage-list mt">${stageHtml}</div>
    <p class="deploy-stage-note">Expand a stage for detailed checks and individual actions.</p>
    <p class="hint mt mb0">${pending ? `${pending} update(s) pending.` : 'Everything is deployed and current.'}${deployStatus.probedAt ? ` · full check ${deployStatus.probedAt.toLocaleTimeString()}` : ''}${deployStatus.appliedAt ? ` · deployment results updated ${deployStatus.appliedAt.toLocaleTimeString()}` : ''} · Check status performs a fresh full read; successful deploy actions update the rows they directly verified. Apply All always refreshes runtime secrets and the metadata spreadsheet.</p>`;
}

async function runDeployRow(key){
  if (deployBusy()) return;
  if (deployBoardIsStale()){ toast('The design changed since the last check — press "Check status" first.', 'err'); return; }
  const row = deployStatus && deployStatus.rows.find(r=>r.key===key);
  if (!row) return;
  const fn = row.apply || row.reapply;
  if (!fn) return;
  const obsolete = (row.delta && row.delta.obsoleteColumns) || [];
  if (obsolete.length && !confirm(
    `Remove ${obsolete.length} obsolete Link Satellite column(s)?\n\n` +
    obsolete.map(c=>'· '+c.schema+'.'+c.table+'.'+c.column).join('\n') +
    `\n\nThese columns were generated by an older Studio version but are never populated by the Link Satellite loader.`
  )) return;
  row.state = 'busy'; row.error = null;
  renderAll(); setActiveTabViewOnly('export');
  try {
    const usedApply=!!row.apply;
    const result=await fn();
    if(row.workflow==='external-route')reconcileExternalDeploymentBoard(result);
    row.state = 'current'; row.error=null; // resolved — never leave a busy row behind
    if(usedApply)row.apply=null;
    toast(`${row.label}: applied. Status was not rechecked.`, 'ok');
    renderAll(); setActiveTabViewOnly('export');
  } catch(err){
    row.state = 'fail'; row.error = explainTargetSqlError(err.message);
    toast(`${row.label}: ${row.error}`, 'err');
    renderAll(); setActiveTabViewOnly('export');
  }
}

async function applyAllPending(){
  if (deployBusy() || !deployStatus) return;
  if (deployBoardIsStale()){ toast('The design changed since the last check — press "Check status" first.', 'err'); return; }
  const credentialProblem=runtimeCredentialValidationMessage();
  if(credentialProblem){ toast(credentialProblem,'err'); return; }
  const pending = deployStatus.rows.filter(r=>r.apply && !['credentials','workbook'].includes(r.key)).slice().sort((a,b)=>{
    const aRoute = a.workflow==='external-route' ? 0 : 1;
    const bRoute = b.workflow==='external-route' ? 0 : 1;
    return aRoute-bRoute;
  });
  const steps=[{label:'Runtime secrets (.env)'},...pending.map(r=>({label:r.label})),{label:'Metadata spreadsheet'}];
  const obsolete = pending.flatMap(r=>(r.delta && r.delta.obsoleteColumns)||[]);
  const repair = obsolete.length
    ? `\n\nThis includes removing ${obsolete.length} obsolete Link Satellite column(s) that the loader never populates:\n${obsolete.map(c=>'· '+c.schema+'.'+c.table+'.'+c.column).join('\n')}`
    : '';
  if (!confirm(`Apply ${steps.length} deployment step(s), in order?\n\n${steps.map(r=>'· '+r.label).join('\n')}${repair}\n\nThe root .env secrets are synchronised first and the mapping spreadsheet is regenerated last on every Apply All.`)) return;
  deployApplying = true;
  try {
    const credentialsRow=deployStatus.rows.find(r=>r.key==='credentials');
    if(credentialsRow) credentialsRow.state='busy';
    renderAll(); setActiveTabViewOnly('export');
    await deployRuntimeCredentials({silent:true});
    if(credentialsRow){ credentialsRow.state='current'; credentialsRow.apply=null; }

    for (const row of pending){
      row.state = 'busy'; renderAll(); setActiveTabViewOnly('export');
      try {
        const result=await row.apply();
        if(row.workflow==='external-route')reconcileExternalDeploymentBoard(result);
        row.state = 'current'; row.apply = null;
      }
      catch(err){ row.state = 'fail'; row.error = explainTargetSqlError(err.message); throw new Error(`${row.label}: ${row.error}`); }
    }

    const workbookRow=deployStatus.rows.find(r=>r.key==='workbook');
    if(workbookRow) workbookRow.state='busy';
    renderAll(); setActiveTabViewOnly('export');
    await deployMappingWorkbook({silent:true});
    if(workbookRow){ workbookRow.state='current'; workbookRow.apply=null; }
    toast('Apply All completed. Runtime secrets and the mapping spreadsheet were refreshed. Status was not rechecked.', 'ok');
  } catch(err){
    toast(err.message, 'err');
  } finally {
    deployApplying = false;
    renderAll(); setActiveTabViewOnly('export');
  }
}

// (The "run canonical Python validator" button was removed from the Export
// page by request. The server's /api/validate-workbook endpoint remains for
// CI or scripted use — POST { workbookBase64, filename }.)

