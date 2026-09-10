/* =========================================================================
   HOPPER EDW MODEL EXPORT

   The Studio model remains the source of truth.  This exporter deliberately
   serializes its logical source/Vault model, rather than reusing the
   Millersoft staging hashes or spreadsheet-specific execution metadata.
   ========================================================================= */
function hopperXml(value){
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function hopperTag(name, value, indent=''){
  return `${indent}<${name}>${hopperXml(value)}</${name}>`;
}
function hopperEmpty(name, indent=''){
  return `${indent}<${name}/>`;
}
function hopperModelStem(){
  return targetIdentifierBase(state.vault.name || 'data_vault', 'data_vault');
}
function hopperSourceConnectionName(){
  return `${hopperModelStem()}_source`;
}
function hopperCatalogConnectionName(){ return 'local-catalog'; }
function hopperVaultConfigurationName(){ return 'data-vault'; }
function hopperHopType(column){
  const type=String(column && column.type || '').toLowerCase();
  if (/bool/.test(type)) return { name:'Boolean', code:1 };
  if (/(char|text|json|xml|uuid|enum|set)/.test(type)) return { name:'String', code:2 };
  if (/(blob|binary|bytea|image)/.test(type)) return { name:'Binary', code:3 };
  if (/\bdate\b/.test(type) && !/(time|stamp)/.test(type)) return { name:'Date', code:7 };
  if (/(time|stamp)/.test(type)) return { name:'Timestamp', code:9 };
  if (/(decimal|numeric|float|double|real|money)/.test(type)) return { name:'Number', code:6 };
  if (/(bigint|int|serial|smallint|tinyint)/.test(type)) return { name:'Integer', code:5 };
  return { name:'String', code:2 };
}
function hopperColumnLength(column){
  const type=String(column && column.type || '');
  const match=type.match(/\((\d+)(?:\s*,\s*(\d+))?\)/);
  return match ? match[1] : '';
}
function hopperColumnPrecision(column){
  const type=String(column && column.type || '');
  const match=type.match(/\(\d+\s*,\s*(\d+)\)/);
  return match ? match[1] : '';
}
function hopperSourceFieldName(column){ return targetColumnName(column) || (column && column.name) || ''; }
function hopperSourceRecordName(table){ return targetIdentifierBase(table && table.name, 'source'); }
function hopperBusinessKeyName(column){ return targetColumnName(column) || (column && column.name) || 'business_key'; }
function hopperHubKeys(hub){ return hubKeyCols(hub); }

function hopperGridLayout(items, cardHeight, startY=80, columns=4){
  const positions=new Map();
  let y=startY;
  for (let first=0; first<items.length; first+=columns){
    const row=items.slice(first,first+columns);
    row.forEach((item,index)=>positions.set(item.id,{ x:80 + index*360, y }));
    y += Math.max(220, ...row.map(cardHeight)) + 70;
  }
  return { positions, bottom:y };
}

function hopperSourceTableHeight(table){
  return 110 + Math.min(16,(table.columns || []).filter(isColumnStaged).length)*24;
}

function hopperSatelliteHeight(satellite){
  return 100 + Math.min(16,(satellite.attrs || []).length)*28;
}

function hopperFamilyLayout(parents, childForParent, startY=80, columns=4){
  const parentPositions=new Map(), childPositions=new Map();
  let y=startY;
  for (let first=0; first<parents.length; first+=columns){
    const row=parents.slice(first,first+columns);
    let rowHeight=180;
    row.forEach((parent,index)=>{
      const x=80 + index*360;
      parentPositions.set(parent.id,{ x, y });
      let childY=y+150;
      (childForParent(parent) || []).forEach(child=>{
        childPositions.set(child.id,{ x, y:childY });
        childY += hopperSatelliteHeight(child) + 35;
      });
      rowHeight=Math.max(rowHeight, childY-y);
    });
    y += rowHeight + 80;
  }
  return { parentPositions, childPositions, bottom:y };
}

function hopperSatelliteParentFields(satellite, hub, issues){
  const sourceTable=findTable(satellite.tableId);
  return hopperHubKeys(hub).map(key=>{
    const found=(sourceTable && sourceTable.columns || []).find(column=>
      column.name===key.name || targetColumnName(column)===hopperBusinessKeyName(key));
    if (found) return hopperSourceFieldName(found);
    issues.warnings.push(`Satellite "${satellite.entity}" cannot confirm parent key "${key.name}" on source "${sourceTable ? sourceTable.name : '?'}"; exported the hub key name for review.`);
    return hopperSourceFieldName(key);
  });
}

function buildHopperSourceModel(){
  const layout=hopperGridLayout(includedTables(),hopperSourceTableHeight);
  const lines=[
    '<source-model>',
    hopperTag('name_sync_with_filename','Y','  '),
    hopperTag('configurationName','source-model','  '),
    '  <configuration>',
    hopperTag('defaultDatabase',hopperSourceConnectionName(),'    '),
    hopperTag('defaultSchema',state.vault.sourceSchema || 'public','    '),
    hopperTag('catalogConnection',hopperCatalogConnectionName(),'    '),
    '  </configuration>',
    '  <tables>',
  ];
  includedTables().forEach(table=>{
    const position=layout.positions.get(table.id);
    lines.push('    <table>');
    lines.push(hopperTag('catalogSourceName',hopperSourceRecordName(table),'      '));
    lines.push(hopperTag('physicalType','DATABASE','      '));
    lines.push(hopperTag('databaseName',hopperSourceConnectionName(),'      '));
    lines.push(hopperTag('schemaName',state.vault.sourceSchema || 'public','      '));
    lines.push(hopperTag('tableName',table.name,'      '));
    lines.push('      <columns>');
    let pkPosition=0;
    (table.columns || []).filter(isColumnStaged).forEach(column=>{
      if (column.pk) pkPosition++;
      const type=hopperHopType(column);
      lines.push('        <column>');
      lines.push(hopperTag('name',hopperSourceFieldName(column),'          '));
      lines.push(hopperTag('description','', '          '));
      lines.push(hopperTag('sourceDataType',column.type || type.name,'          '));
      lines.push(hopperTag('length',hopperColumnLength(column),'          '));
      lines.push(hopperTag('precision',hopperColumnPrecision(column),'          '));
      lines.push(hopperTag('hopType',type.code,'          '));
      lines.push(hopperTag('primaryKeyPosition',column.pk ? pkPosition : 0,'          '));
      lines.push('        </column>');
    });
    lines.push('      </columns>');
    lines.push(hopperEmpty('dataTypeMappingNames','      '));
    lines.push(hopperEmpty('fieldTypeMappings','      '));
    lines.push(hopperTag('xloc',position.x,'      '));
    lines.push(hopperTag('yloc',position.y,'      '));
    lines.push(hopperTag('name',table.name,'      '));
    lines.push('    </table>');
  });
  lines.push('  </tables>');
  lines.push('  <relationships>');
  const included=new Set(includedTables().map(table=>table.name));
  (state.sourceMeta.foreignKeys || []).filter(fk=>included.has(fk.table) && included.has(fk.refTable)).forEach(fk=>{
    const childTable=findIncludedTableByName(fk.table), parentTable=findIncludedTableByName(fk.refTable);
    const childColumn=(childTable && childTable.columns || []).find(column=>column.name===fk.column);
    const parentColumn=(parentTable && parentTable.columns || []).find(column=>column.name===fk.refColumn);
    lines.push('    <relationship>');
    lines.push(hopperTag('description','', '      '));
    lines.push(hopperTag('childEndpointKind','TABLE','      '));
    lines.push(hopperTag('parentEndpointKind','TABLE','      '));
    lines.push(hopperTag('childTableName',fk.table,'      '));
    lines.push(hopperTag('parentTableName',fk.refTable,'      '));
    lines.push('      <child_columns>');
    lines.push(hopperTag('child_column',hopperSourceFieldName(childColumn) || fk.column,'        '));
    lines.push('      </child_columns>');
    lines.push('      <parent_columns>');
    lines.push(hopperTag('parent_column',hopperSourceFieldName(parentColumn) || fk.refColumn,'        '));
    lines.push('      </parent_columns>');
    lines.push(hopperTag('defaultJoinType','LEFT','      '));
    lines.push(hopperTag('cardinality','0..N:1','      '));
    lines.push(hopperTag('childMultiplicity','ZERO_OR_MANY','      '));
    lines.push(hopperTag('parentMultiplicity','ONE','      '));
    lines.push(hopperTag('name',fk.constraintName || `rel_${fk.table}_${fk.column}_${fk.refTable}`,'      '));
    lines.push('    </relationship>');
  });
  lines.push('  </relationships>');
  lines.push(hopperEmpty('queries','  '));
  lines.push(hopperEmpty('notes','  '));
  lines.push(hopperTag('name',hopperModelStem(),'  '));
  lines.push('</source-model>');
  return `${lines.join('\n')}\n`;
}

function addHopperHub(lines, hub, position){
  const table=findTable(hub.tableId);
  lines.push('    <table>');
  hopperHubKeys(hub).forEach(key=>{
    const type=hopperHopType(key);
    lines.push('      <businessKeys>');
    lines.push(hopperTag('name',hopperBusinessKeyName(key),'        '));
    lines.push(hopperTag('description','', '        '));
    lines.push(hopperTag('dataType',type.name,'        '));
    lines.push(hopperTag('length',hopperColumnLength(key),'        '));
    lines.push(hopperTag('composite','N','        '));
    lines.push(hopperEmpty('sourceFieldNames','        '));
    lines.push(hopperTag('sourceFieldName',hopperSourceFieldName(key),'        '));
    lines.push(hopperTag('recordSourceName',hopperSourceRecordName(table),'        '));
    lines.push('      </businessKeys>');
  });
  lines.push(hopperTag('hashKeyFieldName',hubKey(hub.entity),'      '));
  lines.push(hopperEmpty('recordSourceFieldName','      '));
  lines.push('      <recordSources>');
  lines.push(hopperTag('recordSource',hopperSourceRecordName(table),'        '));
  lines.push('      </recordSources>');
  lines.push(hopperTag('allowInferredInsert','N','      '));
  lines.push(hopperTag('tableName',hubName(hub.entity),'      '));
  lines.push(hopperTag('description',hub.description || '', '      '));
  lines.push(hopperTag('tableType','HUB','      '));
  lines.push(hopperTag('integrationMode','HOP_MANAGED','      '));
  lines.push(hopperEmpty('customUpdatePipelinePaths','      '));
  lines.push(hopperTag('xloc',position.x,'      '));
  lines.push(hopperTag('yloc',position.y,'      '));
  lines.push(hopperTag('name',hubName(hub.entity),'      '));
  lines.push(hopperEmpty('virtualPath','      '));
  lines.push('    </table>');
}

function addHopperHubSatellite(lines, satellite, issues, position){
  const hub=findHub(satellite.hubId), table=findTable(satellite.tableId);
  lines.push('    <table>');
  lines.push(hopperTag('hub',hubName(hub.entity),'      '));
  lines.push(hopperEmpty('link','      '));
  (satellite.attrs || []).forEach(attribute=>{
    const column=findCol(table,attribute.colId), type=hopperHopType(column);
    lines.push('      <attributes>');
    lines.push(hopperTag('name',attribute.target || hopperSourceFieldName(column),'        '));
    lines.push(hopperTag('description','', '        '));
    lines.push(hopperTag('dataType',type.name,'        '));
    lines.push(hopperTag('length',hopperColumnLength(column),'        '));
    lines.push(hopperTag('precision',hopperColumnPrecision(column),'        '));
    lines.push(hopperTag('includeInChangeDataCapture','Y','        '));
    lines.push('      </attributes>');
  });
  lines.push('      <parentKeySourceFields>');
  hopperSatelliteParentFields(satellite,hub,issues).forEach(field=>lines.push(hopperTag('parentKeySourceField',field,'        ')));
  lines.push('      </parentKeySourceFields>');
  lines.push(hopperEmpty('drivingKey','      '));
  lines.push(hopperEmpty('drivingKeySourceField','      '));
  lines.push(hopperTag('recordSource',hopperSourceRecordName(table),'      '));
  lines.push(hopperTag('storeRecordSource','Y','      '));
  lines.push(hopperTag('tableName',satName(satellite.entity,satellite.concern),'      '));
  lines.push(hopperTag('description',satellite.description || '', '      '));
  lines.push(hopperTag('tableType','SATELLITE','      '));
  lines.push(hopperTag('integrationMode','HOP_MANAGED','      '));
  lines.push(hopperEmpty('customUpdatePipelinePaths','      '));
  lines.push(hopperTag('xloc',position.x,'      '));
  lines.push(hopperTag('yloc',position.y,'      '));
  lines.push(hopperTag('name',satName(satellite.entity,satellite.concern),'      '));
  lines.push(hopperEmpty('virtualPath','      '));
  lines.push('    </table>');
}

function addHopperLinkSatelliteSources(lines, link){
  const satellites=(state.linkSats || []).filter(satellite=>satellite.linkId===link.id);
  if (!satellites.length) {
    lines.push(hopperEmpty('linkSatelliteSources','      '));
    return;
  }

  // Hopper nests link-satellite mappings beneath the parent Link.  One record
  // source can feed several link satellites, so preserve that relationship in
  // a single linkSatelliteSource rather than emitting duplicate source blocks.
  const bySource=new Map();
  satellites.forEach(satellite=>{
    const table=findTable(satellite.tableId);
    const source=hopperSourceRecordName(table);
    if (!bySource.has(source)) bySource.set(source,[]);
    bySource.get(source).push({ satellite, table });
  });

  lines.push('      <linkSatelliteSources>');
  bySource.forEach((sourceSatellites, source)=>{
    lines.push('        <linkSatelliteSource>');
    lines.push(hopperTag('source',source,'          '));
    lines.push('          <satelliteSourceKeyFields>');
    sourceSatellites.forEach(({ satellite, table })=>{
      lines.push('            <satelliteSourceKeyField>');
      lines.push(hopperTag('satelliteName',lsatName(satellite.entity,satellite.concern),'              '));
      if (!(satellite.attrs || []).length) {
        lines.push(hopperEmpty('attributeSources','              '));
      } else {
        lines.push('              <attributeSources>');
        satellite.attrs.forEach(attribute=>{
          const column=findCol(table,attribute.colId);
          lines.push('                <attributeSource>');
          lines.push(hopperTag('attributeField',attribute.target || hopperSourceFieldName(column),'                  '));
          lines.push(hopperTag('sourceFieldName',hopperSourceFieldName(column),'                  '));
          lines.push('                </attributeSource>');
        });
        lines.push('              </attributeSources>');
      }
      // Studio does not model multi-active link-satellite driving keys yet.
      lines.push(hopperEmpty('drivingKeySources','              '));
      lines.push('            </satelliteSourceKeyField>');
    });
    lines.push('          </satelliteSourceKeyFields>');
    lines.push('        </linkSatelliteSource>');
  });
  lines.push('      </linkSatelliteSources>');
}

function addHopperLink(lines, link, issues, position){
  const table=findTable(link.tableId);
  lines.push('    <table>');
  (link.hubs || []).forEach(linkHub=>{
    const hub=findHub(linkHub.hubId);
    lines.push(hopperTag('hubNames',hubName(hub.entity),'      '));
  });
  lines.push('      <linkHubSources>');
  lines.push('        <linkHubSource>');
  lines.push(hopperTag('source',hopperSourceRecordName(table),'          '));
  lines.push('          <hubSourceKeyFields>');
  (link.hubs || []).forEach(linkHub=>{
    const hub=findHub(linkHub.hubId), keyFields=hopperHubKeys(hub), sourceFields=linkHubCols(table,linkHub);
    lines.push('            <hubSourceKeyField>');
    lines.push(hopperTag('hubName',hubName(hub.entity),'              '));
    lines.push('              <businessKeySources>');
    keyFields.forEach((key,index)=>{
      const source=sourceFields[index];
      if (!source) issues.errors.push(`Link "${link.entity}" is missing source field ${index+1} for hub "${hub.entity}".`);
      lines.push('                <businessKeySource>');
      lines.push(hopperTag('businessKeyField',hopperBusinessKeyName(key),'                  '));
      lines.push(hopperEmpty('sourceFieldNames','                  '));
      lines.push(hopperTag('sourceFieldName',hopperSourceFieldName(source),'                  '));
      lines.push('                </businessKeySource>');
    });
    lines.push('              </businessKeySources>');
    lines.push(hopperEmpty('drivingKeySources','              '));
    lines.push('            </hubSourceKeyField>');
  });
  lines.push('          </hubSourceKeyFields>');
  lines.push('        </linkHubSource>');
  lines.push('      </linkHubSources>');
  addHopperLinkSatelliteSources(lines,link);
  lines.push(hopperEmpty('dependentChildKeys','      '));
  lines.push(hopperTag('linkHashKeyFieldName',linkKeyOf(link.entity),'      '));
  lines.push(hopperEmpty('hubSourceKeyFields','      '));
  lines.push(hopperTag('hasDescriptiveAttributes',(state.linkSats || []).some(s=>s.linkId===link.id) ? 'Y' : 'N','      '));
  lines.push(hopperEmpty('recordSourceFieldName','      '));
  lines.push(hopperTag('tableName',linkNameOf(link.entity),'      '));
  lines.push(hopperTag('description',link.description || '', '      '));
  lines.push(hopperTag('tableType','LINK','      '));
  lines.push(hopperTag('integrationMode','HOP_MANAGED','      '));
  lines.push(hopperEmpty('customUpdatePipelinePaths','      '));
  lines.push(hopperTag('xloc',position.x,'      '));
  lines.push(hopperTag('yloc',position.y,'      '));
  lines.push(hopperTag('name',linkNameOf(link.entity),'      '));
  lines.push(hopperEmpty('virtualPath','      '));
  lines.push('    </table>');
}

function addHopperLinkSatellite(lines, satellite, position){
  const link=findLink(satellite.linkId), table=findTable(satellite.tableId);
  lines.push('    <table>');
  lines.push(hopperEmpty('hub','      '));
  lines.push(hopperTag('link',linkNameOf(link.entity),'      '));
  (satellite.attrs || []).forEach(attribute=>{
    const column=findCol(table,attribute.colId), type=hopperHopType(column);
    lines.push('      <attributes>');
    lines.push(hopperTag('name',attribute.target || hopperSourceFieldName(column),'        '));
    lines.push(hopperTag('description','', '        '));
    lines.push(hopperTag('dataType',type.name,'        '));
    lines.push(hopperTag('length',hopperColumnLength(column),'        '));
    lines.push(hopperTag('precision',hopperColumnPrecision(column),'        '));
    lines.push(hopperTag('includeInChangeDataCapture','Y','        '));
    lines.push('      </attributes>');
  });
  lines.push(hopperEmpty('parentKeySourceFields','      '));
  lines.push(hopperEmpty('drivingKey','      '));
  lines.push(hopperEmpty('drivingKeySourceField','      '));
  lines.push(hopperTag('recordSource',hopperSourceRecordName(table),'      '));
  lines.push(hopperTag('storeRecordSource','Y','      '));
  lines.push(hopperTag('tableName',lsatName(satellite.entity,satellite.concern),'      '));
  lines.push(hopperTag('description',satellite.description || '', '      '));
  lines.push(hopperTag('tableType','SATELLITE','      '));
  lines.push(hopperTag('integrationMode','HOP_MANAGED','      '));
  lines.push(hopperEmpty('customUpdatePipelinePaths','      '));
  lines.push(hopperTag('xloc',position.x,'      '));
  lines.push(hopperTag('yloc',position.y,'      '));
  lines.push(hopperTag('name',lsatName(satellite.entity,satellite.concern),'      '));
  lines.push(hopperEmpty('virtualPath','      '));
  lines.push('    </table>');
}

function buildHopperDataVaultModel(issues={errors:[],warnings:[]}){
  const hubLayout=hopperFamilyLayout(state.hubs, hub=>(state.hubSats || []).filter(satellite=>satellite.hubId===hub.id));
  const linkLayout=hopperFamilyLayout(state.links, link=>(state.linkSats || []).filter(satellite=>satellite.linkId===link.id),hubLayout.bottom+160);
  const lines=[
    '<data-vault-model>',
    hopperTag('name_sync_with_filename','Y','  '),
    hopperTag('description',state.vault.vaultDescription || `Exported from Data Vault Studio: ${hopperModelStem()}`,'  '),
    hopperTag('configurationName',hopperVaultConfigurationName(),'  '),
    '  <tables>',
  ];
  state.hubs.forEach(hub=>addHopperHub(lines,hub,hubLayout.parentPositions.get(hub.id)));
  state.hubSats.forEach(satellite=>addHopperHubSatellite(lines,satellite,issues,hubLayout.childPositions.get(satellite.id)));
  state.links.forEach(link=>addHopperLink(lines,link,issues,linkLayout.parentPositions.get(link.id)));
  state.linkSats.forEach(satellite=>addHopperLinkSatellite(lines,satellite,linkLayout.childPositions.get(satellite.id)));
  lines.push('  </tables>');
  lines.push(hopperEmpty('notes','  '));
  lines.push(hopperTag('name',hopperModelStem(),'  '));
  lines.push('</data-vault-model>');
  return `${lines.join('\n')}\n`;
}

function validateHopperExport(){
  const issues={errors:[],warnings:[]};
  if (!includedTables().length) issues.errors.push('Hopper export needs at least one included source table.');
  includedTables().forEach(table=>{
    if (!(table.columns || []).filter(isColumnStaged).length) issues.errors.push(`Source table "${table.name}" has no selected columns.`);
    if (!(table.columns || []).some(column=>column.pk && isColumnStaged(column))) issues.warnings.push(`Source table "${table.name}" has no selected primary key; Hopper generation may skip it.`);
    if (table.customOverride) issues.warnings.push(`Staging SQL override on "${table.name}" is not exported; Hopper reads the declared source table instead.`);
    if (table.incremental) issues.warnings.push(`Incremental load settings on "${table.name}" are not exported; configure scheduling in Hopper separately.`);
  });
  state.hubs.forEach(hub=>{
    if (!findTable(hub.tableId)) issues.errors.push(`Hub "${hub.entity}" has no source table.`);
    if (!hopperHubKeys(hub).length) issues.errors.push(`Hub "${hub.entity}" has no business-key field.`);
    if (hub.statusSat) issues.warnings.push(`Status satellite setting on hub "${hub.entity}" is not exported.`);
  });
  state.links.forEach(link=>{
    if (!findTable(link.tableId)) issues.errors.push(`Link "${link.entity}" has no source table.`);
    if ((link.hubs || []).length < 2) issues.errors.push(`Link "${link.entity}" needs at least two hubs.`);
    (link.hubs || []).forEach(linkHub=>{ if (!findHub(linkHub.hubId)) issues.errors.push(`Link "${link.entity}" references a missing hub.`); });
  });
  state.hubSats.forEach(satellite=>{
    if (!findHub(satellite.hubId)) issues.errors.push(`Satellite "${satellite.entity}" references a missing hub.`);
    if (!(satellite.attrs || []).length) issues.errors.push(`Satellite "${satellite.entity}" has no attributes.`);
  });
  state.linkSats.forEach(satellite=>{
    if (!findLink(satellite.linkId)) issues.errors.push(`Link satellite "${satellite.entity}" references a missing link.`);
    if (!(satellite.attrs || []).length) issues.errors.push(`Link satellite "${satellite.entity}" has no attributes.`);
  });
  if (state.externalTables && state.externalTables.enabled) issues.warnings.push('External JDBC-FDW target settings are not exported; configure Hopper with a direct target database connection.');
  return issues;
}

function buildHopperExport(){
  const issues=validateHopperExport();
  const hdv=buildHopperDataVaultModel(issues);
  const stem=hopperModelStem();
  const manifest={
    schemaVersion:1,
    generatedBy:'Millersoft Data Vault Studio',
    sourceModel:`${stem}.hsm`,
    dataVaultModel:`${stem}.hdv`,
    requiredHopMetadata:{ catalogConnection:hopperCatalogConnectionName(), sourceConnection:hopperSourceConnectionName(), dataVaultConfiguration:hopperVaultConfigurationName() },
    unsupportedStudioSettings:issues.warnings,
    sourceTables:includedTables().map(table=>({ studioId:table.id, name:table.name, hopperRecordName:hopperSourceRecordName(table) })),
    hubs:state.hubs.map(hub=>({ studioId:hub.id, name:hubName(hub.entity) })),
    links:state.links.map(link=>({ studioId:link.id, name:linkNameOf(link.entity) })),
  };
  return { stem, hsm:buildHopperSourceModel(), hdv, manifest:JSON.stringify(manifest,null,2)+'\n', issues };
}
