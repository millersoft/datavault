const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadApp } = require('./helpers/load-app');
const { createDatabasePackService } = require('../server/database-packs');

const mysqlPack = JSON.parse(fs.readFileSync(path.join(__dirname,'..','database-packs','mysql.json'),'utf8'));
const postgresPack = JSON.parse(fs.readFileSync(path.join(__dirname,'..','database-packs','postgresql.json'),'utf8'));
const mssqlNativePack = JSON.parse(fs.readFileSync(path.join(__dirname,'..','database-packs','mssqlnative.json'),'utf8'));
const mssqlPack = JSON.parse(fs.readFileSync(path.join(__dirname,'..','database-packs','mssql.json'),'utf8'));
const oraclePack = JSON.parse(fs.readFileSync(path.join(__dirname,'..','database-packs','oracle.json'),'utf8'));
const snowflakePack = JSON.parse(fs.readFileSync(path.join(__dirname,'..','database-packs','snowflake.json'),'utf8'));
const bundledPacksJson = JSON.stringify([postgresPack,mysqlPack]);
const selectorPacksJson = JSON.stringify([postgresPack,mysqlPack,mssqlNativePack,mssqlPack,oraclePack,snowflakePack]);

let app;

function newPackApp(runtimeMode='production'){
  // The real page starts loading Packs asynchronously. Keep that startup fetch
  // pending in this isolated unit file so the explicit bundled fixtures below
  // cannot be replaced by the test harness's empty default HTTP response.
  return loadApp({
    runtimeMode,
    location:{origin:'http://127.0.0.1:8420',protocol:'http:',href:'http://127.0.0.1:8420/',port:'8420'},
    fetch:()=>new Promise(()=>{}),
  });
}

function installBundledPacks(target=app){
  target.eval(`
    clearRegisteredDatabasePacks();
    databasePacks=${bundledPacksJson};
    databasePacks.forEach(registerDatabasePack);
  `);
}

beforeEach(()=>{
  app=newPackApp('production');
  app.eval(`startNewProject(true);`);
  installBundledPacks();
});

describe('MySQL/PostgreSQL bundled Pack migration',()=>{
  test('stable mysql/postgresql dialect ids resolve through the generated Packs',()=>{
    assert.strictEqual(app.eval(`databasePackForDialect('mysql').id`),'mysql');
    assert.strictEqual(app.eval(`databasePackForDialect('postgresql').id`),'postgresql');
    assert.strictEqual(app.eval(`databasePackDialectValue(databasePackForDialect('mysql'))`),'mysql');
    assert.strictEqual(app.eval(`databasePackDialectValue(databasePackForDialect('postgresql'))`),'postgresql');
    assert.strictEqual(app.eval(`isDatabasePackDialect('mysql')`),false);
    assert.strictEqual(app.eval(`isDatabasePackDialect('postgresql')`),false);
  });

  test('source selector promotes only the preferred common databases',()=>{
    const html=app.eval(`{
      databasePacks=${selectorPacksJson};
      sourceDialectOptionsHtml();
    }`);
    const common=html.slice(html.indexOf('<optgroup label="Common databases">'),html.indexOf('</optgroup>')+11);
    const others=html.slice(html.indexOf('<optgroup label="Other databases">'));
    assert.match(common,/value="postgresql"[^>]*>PostgreSQL</);
    assert.match(common,/value="mysql"[^>]*>MySQL</);
    assert.match(common,/value="pack:mssqlnative"[^>]*>MS SQL Server \(Native\)</);
    assert.match(common,/value="pack:oracle"[^>]*>Oracle</);
    assert.doesNotMatch(common,/value="pack:mssql"/);
    assert.doesNotMatch(common,/value="pack:snowflake"/);
    assert.match(others,/value="pack:mssql"[^>]*>MS SQL Server</);
    assert.match(others,/value="pack:snowflake"[^>]*>Snowflake</);
    assert.ok(common.indexOf('value="postgresql"') < common.indexOf('value="mysql"'));
    assert.ok(common.indexOf('value="mysql"') < common.indexOf('value="pack:mssqlnative"'));
    assert.ok(common.indexOf('value="pack:mssqlnative"') < common.indexOf('value="pack:oracle"'));
  });

  test('bundled MySQL/PostgreSQL Packs retain trusted JDBC driver fetch specs',()=>{
    const mysql=app.eval(`jdbcDriverSpec('mysql')`);
    const postgres=app.eval(`jdbcDriverSpec('postgresql')`);
    assert.strictEqual(mysql.filename,'mysql-connector-j-9.7.0.jar');
    assert.match(mysql.url,/^https:\/\/repo1\.maven\.org\//);
    assert.strictEqual(postgres.filename,'postgresql-42.7.7.jar');
    assert.match(postgres.url,/^https:\/\/repo1\.maven\.org\//);
    const render=app.eval(`renderConnections.toString()`);
    assert.match(render,/\['mysql','postgresql'\]\.includes\(v\.dialect\)\?jdbcDriverSectionHtml\(v\)/);
  });

  test('production MySQL source uses Pack fields and JDBC options while keeping mysql semantics',()=>{
    const result=app.eval(`{
      state.vault.sourcePreset='';
      Object.assign(state.vault,{dialect:'mysql',srcHost:'mysql.example',srcPort:'3307',srcDatabase:'sales',sourceSchema:'sales',srcUser:'reader',srcPassword:'source-secret'});
      seedPackConnectionValues(databasePackForDialect('mysql'),'source',{reset:true});
      state.vault.sourcePackOptions=[{key:'useSSL',value:'true'}];
      ({payload:sourceConnectionPayload(),schema:state.vault.sourceSchema,values:state.vault.sourcePackValues});
    }`);
    assert.strictEqual(result.payload.dialect,'mysql');
    assert.strictEqual(result.payload.credentialRef,undefined);
    assert.strictEqual(result.payload.packValues.host,'mysql.example');
    assert.strictEqual(result.payload.packValues.port,'3307');
    assert.strictEqual(result.payload.packValues.database,'sales');
    assert.strictEqual(result.payload.packValues.schema,'sales');
    assert.strictEqual(result.payload.packValues.user,'reader');
    assert.strictEqual(result.payload.packValues.password,'source-secret');
    assert.deepStrictEqual(result.payload.options,[{key:'useSSL',value:'true'}]);
    assert.strictEqual(result.schema,'sales');
  });

  test('production PostgreSQL source uses Pack fields and JDBC options without changing the dialect id',()=>{
    const payload=app.eval(`{
      state.vault.sourcePreset='';
      Object.assign(state.vault,{dialect:'postgresql',srcHost:'pg.example',srcPort:'5544',srcDatabase:'source_db',sourceSchema:'sales',srcUser:'reader',srcPassword:'source-secret'});
      seedPackConnectionValues(databasePackForDialect('postgresql'),'source',{reset:true});
      state.vault.sourcePackOptions=[{key:'ApplicationName',value:'DataVaultStudio'}];
      sourceConnectionPayload();
    }`);
    assert.strictEqual(payload.dialect,'postgresql');
    assert.strictEqual(payload.packValues.host,'pg.example');
    assert.strictEqual(payload.packValues.port,'5544');
    assert.strictEqual(payload.packValues.database,'source_db');
    assert.strictEqual(payload.packValues.schema,'sales');
    assert.deepStrictEqual(payload.options,[{key:'ApplicationName',value:'DataVaultStudio'}]);
  });

  test('demo MySQL stays on its server-side credential reference even when the MySQL Pack is installed',()=>{
    const demo=newPackApp('demo');
    installBundledPacks(demo);
    const result=demo.eval(`{
      startNewProject(true);
      state.vault.sourcePackValues={password:'old-production-secret',host:'old-host'};
      state.vault.sourcePackOptions=[{key:'oldOption',value:'oldValue'}];
      state.vault.sourceManualUrl='jdbc:mysql://old-host/db?password=old-production-secret';
      applyDemoSource(true);
      ({payload:sourceConnectionPayload(),password:state.vault.srcPassword,packValues:state.vault.sourcePackValues,
        packOptions:state.vault.sourcePackOptions,manualUrl:state.vault.sourceManualUrl});
    }`);
    assert.deepStrictEqual(result.payload,{credentialRef:'packaged-mysql-source',database:'sakila',dialect:'mysql'});
    assert.strictEqual(result.password,'');
    assert.deepStrictEqual(result.packValues,{});
    assert.deepStrictEqual(result.packOptions,[]);
    assert.strictEqual(result.manualUrl,'');
  });

  test('demo table detection keeps using the server-side MySQL credential reference',async()=>{
    let request;
    const demo=loadApp({
      runtimeMode:'demo',
      location:{origin:'http://127.0.0.1:8420',protocol:'http:',href:'http://127.0.0.1:8420/',port:'8420'},
      fetch:async(url,options)=>{
        request={url,body:JSON.parse(options.body)};
        return {json:async()=>({ok:true,tables:[],foreignKeys:[]})};
      },
    });
    installBundledPacks(demo);
    demo.eval(`startNewProject(true); applyDemoSource(true);`);

    await demo.evalRaw(`fetchIntrospection(true)`);

    assert.strictEqual(request.url,'http://127.0.0.1:8420/api/introspect');
    assert.deepStrictEqual(request.body,{
      credentialRef:'packaged-mysql-source', database:'sakila', dialect:'mysql',
      schema:'sakila', catalog:'', profileColumns:true,
    });
  });

  test('Pack password mirrors are stripped from autosave without mutating the live connection',()=>{
    const result=app.eval(`{
      Object.assign(state.vault,{dialect:'mysql',srcHost:'db',srcPort:'3306',srcDatabase:'sales',sourceSchema:'sales',srcUser:'reader',srcPassword:'source-secret'});
      seedPackConnectionValues(databasePackForDialect('mysql'),'source',{reset:true});
      state.externalTables.enabled=true;
      state.externalTables.remoteDialect='mysql';
      Object.assign(state.externalTables,{studioHost:'target',studioPort:'3306',studioDatabase:'vault',remoteDatabase:'vault',studioSchema:'vault',remoteSchema:'vault',studioUser:'writer',studioPassword:'target-secret'});
      seedPackConnectionValues(databasePackForDialect('mysql'),'target',{reset:true});
      const saved=buildAutosavePayload();
      ({savedSource:saved.state.vault.sourcePackValues.password,savedTarget:saved.state.externalTables.packValues.password,
        liveSource:state.vault.sourcePackValues.password,liveTarget:state.externalTables.packValues.password});
    }`);
    assert.strictEqual(result.savedSource,'');
    assert.strictEqual(result.savedTarget,'');
    assert.strictEqual(result.liveSource,'source-secret');
    assert.strictEqual(result.liveTarget,'target-secret');
  });

  test('MySQL source JDBC options reach Hop EXTRA_OPTION attributes',()=>{
    const connection=app.eval(`{
      Object.assign(state.vault,{dialect:'mysql',sourcePreset:'',srcHost:'localhost',srcPort:'3306',srcDatabase:'sales',sourceSchema:'sales',srcUser:'reader',srcPassword:'secret'});
      seedPackConnectionValues(databasePackForDialect('mysql'),'source',{reset:true});
      state.vault.sourcePackOptions=[{key:'useSSL',value:'true'},{key:'customFlag',value:'abc'}];
      JSON.parse(buildHopSourceConnectionJson());
    }`);
    assert.strictEqual(connection.rdbms.MYSQL.pluginId,'MYSQL');
    assert.strictEqual(connection.rdbms.MYSQL.attributes['EXTRA_OPTION_MYSQL.tinyInt1isBit'],'false');
    assert.strictEqual(connection.rdbms.MYSQL.attributes['EXTRA_OPTION_MYSQL.yearIsDateType'],'false');
    assert.strictEqual(connection.rdbms.MYSQL.attributes['EXTRA_OPTION_MYSQL.useSSL'],'true');
    assert.strictEqual(connection.rdbms.MYSQL.attributes['EXTRA_OPTION_MYSQL.customFlag'],'abc');
    assert.ok(!JSON.stringify(connection).includes('secret'));
  });

  test('runtime topology stays separate from the Pack connection definition',()=>{
    const normal=app.eval(`{
      Object.assign(state.vault,{dialect:'mysql',sourcePreset:'',srcHost:'localhost',srcPort:'3306',srcDatabase:'sales',sourceSchema:'sales'});
      seedPackConnectionValues(databasePackForDialect('mysql'),'source',{reset:true});
      const env=JSON.parse(buildHopEnvironmentJson());
      Object.fromEntries(env.variables.map(v=>[v.name,v.value]));
    }`);
    assert.strictEqual(normal.source_host_name,'host.docker.internal');
    assert.strictEqual(normal.source_port_number,'3306');

    const demo=newPackApp('demo');
    installBundledPacks(demo);
    const demoVars=demo.eval(`{
      startNewProject(true); applyDemoSource(true); applyDemoTarget(true);
      const env=JSON.parse(buildHopEnvironmentJson());
      Object.fromEntries(env.variables.map(v=>[v.name,v.value]));
    }`);
    assert.strictEqual(demoVars.source_host_name,'mysql');
    assert.strictEqual(demoVars.source_port_number,'3306');
    assert.strictEqual(demoVars.data_vault_host_name,'postgres');
    assert.strictEqual(demoVars.data_vault_port_number,'5432');
  });

  test('MySQL physical target is Pack-backed and uses target state independent of source state',()=>{
    const result=app.eval(`{
      Object.assign(state.vault,{dialect:'mysql',srcHost:'source-db',srcPort:'3306',srcDatabase:'source_sales',sourceSchema:'source_sales',srcUser:'reader',srcPassword:'source-secret'});
      seedPackConnectionValues(databasePackForDialect('mysql'),'source',{reset:true});
      applyDeploymentTarget('mysql');
      Object.assign(state.externalTables,{studioHost:'target-db',studioPort:'3307',studioDatabase:'vault',remoteDatabase:'vault',studioSchema:'vault',remoteSchema:'vault',studioUser:'writer',studioPassword:'target-secret'});
      seedPackConnectionValues(databasePackForDialect('mysql'),'target',{reset:true});
      state.externalTables.packOptions=[{key:'targetOption',value:'on'}];
      ({payload:externalConnectionPayload(),source:state.vault.sourcePackValues,target:state.externalTables.packValues,
        remoteDialect:state.externalTables.remoteDialect,targetPreset:state.vault.targetPreset});
    }`);
    assert.strictEqual(result.remoteDialect,'mysql');
    assert.strictEqual(result.targetPreset,'internal');
    assert.strictEqual(result.payload.dialect,'mysql');
    assert.strictEqual(result.payload.packValues.host,'target-db');
    assert.strictEqual(result.payload.packValues.password,'target-secret');
    assert.deepStrictEqual(result.payload.options,[{key:'targetOption',value:'on'}]);
    assert.strictEqual(result.source.host,'source-db');
    assert.strictEqual(result.source.password,'source-secret');
    assert.strictEqual(result.target.host,'target-db');
  });

  test('external PostgreSQL target remains the existing direct PostgreSQL deployment path',()=>{
    const result=app.eval(`{
      applyDeploymentTarget('postgres');
      ({targetPreset:state.vault.targetPreset,externalEnabled:state.externalTables.enabled,payload:targetConnectionPayload()});
    }`);
    assert.strictEqual(result.targetPreset,'');
    assert.strictEqual(result.externalEnabled,false);
    assert.strictEqual(result.payload.dialect,'postgresql');
    assert.strictEqual(result.payload.credentialRef,'external-postgres-target');
    assert.strictEqual(result.payload.packValues,undefined);
  });

  test('target selector keeps PostgreSQL deployment choices separate and promotes SQL Server Native',()=>{
    const physical=app.eval(`{
      databasePacks=${selectorPacksJson};
      databasePackTargetOptionsGroupedHtml();
    }`);
    const render=app.eval(`renderConnections.toString()`);
    const common=physical.slice(physical.indexOf('<optgroup label="Common physical targets">'),physical.indexOf('</optgroup>')+11);
    const others=physical.slice(physical.indexOf('<optgroup label="Other physical targets">'));
    assert.match(render,/optgroup label="PostgreSQL deployment"/);
    assert.match(render,/option value="internal-postgres"/);
    assert.match(render,/option value="postgres"/);
    assert.match(common,/value="mysql"[^>]*>MySQL/);
    assert.match(common,/value="pack:mssqlnative"[^>]*>MS SQL Server \(Native\)/);
    assert.match(common,/value="pack:oracle"[^>]*>Oracle/);
    assert.doesNotMatch(common,/value="pack:mssql"/);
    assert.doesNotMatch(common,/value="pack:snowflake"/);
    assert.match(others,/value="pack:mssql"[^>]*>MS SQL Server/);
    assert.match(others,/value="pack:snowflake"[^>]*>Snowflake/);
    assert.doesNotMatch(physical,/value="postgresql"/);
  });
});

describe('server Pack dialect aliases',()=>{
  test('server resolves stable MySQL/PostgreSQL dialect ids without reclassifying them as pack:*',()=>{
    const service=createDatabasePackService({
      projectRoot:path.join(__dirname,'..','..'),
      jdbcDriverPath:path.join(__dirname,'..','..','jdbc-drivers'),
      studioDir:path.join(__dirname,'..'),
      env:{},
    });
    assert.strictEqual(service.getDatabasePackForDialect('mysql').id,'mysql');
    assert.strictEqual(service.getDatabasePackForDialect('postgresql').id,'postgresql');
    assert.strictEqual(service.isPackDialect('mysql'),false);
    assert.strictEqual(service.isPackDialect('postgresql'),false);
  });

  test('MySQL YEAR remains numeric when JDBC metadata reports it as DATE',()=>{
    const service=createDatabasePackService({
      projectRoot:path.join(__dirname,'..','..'),
      jdbcDriverPath:path.join(__dirname,'..','..','jdbc-drivers'),
      studioDir:path.join(__dirname,'..'),
      env:{},
    });
    assert.strictEqual(mysqlPack.source.nativeTypeOverrides.YEAR,'SMALL_INTEGER');
    assert.strictEqual(service.semanticTypeForJdbc(mysqlPack,{nativeType:'YEAR',jdbcType:'DATE'}),'SMALL_INTEGER');
    const detected=service.applyPackSemanticTypes(mysqlPack,{tables:[{columns:[{nativeType:'YEAR',jdbcType:'DATE'}]}]});
    assert.strictEqual(detected.tables[0].columns[0].type,'smallint');
  });

  test('regenerating the MySQL Pack preserves the YEAR override',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-mysql-pack-'));
    const input=path.join(root,'hop-extract.json');
    const output=path.join(root,'packs');
    const mysqlExtract=[{
      pluginId:'MYSQL', pluginName:'MySQL', module:'mysql',
      driverClass:'com.mysql.cj.jdbc.Driver',
      urlTemplate:'jdbc:mysql://{host}:{port}/{database}', urlStatus:'extracted',
      baseUrlTemplate:'jdbc:mysql://{host}:{port}/{database}', defaultPort:3306,
      requiresDatabaseName:true, namespace:{supportsSchemas:true},
      capabilities:{tableInput:true}, connectionForm:{fields:[]}, defaultAttributes:{},
    }];
    try{
      fs.writeFileSync(input,JSON.stringify(mysqlExtract));
      execFileSync(process.execPath,[path.join(__dirname,'..','hop','build-database-packs.js'),input,output],{stdio:'pipe'});
      const generated=JSON.parse(fs.readFileSync(path.join(output,'mysql.json'),'utf8'));
      assert.deepStrictEqual(generated.source.nativeTypeOverrides,{YEAR:'SMALL_INTEGER'});
    } finally {
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
});

describe('portable dv-certs references in Pack-backed sources',()=>{
  test('JDBC option certificate references stay portable in state and map to the Hop container in source.json',()=>{
    const result=app.eval(`{
      Object.assign(state.vault,{dialect:'postgresql',sourcePreset:'',srcHost:'pg.example',srcPort:'5432',srcDatabase:'source_db',sourceSchema:'public',srcUser:'reader',srcPassword:'secret'});
      seedPackConnectionValues(databasePackForDialect('postgresql'),'source',{reset:true});
      state.vault.sourcePackOptions=[
        {key:'sslmode',value:'verify-full'},
        {key:'sslrootcert',value:'dv-certs/customer-ca.pem'},
        {key:'sslcert',value:'dv-certs/client/client.crt'}
      ];
      const generated=JSON.parse(buildHopSourceConnectionJson());
      ({stored:state.vault.sourcePackOptions,attrs:generated.rdbms.POSTGRESQL.attributes});
    }`);
    assert.deepStrictEqual(result.stored,[
      {key:'sslmode',value:'verify-full'},
      {key:'sslrootcert',value:'dv-certs/customer-ca.pem'},
      {key:'sslcert',value:'dv-certs/client/client.crt'},
    ]);
    assert.strictEqual(result.attrs['EXTRA_OPTION_POSTGRESQL.sslmode'],'verify-full');
    assert.strictEqual(result.attrs['EXTRA_OPTION_POSTGRESQL.sslrootcert'],'/app/dv-certs/customer-ca.pem');
    assert.strictEqual(result.attrs['EXTRA_OPTION_POSTGRESQL.sslcert'],'/app/dv-certs/client/client.crt');
  });

  test('manual JDBC URLs rewrite dv-certs references for Hop without changing saved project state',()=>{
    const result=app.eval(`{
      Object.assign(state.vault,{dialect:'postgresql',sourcePreset:'',srcHost:'pg.example',srcPort:'5432',srcDatabase:'source_db',sourceSchema:'public',srcUser:'reader',srcPassword:'secret'});
      seedPackConnectionValues(databasePackForDialect('postgresql'),'source',{reset:true});
      state.vault.sourceManualUrl='jdbc:postgresql://pg.example:5432/source_db?sslmode=verify-full&sslrootcert=dv-certs/root.pem';
      const generated=JSON.parse(buildHopSourceConnectionJson());
      ({stored:state.vault.sourceManualUrl,manualUrl:generated.rdbms.POSTGRESQL.manualUrl});
    }`);
    assert.match(result.stored,/sslrootcert=dv-certs\/root\.pem$/);
    assert.match(result.manualUrl,/sslrootcert=\/app\/dv-certs\/root\.pem$/);
  });

  test('source.json generation rejects dv-certs traversal instead of exposing other container files',()=>{
    assert.throws(()=>app.eval(`{
      Object.assign(state.vault,{dialect:'mysql',sourcePreset:'',srcHost:'mysql.example',srcPort:'3306',srcDatabase:'sales',sourceSchema:'sales',srcUser:'reader',srcPassword:'secret'});
      seedPackConnectionValues(databasePackForDialect('mysql'),'source',{reset:true});
      state.vault.sourcePackOptions=[{key:'trustCertificateKeyStoreUrl',value:'file:dv-certs/../outside.p12'}];
      buildHopSourceConnectionJson();
    }`),/parent-directory/);
  });

  test('source runtime generation rejects unmanaged local JDBC file paths',()=>{
    assert.throws(()=>app.eval(`{
      Object.assign(state.vault,{dialect:'postgresql',sourcePreset:'',srcHost:'pg.example',srcPort:'5432',srcDatabase:'source_db',sourceSchema:'public',srcUser:'reader',srcPassword:'secret'});
      seedPackConnectionValues(databasePackForDialect('postgresql'),'source',{reset:true});
      state.vault.sourcePackOptions=[{key:'sslrootcert',value:'/etc/ssl/private/customer-ca.pem'}];
      buildHopSourceConnectionJson();
    }`),/must use the project dv-certs\/ directory/);
  });

  test('manual JDBC URL properties reject unmanaged local files without blocking the JDBC endpoint itself',()=>{
    assert.throws(()=>app.eval(`{
      Object.assign(state.vault,{dialect:'postgresql',sourcePreset:'',srcHost:'pg.example',srcPort:'5432',srcDatabase:'source_db',sourceSchema:'public',srcUser:'reader',srcPassword:'secret'});
      seedPackConnectionValues(databasePackForDialect('postgresql'),'source',{reset:true});
      state.vault.sourceManualUrl='jdbc:postgresql://pg.example:5432/source_db?sslrootcert=file:/tmp/root.pem';
      buildHopSourceConnectionJson();
    }`),/must use the project dv-certs\/ directory/);
  });

  test('Pack options UI documents the project-local certificate reference without adding an upload control',()=>{
    const html=app.eval(`packJdbcOptionsHtml(databasePackForDialect('postgresql'),'source')`);
    assert.match(html,/dv-certs\/filename/);
    assert.match(html,/\/app\/dv-certs\/filename/);
    assert.doesNotMatch(html,/type="file"/i);
    assert.doesNotMatch(html,/upload/i);
  });
});

describe('portable dv-certs references for Pack-backed physical targets',()=>{
  test('container-side FDW URL maps dv-certs without conflating it with the Studio Pack Manual URL',()=>{
    const result=app.eval(`{
      state.externalTables.enabled=true;
      state.externalTables.remoteDialect='mysql';
      Object.assign(state.externalTables,{serverName:'vault_external_srv',studioHost:'mysql.example',studioPort:'3306',studioDatabase:'vault',remoteDatabase:'vault',studioSchema:'vault',remoteSchema:'vault',studioUser:'writer',studioPassword:'target-secret',username:'writer',password:'target-secret'});
      seedPackConnectionValues(databasePackForDialect('mysql'),'target',{reset:true});
      state.externalTables.manualUrl='jdbc:mysql://127.0.0.1:3306/vault?sslMode=VERIFY_CA';
      state.externalTables.url='jdbc:mysql://mysql.internal:3306/vault?sslMode=VERIFY_CA&trustCertificateKeyStoreUrl=file:dv-certs/mysql-trust.p12';
      state.externalTables.fdwUrlOverridden=true;
      const ddl=buildFdwPreamble();
      ({studioManual:state.externalTables.manualUrl,storedFdwUrl:state.externalTables.url,ddl});
    }`);
    assert.match(result.studioManual,/127\.0\.0\.1:3306/);
    assert.match(result.storedFdwUrl,/mysql\.internal:3306/);
    assert.match(result.storedFdwUrl,/file:dv-certs\/mysql-trust\.p12$/);
    assert.match(result.ddl,/mysql\.internal:3306/);
    assert.match(result.ddl,/file:\/app\/dv-certs\/mysql-trust\.p12/);
    assert.doesNotMatch(result.ddl,/127\.0\.0\.1:3306/);
  });

  test('target runtime URL rejects traversal before generating jdbc_fdw DDL',()=>{
    assert.throws(()=>app.eval(`{
      state.externalTables.enabled=true;
      state.externalTables.remoteDialect='mysql';
      Object.assign(state.externalTables,{serverName:'vault_external_srv',studioHost:'mysql.example',studioPort:'3306',studioDatabase:'vault',remoteDatabase:'vault',studioSchema:'vault',remoteSchema:'vault',studioUser:'writer',studioPassword:'target-secret',username:'writer',password:'target-secret',fdwUrlOverridden:true,url:'jdbc:mysql://mysql.internal:3306/vault?trustCertificateKeyStoreUrl=file:dv-certs/../outside.p12'});
      seedPackConnectionValues(databasePackForDialect('mysql'),'target',{reset:true});
      buildFdwPreamble();
    }`),/parent-directory/);
  });
});
