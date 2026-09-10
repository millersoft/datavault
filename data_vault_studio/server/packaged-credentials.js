'use strict';

const fs = require('node:fs');

const REFERENCES = Object.freeze({
  MYSQL_SOURCE: 'packaged-mysql-source',
  INTERNAL_POSTGRES: 'internal-postgres-target',
  EXTERNAL_POSTGRES: 'external-postgres-target',
  DEMO_FDW_MYSQL: 'demo-fdw-physical-mysql',
});

function decodeSingleQuoted(value){
  let out='';
  for(let i=0;i<value.length;i++){
    if(value[i]==='\\' && i+1<value.length && (value[i+1]==='\\' || value[i+1]==="'")) out+=value[++i];
    else out+=value[i];
  }
  return out;
}

function readResolvedEnv(envPath){
  const entries={};
  fs.readFileSync(envPath,'utf8').split(/\r?\n/).forEach(line=>{
    if(/^\s*#/.test(line)||!line.trim())return;
    const match=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if(!match)return;
    let raw=match[2],literal=false;
    if(raw.length>=2&&raw.startsWith("'")&&raw.endsWith("'")){raw=decodeSingleQuoted(raw.slice(1,-1));literal=true;}
    else if(raw.length>=2&&raw.startsWith('"')&&raw.endsWith('"')) raw=raw.slice(1,-1).replace(/\\n/g,'\n').replace(/\\r/g,'\r').replace(/\\t/g,'\t').replace(/\\"/g,'"').replace(/\\\\/g,'\\');
    else raw=raw.replace(/\s+#.*$/,'').trim();
    entries[match[1]]={value:raw,literal};
  });
  const memo={};
  function resolve(key,stack=new Set()){
    if(Object.prototype.hasOwnProperty.call(memo,key))return memo[key];
    const entry=entries[key];
    if(!entry)return '';
    if(entry.literal)return (memo[key]=entry.value);
    if(stack.has(key))return entry.value;
    const next=new Set(stack);next.add(key);
    return (memo[key]=entry.value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(_,name)=>resolve(name,next)));
  }
  const result={};Object.keys(entries).forEach(key=>{result[key]=resolve(key);});
  return result;
}

function createPackagedCredentialService({ envFilePath, hopEnvironmentPath }){
  function env(){
    try{return readResolvedEnv(envFilePath);}catch(_){return null;}
  }
  function configured(value){return typeof value==='string'&&value.length>0&&!/^<[^>]+>$/.test(value);}
  function externalPostgresTarget(){
    if(!hopEnvironmentPath)throw new Error('External PostgreSQL runtime configuration is unavailable.');
    let document;
    try{document=JSON.parse(fs.readFileSync(hopEnvironmentPath,'utf8'));}
    catch(_){throw new Error('External PostgreSQL runtime configuration has not been deployed.');}
    const variables=Object.fromEntries((Array.isArray(document.variables)?document.variables:[]).map(item=>[String(item?.name||''),String(item?.value||'')]));
    const target={
      host:variables.pdi_meta_host_name||'',
      port:variables.pdi_meta_port_number||'5432',
      database:variables.pdi_meta_database_name||'',
    };
    if(!configured(target.host)||!configured(target.database)||target.host==='postgres')throw new Error('External PostgreSQL runtime configuration has not been deployed.');
    for(const prefix of ['data_vault','stg']){
      if(variables[`${prefix}_host_name`]!==target.host||variables[`${prefix}_port_number`]!==target.port||variables[`${prefix}_database_name`]!==target.database){
        throw new Error('External PostgreSQL runtime target settings are inconsistent.');
      }
    }
    return target;
  }
  function publicDefaults(){
    const values=env();
    if(!values)return {found:false};
    const sourcePassword=values.MYSQL_PASSWORD||values.SOURCE_PASSWORD||'';
    const targetPassword=values.DB_PASSWORD||values.VAULT_PASSWORD||'';
    return {found:true,
      mysql:{user:values.MYSQL_USER||'',passwordConfigured:configured(sourcePassword)},
      target:{user:values.DB_USER||'',passwordConfigured:configured(targetPassword)},
      bootstrap:{user:values.POSTGRES_BOOTSTRAP_USER||'',passwordConfigured:configured(values.POSTGRES_BOOTSTRAP_PASSWORD||'')},
      vault:{passwordConfigured:configured(values.VAULT_PASSWORD||'')},
    };
  }
  function rejectConflicts(body){
    if(Object.prototype.hasOwnProperty.call(body,'password')||Object.prototype.hasOwnProperty.call(body,'user')) throw new Error('Packaged credential references cannot be combined with user or password fields.');
  }
  function assertFixed(body,{hosts,port,dialect}){
    if(body.host!==undefined&&!hosts.includes(String(body.host).toLowerCase()))throw new Error('Packaged credential reference cannot be used with that host.');
    if(body.port!==undefined&&String(body.port)!==String(port))throw new Error('Packaged credential reference cannot be used with that port.');
    if(body.dialect!==undefined&&String(body.dialect).toLowerCase()!==dialect)throw new Error('Packaged credential reference cannot be used with that dialect.');
  }
  function resolveConnection(body={}){
    const reference=String(body.credentialRef||'');
    if(!reference)return {...body};
    rejectConflicts(body);
    const {credentialRef:_credentialRef,...base}=body;
    const values=env();
    if(!values)throw new Error('Packaged database credentials are not configured.');
    if(reference===REFERENCES.INTERNAL_POSTGRES){
      assertFixed(body,{hosts:['localhost','127.0.0.1','::1'],port:'5433',dialect:'postgresql'});
      const database=String(body.database||'').trim();
      if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database))throw new Error('Internal PostgreSQL database must be a plain identifier.');
      const user=values.DB_USER||'';const password=values.DB_PASSWORD||values.VAULT_PASSWORD||'';
      if(!configured(user)||!configured(password))throw new Error('Internal PostgreSQL credentials are not configured.');
      return {...base,dialect:'postgresql',host:'localhost',port:'5433',database,user,password};
    }
    if(reference===REFERENCES.EXTERNAL_POSTGRES){
      if(body.dialect!==undefined&&String(body.dialect).toLowerCase()!=='postgresql')throw new Error('External PostgreSQL credential reference cannot be used with that dialect.');
      const target=externalPostgresTarget();
      for(const key of ['host','port','database']){
        if(String(body[key]||'')!==target[key])throw new Error(`External PostgreSQL credential reference does not match the deployed ${key}.`);
      }
      const user=values.POSTGRES_BOOTSTRAP_USER||'';const password=values.POSTGRES_BOOTSTRAP_PASSWORD||'';
      if(!configured(user)||!configured(password))throw new Error('External PostgreSQL credentials are not configured.');
      return {...base,...target,dialect:'postgresql',user,password};
    }
    if(reference===REFERENCES.MYSQL_SOURCE){
      assertFixed(body,{hosts:['localhost','127.0.0.1','::1'],port:'3306',dialect:'mysql'});
      if(body.database!==undefined&&String(body.database)!=='sakila')throw new Error('Packaged MySQL source is restricted to the sakila database.');
      const user=values.MYSQL_USER||'';const password=values.MYSQL_PASSWORD||values.SOURCE_PASSWORD||'';
      if(!configured(user)||!configured(password))throw new Error('Packaged MySQL credentials are not configured.');
      return {...base,dialect:'mysql',host:'localhost',port:'3306',database:'sakila',user,password};
    }
    if(reference===REFERENCES.DEMO_FDW_MYSQL){
      assertFixed(body,{hosts:['localhost','127.0.0.1','::1'],port:'3306',dialect:'mysql'});
      if(body.database!==undefined&&body.database!==''&&String(body.database)!=='datavault')throw new Error('Demo FDW MySQL is restricted to the datavault database.');
      const user=values.MYSQL_USER||'';const password=values.MYSQL_PASSWORD||values.SOURCE_PASSWORD||'';
      if(!configured(user)||!configured(password))throw new Error('Packaged MySQL credentials are not configured.');
      return {...base,dialect:'mysql',host:'localhost',port:'3306',database:body.database||undefined,user,password};
    }
    throw new Error('Unknown packaged credential reference.');
  }
  function resolveSecret(reference){
    const connection=resolveConnection({credentialRef:reference,database:reference===REFERENCES.INTERNAL_POSTGRES?'postgres':reference===REFERENCES.MYSQL_SOURCE?'sakila':'datavault'});
    return {user:connection.user,password:connection.password};
  }
  function resolveRedactionValues(reference){
    const values=env();
    if(!values) return {};
    if(reference===REFERENCES.INTERNAL_POSTGRES)return {user:values.DB_USER||'',password:values.DB_PASSWORD||values.VAULT_PASSWORD||''};
    if(reference===REFERENCES.EXTERNAL_POSTGRES)return {user:values.POSTGRES_BOOTSTRAP_USER||'',password:values.POSTGRES_BOOTSTRAP_PASSWORD||''};
    if(reference===REFERENCES.MYSQL_SOURCE||reference===REFERENCES.DEMO_FDW_MYSQL)return {user:values.MYSQL_USER||'',password:values.MYSQL_PASSWORD||values.SOURCE_PASSWORD||''};
    return {};
  }
  return {REFERENCES,readEnv:env,publicDefaults,resolveConnection,resolveSecret,resolveRedactionValues};
}

module.exports={REFERENCES,readResolvedEnv,createPackagedCredentialService};
