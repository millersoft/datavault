function buildHopPackNativeProperties(pack, values){
  const props={};
  for(const field of pack?.connectionFields||[]){
    const hopProperty=String(field?.hopProperty||'').trim();
    if(!hopProperty) continue;
    if(['hostname','port','databaseName','username','password','manualUrl'].includes(hopProperty)) continue;
    if(field.hopType==='ADVANCED_ATTRIBUTE') continue;
    const current=values?.[field.key] ?? field.default ?? '';
    // Hop metadata boolean properties are serialized as booleans; text/combo
    // properties can safely stay variable-driven like the standard fields.
    if(field.type==='checkbox') props[hopProperty]=current===true||String(current).toLowerCase()==='true'||String(current).toUpperCase()==='Y';
    else props[hopProperty]=`\${${runtimeVariableForPackField(field)}}`;
  }
  return props;
}
function buildHopPackAttributes(hop,pack){
  const attributes=hopConnectionAttributes(hop,pack);
  const schemaField=(pack?.connectionFields||[]).find(field=>field.mapsTo==='schema');
  if(schemaField) attributes.PREFERRED_SCHEMA_NAME='${source_schema_name}';
  const pluginId=String(hop?.pluginId||pack?.hop?.pluginId||'').trim();
  const options=typeof packJdbcOptionsPayload==='function'?packJdbcOptionsPayload('source'):{};
  for(const [key,value] of Object.entries(options||{})){
    if(!key) continue;
    attributes[`EXTRA_OPTION_${pluginId}.${key}`]=String(value??'');
  }
  return attributes;
}

function buildHopSourceConnectionJson(){
  const pack=databasePackForDialect(state.vault.dialect);
  if(!pack && state.vault.dialect==='sqlserver') throw new Error('SQL Server source support is installed through the SQL Server Database Pack. Use + Add database type to install it.');
  const dialect = pack ? 'pack' : (state.vault.dialect==='mysql' ? 'mysql' : 'postgresql');
  const baseCommon = {
    databaseName: '${source_database_name}',
    hostname: '${source_host_name}',
    password: '${source_password}',
    port: '${source_port_number}',
    manualUrl: '',
    username: '${source_user_name}',
  };
  let hop=pack ? resolveHopDatabaseType(pack) : resolveHopDatabaseType(null,dialect);
  let rdbms;
  if(pack){
    syncPackMappedValues(pack,'source');
    const rawValues={...packConnectionValues('source')};
    const values={...rawValues};
    (pack.connectionFields||[]).forEach(field=>{ values[field.key]=`\${${runtimeVariableForPackField(field)}}`; });
    const manualUrl=packTemplate(pack.jdbc.urlTemplate,values);
    hop=hop||{pluginId:'GENERIC',pluginName:'Generic database',strategy:'generic',connectionDefaults:{accessType:0,attributes:{}}};
    const common=Object.assign({},baseCommon,{accessType:hop.connectionDefaults?.accessType??0});
    const userManualUrl=typeof packManualUrlValue==='function'?String(packManualUrlValue('source')||''):'';
    if(hop.strategy==='native'){
      const nativeProperties=buildHopPackNativeProperties(pack,rawValues);
      rdbms={ [hop.pluginId]: Object.assign({},common,nativeProperties,{
        pluginId:hop.pluginId,
        pluginName:hop.pluginName,
        manualUrl:userManualUrl,
        attributes:buildHopPackAttributes(hop,pack),
      }) };
    }else{
      rdbms={ GENERIC: Object.assign({},common,{
        pluginId:'GENERIC',
        pluginName:hop.pluginName||'Generic database',
        driverClass:pack.jdbc.driverClass,
        manualUrl:userManualUrl||manualUrl,
        attributes:buildHopPackAttributes(hop,pack),
      }) };
    }
  }else if(hop){
    const common=Object.assign({},baseCommon,{accessType:hop.connectionDefaults?.accessType??0});
    rdbms={ [hop.pluginId]: Object.assign({},common,{
      pluginId:hop.pluginId, pluginName:hop.pluginName, attributes:hopConnectionAttributes(hop),
    }) };
  }else{
    // Catalogue unavailable: retain the pre-v0.1.1 built-in definitions as a
    // safety fallback so standalone/offline Studio does not regress. Normal
    // companion-server operation always takes the bundled catalogue path.
    const fallback={
      mysql:{pluginId:'MYSQL',pluginName:'MySQL',attributes:{SUPPORTS_TIMESTAMP_DATA_TYPE:'Y',QUOTE_ALL_FIELDS:'N',SUPPORTS_BOOLEAN_DATA_TYPE:'N',FORCE_IDENTIFIERS_TO_LOWERCASE:'N',PRESERVE_RESERVED_WORD_CASE:'N',SQL_CONNECT:'',FORCE_IDENTIFIERS_TO_UPPERCASE:'N',PREFERRED_SCHEMA_NAME:'','EXTRA_OPTION_MYSQL.tinyInt1isBit':'false','EXTRA_OPTION_MYSQL.yearIsDateType':'false'}},
      postgresql:{pluginId:'POSTGRESQL',pluginName:'PostgreSQL',attributes:{SUPPORTS_TIMESTAMP_DATA_TYPE:'Y',QUOTE_ALL_FIELDS:'N',SUPPORTS_BOOLEAN_DATA_TYPE:'Y',FORCE_IDENTIFIERS_TO_LOWERCASE:'N',PRESERVE_RESERVED_WORD_CASE:'N',SQL_CONNECT:'',FORCE_IDENTIFIERS_TO_UPPERCASE:'N',PREFERRED_SCHEMA_NAME:''}}
    }[dialect];
    rdbms={ [fallback.pluginId]: Object.assign({},baseCommon,{accessType:0,pluginId:fallback.pluginId,pluginName:fallback.pluginName,attributes:fallback.attributes}) };
  }
  return JSON.stringify({ rdbms, name: 'source' }, null, 2);
}
function buildHopEnvironmentJson(){
  const v = state.vault;
  const sourcePack=databasePackForDialect(v.dialect);
  if(sourcePack) syncPackMappedValues(sourcePack,'source');
  const sourcePackValues=sourcePack ? packConnectionValues('source') : {};
  // The hop engine runs INSIDE the compose network. When the packaged
  // containers are selected, the GUI talks to them via the host-mapped
  // ports (localhost:5433 / localhost:3306) but hop must use the compose
  // service hostnames and internal ports instead: postgres:5432, mysql:3306.
  const targetInternal = v.targetPreset === 'internal';
  const sourceDemo = v.sourcePreset === 'demo';
  const host = targetInternal ? 'postgres' : (v.dvHost || '');
  const port = targetInternal ? '5432' : String(v.dvPort || '');
  const srcHost = hopRuntimeSourceHost();
  const srcPort = hopRuntimeSourcePort();
  // v0.1.0 packs could legitimately model a JDBC "Database" as a catalog
  // (MariaDB was our first live example). Native Hop database connections still
  // expect the database name through source_database_name, so retain the modern
  // explicit database value first and fall back to the selected pack catalog.
  // This keeps already-installed v0.1.0 manifests working after the v0.1.1+ migration.
  const srcDatabase = v.srcDatabase || sourcePackValues.database || sourcePackValues.catalog || '';
  const srcSchema = sourcePack ? (sourcePackValues.schema || '') : (v.sourceSchema || 'public');
  const database = v.dvDatabase || '';
  const variables = [
    { name:'pdi_meta_host_name', value: host, description:'' },
    { name:'pdi_meta_port_number', value: port, description:'' },
    { name:'pdi_meta_database_name', value: database, description:'' },
    { name:'pdi_meta_user_name', value:'pdi_meta', description:'' },
    { name:'pdi_meta_password', value:'${VAULT_PASSWORD}', description:'' },
    { name:'pdi_meta_schema_name', value:'pdi_meta', description:'' },
    { name:'data_vault_host_name', value: host, description:'' },
    { name:'data_vault_port_number', value: port, description:'' },
    { name:'data_vault_database_name', value: database, description:'' },
    { name:'data_vault_user_name', value:'data_vault', description:'' },
    { name:'data_vault_password', value:'${VAULT_PASSWORD}', description:'' },
    { name:'data_vault_schema_name', value:'data_vault', description:'' },
    { name:'stg_host_name', value: host, description:'' },
    { name:'stg_port_number', value: port, description:'' },
    { name:'stg_database_name', value: database, description:'' },
    { name:'stg_user_name', value:'staging', description:'' },
    { name:'stg_password', value:'${VAULT_PASSWORD}', description:'' },
    { name:'stg_schema_name', value:'staging', description:'' },
    { name:'staging_host_name', value: host, description:'' },
    { name:'staging_port_number', value: port, description:'' },
    { name:'staging_database_name', value: database, description:'' },
    { name:'staging_schema_name', value:'staging', description:'' },
    { name:'source_host_name', value: srcHost, description:'' },
    { name:'source_port_number', value: srcPort, description:'' },
    { name:'source_database_name', value: srcDatabase, description:'' },
    { name:'source_user_name', value: v.srcUser || '', description:'' },
    { name:'source_password', value:'${SOURCE_PASSWORD}', description:'' },
    { name:'source_schema_name', value: srcSchema, description:'' },
    { name:'SRC_CONNECTION', value:'source', description:'' },
    { name:'PROP_DATABASE_TYPE', value:'POSTGRESQL', description:'' },
    { name:'PROP_DATABASE_ALTER_COLUMN_SYNTAX', value:'alter column', description:'' },
    { name:'PROP_DATABASE_REMOVE_INT_NOT_NULL_SYNTAX', value:'DROP NOT NULL', description:'' },
    { name:'PROP_DATABASE_CALL_PROCEDURE_SYNTAX', value:'SELECT', description:'' },
    { name:'PROP_DATABASE_STRING_SEARCH_FUNCTION', value:'strpos', description:'' },
    { name:'PROP_DUMMY_LINK_ATTRIBUTES', value:"']#['", description:'' },
    { name:'PROP_DATABASE_LOAD_DTS_DATATYPE', value:'TIMESTAMP', description:'' },
    { name:'PROP_DATABASE_LOAD_DTS_CAST_PRE', value:'cast(', description:'' },
    { name:'PROP_DATABASE_LOAD_DTS_CAST_POST', value:' as timestamp)', description:'' },
    { name:'PROP_LOAD_END_DTS_LATEST', value:"cast('9999-12-31' as timestamp)", description:'' },
    { name:'PROP_COMMIT_SIZE_STAGING', value:'10000', description:'' },
    { name:'PROP_COMMIT_SIZE_DATA_VAULT', value:'10000', description:'' },
    { name:'PROP_COMMIT_SIZE_PDI_META', value:'10000', description:'' },
    { name:'KETTLE_EMPTY_STRING_DIFFERS_FROM_NULL', value:'N', description:'' },
    { name:'datavault_definition_file', value: `/app/mappings/${v.mappingBaseName || 'metadata_spreadsheet'}`, description:'' },
    { name:'CDC_HASH_FUNCTION', value:'public.digest', description:'' },
    { name:'CDC_DEL', value:']#CDC_DEL#[', description:'' },
    { name:'CDC_NULL', value:']#CDC_NULL#[', description:'' },
    { name:'staging_prefix', value:'', description:'' },
    { name:'PROP_LOAD_END_DTS_LATEST_COND', value:"= cast('9999-12-31' as timestamp)", description:'' },
    { name:'tenant_id', value: v.tenantId || '1', description:'' },
    { name:'STG_INSERT_COPIES', value:'3', description:'' },
    { name:'HUB_INSERT_COPIES', value:'3', description:'' },
    { name:'LINK_INSERT_COPIES', value:'3', description:'' },
    { name:'SAT_INSERT_COPIES', value:'3', description:'' },
    { name:'LINKSAT_INSERT_COPIES', value:'3', description:'' },
    { name:'HUB_STATUS_SAT_INSERT_COPIES', value:'3', description:'' },
    { name:'TABLE_ERRORS', value:'', description:'Set to _errors to log table errors' },
  ];
  if(sourcePack){
    const values=packConnectionValues('source');
    const existing=new Set(variables.map(x=>x.name));
    (sourcePack.connectionFields||[]).forEach(field=>{
      const runtimeName=runtimeVariableForPackField(field);
      if(existing.has(runtimeName)) return;
      const isSecret=field.type==='password'||field.mapsTo==='password';
      variables.push({name:runtimeName,value:isSecret?'${SOURCE_PASSWORD}':String(values[field.key]??field.default??''),description:''});
      existing.add(runtimeName);
    });
  }
  return JSON.stringify({ variables, purpose: 'Development', name: 'postgres' }, null, 2);
}
