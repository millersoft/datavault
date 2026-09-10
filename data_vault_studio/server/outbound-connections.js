'use strict';

const dns = require('node:dns');
const net = require('node:net');

const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function validatePort(value, fallback){
  const candidate=(value===undefined||value===null||value==='')?fallback:value;
  const text=typeof candidate==='number'?String(candidate):String(candidate||'');
  if(!/^\d{1,5}$/.test(text)) throw new Error('Database port must be an integer from 1 to 65535.');
  const port=Number(text);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Database port must be an integer from 1 to 65535.');
  return port;
}

function normalizeHost(value){
  const raw=String(value==null?'':value);
  const host=raw.trim();
  if(!host) throw new Error('Database host is required.');
  if(host!==raw||/[\u0000-\u001f\u007f]/.test(host)) throw new Error('Database host is malformed.');
  const unbracketed=host.startsWith('[')&&host.endsWith(']')?host.slice(1,-1):host;
  if(net.isIP(unbracketed)) return unbracketed;
  if(host.includes(':')||/[\s/@?#;\\]/.test(host)||host.length>253) throw new Error('Database host is malformed.');
  const dnsName=host.endsWith('.')?host.slice(0,-1):host;
  if(!dnsName||dnsName.split('.').some(label=>!HOSTNAME_LABEL.test(label))) throw new Error('Database host is malformed.');
  return dnsName;
}

function ipv4Number(address){
  const parts=String(address).split('.').map(Number);
  if(parts.length!==4||parts.some(part=>!Number.isInteger(part)||part<0||part>255)) return null;
  return (((parts[0]<<24)>>>0)+(parts[1]<<16)+(parts[2]<<8)+parts[3])>>>0;
}
function ipv4In(address,base,bits){
  const value=ipv4Number(address), network=ipv4Number(base);
  if(value===null||network===null)return false;
  const mask=bits===0?0:(0xffffffff<<(32-bits))>>>0;
  return (value&mask)===(network&mask);
}
function addressKind(address){
  let value=String(address||'').toLowerCase().split('%')[0];
  if(net.isIP(value)===6){
    try{value=new URL(`http://[${value}]/`).hostname.slice(1,-1).toLowerCase();}catch(_){}
  }
  const mapped=value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if(mapped)value=mapped[1];
  if(net.isIP(value)===4){
    if(ipv4In(value,'127.0.0.0',8))return 'loopback';
    if(value==='100.100.100.200'||value==='168.63.129.16')return 'metadata';
    if(ipv4In(value,'169.254.0.0',16))return 'link-local';
    if(ipv4In(value,'10.0.0.0',8)||ipv4In(value,'172.16.0.0',12)||ipv4In(value,'192.168.0.0',16))return 'private';
    return 'public';
  }
  if(net.isIP(value)===6){
    if(value==='::1')return 'loopback';
    if(/^::ffff:a9fe:/.test(value))return 'link-local';
    if(/^fe[89ab][0-9a-f]:/.test(value))return 'link-local';
    if(/^(?:fc|fd)[0-9a-f]{2}:/.test(value))return value==='fd00:ec2::254'?'metadata':'private';
    return 'public';
  }
  return 'unknown';
}

function createOutboundConnectionPolicy(options={}){
  const lookup=options.lookup||dns.promises.lookup.bind(dns.promises);
  async function inspectHost(hostValue){
    const host=normalizeHost(hostValue);
    const answers=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await lookup(host,{all:true,verbatim:true});
    if(!Array.isArray(answers)||!answers.length) throw new Error('Database host did not resolve to an address.');
    const kinds=[...new Set(answers.map(answer=>addressKind(answer.address)))];
    if(kinds.includes('link-local')||kinds.includes('metadata')) throw new Error('Connections to link-local and cloud metadata addresses are not allowed.');
    const addresses=answers.map(answer=>answer.address);
    const pinnedLookup=(_hostname,lookupOptions,callback)=>{
      if(typeof lookupOptions==='function'){callback=lookupOptions;lookupOptions={};}
      const family=typeof lookupOptions==='number'?lookupOptions:Number(lookupOptions&&lookupOptions.family||0);
      const eligible=family?answers.filter(answer=>Number(answer.family)===family):answers;
      if(!eligible.length)return callback(Object.assign(new Error('Database host has no validated address for the requested family.'),{code:'ENOTFOUND'}));
      if(lookupOptions&&lookupOptions.all)return callback(null,eligible.map(answer=>({address:answer.address,family:Number(answer.family)})));
      callback(null,eligible[0].address,Number(eligible[0].family));
    };
    return {host,addresses,kinds,lookup:pinnedLookup};
  }
  async function validateNetworkDestination({host,port,defaultPort}){
    const normalizedPort=validatePort(port,defaultPort);
    const inspected=await inspectHost(host);
    return {...inspected,port:normalizedPort};
  }
  return {inspectHost,validateNetworkDestination};
}

function jdbcTemplateDestination(template,url){
  const tokens=[];
  let pattern='^',cursor=0;
  for(const match of String(template||'').matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)){
    pattern+=String(template).slice(cursor,match.index).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    tokens.push(match[1]);
    pattern+=match[1]==='host'?'([^\\s/:;?]+|\\[[0-9A-Fa-f:.]+\\])':match[1]==='port'?'(\\d{1,5})':'(.+?)';
    cursor=match.index+match[0].length;
  }
  pattern+=String(template||'').slice(cursor).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';
  const found=String(url||'').match(new RegExp(pattern));
  if(!found)return null;
  const values={}; tokens.forEach((token,index)=>{if(values[token]===undefined)values[token]=found[index+1];});
  return values.host?{host:values.host,port:values.port}:null;
}
function jdbcAuthorityDestination(url){
  const match=String(url||'').match(/^jdbc:[A-Za-z0-9+._-]+(?::[A-Za-z0-9+._-]+)*:\/\/([^/;?\s]+)/i);
  if(!match)return null;
  const authority=match[1];
  if(authority.includes('@'))throw new Error('JDBC URLs must not contain embedded credentials.');
  if(authority.startsWith('[')){
    const ipv6=authority.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if(!ipv6)throw new Error('JDBC URL contains a malformed destination.');
    return {host:ipv6[1],port:ipv6[2]};
  }
  const parts=authority.split(':');
  if(parts.length>2)throw new Error('JDBC URL contains a malformed destination.');
  return {host:parts[0],port:parts[1]};
}
function effectiveJdbcDestination(pack,body,url){
  if(/^jdbc:(?:sqlite|duckdb|ucanaccess):/i.test(String(url||'')))return null;
  const authority=jdbcAuthorityDestination(url);
  if(authority)return authority;
  const templated=jdbcTemplateDestination(pack&&pack.jdbc&&pack.jdbc.urlTemplate,url);
  if(templated)return templated;
  const template=String(pack&&pack.jdbc&&pack.jdbc.urlTemplate||'');
  if(/\{host\}/.test(template)) throw new Error('JDBC URL destination could not be validated for this Database Pack.');
  return null;
}
function structuredJdbcDestination(pack,body){
  if(body&&(body.manualUrl||body.jdbcUrl))return null;
  const template=String(pack&&pack.jdbc&&pack.jdbc.urlTemplate||'');
  if(!/\{host\}/.test(template))return null;
  const fields=Array.isArray(pack&&pack.connectionFields)?pack.connectionFields:[];
  const hostField=fields.find(field=>field.mapsTo==='host'||field.key==='host');
  if(!hostField)return null;
  const incoming=body&&body.packValues&&typeof body.packValues==='object'?body.packValues:{};
  const portField=fields.find(field=>field.mapsTo==='port'||field.key==='port');
  const mappedHost=incoming[hostField.key]!==undefined?incoming[hostField.key]:(body&&body.host);
  const mappedPort=portField&&(incoming[portField.key]!==undefined?incoming[portField.key]:(body&&body.port));
  return {host:mappedHost!==undefined?mappedHost:hostField.default,port:portField?(mappedPort!==undefined?mappedPort:portField.default):undefined};
}

module.exports={validatePort,normalizeHost,addressKind,createOutboundConnectionPolicy,effectiveJdbcDestination,structuredJdbcDestination};
