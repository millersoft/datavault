const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./helpers/load-app');

let app;
const sqlServerPack = JSON.parse(fs.readFileSync(path.join(__dirname,'..','database-packs','sqlserver.json'),'utf8'));
const packJson = JSON.stringify(sqlServerPack);

function sqlServerSetup(body=''){
  return `{
    startNewProject(true);
    databasePacks=[${packJson}]; registerDatabasePack(databasePacks[0]);
    hopDatabaseCatalog={databaseTypes:[{module:'mssql',pluginId:'MSSQLNATIVE',pluginName:'MS SQL Server (Native)',aliases:['sqlserver','mssql'],products:['Microsoft SQL Server']}],generic:{pluginId:'GENERIC',pluginName:'Generic database'}};
    state.vault.dialect='pack:sqlserver';
    state.vault.sourcePackValues={host:'127.0.0.1',port:'1433',database:'Sales',schema:'dbo',user:'sa',password:'secret'};
    syncPackMappedValues(databasePacks[0],'source');
    state.vault.name='sales'; state.vault.prefix='sales'; state.vault.tenantId='SALES'; state.vault.srcCod='SALES'; state.vault.srcDescription='SALES';
    const t=newTable('Order');
    t.columns=[Object.assign(newColumn('id','integer'),{pk:true,nullable:false}),newColumn('order total','numeric(18,2)')];
    state.tables=[t]; ensureKeyDerivation(t,'order',['id'],'both');
    ${body}
  }`;
}

beforeEach(()=>{ app=loadApp({runtimeMode:'production'}); });

describe('Database Packs v0.2.2 staging-view and authoring contract',()=>{
  test('feature version is 0.2.2 and source Packs do not register hash SQL',()=>{
    assert.strictEqual(app.eval('DATABASE_PACK_FEATURE_VERSION'),'0.2.2');
    assert.strictEqual(app.eval(`${sqlServerSetup(`typeof DIALECTS['pack:sqlserver'].hash`)}`),'undefined');
  });

  test('SQL Server is not a built-in source and appears only after its Pack is installed',()=>{
    const before=app.eval(`startNewProject(true); databasePacks=[]; clearRegisteredDatabasePacks(); sourceDialectOptionsHtml()`);
    assert.doesNotMatch(before,/>SQL Server</);
    assert.match(before,/Add database type/);
    const after=app.eval(`startNewProject(true); databasePacks=[${packJson}]; registerDatabasePack(databasePacks[0]); sourceDialectOptionsHtml()`);
    assert.match(after,/value="pack:sqlserver"[^>]*>SQL Server</);
  });

  test('SQL Server proof Pack keeps only the minimal JDBC contract plus its Hop connection exception',()=>{
    assert.strictEqual(sqlServerPack.featureVersion,undefined);
    assert.strictEqual(sqlServerPack.connectionFields,undefined);
    assert.strictEqual(sqlServerPack.source,undefined);
    assert.strictEqual(sqlServerPack.target,undefined);
    assert.deepStrictEqual(sqlServerPack.fdw,{remoteSchemaResolution:'connection-default'});
    assert.strictEqual(sqlServerPack.jdbc.jarfile,undefined);
    assert.strictEqual(sqlServerPack.jdbc.jarPattern,'mssql-jdbc-*.jar');
    assert.strictEqual(sqlServerPack.namespace.usesSchema,true);
    assert.strictEqual(sqlServerPack.hop.attributes['EXTRA_OPTION_MSSQLNATIVE.trustServerCertificate'],'true');
  });

  test('minimal SQL Server Pack derives the standard connection form automatically',()=>{
    const fields=app.eval(`startNewProject(true); const p=${packJson}; deriveStandardPackConnectionFields(p).map(f=>({key:f.key,mapsTo:f.mapsTo,default:f.default||''}))`);
    assert.deepStrictEqual(fields.map(f=>f.key),['host','port','database','schema','user','password']);
    assert.strictEqual(fields.find(f=>f.key==='port').default,'1433');
    assert.strictEqual(fields.find(f=>f.key==='schema').default,'');
  });

  test('source SQL extracts explicit columns only and uses the generic quoted-identifier default',()=>{
    const sql=app.eval(sqlServerSetup('buildOverride(t)'));
    assert.match(sql,/select\n  src\.id as id,\n  src\."order total" as order_total\nfrom dbo\."Order" src\nwhere 1=1/);
    assert.doesNotMatch(sql,/sha256|hashbytes|hash_|_bk|tenant_id/i);
  });

  test('physical staging table contains source columns only',()=>{
    const ddl=app.eval(sqlServerSetup(`ddlFromColumns('staging.'+stagingTableName(t.name),buildStagingBaseColumns(t))`));
    assert.match(ddl,/CREATE TABLE IF NOT EXISTS staging\.stg_sales_order/);
    assert.match(ddl,/id INTEGER NOT NULL/);
    assert.match(ddl,/order_total NUMERIC\(18,2\)/);
    assert.doesNotMatch(ddl,/hash_|_bk|tenant_id/i);
  });

  test('staging readiness recognises hash derivations that are materialised on the _vw',()=>{
    const result=app.eval(sqlServerSetup(`({
      missing:stagingTablesMissingHashColumns().map(x=>x.name),
      ready:stagingHashColumnsReady(),
      hashedViewColumns:buildStagingViewColumns(t).filter(c=>c.hashed).map(c=>c.name),
      message:stagingHashRequirementMessage()
    })`));
    assert.deepStrictEqual(result.missing,[]);
    assert.strictEqual(result.ready,true);
    assert.deepStrictEqual(result.hashedViewColumns,['hash_order_id']);
    assert.strictEqual(result.message,'');
  });

  test('PostgreSQL staging view adds the canonical SHA-256, BK and tenant fields',()=>{
    const ddl=app.eval(sqlServerSetup('buildStagingViewSql(t)'));
    assert.match(ddl,/CREATE OR REPLACE VIEW staging\.stg_sales_order_vw AS/);
    assert.match(ddl,/sha256\(convert_to\(\(b\.id::text\), 'UTF8'\)\) AS hash_order_id/);
    assert.match(ddl,/b\.id::text AS order_bk/);
    assert.match(ddl,/'SALES'::varchar\(20\) AS tenant_id/);
    assert.match(ddl,/FROM staging\.stg_sales_order b/);
    assert.doesNotMatch(ddl,/HASHBYTES|UNHEX|SHA2\(/i);
  });

  test('workbook points the existing single staging_table_name at the writable _vw relation',()=>{
    const row=app.eval(sqlServerSetup('buildWorkbookRows().source_tables[0]'));
    assert.strictEqual(row[3],'stg_sales_order_vw');
    assert.match(row[9],/from dbo\."Order" src/i);
    assert.doesNotMatch(row[9],/hash_|tenant_id/i);
  });

  test('deployment model expects both the physical table and engine-facing view',()=>{
    const objects=app.eval(sqlServerSetup(`expectedStagingObjects().map(o=>({name:o.name,kind:o.relationKind,columns:o.columns.map(c=>c.name)}))`));
    assert.deepStrictEqual(objects[0],{name:'stg_sales_order',kind:'r',columns:['id','order_total']});
    assert.deepStrictEqual(objects[1],{name:'stg_sales_order_vw',kind:'v',columns:['id','order_total','hash_order_id','order_bk','tenant_id']});
  });

  test('Hop source metadata comes from the SQL Server Pack, not a built-in SQL Server source branch',()=>{
    const json=app.eval(sqlServerSetup('buildHopSourceConnectionJson()'));
    const parsed=JSON.parse(json);
    assert.ok(parsed.rdbms.MSSQLNATIVE);
    assert.strictEqual(parsed.rdbms.MSSQLNATIVE.pluginId,'MSSQLNATIVE');
    assert.strictEqual(parsed.rdbms.MSSQLNATIVE.hostname,'${source_host_name}');
    assert.strictEqual(parsed.rdbms.MSSQLNATIVE.attributes['EXTRA_OPTION_MSSQLNATIVE.encrypt'],'true');
    assert.ok(!json.includes('secret'));
  });

  test('legacy saved SQL Server source migrates to the installed Pack without losing connection values',()=>{
    const migrated=app.eval(`{
      startNewProject(true);
      state.vault.dialect='sqlserver'; state.vault.srcHost='legacy-db'; state.vault.srcPort='1433'; state.vault.srcDatabase='Sales'; state.vault.sourceSchema='dbo'; state.vault.srcUser='alice'; state.vault.srcPassword='pw';
      databasePacks=[${packJson}]; registerDatabasePack(databasePacks[0]);
      const changed=migrateLegacySqlServerSourceToPack();
      ({changed,dialect:state.vault.dialect,values:state.vault.sourcePackValues,host:state.vault.srcHost,schema:state.vault.sourceSchema});
    }`);
    assert.strictEqual(migrated.changed,true);
    assert.strictEqual(migrated.dialect,'pack:sqlserver');
    assert.strictEqual(migrated.values.host,'legacy-db');
    assert.strictEqual(migrated.values.database,'Sales');
    assert.strictEqual(migrated.values.schema,'dbo');
    assert.strictEqual(migrated.values.user,'alice');
    assert.strictEqual(migrated.values.password,'pw');
  });

  test('old custom overrides that try to populate derived view columns are blocked',()=>{
    const result=app.eval(sqlServerSetup(`
      t.customOverride="select src.id as id, src.id as hash_order_id, 'SALES' as tenant_id from dbo.\\"Order\\" src";
      ({derived:customOverrideDerivedOutputColumns(t),errors:validateModel().errors});
    `));
    assert.deepStrictEqual(result.derived.sort(),['hash_order_id','tenant_id']);
    assert.ok(result.errors.some(e=>/custom staging SQL override/.test(e) && /hash_order_id/.test(e)));
  });

  test('wizard generates a minimal Pack and keeps connection testing out of the creation flow',()=>{
    const result=app.eval(`{
      databaseTypeWizardState={hopPluginId:DATABASE_TYPE_WIZARD_GENERIC,customLabel:'Example DB',driverClass:'com.example.Driver',urlTemplate:'jdbc:example://{host}:{port}/{database}',defaultPort:'7777',jarfile:'example-jdbc.jar'};
      ({manifest:databaseTypeWizardManifest(),choice:databaseTypeWizardChoiceHtml(),jdbc:databaseTypeWizardJdbcHtml()});
    }`);
    assert.deepStrictEqual(Object.keys(result.manifest),['schemaVersion','id','label','version','jdbc','namespace','hop']);
    assert.strictEqual(result.manifest.id,'example-db');
    assert.strictEqual(result.manifest.version,'1.0.0');
    assert.strictEqual(result.manifest.connectionFields,undefined);
    assert.deepStrictEqual(result.manifest.namespace,{usesSchema:true});
    assert.strictEqual(result.manifest.source,undefined);
    assert.strictEqual(result.manifest.target,undefined);
    assert.deepStrictEqual(result.manifest.hop,{forceGeneric:true});
    assert.match(result.choice,/Create new database type/);
    assert.match(result.choice,/Import existing Database Pack/);
    assert.match(result.jdbc,/jdbc-drivers\//);
    assert.doesNotMatch(result.choice+result.jdbc,/Test connection/i);
  });

  test('all shipped source examples no longer require source-side hashing',()=>{
    const dir=path.join(__dirname,'..','database-packs','examples');
    for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.json'))){
      const pack=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
      assert.strictEqual(pack.source && pack.source.hashSha256,undefined,file);
    }
  });

  test('Pack source connections expose an optional schema even when the manifest omits namespace metadata',()=>{
    const result=app.eval(`{
      startNewProject(true);
      discoveredSchemas=[];
      const p={schemaVersion:1,id:'example',label:'Example',version:'1.0.0',jdbc:{driverClass:'com.example.Driver',urlTemplate:'jdbc:example://{host}:{port}/{database}',defaultPort:'7777',jarfile:'example.jar'},namespace:{},hop:{forceGeneric:true}};
      deriveStandardPackConnectionFields(p);
      ({fields:p.connectionFields.map(f=>({key:f.key,mapsTo:f.mapsTo,required:f.required})),html:packConnectionFieldsHtml(p,'source')});
    }`);
    const schema=result.fields.find(f=>f.mapsTo==='schema');
    assert.ok(schema);
    assert.strictEqual(schema.required,false);
    assert.match(result.html,/Optional\. Type a schema now/);
  });

  test('source schema keeps manual text and adds JDBC-discovered schemas as suggestions',()=>{
    const result=app.eval(`{
      startNewProject(true);
      discoveredSchemas=['dbo','sales','archive'];
      const p=${packJson}; deriveStandardPackConnectionFields(p);
      state.vault.sourcePackValues={host:'db',port:'1433',database:'Sales',schema:'custom_schema',user:'sa',password:'pw'};
      packConnectionFieldsHtml(p,'source');
    }`);
    assert.match(result,/value="custom_schema"/);
    assert.match(result,/list="pack-source-schema-options"/);
    assert.match(result,/value="sales"/);
  });

  test('wizard adds SQL Server FDW connection-default resolution by default',()=>{
    const result=app.eval(`{
      hopDatabaseCatalog={databaseTypes:[{module:'mssql',pluginId:'MSSQLNATIVE',pluginName:'MS SQL Server (Native)',studioPack:{id:'sqlserver',label:'SQL Server'}}],generic:{pluginId:'GENERIC'}};
      databaseTypeWizardState={hopPluginId:'MSSQLNATIVE',driverClass:'com.microsoft.sqlserver.jdbc.SQLServerDriver',urlTemplate:'jdbc:sqlserver://{host}:{port};databaseName={database}',defaultPort:'1433',jarfile:'mssql-jdbc.jar'};
      databaseTypeWizardManifest();
    }`);
    assert.deepStrictEqual(result.namespace,{usesSchema:true});
    assert.deepStrictEqual(result.fdw,{remoteSchemaResolution:'connection-default'});
  });

});
