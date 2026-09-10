'use strict';

function registerDatabasePackRoutes(parentApp, dependencies){
  const {
    express,
    DATABASE_PACK_FEATURE_VERSION,
    DATABASE_PACK_SCHEMA_VERSION,
    JDBC_DRIVER_PATH,
    findPackJdbcDriver,
    listDatabasePacks,
    loadHopDatabaseTypes,
    validateDatabasePackManifest,
    writeDatabasePack,
    removeDatabasePack,
    getDatabasePack,
    runJdbcBridge,
    semanticTypeForJdbc,
    resolveJdbcTargetProfile,
    sourceHopCapabilitiesFromJdbcAnalysis,
    requestControls,
    audit,
  } = dependencies;
  const app = express.Router();

  app.get('/api/database-packs', (req,res)=>{
    try{
      const packs=listDatabasePacks().map(pack=>{
        if(pack.invalid) return pack;
        const driver=findPackJdbcDriver(pack);
        return {...pack,driverPresent:driver.exists,driverFile:driver.filename};
      });
      res.json({ok:true,featureVersion:DATABASE_PACK_FEATURE_VERSION,schemaVersion:DATABASE_PACK_SCHEMA_VERSION,packs,hopCatalog:loadHopDatabaseTypes()});
    }catch(err){res.status(400).json({ok:false,error:err.message});}
  });
  app.post('/api/database-packs', (req,res)=>{
    try{
      const input=(req.body&&req.body.pack)||req.body;
      const checked=validateDatabasePackManifest(input);
      const checkedDriver=findPackJdbcDriver(checked);
      if(req.body&&req.body.requireDriver===true&&!checkedDriver.exists){
        throw new Error(`JDBC driver ${checked.jdbc.jarfile||checked.jdbc.jarPattern||''} is not present in ${JDBC_DRIVER_PATH}. Place the driver JAR in project-root jdbc-drivers/ before adding this database type.`);
      }
      const pack=writeDatabasePack(input);
      const driver=findPackJdbcDriver(pack);
      audit('database-pack.installed', { id:pack.id, version:pack.version, driverPresent:driver.exists, success:true });
      res.json({ok:true,featureVersion:DATABASE_PACK_FEATURE_VERSION,pack:{...pack,driverPresent:driver.exists,driverFile:driver.filename}});
    }catch(err){audit('database-pack.installed', { success:false });res.status(400).json({ok:false,error:err.message});}
  });
  app.delete('/api/database-packs/:id', (req,res)=>{
    try{const pack=removeDatabasePack(req.params.id);audit('database-pack.deleted', { id:pack.id, version:pack.version, success:true });res.json({ok:true,removed:{id:pack.id,label:pack.label,version:pack.version}});}
    catch(err){audit('database-pack.deleted', { id:req.params.id, success:false });res.status(400).json({ok:false,error:err.message});}
  });
  app.post('/api/database-packs/analyze', requestControls.guard('introspection'), async (req,res)=>{
    try{
      const body=req.body||{};
      const pack=body.pack ? validateDatabasePackManifest(body.pack) : getDatabasePack(body.dialect||body.id);
      const connection=body.connection&&typeof body.connection==='object'?body.connection:body;
      const analysis=await runJdbcBridge(pack,connection,'analyze','');
      const discoveredTypes=(analysis.types||[]).map(t=>({...t,semanticType:semanticTypeForJdbc(pack,t)}));
      const enriched={...analysis,types:discoveredTypes};
      const targetProfile=resolveJdbcTargetProfile(pack,enriched);
      const sourceCapabilities=sourceHopCapabilitiesFromJdbcAnalysis(pack,enriched);
      res.json({ok:true,pack:{id:pack.id,label:pack.label,version:pack.version},analysis:enriched,sourceCapabilities,targetProfile});
    }catch(err){res.status(400).json({ok:false,error:err.message});}
  });
  app.post('/api/database-packs/test-target', requestControls.guard('connection-test'), async (req,res)=>{
    try{
      const body=req.body||{}; const pack=getDatabasePack(body.dialect||body.id);
      // JDBC metadata discovery opens and validates the connection itself, so a
      // separate SELECT 1 only adds another JVM/driver/TLS startup.
      const analysis=await runJdbcBridge(pack,body,'analyze','');
      const discoveredTypes=(analysis.types||[]).map(t=>({...t,semanticType:semanticTypeForJdbc(pack,t)}));
      const enriched={...analysis,types:discoveredTypes};
      res.json({ok:true,pack:{id:pack.id,label:pack.label,version:pack.version},fdw:pack.fdw,target:pack.target,targetProfile:resolveJdbcTargetProfile(pack,enriched)});
    }catch(err){res.status(400).json({ok:false,error:err.message});}
  });
  parentApp.use(app);
}

module.exports = { registerDatabasePackRoutes };
