'use strict';

function registerExternalTargetRoutes(parentApp, dependencies){
  const {
    express,
    mysql,
    connectPgWithFallback,
    isPackDialect,
    getDatabasePack,
    getDatabasePackForDialect,
    runJdbcBridge,
    packNamespaceFromBody,
    firstNonBlank,
    analysisValue,
    resolveJdbcTargetProfile,
    packagedCredentialService,
    outboundConnectionPolicy,
    audit,
  } = dependencies;
  const app = express.Router();

  function externalDialect(body){
    const dialect = String((body && body.dialect) || 'postgresql').toLowerCase();
    if (isPackDialect(dialect)) {
      // Installed Database Packs are eligible physical targets. Their JDBC
      // metadata is inspected at runtime; target/fdw manifest sections are
      // optional exception/compatibility metadata rather than an allowlist.
      getDatabasePack(dialect);
      return dialect;
    }
    if (dialect==='mysql') {
      const pack=getDatabasePackForDialect('mysql');
      if(pack) return `pack:${pack.id}`;
      return 'mysql';
    }
    if (dialect==='postgresql') return dialect;
  
    // Backward-compatibility and defence in depth: if a client accidentally
    // sends the raw id of an installed Pack (for example "sqlserver"), keep it
    // on the Pack/JDBC path rather than falling into the retired built-in route.
    try {
      const pack=getDatabasePack(dialect);
      return `pack:${pack.id}`;
    } catch (_) {}
  
    throw new Error(`Automatic external deployment does not support dialect "${dialect}".`);
  }
  function externalIdentifier(value, label){
    const name=String(value||'');
    if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(name)) throw new Error(`${label} must be a plain identifier.`);
    return name;
  }
  function externalSqlLiteral(value){ return `'${String(value==null?'':value).replace(/'/g,"''")}'`; }
  function renderPackProvisioningSql(template, values){
    return String(template||'').replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(match,key)=>{
      if(!values||!Object.prototype.hasOwnProperty.call(values,key)) throw new Error(`Unknown Database Pack provisioning placeholder {${key}}.`);
      return String(values[key]);
    });
  }
  function packProvisioningValues({database,schema,serviceUser,servicePassword,tables}={}){
    const values={};
    if(database){values.database=externalIdentifier(database,'Database name');values.databaseLiteral=externalSqlLiteral(database);}
    if(schema){values.schema=externalIdentifier(schema,'Schema name');values.schemaLiteral=externalSqlLiteral(schema);}
    if(serviceUser){values.serviceUser=externalIdentifier(serviceUser,'Service username');values.serviceUserLiteral=externalSqlLiteral(serviceUser);}
    if(servicePassword!=null){values.servicePasswordLiteral=externalSqlLiteral(servicePassword);}
    if(Array.isArray(tables)){
      values.tableNamesLiteral=tables.map(name=>externalSqlLiteral(externalIdentifier(name,'Table name'))).join(', ');
    }
    return values;
  }
  function packAnalysisSchemaExists(analysis,database,schema){
    const wantedSchema=String(schema||'').trim().toLowerCase();
    if(!wantedSchema)return true;
    const wantedCatalog=String(database||'').trim().toLowerCase();
    const entries=Array.isArray(analysis&&analysis.schemas)?analysis.schemas:[];
    if(!entries.length)return null;
    return entries.some(entry=>{
      if(typeof entry==='string')return entry.trim().toLowerCase()===wantedSchema;
      const foundSchema=String(entry&&entry.schema||entry&&entry.name||'').trim().toLowerCase();
      const foundCatalog=String(entry&&entry.catalog||'').trim().toLowerCase();
      return foundSchema===wantedSchema && (!wantedCatalog||!foundCatalog||foundCatalog===wantedCatalog);
    });
  }
  function packTargetProfileFromAnalysis(pack,analysis){
    return resolveJdbcTargetProfile(pack,analysis||{});
  }
  function databasePackBodyForCatalog(pack,body,catalog){
    const copy=JSON.parse(JSON.stringify(body||{}));
    copy.database=catalog; copy.catalog=catalog; copy.packValues={...(copy.packValues||{})};
    for(const field of pack.connectionFields||[]){
      if(field.mapsTo==='database'||field.mapsTo==='catalog')copy.packValues[field.key]=catalog;
    }
    return copy;
  }
  function databasePackBodyWithCredentials(pack,body,user,password){
    const copy=JSON.parse(JSON.stringify(body||{}));
    copy.user=user; copy.password=password; copy.packValues={...(copy.packValues||{})};
    for(const field of pack.connectionFields||[]){
      if(field.mapsTo==='user')copy.packValues[field.key]=user;
      if(field.mapsTo==='password')copy.packValues[field.key]=password;
    }
    return copy;
  }
  async function openExternalTarget(body, { databaseRequired=true, multipleStatements=false }={}){
    const connection=packagedCredentialService.resolveConnection(body||{});
    const dialect=externalDialect(connection);
    if(isPackDialect(dialect)){
      const pack=getDatabasePack(dialect);
      return {
        dialect, pack,
        query:async(sql)=>{const d=await runJdbcBridge(pack,connection,'query',String(sql));return {rows:d.rows||[],fields:(d.fields||[]).map(name=>({name})),rowCount:Number(d.rowCount||0)};},
        execute:async(sql)=>runJdbcBridge(pack,connection,'execute',String(sql)),
        end:async()=>{},
      };
    }
    const {host,port,database,user,password}=connection;
    if (!host || !user || (databaseRequired && !database)) throw new Error(`host, ${databaseRequired?'database, ':''}and user are required.`);
    if (dialect==='postgresql'){
      const client=await connectPgWithFallback({host,port:port||5432,database:database||'postgres',user,password});
      return {dialect, query:(sql,params)=>client.query(sql,params), end:()=>client.end()};
    }
    const destination=await outboundConnectionPolicy.validateNetworkDestination({host,port,defaultPort:3306});
    const conn=await mysql.createConnection({
      host:destination.addresses[0],
      port:destination.port,
      database:databaseRequired?(database||undefined):undefined,
      user,
      password:password||undefined,
      connectTimeout:6000,
      multipleStatements,
    });
    return {
      dialect,
      query:async(sql,params)=>{
        const [rows]=await conn.query(sql,params);
        return {rows,rowCount:Array.isArray(rows)?rows.length:0};
      },
      end:()=>conn.end(),
    };
  }
  
  async function mysqlConnectionIdentity(conn){
    const result=await conn.query('SELECT @@hostname AS server_hostname, @@port AS server_port, CURRENT_USER() AS authenticated_user, USER() AS client_user');
    const row=(result.rows&&result.rows[0])||{};
    return {
      serverHostname:String(row.server_hostname ?? row.SERVER_HOSTNAME ?? ''),
      serverPort:Number(row.server_port ?? row.SERVER_PORT ?? 0),
      currentUser:String(row.authenticated_user ?? row.AUTHENTICATED_USER ?? ''),
      clientUser:String(row.client_user ?? row.CLIENT_USER ?? ''),
    };
  }
  
  
  app.post('/api/external-db-status', async (req,res)=>{
    let conn;
    try{
      const dialect=externalDialect(req.body);
      if(isPackDialect(dialect)){
        const pack=getDatabasePack(dialect);
        const connection=packagedCredentialService.resolveConnection(req.body||{});
        const ns=packNamespaceFromBody(pack,connection);
        const database=ns.catalog||String((connection&&connection.database)||''); const schema=ns.schema||'';
        const provisioning=pack.provisioning&&typeof pack.provisioning==='object'?pack.provisioning:null;
        const includeProfile=!!(req.body&&req.body.includeProfile);
        const values=packProvisioningValues({database,schema});
        if(pack.id==='mysql'){
          const maintenance=databasePackBodyForCatalog(pack,connection,'mysql');
          conn=await openExternalTarget(maintenance);
          const dbCheck=await conn.query(`SELECT 1 AS found FROM information_schema.schemata WHERE schema_name = ${externalSqlLiteral(database)}`);
          const exists=Array.isArray(dbCheck.rows)&&dbCheck.rows.length>0;
          let identity={};
          try{ identity=await mysqlConnectionIdentity(conn); }catch(_){}
          await conn.end(); conn=null;
          if(!exists)return res.json({ok:true,connected:true,exists:false,schemaExists:false,selectedDatabase:database,selectedSchema:database,pack:{id:pack.id,label:pack.label,version:pack.version},...identity});
          let targetProfile=null;
          if(includeProfile){
            const analysis=await runJdbcBridge(pack,connection,'analyze','');
            targetProfile=packTargetProfileFromAnalysis(pack,analysis);
          }
          return res.json({ok:true,connected:true,exists:true,schemaExists:true,selectedDatabase:database,selectedSchema:database,pack:{id:pack.id,label:pack.label,version:pack.version},targetProfile,profileIncluded:includeProfile,...identity});
        }
        let targetError=null;
        try{
          if(includeProfile){
            // One JDBC metadata pass proves the selected database connection,
            // discovers its schemas and resolves target types. The previous flow
            // opened separate JVM/JDBC sessions for database status, SELECT 1,
            // schema status and then target-profile discovery.
            const analysis=await runJdbcBridge(pack,connection,'analyze','');
            let schemaExists=packAnalysisSchemaExists(analysis,database,schema);
            if(schemaExists==null && schema&&provisioning&&provisioning.schemaExistsSql){
              conn=await openExternalTarget(connection);
              const schemaCheck=await conn.query(renderPackProvisioningSql(provisioning.schemaExistsSql,values));
              schemaExists=Array.isArray(schemaCheck.rows)&&schemaCheck.rows.length>0;
              await conn.end(); conn=null;
            }
            if(schemaExists==null)schemaExists=true;
            return res.json({
              ok:true,connected:true,exists:true,schemaExists,selectedDatabase:database,selectedSchema:schema,
              pack:{id:pack.id,label:pack.label,version:pack.version},
              targetProfile:packTargetProfileFromAnalysis(pack,analysis),profileIncluded:true
            });
          }
          // Status-only checks use a narrow query against the selected database.
          // If a schema was selected, checking that schema also proves the
          // database is reachable, avoiding a separate SELECT 1 round trip.
          conn=await openExternalTarget(connection);
          if(schema&&provisioning&&provisioning.schemaExistsSql){
            const schemaCheck=await conn.query(renderPackProvisioningSql(provisioning.schemaExistsSql,values));
            const schemaExists=Array.isArray(schemaCheck.rows)&&schemaCheck.rows.length>0;
            return res.json({ok:true,connected:true,exists:true,schemaExists,selectedDatabase:database,selectedSchema:schema,pack:{id:pack.id,label:pack.label,version:pack.version}});
          }
          const result=await conn.query(String(pack.jdbc.testSql||'SELECT 1'));
          return res.json({ok:true,connected:true,exists:true,schemaExists:true,vendorManaged:!(provisioning&&provisioning.databaseExistsSql),selectedDatabase:database,selectedSchema:schema,pack:{id:pack.id,label:pack.label,version:pack.version},rowCount:result.rowCount||0});
        }catch(err){
          targetError=err;
          if(conn){try{await conn.end();}catch(_){}} conn=null;
        }
        // A failed target connection can mean the database does not exist. Only
        // then fall back to the maintenance catalog. Existing databases stay on
        // the one-session fast path above.
        if(provisioning&&provisioning.maintenanceCatalog&&provisioning.databaseExistsSql&&database){
          conn=await openExternalTarget(databasePackBodyForCatalog(pack,connection,String(provisioning.maintenanceCatalog)));
          const dbCheck=await conn.query(renderPackProvisioningSql(provisioning.databaseExistsSql,values));
          const exists=Array.isArray(dbCheck.rows)&&dbCheck.rows.length>0;
          if(!exists)return res.json({ok:true,connected:true,exists:false,schemaExists:false,selectedDatabase:database,selectedSchema:schema,pack:{id:pack.id,label:pack.label,version:pack.version}});
        }
        throw targetError||new Error(`Could not connect to ${pack.label}.`);
      }
      const database=externalIdentifier(req.body && req.body.database,'Database name');
      if(dialect==='postgresql'){
        conn=await openExternalTarget({...req.body,database:(req.body&&req.body.maintenanceDatabase)||'postgres'});
        const result=await conn.query('SELECT 1 FROM pg_database WHERE datname=$1',[database]);
        return res.json({ok:true,connected:true,exists:result.rowCount>0});
      }
      conn=await openExternalTarget(req.body,{databaseRequired:false});
      const result=await conn.query('SELECT 1 FROM information_schema.schemata WHERE schema_name=?',[database]);
      const identity=await mysqlConnectionIdentity(conn);
      res.json({ok:true,connected:true,exists:Array.isArray(result.rows)&&result.rows.length>0,...identity});
    }catch(err){res.status(400).json({ok:false,error:err.message});}
    finally{if(conn){try{await conn.end();}catch(_){}}}
  });
  
  app.post('/api/external-create-database', async (req,res)=>{
    let conn;
    try{
      const dialect=externalDialect(req.body);
      if(isPackDialect(dialect)){
        const pack=getDatabasePack(dialect);
        const connection=packagedCredentialService.resolveConnection(req.body||{});
        const ns=packNamespaceFromBody(pack,connection);
        const database=ns.catalog||String((connection&&connection.database)||''); const schema=ns.schema||'';
        const provisioning=pack.provisioning&&typeof pack.provisioning==='object'?pack.provisioning:null;
        if(pack.id==='mysql'){
          externalIdentifier(database,'Database name');
          conn=await openExternalTarget(databasePackBodyForCatalog(pack,connection,'mysql'));
          const existing=await conn.query(`SELECT 1 AS found FROM information_schema.schemata WHERE schema_name = ${externalSqlLiteral(database)}`);
          const created=!Array.isArray(existing.rows)||existing.rows.length===0;
          if(created) await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g,'``')}\``);
          const verify=await conn.query(`SELECT 1 AS found FROM information_schema.schemata WHERE schema_name = ${externalSqlLiteral(database)}`);
          if(!Array.isArray(verify.rows)||verify.rows.length===0)throw new Error(`Database "${database}" was not visible after CREATE DATABASE.`);
          const identity=await mysqlConnectionIdentity(conn).catch(()=>({}));
          await conn.end(); conn=null;
          const analysis=await runJdbcBridge(pack,connection,'analyze','');
          return res.json({ok:true,created,exists:true,schemaExists:true,selectedDatabase:database,selectedSchema:database,pack:{id:pack.id,label:pack.label,version:pack.version},targetProfile:packTargetProfileFromAnalysis(pack,analysis),...identity});
        }
        if(!provisioning||!provisioning.maintenanceCatalog||!provisioning.databaseExistsSql||!provisioning.createDatabaseSql){
          conn=await openExternalTarget(connection); await conn.query(String(pack.jdbc.testSql||'SELECT 1'));
          return res.json({ok:true,created:false,exists:true,vendorManaged:true,selectedDatabase:database,selectedSchema:schema,message:'Database/catalog creation is administrator-managed for this Database Pack.'});
        }
        const values=packProvisioningValues({database,schema});
        const knownDatabaseExists=req.body&&typeof req.body.knownDatabaseExists==='boolean'?req.body.knownDatabaseExists:null;
        const knownSchemaExists=req.body&&typeof req.body.knownSchemaExists==='boolean'?req.body.knownSchemaExists:null;
        if(provisioning.ensureDatabaseSql && knownDatabaseExists!==null){
          // The caller has just performed a live status check. Use that result as
          // a hint to avoid repeating existence probes, but still finish with a
          // fresh JDBC metadata verification. SQL Server's ensure statement is
          // idempotent so a race cannot create the database twice.
          let created=false, schemaCreated=false;
          if(!knownDatabaseExists){
            conn=await openExternalTarget(databasePackBodyForCatalog(pack,connection,String(provisioning.maintenanceCatalog)));
            await conn.execute(renderPackProvisioningSql(provisioning.ensureDatabaseSql,values));
            created=true; await conn.end(); conn=null;
          }
          if(schema && knownSchemaExists!==true && provisioning.createSchemaSql){
            conn=await openExternalTarget(connection);
            await conn.execute(renderPackProvisioningSql(provisioning.createSchemaSql,values));
            schemaCreated=true; await conn.end(); conn=null;
          }
          const analysis=await runJdbcBridge(pack,connection,'analyze','');
          let schemaExists=packAnalysisSchemaExists(analysis,database,schema);
          if(schemaExists==null && schema&&provisioning.schemaExistsSql){
            conn=await openExternalTarget(connection);
            const schemaCheck=await conn.query(renderPackProvisioningSql(provisioning.schemaExistsSql,values));
            schemaExists=Array.isArray(schemaCheck.rows)&&schemaCheck.rows.length>0;
            await conn.end(); conn=null;
          }
          if(schemaExists===false)throw new Error(`Schema "${schema}" was not visible after creation.`);
          return res.json({
            ok:true,created,exists:true,schemaCreated,schemaExists:schemaExists!==false,verified:true,
            selectedDatabase:database,selectedSchema:schema,pack:{id:pack.id,label:pack.label,version:pack.version},
            targetProfile:packTargetProfileFromAnalysis(pack,analysis)
          });
        }
        conn=await openExternalTarget(databasePackBodyForCatalog(pack,connection,String(provisioning.maintenanceCatalog)));
        let check=await conn.query(renderPackProvisioningSql(provisioning.databaseExistsSql,values));
        let created=false;
        let exists=Array.isArray(check.rows)&&check.rows.length>0;
        if(!exists){
          await conn.end(); conn=null;
          try{
            conn=await openExternalTarget(connection);
            await conn.query(String(pack.jdbc.testSql||'SELECT 1'));
            exists=true;
          }catch(_){
            if(conn){try{await conn.end();}catch(__){}} conn=null;
          }
        }
        if(!exists){
          conn=await openExternalTarget(databasePackBodyForCatalog(pack,connection,String(provisioning.maintenanceCatalog)));
          await conn.execute(renderPackProvisioningSql(provisioning.createDatabaseSql,values)); created=true;
          check=await conn.query(renderPackProvisioningSql(provisioning.databaseExistsSql,values));
          if(!Array.isArray(check.rows)||!check.rows.length)throw new Error(`Database "${database}" was not visible after creation.`);
          await conn.end(); conn=null;
        }
        if(!conn)conn=await openExternalTarget(connection);
        await conn.query(String(pack.jdbc.testSql||'SELECT 1'));
        let schemaCreated=false, schemaExists=true;
        if(schema&&provisioning.schemaExistsSql){
          let schemaCheck=await conn.query(renderPackProvisioningSql(provisioning.schemaExistsSql,values));
          schemaExists=Array.isArray(schemaCheck.rows)&&schemaCheck.rows.length>0;
          if(!schemaExists&&provisioning.createSchemaSql){
            await conn.execute(renderPackProvisioningSql(provisioning.createSchemaSql,values)); schemaCreated=true;
            schemaCheck=await conn.query(renderPackProvisioningSql(provisioning.schemaExistsSql,values));
            schemaExists=Array.isArray(schemaCheck.rows)&&schemaCheck.rows.length>0;
          }
          if(!schemaExists)throw new Error(`Schema "${schema}" was not visible after creation.`);
        }
        return res.json({ok:true,created,exists:true,schemaCreated,schemaExists,selectedDatabase:database,selectedSchema:schema,pack:{id:pack.id,label:pack.label,version:pack.version}});
      }
      const database=externalIdentifier(req.body && req.body.database,'Database name');
      if(dialect==='postgresql'){
        conn=await openExternalTarget({...req.body,database:(req.body&&req.body.maintenanceDatabase)||'postgres'});
        const existing=await conn.query('SELECT 1 FROM pg_database WHERE datname=$1',[database]);
        if(existing.rowCount) return res.json({ok:true,created:false,exists:true});
        await conn.query(`CREATE DATABASE "${database}"`);
        const verify=await conn.query('SELECT 1 FROM pg_database WHERE datname=$1',[database]);
        if(!verify.rowCount) throw new Error(`Database "${database}" was not visible after CREATE DATABASE.`);
        return res.json({ok:true,created:true,exists:true});
      }
      conn=await openExternalTarget(req.body,{databaseRequired:false});
      const existing=await conn.query('SELECT 1 FROM information_schema.schemata WHERE schema_name=?',[database]);
      const created=!Array.isArray(existing.rows)||existing.rows.length===0;
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
      const verify=await conn.query('SELECT 1 FROM information_schema.schemata WHERE schema_name=?',[database]);
      if(!Array.isArray(verify.rows)||verify.rows.length===0) throw new Error(`Database "${database}" was not visible after CREATE DATABASE.`);
      const identity=await mysqlConnectionIdentity(conn);
      await conn.end(); conn=null;
      const databaseConn=await openExternalTarget({...req.body,database});
      try{await databaseConn.query('SELECT DATABASE() AS selected_database');}
      finally{await databaseConn.end();}
      res.json({ok:true,created,exists:true,...identity,selectedDatabase:database});
    }catch(err){res.status(400).json({ok:false,error:err.message});}
    finally{if(conn){try{await conn.end();}catch(_){}}}
  });
  
  app.post('/api/database-packs/provision-fdw-service-user', async (req,res)=>{
    let conn;
    try{
      const dialect=externalDialect(req.body);
      if(!isPackDialect(dialect))throw new Error('FDW service-account provisioning requires a Database Pack target.');
      const pack=getDatabasePack(dialect); const spec=pack.fdw&&pack.fdw.serviceUser;
      if(!spec||typeof spec!=='object')throw new Error(`${pack.label} does not provide FDW service-account provisioning rules.`);
      const ns=packNamespaceFromBody(pack,req.body); const database=ns.catalog||String(req.body&&req.body.database||''); const schema=ns.schema||'';
      if(!database)throw new Error('Target database is required.');
      if(!schema)throw new Error('Target schema is required before creating an FDW service account.');
      const serviceUser=externalIdentifier(req.body&&req.body.serviceUser,'Service username');
      const servicePassword=String(req.body&&req.body.servicePassword||'');
      if(!servicePassword)throw new Error('Service account password is required.');
      const values=packProvisioningValues({database,schema,serviceUser,servicePassword});
      const maintenance=String(spec.maintenanceCatalog||pack.provisioning&&pack.provisioning.maintenanceCatalog||'');
      if(!maintenance||!spec.loginExistsSql||!spec.createLoginSql)throw new Error(`${pack.label} service-account rules are incomplete.`);
      conn=await openExternalTarget(databasePackBodyForCatalog(pack,req.body,maintenance));
      const loginCheck=await conn.query(renderPackProvisioningSql(spec.loginExistsSql,values));
      const loginExists=Array.isArray(loginCheck.rows)&&loginCheck.rows.length>0;
      if(!loginExists)await conn.execute(renderPackProvisioningSql(spec.createLoginSql,values));
      await conn.end(); conn=null;
      if(loginExists){
        try{
          const proofBody=databasePackBodyWithCredentials(pack,databasePackBodyForCatalog(pack,req.body,maintenance),serviceUser,servicePassword);
          await runJdbcBridge(pack,proofBody,'query',String(pack.jdbc.testSql||'SELECT 1'));
        }catch(_){
          throw new Error(`Service login "${serviceUser}" already exists, but the supplied password did not authenticate. Choose a different service username or enter that login's existing password; Studio will not reset an existing login.`);
        }
      }
  
      conn=await openExternalTarget(req.body);
      const provisioning=pack.provisioning&&typeof pack.provisioning==='object'?pack.provisioning:null;
      if(spec.configureDatabaseUserSql){
        // Packs may combine schema ensure + database-user create/alter + grants
        // into one idempotent statement. This avoids a fresh JVM/JDBC session
        // for every individual provisioning statement.
        await conn.execute(renderPackProvisioningSql(spec.configureDatabaseUserSql,values));
      }else{
        if(provisioning&&provisioning.createSchemaSql){
          await conn.execute(renderPackProvisioningSql(provisioning.createSchemaSql,values));
        }
        let userExists=false;
        if(spec.databaseUserExistsSql){
          const userCheck=await conn.query(renderPackProvisioningSql(spec.databaseUserExistsSql,values));
          userExists=Array.isArray(userCheck.rows)&&userCheck.rows.length>0;
        }
        if(userExists){
          if(!spec.setDefaultSchemaSql)throw new Error(`${pack.label} cannot safely configure the existing database user ${serviceUser}.`);
          await conn.execute(renderPackProvisioningSql(spec.setDefaultSchemaSql,values));
        }else{
          if(!spec.createDatabaseUserSql)throw new Error(`${pack.label} service-account rules do not define database-user creation.`);
          await conn.execute(renderPackProvisioningSql(spec.createDatabaseUserSql,values));
        }
        const grants=Array.isArray(spec.grantSql)?spec.grantSql:(spec.grantSql?[spec.grantSql]:[]);
        for(const statement of grants)await conn.execute(renderPackProvisioningSql(statement,values));
      }
      await conn.end(); conn=null;
  
      const serviceBody=databasePackBodyWithCredentials(pack,req.body,serviceUser,servicePassword);
      // analyze opens and validates the service-user connection; no separate
      // SELECT 1 process is needed before it.
      const analysis=await runJdbcBridge(pack,serviceBody,'analyze','');
      const currentSchema=String(analysisValue(analysis,'currentSchema','schema','metadata.currentSchema')||'');
      if(currentSchema&&currentSchema.toLowerCase()!==schema.toLowerCase())throw new Error(`The new service account connected, but JDBC reports default schema "${currentSchema}" instead of "${schema}".`);
      res.json({ok:true,serviceUser,database,schema,currentSchema,message:`Created ${serviceUser} for ${database}/${schema} and verified the JDBC connection.`});
    }catch(err){res.status(400).json({ok:false,error:err.message});}
    finally{if(conn){try{await conn.end();}catch(_){}}}
  });
  
  app.post('/api/external-verify-user-access', async (req,res)=>{
    let conn;
    try{
      const dialect=externalDialect(req.body);
      // Preserve the built-in guard: reject unsafe database identifiers before
      // attempting a network connection. Pack namespaces are adapter-defined
      // and may legitimately contain vendor-specific characters, so their
      // validation stays in the pack/JDBC layer.
      if(!isPackDialect(dialect)) externalIdentifier(req.body && req.body.database,'Database name');
      conn=await openExternalTarget(req.body);
      if(isPackDialect(dialect)){
        const pack=getDatabasePack(dialect); const result=await conn.query(String(pack.jdbc.testSql||'SELECT 1'));
        const connection=packagedCredentialService.resolveConnection(req.body||{});
        const ns=packNamespaceFromBody(pack,connection);
        if(pack.id==='mysql'){
          const identity=await mysqlConnectionIdentity(conn).catch(()=>({}));
          let grants=[]; try{grants=(await conn.query('SHOW GRANTS FOR CURRENT_USER()')).rows||[];}catch(_){}
          return res.json({ok:true,pack:{id:pack.id,label:pack.label,version:pack.version},catalog:ns.catalog,schema:ns.schema||connection.database,fdw:pack.fdw,rowCount:result.rowCount||0,...identity,grants});
        }
        return res.json({ok:true,pack:{id:pack.id,label:pack.label,version:pack.version},catalog:ns.catalog,schema:ns.schema,fdw:pack.fdw,rowCount:result.rowCount||0});
      }
      if(dialect==='mysql'){
        const identity=await mysqlConnectionIdentity(conn);
        const grants=await conn.query('SHOW GRANTS FOR CURRENT_USER()');
        await conn.query('SELECT 1 AS route_ok');
        return res.json({ok:true,...identity,grants:grants.rows||[]});
      }
      const identity=await conn.query('SELECT current_user, current_database()');
      await conn.query('SELECT 1 AS route_ok');
      res.json({ok:true,currentUser:identity.rows&&identity.rows[0]&&identity.rows[0].current_user,database:identity.rows&&identity.rows[0]&&identity.rows[0].current_database});
    }catch(err){res.status(400).json({ok:false,error:err.message});}
    finally{if(conn){try{await conn.end();}catch(_){}}}
  });
  
  app.post('/api/external-execute-sql', async (req,res)=>{
    const sql=String((req.body&&req.body.sql)||'');
    if(!sql.trim()) return res.status(400).json({ok:false,error:'No SQL provided.'});
    let conn;
    try{
      conn=await openExternalTarget(req.body,{multipleStatements:true});
      if(isPackDialect(conn.dialect)){
        const result=await conn.execute(sql);
        audit('sql.deployed', { target:'database-pack', dialect:conn.dialect, statements:result.statements||0, success:true });
        return res.json({ok:true,statements:result.statements||0});
      }
      if(conn.dialect==='postgresql'){
        await conn.query('BEGIN');
        try{
          await conn.query("SET LOCAL lock_timeout='10s'");
          await conn.query("SET LOCAL statement_timeout='120s'");
          await conn.query(sql);
          await conn.query('COMMIT');
        }catch(err){
          await conn.query('ROLLBACK').catch(()=>{});
          throw err;
        }
      }else{
        await conn.query(sql);
      }
      audit('sql.deployed', { target:'external', dialect:conn.dialect, success:true });
      res.json({ok:true});
    }catch(err){audit('sql.deployed', { target:'external', success:false });res.status(400).json({ok:false,error:err.message});}
    finally{if(conn){try{await conn.end();}catch(_){}}}
  });
  
  app.post('/api/external-table-status', async (req,res)=>{
    let conn;
    try{
      const dialect=externalDialect(req.body);
      const tables=Array.isArray(req.body&&req.body.tables)?req.body.tables.map(t=>externalIdentifier(t,'Table name')):[];
      if(!tables.length) return res.status(400).json({ok:false,error:'At least one table is required.'});
      if(isPackDialect(dialect)){
        const pack=getDatabasePack(dialect); const connection=packagedCredentialService.resolveConnection(req.body||{}); const ns=packNamespaceFromBody(pack,connection);
        const provisioning=pack.provisioning&&typeof pack.provisioning==='object'?pack.provisioning:null;
        let present;
        if(provisioning&&provisioning.tableStatusSql&&ns.schema){
          // Avoid a full JDBC schema introspection just to answer "do these
          // specific Vault tables exist?". Packs can provide a narrow catalog
          // query; generic Packs still fall back to JDBC metadata below.
          conn=await openExternalTarget(connection);
          const values=packProvisioningValues({database:ns.catalog,schema:ns.schema,tables});
          const result=await conn.query(renderPackProvisioningSql(provisioning.tableStatusSql,values));
          present=new Set((result.rows||[]).map(row=>String(row.table_name??row.TABLE_NAME??row.name??'').toLowerCase()).filter(Boolean));
        }else{
          const jdbcCatalog=pack.id==='mysql'?String(connection.database||ns.catalog||''):ns.catalog;
          const jdbcSchema=pack.id==='mysql'?'':ns.schema;
          const raw=await runJdbcBridge(pack,connection,'introspect',`${jdbcCatalog}\n${jdbcSchema}`);
          present=new Set((raw.tables||[]).map(t=>String(t.name).toLowerCase()));
        }
        const existing=tables.filter(t=>present.has(String(t).toLowerCase()));
        return res.json({ok:true,existing,missing:tables.filter(t=>!present.has(String(t).toLowerCase())),catalog:ns.catalog,schema:ns.schema});
      }
      const database=externalIdentifier(req.body && req.body.database,'Database name');
      conn=await openExternalTarget(req.body);
      let rows;
      if(dialect==='postgresql'){
        const schema=externalIdentifier((req.body&&req.body.schema)||'public','Schema name');
        const result=await conn.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name=ANY($2::text[])',[schema,tables]);
        rows=result.rows;
      }else{
        const marks=tables.map(()=>'?').join(',');
        const result=await conn.query(`SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${marks})`,[database,...tables]);
        rows=result.rows;
      }
      const found=new Set((rows||[]).map(r=>String(r.table_name ?? r.TABLE_NAME ?? '').toLowerCase()).filter(Boolean));
      res.json({ok:true,found:tables.filter(t=>found.has(t.toLowerCase())),missing:tables.filter(t=>!found.has(t.toLowerCase()))});
    }catch(err){res.status(400).json({ok:false,error:err.message});}
    finally{if(conn){try{await conn.end();}catch(_){}}}
  });
  parentApp.use(app);
}

module.exports = { registerExternalTargetRoutes };
