async function ensureLocalServerReachable(){
  const health = await localFetch(`/api/health`).catch(()=>null);
  if (!health || !health.ok) throw new Error(`Local server not reachable at ${localServerUrl} — is it running?`);
}

// Translate raw Postgres permission errors into something the person can
// actually act on, instead of a bare "permission denied".
function explainTargetSqlError(message){
  const m = String(message || '');
  let hint = '';
  const schemaDenied = m.match(/permission denied for schema (\w+)/i);
  const roleMissing = m.match(/role "([\w]+)" does not exist/i);
  const notOwner = m.match(/must be owner of schema (\w+)/i);
  if (/lock timeout|canceling statement due to lock/i.test(m)){
    return m + ' — something else holds a lock on these tables (a running engine load, the scheduler, or an abandoned session). Stop the engine / disable the scheduler and retry; to find the blocker, run this using a PostgreSQL account that can view active sessions: SELECT pid, state, pg_blocking_pids(pid), left(query,80) FROM pg_stat_activity WHERE datname = current_database();';
  }
  if (/statement timeout/i.test(m)){
    return m + ' — the script ran longer than 120s. Check the target database load and retry.';
  }
  if (schemaDenied || notOwner){
    const schema = (schemaDenied || notOwner)[1];
    hint = ` — schema "${schema}" is owned by another user. Run this using the schema owner or another PostgreSQL account allowed to change ownership: ALTER SCHEMA ${schema} OWNER TO ${schema};`;
  } else if (roleMissing){
    hint = ` — the required Data Vault users are missing from this database server. Use Set up metadata on the Export & Deploy page, or run start.sh up --build from the command line.`;
  }
  return m + hint;
}

function explainBootstrapError(r){
  const msg = r.error || `Target setup failed at step: ${r.step||'?'}.`;
  if (/password authentication failed for user/i.test(msg)){
    return msg + ' — check the Target username and password on the Connections step. That PostgreSQL account must be allowed to create the target database, users and schemas.';
  }
  if (/connection to server at "postgres"/i.test(msg)){
    return msg + ' — the engine settings still pointed at the internal service. They have been saved again; run target setup once more.';
  }
  if (/could not translate host name|connection refused|timeout expired/i.test(msg)){
    return msg + ' — the target setup runs inside a container, so "localhost" refers to the container itself. Use the database server\'s hostname or IP address (or host.docker.internal for a database on this machine).';
  }
  return msg;
}

async function executeSqlAgainstTarget(sql, options={}){
  if (state.externalTables.enabled && !options.allowExternalLocalDdl && /(?:CREATE|ALTER)\s+FOREIGN\s+TABLE|CREATE\s+EXTENSION[\s\S]*?jdbc_fdw/i.test(String(sql||''))){
    throw new Error('External core tables must be deployed from Vault → External Data Vault tables so remote tables are verified before local FDW objects are applied.');
  }
  const v = state.vault;
  await ensureLocalServerReachable();
  const resp = await localFetch(`/api/execute-sql`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({...targetConnectionPayload(),sql}),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Execution failed.');
  return data;
}

async function queryPostgresDatabase(database, sql, options={}){
  const v = state.vault;
  await ensureLocalServerReachable();
  const resp = await localFetch(`/api/query`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({...targetConnectionPayload(database),sql,role:options.role||undefined}),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Query failed.');
  return data.rows || [];
}

async function queryTarget(sql){
  return queryPostgresDatabase(state.vault.dvDatabase, sql);
}

async function queryTargetAsDataVault(sql){
  return queryPostgresDatabase(state.vault.dvDatabase, sql, {role:'data_vault'});
}

async function queryTargetAsPdiMeta(sql){
  return queryPostgresDatabase(state.vault.dvDatabase, sql, {role:'pdi_meta'});
}

function expectedDataVaultTableNames(){
  const names = [];
  const add = n => { if (n){ names.push(n); names.push(`${n}_err`); } };
  state.hubs.forEach(h=>add(hubName(h.entity)));
  state.links.forEach(l=>add(linkNameOf(l.entity)));
  state.hubSats.forEach(s=>add(satName(s.entity, s.concern)));
  state.linkSats.forEach(s=>add(lsatName(s.entity, s.concern)));
  return [...new Set(names)];
}

async function findMissingDataVaultTables(){
  const expected = expectedDataVaultTableNames();
  if (expected.length===0) return [];
  const rows = await queryTarget(`SELECT DISTINCT table_name FROM data_vault.vw_information_schema_columns_data_vault`);
  const live = new Set(rows.map(r=>String(r.table_name||'').toLowerCase()));
  return expected.filter(n=>!live.has(String(n).toLowerCase()));
}

async function runSqlAgainstTarget(sql, label){
  const v = state.vault;
  if (!confirm(`Run ${label} against ${v.dvHost}:${v.dvPort}/${v.dvDatabase}?\n\nThis executes real SQL on that database, inside a transaction — if anything fails, nothing is committed. This cannot be undone by this app.`)) return;
  try {
    await executeSqlAgainstTarget(sql);
    toast(`${label} applied to ${v.dvDatabase}.`, 'ok');
  } catch(err){
    toast(`${label} failed: ${err.message}`, 'err');
  }
}

function dockerResultHtml(result, actionLabel){
  if (!result.ok){
    const msg = result.error || result.stderr || 'Failed — no further detail returned.';
    return `<div class="ai-status err mt" style="align-items:flex-start;"><span style="white-space:pre-wrap;">${escapeHtml(actionLabel)} failed:<br>${escapeHtml(msg)}</span></div>`;
  }
  return `<div class="ai-status ok mt" style="align-items:flex-start;"><span style="white-space:pre-wrap;">${escapeHtml(actionLabel)} succeeded.${result.stdout ? '<br><br>'+escapeHtml(result.stdout) : ''}</span></div>`;
}

// Shared: whether the next external-mode engine start should include the
// one-off metadata setup (start.sh's --build flag).
// (The one-off --build engine start was replaced by the deployment board's
// Set up metadata, which refreshes the engine config first and reports errors
// properly. start.sh up --external-postgres --build remains for CLI users.)

async function dockerRunHop(){
  const btn = document.getElementById('btn-docker-runhop');
  const statusEl = document.getElementById('docker-runhop-status');
  if (!await requireLicenseAccepted(()=> dockerRunHop())) return;
  if (deployBusy()){ toast('A deploy is still running — wait for it to finish before starting the engine.', 'err'); return; }

  const validation = validateModel();
  if (validation.errors.length){
    const msg = `The engine was not started because the design has ${validation.errors.length} blocking validation error(s). Open Export & Deploy to review them.`;
    statusEl.innerHTML = `<div class="ai-status err mt">${escapeHtml(msg)}</div>`;
    toast(msg, 'err');
    return;
  }
  if (engineModeInvalid()){
    const msg = 'The bundled sakila demo source only runs with the internal Postgres target (start.sh rejects --demo with --external-postgres). Switch the target to "Postgres Internal", or the source away from "MySQL Demo".';
    statusEl.innerHTML = `<div class="ai-status err mt" style="align-items:flex-start;"><span>${escapeHtml(msg)}</span></div>`;
    toast('Invalid run mode — see details.', 'err');
    return;
  }
  const sourceDriverSpec=jdbcDriverSpec(state.vault.dialect);
  if (sourceDriverSpec){
    try {
      const sourcePack=databasePackForDialect(state.vault.dialect);
      let found='';
      if(sourcePack){
        const pathStatus=await localFetch('/api/driver-path-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jarfile:sourcePack.driverFile?`/opt/jdbc-drivers/${sourcePack.driverFile}`:''})}).then(r=>r.json());
        if(!pathStatus.ok) throw new Error(pathStatus.error||'Could not check source JDBC driver.');
        if(pathStatus.exists) found=pathStatus.filename;
      }else{
        const drv = await checkJdbcDrivers();
        found=drv[sourceDriverSpec.statusField]||'';
      }
      if (!found){
        statusEl.innerHTML = `<div class="ai-status err mt" style="align-items:flex-start;"><span>No ${escapeHtml(sourceDriverSpec.label)} jar found in <span class="mono">jdbc-drivers/</span> — the engine cannot read this source without it. ${sourcePack?'Place a driver matching the database type in jdbc-drivers/.':'Fetch it from Connections, then start again.'}</span></div>`;
        toast(`${sourceDriverSpec.label} missing — engine not started.`, 'err');
        return;
      }
    } catch(err){
      statusEl.innerHTML = `<div class="ai-status err mt">Could not verify the source JDBC driver: ${escapeHtml(err.message)}</div>`;
      return;
    }
  }

  btn.disabled = true; btn.textContent = 'Checking…';
  statusEl.innerHTML = `<div class="ai-status busy mt"><span class="dot"></span>Checking the generated Data Vault DDL against the target tables and columns…</div>`;
  try {
    const expected = parseGeneratedDdlObjects(buildDataVaultDdl()).filter(o=>o.schema==='data_vault');
    const liveRows = await queryTarget(`SELECT table_schema, table_name, column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, udt_name FROM information_schema.columns WHERE lower(table_schema)='data_vault'`);
    const delta = computeTargetDelta(expected, liveRows);
    if (delta.missingTables.length || delta.missingColumns.length || delta.obsoleteColumns.length){
      const count = delta.missingTables.length + delta.missingColumns.length + delta.obsoleteColumns.length;
      const preview = [
        ...delta.missingTables.slice(0,10).map(x=>`missing table ${x.schema}.${x.name}`),
        ...delta.missingColumns.slice(0,10).map(x=>`missing column ${x.schema}.${x.table}.${x.column}`),
        ...delta.obsoleteColumns.slice(0,10).map(x=>`obsolete Link Satellite column ${x.schema}.${x.table}.${x.column}`),
      ].slice(0,20).join('\n');
      const apply = confirm(`${count} Data Vault object/column change(s) are required before the engine can run:\n\n${preview}${count>20?`\n…plus ${count-20} more`:''}\n\nApply the incremental DDL now?`);
      if (!apply){
        statusEl.innerHTML = `<div class="ai-status err mt">The engine was not started because the physical Data Vault schema is out of date.</div>`;
        return;
      }
      btn.textContent = 'Applying DDL…';
      statusEl.innerHTML = `<div class="ai-status busy mt"><span class="dot"></span>Applying required Data Vault schema changes…</div>`;
      await executeSqlAgainstTarget(buildIncrementalSql(delta));
    }

    const useBuild = false; // metadata setup runs from the deployment board, never bundled into engine start
    if (!confirm(`Start the data vault engine now?\n\nRun mode: ${engineModeLabel()}${useBuild ? '\nIncluding first-time target setup (--build) — this can take several minutes.' : ''}`)) return;

    btn.textContent = 'Applying current design…';
    statusEl.innerHTML = `<div class="ai-status busy mt"><span class="dot"></span>Saving the current metadata workbook, source connection and engine settings…</div>`;
    await deployMappingWorkbook({ silent:true });
    await deployHopSourceConnection({ silent:true });
    await deployHopConfig({ silent:true });


    btn.textContent = 'Starting…';
    statusEl.innerHTML = `<div class="ai-status busy mt"><span class="dot"></span>Preparing run monitor and starting the data vault engine — ${escapeHtml(engineModeLabel())}${useBuild ? ' (with target setup)' : ''}…</div>`;
    await ensureLocalServerReachable();
    // Capture the pdi_meta baseline BEFORE Docker starts. The old flow captured
    // MAX(id_run) after `up -d` returned, which could race a fast-starting run.
    // Failure to prepare the optional Hub watcher never blocks the engine start.
    const watchPrepared = await prepareRunWatch();
    const resp = await localFetch(`/api/docker/run-hop`, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ mode: engineMode(), build: useBuild }) });
    const data = await resp.json();
    statusEl.innerHTML = dockerResultHtml(data, 'Starting the data vault engine');
    if(data.ok && watchPrepared) armRunWatch();
    else if(!data.ok && watchPrepared) cancelPreparedRunWatch();
    toast(data.ok ? 'Data vault engine starting.' : 'Could not start the data vault engine — see details.', data.ok?'ok':'err');
  } catch(err){
    statusEl.innerHTML = `<div class="ai-status err mt">${escapeHtml(err.message)}</div>`;
    toast('Could not start the data vault engine.','err');
  }
  btn.disabled = false; btn.textContent = 'Start data vault engine';
}

// (Container-status checking was removed from the UI — in production the
// source/target databases are typically external servers, not containers.
// The server's read-only /api/docker/status endpoint still exists if a
// future surface needs it; only the hop ENGINE is Docker-managed here.)

async function deployFilesToFolder(){
  const n = parseInt(deployStartNum, 10) || 4;
  const pad = num => String(num).padStart(2, '0');
  const files = {
    [`${pad(n)}-ddls.sql`]: buildCombinedDdl(),
    [`${pad(n+1)}-pdi-meta.sql`]: getExportSql('pdimeta'),
  };
  // Remote table DDL targets a DIFFERENT database entirely (possibly a
  // different engine) — it has no place in this Postgres container's own
  // init sequence, so it's deliberately left out of this numbered set.
  const statusEl = document.getElementById('deploy-status');
  try {
    const health = await localFetch(`/api/health`).catch(()=>null);
    if (!health || !health.ok) throw new Error(`Local server not reachable at ${localServerUrl} — is it running?`);
    const body = { destination: 'db-init', files };
    const resp = await localFetch(`/api/deploy-files`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Deploy failed.');
    if (statusEl) statusEl.innerHTML = `<div class="ai-status ok mt" style="align-items:flex-start;"><span>Wrote ${data.written.length} file(s) to <span class="mono">${escapeHtml(data.folder)}</span>:<br>${data.written.map(escapeHtml).join('<br>')}<br><br>Postgres only runs <span class="mono">docker-entrypoint-initdb.d</span> scripts on a <b>fresh, empty data volume</b> — dropping these into an already-initialized container's local deploy folder won't run them automatically. Use "Execute" above for an already-running database, or reset the volume for a true from-scratch init.</span></div>`;
    toast(`Deployed ${data.written.length} file(s) to ${data.folder}.`, 'ok');
  } catch(err){
    if (statusEl) statusEl.innerHTML = `<div class="ai-status err mt">${escapeHtml(err.message)}</div>`;
    toast(`Deploy failed: ${err.message}`, 'err');
  }
}

async function deployJdbcDriver(context='source'){
  const targetRequest=context==='target';
  const dialect=targetRequest ? state.externalTables.remoteDialect : state.vault.dialect;
  const spec=jdbcDriverSpec(dialect);
  if (!spec || !spec.url){
    const pack=databasePackForDialect(dialect);
    const message=pack
      ? `${pack.label} uses a customer-supplied JDBC driver. Place a jar matching ${packDriverDisplay(pack)} in jdbc-drivers/; Studio will verify it but will not download vendor drivers automatically.`
      : (targetRequest
        ? 'Automated built-in target-driver download is available for MySQL. Database Pack targets use the Pack JDBC driver requirement; Export preflight validates the shared jdbc-drivers folder.'
        : 'The Hop PostgreSQL source driver is already bundled.');
    toast(message, 'err');
    return;
  }

  jdbcDriverDeployStatus = 'loading';
  if(targetRequest) targetJdbcDriverStatus='loading';
  const btn = document.getElementById(targetRequest?'btn-deploy-target-jdbc-driver':'btn-deploy-jdbc-driver');
  if (btn) btn.textContent = 'Fetching & deploying…';
  const statusEl = targetRequest ? null : document.getElementById('jdbc-driver-deploy-status');
  try {
    const health = await localFetch(`/api/health`).catch(()=>null);
    if (!health || !health.ok) throw new Error(`Local server not reachable at ${localServerUrl} — is it running?`);
    const resp = await localFetch(`/api/fetch-driver`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ url:spec.url, filename:spec.filename, ...(jdbcDriverFolder ? {folder:jdbcDriverFolder} : {}) }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Fetch/deploy failed.');
    jdbcDriverDeployStatus = 'ok';
    if(targetRequest){
      state.externalTables.jarfile=`/opt/jdbc-drivers/${spec.filename}`;
      const pack=databasePackForDialect(dialect);
      if(pack){ pack.driverPresent=true; pack.driverFile=spec.filename; }
      targetJdbcDriverStatus='ok';
      targetJdbcDriverMessage=`${spec.filename} was written to jdbc-drivers/ and is available to the packaged PostgreSQL FDW container.`;
    } else if (statusEl) {
      const pack=databasePackForDialect(dialect);
      if(pack){ pack.driverPresent=true; pack.driverFile=spec.filename; }
      statusEl.innerHTML = `<div class="ai-status ok mt" style="align-items:flex-start;"><span>Fetched and wrote <span class="mono">${escapeHtml(spec.filename)}</span> (${(data.bytes/1024/1024).toFixed(1)} MB) to <span class="mono">${escapeHtml(data.folder)}</span>.</span></div>`;
    }
    toast(`Deployed ${spec.filename} to ${data.folder}.`, 'ok');
    if(targetRequest){
      if(activeTab==='connections'){ renderAll(); setActiveTabViewOnly('connections'); }
    } else refreshJdbcDriverStatus();
  } catch(err){
    jdbcDriverDeployStatus = 'error';
    if(targetRequest){
      targetJdbcDriverStatus='error'; targetJdbcDriverMessage=err.message;
      if(activeTab==='connections'){ renderAll(); setActiveTabViewOnly('connections'); }
    } else if (statusEl) statusEl.innerHTML = `<div class="ai-status err mt">${escapeHtml(err.message)}</div>`;
    toast(`Driver deploy failed: ${err.message}`, 'err');
  }
  if (btn) btn.textContent = targetRequest?`Fetch ${spec.label}`:'⬆ Fetch and deploy driver to jdbc-drivers/';
}
async function deployHopConfig(options = {}){
  const statusEl = document.getElementById('hopconfig-deploy-status');
  try {
    const health = await localFetch(`/api/health`).catch(()=>null);
    if (!health || !health.ok) throw new Error(`Local server not reachable at ${localServerUrl} — is it running?`);
    const body = { destination: 'hop', files: { 'postgres-environment.json': buildHopEnvironmentJson() } };
    const resp = await localFetch(`/api/deploy-files`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Deploy failed.');
    if (!options.silent){
      if (statusEl) statusEl.innerHTML = `<div class="ai-status ok mt" style="align-items:flex-start;"><span>Wrote <span class="mono">${escapeHtml(data.written[0] || 'postgres-environment.json')}</span> to <span class="mono">${escapeHtml(data.folder)}</span>. The root <span class="mono">.env</span> was not changed. Restart the engine for it to pick up the new settings.</span></div>`;
      toast(`Saved engine settings to ${data.folder}.`, 'ok');
    }
    return data;
  } catch(err){
    if (!options.silent){
      if (statusEl) statusEl.innerHTML = `<div class="ai-status err mt">${escapeHtml(err.message)}</div>`;
      toast(`Deploy failed: ${err.message}`, 'err');
    }
    if (options.silent) throw err;
    return null;
  }
}

async function deployHopSourceConnection(options = {}){
  const statusEl = document.getElementById('sourceconn-deploy-status');
  try {
    const health = await localFetch(`/api/health`).catch(()=>null);
    if (!health || !health.ok) throw new Error(`Local server not reachable at ${localServerUrl} — is it running?`);
    const body = { destination: 'metadata-rdbms', files: { 'source.json': buildHopSourceConnectionJson() } };
    const resp = await localFetch(`/api/deploy-files`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Deploy failed.');
    if (!options.silent){
      if (statusEl) statusEl.innerHTML = `<div class="ai-status ok mt" style="align-items:flex-start;"><span>Wrote <span class="mono">${escapeHtml(data.written[0] || 'source.json')}</span> (${DIALECTS[state.vault.dialect].label}) to <span class="mono">${escapeHtml(data.folder)}</span>. Restart the engine for it to pick up the new connection.</span></div>`;
      toast(`Deployed ${DIALECTS[state.vault.dialect].label} source.json to ${data.folder}.`, 'ok');
    }
    return data;
  } catch(err){
    if (!options.silent){
      if (statusEl) statusEl.innerHTML = `<div class="ai-status err mt">${escapeHtml(err.message)}</div>`;
      toast(`Deploy failed: ${err.message}`, 'err');
    }
    if (options.silent) throw err;
    return null;
  }
}

async function deployMappingWorkbook(options = {}){
  const statusEl = document.getElementById('mapping-deploy-status');
  try {
    const health = await localFetch(`/api/health`).catch(()=>null);
    if (!health || !health.ok) throw new Error(`Local server not reachable at ${localServerUrl} — is it running?`);
    const prepared=await prepareMappingWorkbookForDelivery();
    if(!prepared.ok) throw new Error(`Workbook preflight failed: ${prepared.error}`);
    const wb = prepared.wb;
    const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
    const filename = prepared.filename;
    const body = { destination: 'mappings', files: { [filename]: base64 } };
    const resp = await localFetch(`/api/deploy-files`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Deploy failed.');
    // This workbook carries the complete incremental configuration: the
    // selected column, per-table on/off flag, and global days-to-load setting.
    // Hop environment/config deployment is unrelated.
    if (FEATURE_INCREMENTAL){
      const incrementalStateChanges = markIncrementalWorkbookDeployed();
      if (incrementalStateChanges && typeof scheduleAutosave === 'function') scheduleAutosave();
    }
    if (!options.silent){
      if (statusEl) statusEl.innerHTML = `<div class="ai-status ok mt" style="align-items:flex-start;"><span>Wrote <span class="mono">${escapeHtml(data.written[0] || filename)}</span> to <span class="mono">${escapeHtml(data.folder)}</span>.</span></div>`;
      toast(`Deployed ${filename} to ${data.folder}.`, 'ok');
    }
    return data;
  } catch(err){
    if (!options.silent){
      if (statusEl) statusEl.innerHTML = `<div class="ai-status err mt">${escapeHtml(err.message)}</div>`;
      toast(`Deploy failed: ${err.message}`, 'err');
    }
    if (options.silent) throw err;
    return null;
  }
}


