function duplicatePhysicalColumn(cols){
  const seen=new Set();
  for(const c of cols||[]){const name=String(c.name||'').toLowerCase();if(seen.has(name)) return c.name;seen.add(name);} return '';
}
function validateModel(){
  pruneDownstreamModel({ dropExcluded:true });
  repairAllForeignKeyDerivations();
  const errors = [], warnings = [];
  const v = state.vault;
  const tables = includedTables();
  if (!v.name) errors.push('Vault short name (NAME) is not set.');
  else {
    const inputIssue=studioInputIssue('vaultShortName',v.name,'Vault short name');
    if(inputIssue) errors.push(inputIssue);
    else if (identifierIssue(v.name)) errors.push('Vault short name: ' + identifierIssue(v.name));
  }
  if (!v.prefix) errors.push('Staging prefix is not set.');
  else {
    const inputIssue=studioInputIssue('stagingPrefix',v.prefix,'Staging prefix');
    if(inputIssue) errors.push(inputIssue);
    else if (identifierIssue(v.prefix)) errors.push('Staging prefix: ' + identifierIssue(v.prefix));
  }
  if (!v.tenantId) errors.push('Tenant ID literal is not set.');
  else { const inputIssue=studioInputIssue('tenantId',v.tenantId,'Tenant ID literal'); if(inputIssue) errors.push(inputIssue); }
  if (v.srcCod) { const inputIssue=studioInputIssue('sourceSystemCode',v.srcCod,'Source system code'); if(inputIssue) errors.push(inputIssue); }
  const prefixLengthIssue=studioLengthIssue('stagingPrefix',v.prefix,'Staging prefix');
  if(prefixLengthIssue) errors.push(prefixLengthIssue);
  const tenantLengthIssue=studioLengthIssue('tenantId',v.tenantId,'Tenant ID literal');
  if(tenantLengthIssue) errors.push(tenantLengthIssue);
  if (!v.srcDescription) errors.push('Source system description is not set — this is the critical join key.');
  else { const inputIssue=studioInputIssue('sourceSystemDescription',v.srcDescription,'Source system description'); if(inputIssue) errors.push(inputIssue); }
  [
    ['vaultShortName', v.name, 'Vault short name'],
    ['dataVaultName', v.vaultDbName, 'Target data vault database name'],
    ['dataVaultDescription', v.vaultDescription, 'Data vault description'],
    ['sourceSystemCode', v.srcCod, 'Source system code'],
    ['sourceSystemDescription', v.srcDescription, 'Source system description'],
    ['connectionHost', v.srcHost, 'Source connection host'],
    ['connectionDatabase', v.srcDatabase, 'Source connection database'],
    ['connectionUser', v.srcUser, 'Source connection username'],
    ['connectionHost', v.dvHost, 'Data Vault connection host'],
    ['connectionDatabase', v.dvDatabase, 'Data Vault connection database'],
    ['connectionUser', v.dvUser, 'Data Vault connection username'],
  ].forEach(([fieldKey,value,label])=>{ const issue=pdiMetaLengthIssue(fieldKey,value,label); if(issue) errors.push(issue); });
  const connectionNames=[`${v.name}_source`,`${v.name}_staging`,`${v.name}_datavault`];
  connectionNames.forEach(name=>{ const issue=pdiMetaLengthIssue('connectionName',name,`Generated connection name "${name}"`); if(issue) errors.push(issue); });
  if (!v.vaultDbName) warnings.push('Target data vault database name is blank.');
  if (tables.length===0) errors.push('No included source tables defined.');
  if (v.dialect==='sqlserver') errors.push('This project still uses the legacy built-in SQL Server source. Install the SQL Server database type with + Add database type; Studio will migrate the connection values automatically.');
  if (state.hubs.length===0) warnings.push('No hubs defined yet.');
  const stagingTableCounts={};
  tables.forEach(t=>{const name=stagingViewName(t);stagingTableCounts[name]=(stagingTableCounts[name]||0)+1;});
  Object.entries(stagingTableCounts).filter(([,count])=>count>1).forEach(([name,count])=>errors.push(`${count} source tables resolve to the same staging table name "${name}". Set distinct source/target names before export.`));
  findDuplicateSatelliteGroups().forEach(group=>{
    const s = group[0];
    const kind = state.hubSats.includes(s) ? 'hub' : 'link';
    const label = group.map(x=>satelliteDisplayName(x, kind)).join(', ');
    errors.push(`${group.length} duplicate satellites for the same ${kind} source/attribute set (${label}) — this would generate duplicate spreadsheet metadata and may leave the sheet out of sync with DDL. Go to Vault → Satellites and use "Remove duplicates".`);
  });
  tables.forEach(t=>{
    [
      ['sourceTableName', t.name, `Source table "${t.name}" name`],
      ['sourceTableDescription', t.description || '', `Source table "${t.name}" description`],
      ['stagingTableName', stagingViewName(t), `Generated staging table name for "${sourceTableLabel(t)}"`],
      ['sourceConcat', sourceConcat(t), `Generated source_concat for "${sourceTableLabel(t)}"`],
      ['incrementDateColumn', t.incrementCol || '', `Increment date column for "${t.name}"`],
      ['stagingSqlOverride', effectiveOverride(t), `Staging SQL override for "${t.name}"`],
    ].forEach(([fieldKey,value,label])=>{ const issue=pdiMetaLengthIssue(fieldKey,value,label); if(issue) errors.push(issue); });
    const schemaIssue=pdiMetaLengthIssue('sourceSchema',sourceTableSchema(t),`Source schema for "${sourceTableLabel(t)}"`); if(schemaIssue) errors.push(schemaIssue);
    if (t.columns.length===0) warnings.push(`Table "${t.name}" has no columns.`);
    if (t.columns.length>0 && stagedColumns(t).length===0) errors.push(`Table "${t.name}" is included but has no columns selected for staging. Select at least one column or exclude the table on the Tables page.`);
    const legacyOverrideOutputs=customOverrideDerivedOutputColumns(t);
    if(legacyOverrideOutputs.length) errors.push(`Table "${sourceTableLabel(t)}" has a custom staging SQL override that returns PostgreSQL-derived view column(s): ${legacyOverrideOutputs.join(', ')}. Reset the override to auto or remove those output aliases; v0.2 computes them in staging.${stagingViewName(t)}.`);
    const allPk=(t.columns||[]).filter(c=>c.pk);
    const selectedPk=allPk.filter(isColumnStaged);
    if (selectedPk.length>0 && selectedPk.length<allPk.length){
      const missing=allPk.filter(c=>!isColumnStaged(c)).map(c=>c.name);
      errors.push(`Table "${t.name}" has only part of its primary key selected for staging. Include ${missing.join(' + ')} or exclude the full key/table before modelling.`);
    }
    const declared=(state.sourceMeta&&state.sourceMeta.foreignKeys||[]).filter(f=>
      f.table===t.name && f.constraintName &&
      (!f.tableSchema || String(f.tableSchema).toLowerCase()===String(sourceTableSchema(t)).toLowerCase()));
    const fkGroups={}; declared.forEach(f=>{(fkGroups[f.constraintName]||(fkGroups[f.constraintName]=[])).push(f);});
    Object.entries(fkGroups).forEach(([constraint,rows])=>{
      const selected=rows.filter(f=>stagedColumns(t).some(c=>c.name===f.column));
      if(selected.length>0&&selected.length<rows.length){
        const missing=rows.filter(f=>!stagedColumns(t).some(c=>c.name===f.column)).map(f=>f.column);
        errors.push(`Table "${t.name}" has only part of foreign key "${constraint}" selected for staging. Include ${missing.join(' + ')} or exclude every column in that relationship.`);
      }
    });
    const targetCounts = {};
    stagedColumns(t).forEach(c=>{
      const target = targetColumnName(c);
      const issue = targetIdentifierIssue(target);
      if (issue) errors.push(`Table "${t.name}" column "${c.name}": ${issue}`);
      targetCounts[target] = (targetCounts[target]||0)+1;
    });
    Object.entries(targetCounts).filter(([,count])=>count>1).forEach(([name,count])=>{
      errors.push(`Table "${t.name}" has ${count} selected columns targeting staging name "${name}". Give each column a unique Staging name on the Tables page.`);
    });
    if (!t.columns.some(c=>c.pk) && !state.hubs.some(h=>h.tableId===t.id)) {
      // informational only
    }
    // Duplicate physical staging aliases are blocking: silently keeping the
    // first would make a key disappear from the generated SQL/workbook.
    duplicateDerivationTargets(t).forEach(({name,count})=>{
      errors.push(`Table "${t.name}" has ${count} derivations all targeting "${name}". Remove or correct the duplicate derivations before export.`);
    });
  });
  state.hubs.forEach(h=>{
    const descriptionIssue=pdiMetaLengthIssue('hubDescription',h.description || '',`Hub "${h.entity}" description`);
    if(descriptionIssue) errors.push(descriptionIssue);
    const table=findTable(h.tableId);
    if(!table){errors.push(`Hub "${h.entity}" references a missing table.`);return;}
    const keys=hubKeyCols(h);
    if(!keys.length) errors.push(`Hub "${h.entity}" has no business key columns.`);
    else if(!tableHasHashForColumns(table,h.entity,keys.map(c=>c.name),h.entity)) errors.push(`Hub "${h.entity}" has no complete hash/business-key derivation for "${keys.map(c=>c.name).join(' + ')}" on "${table.name}".`);
  });
  state.links.forEach(l=>{
    const descriptionIssue=pdiMetaLengthIssue('linkDescription',l.description || '',`Link "${l.entity}" description`);
    if(descriptionIssue) errors.push(descriptionIssue);
    if (l.hubs.length<2) errors.push(`Link "${l.entity}" has fewer than 2 hubs.`);
    const hubCountIssue=pdiMetaItemCountIssue('linkHubs',l.hubs,`Link "${l.entity}"`);
    if(hubCountIssue) errors.push(hubCountIssue);
    const table = findTable(l.tableId);
    const physicalCols = linkColumns(l).map(c=>c.name);
    const duplicatePhysical = physicalCols.find((name,i)=>physicalCols.indexOf(name)!==i);
    if (duplicatePhysical) errors.push(`Link "${l.entity}" generates duplicate physical column "${duplicatePhysical}". Assign distinct source-role columns before export.`);
    l.hubs.forEach(h=>{
      const hub = findHub(h.hubId);
      const cols = table ? linkHubCols(table, h) : [];
      if (!hub) { errors.push(`Link "${l.entity}" references a missing hub.`); return; }
      if (table && !ensureLinkHubHash(table, h, l)) errors.push(`Link "${l.entity}" is missing a hash key for hub "${hub.entity}" using source column(s) "${cols.map(c=>c.name).join(' + ')||'?'}" on "${table.name}".`);
    });
  });
  state.hubSats.concat(state.linkSats).forEach(s=>{
    const satLabel=`Satellite "${s.entity}${s.concern?'_'+s.concern:''}"`;
    const descriptionIssue=pdiMetaLengthIssue('satelliteDescription',s.description || '',`${satLabel} description`);
    if(descriptionIssue) errors.push(descriptionIssue);
    if(s.attrs.length===0) warnings.push(`${satLabel} has no attributes.`);
    const physical=state.hubSats.includes(s)?hubSatColumns(s):linkSatColumns(s);
    const duplicate=duplicatePhysicalColumn(physical);
    if(duplicate) errors.push(`Satellite "${s.entity}${s.concern?'_'+s.concern:''}" generates duplicate physical column "${duplicate}".`);
    const counts={};
    s.attrs.forEach(a=>{
      const issue=targetIdentifierIssue(a.target);
      if(issue) errors.push(`Satellite "${s.entity}${s.concern?'_'+s.concern:''}" target "${a.target}": ${issue}`);
      if(RESERVED_TARGET_COLUMNS.has(a.target)) errors.push(`Satellite "${s.entity}${s.concern?'_'+s.concern:''}" cannot use reserved system column "${a.target}".`);
      counts[a.target]=(counts[a.target]||0)+1;
    });
    Object.entries(counts).filter(([,count])=>count>1).forEach(([name,count])=>errors.push(`Satellite "${s.entity}${s.concern?'_'+s.concern:''}" maps ${count} attributes to target column "${name}".`));
  });
  const unmapped = unmappedAttributeColumns();
  if (unmapped.length){
    const sample = unmapped.slice(0,20).map(x=>`${x.table}.${x.column}`).join(', ');
    errors.push(`${unmapped.length} staged column(s) are not mapped into a Vault satellite: ${sample}${unmapped.length>20?' …':''}. Map them, run Suggest/AI again, or explicitly exclude them on the Staging page.`);
  }
  const uncoveredTables = vaultUncoveredTables();
  if (uncoveredTables.length){
    const sample = uncoveredTables.slice(0,20).map(sourceTableLabel).join(', ');
    errors.push(`${uncoveredTables.length} included table(s) with staged columns are not represented in the Vault model: ${sample}${uncoveredTables.length>20?' …':''}. Add a Hub, Link or Satellite, or exclude the table.`);
  }
  if (state.externalTables.enabled){
    const ext = state.externalTables;
    const pack=databasePackForDialect(ext.remoteDialect);
    if(pack){
      syncPackMappedValues(pack,'target');
      ext.drivername=pack.jdbc.driverClass;
      ext.jarfile=pack.driverFile?`/opt/jdbc-drivers/${pack.driverFile}`:'';
      ext.url=defaultExternalJdbcUrl(ext.remoteDialect,ext.studioHost||'',ext.studioPort||'',ext.studioDatabase||ext.remoteDatabase||'');
    }
    if (state.vault.targetPreset !== 'internal') errors.push('JDBC FDW storage is available only with the internal PostgreSQL container.');
    if (!ext.serverName) errors.push('External storage is enabled but no server name is set.');
    if (!ext.drivername) errors.push('External storage is enabled but no JDBC driver class is set.');
    if (!ext.url) errors.push('External storage is enabled but no JDBC URL is set.');
    if (!ext.jarfile) warnings.push('External storage has no path set for the JDBC driver .jar file.');
    if(pack){
      const missing=missingDatabasePackConnectionFields(pack,'target');
      if(missing.length) errors.push(`Complete the required ${pack.label} target field(s): ${missing.join(', ')}.`);
      const fdwCredentialIssue=databasePackFdwCredentialIssue(pack);
      if(fdwCredentialIssue) errors.push(fdwCredentialIssue);
    }else{
      if (!ext.username) warnings.push('External storage user mapping has no username set.');
      if (!(ext.studioHost)) errors.push('External storage is enabled but the Studio-to-target host is missing.');
      if (!(ext.studioDatabase||ext.remoteDatabase)) errors.push('External storage is enabled but the remote database name is missing.');
      if (!(ext.studioUser||ext.username)) errors.push('External storage is enabled but the remote deployment username is missing.');
    }
    if (ext.serverName && !externalIdentifierIsSafe(ext.serverName)) errors.push('External storage server name must be a plain SQL identifier.');
    if (!pack && (ext.studioDatabase||ext.remoteDatabase) && !externalIdentifierIsSafe(ext.studioDatabase||ext.remoteDatabase)) errors.push('External database name must be a plain identifier.');
    if (!pack && (ext.studioSchema||ext.remoteSchema) && !externalIdentifierIsSafe(ext.studioSchema||ext.remoteSchema)) errors.push('External schema name must be a plain identifier.');
    if (!pack && ext.remoteDialect!=='mysql' && !(ext.studioSchema||ext.remoteSchema)) warnings.push('Remote table DDL has no remote schema set (leave blank only if the login default is intentional).');
  }
  return { errors, warnings };
}
