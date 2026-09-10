'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_CERTS_REFERENCE_PREFIX = 'dv-certs/';
const HOP_CERTS_ROOT = '/app/dv-certs';

// Project-file references are intentionally narrow. Studio never accepts a
// browser-supplied absolute path for this feature; users place files beneath
// <project-root>/dv-certs and reference them as dv-certs/<relative-name>.
// The reference may be the whole JDBC property value or appear inside a JDBC
// URL/property string (for example file:dv-certs/client.p12).
const REFERENCE_BOUNDARY = new Set(['=', ';', '?', '&', ':', ',', '(', ' ', '\t', '\r', '\n', '"', "'"]);
const REFERENCE_TERMINATOR = new Set(['&', ';', '?', '#', ',', '"', "'", '<', '>', ')', '}', ']', '\r', '\n', '\t']);
const SAFE_RELATIVE_REFERENCE = /^[A-Za-z0-9._/-]+$/;
const MANAGED_REFERENCE_MASK = '__DVS_MANAGED_JDBC_FILE__';

// JDBC URLs can legitimately identify file-backed databases (for example
// SQLite/H2). Do not block the database URL itself. The restriction here is on
// user-supplied local file references used as JDBC option/property values. A
// local certificate/key/keystore/wallet reference must use dv-certs/... so the
// same project value can be resolved safely for Studio and for containers.
const FILE_URI_RE = /(^|[=;&?,(:\s"'])file:/i;
const WINDOWS_ABSOLUTE_RE = /(^|[=;&?,(\s"'])(?:[A-Za-z]:[\\/]|\\\\)/;
const POSIX_ABSOLUTE_RE = /(^|[=;&?,(\s"'])\/(?!\/)/;
const RELATIVE_ESCAPE_RE = /(^|[=;&?,(\s"'])(?:~[\\/]|\.{1,2}[\\/])/;

function validateRelativeCertificateReference(relative){
  const value=String(relative||'');
  if(!value || !SAFE_RELATIVE_REFERENCE.test(value)){
    throw new Error('Project certificate references must use a simple relative path beneath dv-certs/.');
  }
  const parts=value.split('/');
  if(parts.some(part=>!part || part==='.' || part==='..')){
    throw new Error('Project certificate references cannot contain empty, current-directory, or parent-directory path segments.');
  }
  return parts;
}

function certificateReferencesIn(value){
  const text=String(value==null?'':value);
  const refs=[];
  let offset=0;
  while(true){
    const index=text.indexOf(PROJECT_CERTS_REFERENCE_PREFIX,offset);
    if(index<0) break;
    const previous=index===0?'':text[index-1];
    if(index>0 && !REFERENCE_BOUNDARY.has(previous)){
      throw new Error('Project certificate references must start with dv-certs/ as a standalone JDBC value or option value.');
    }
    let end=index+PROJECT_CERTS_REFERENCE_PREFIX.length;
    while(end<text.length && !REFERENCE_TERMINATOR.has(text[end])) end+=1;
    const relative=text.slice(index+PROJECT_CERTS_REFERENCE_PREFIX.length,end);
    validateRelativeCertificateReference(relative);
    refs.push({start:index,end,relative});
    offset=end;
  }
  return {text,refs};
}

function assertNoSymlinkTraversal(root, parts){
  if(fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()){
    throw new Error('The project dv-certs directory cannot be a symbolic link.');
  }
  let current=root;
  for(const part of parts){
    current=path.join(current,part);
    if(!fs.existsSync(current)) break;
    if(fs.lstatSync(current).isSymbolicLink()){
      throw new Error('Project certificate references cannot traverse symbolic links.');
    }
  }
}

function replaceCertificateReferences(value, replacementFor){
  const {text,refs}=certificateReferencesIn(value);
  if(!refs.length) return text;
  let output='';
  let cursor=0;
  for(const ref of refs){
    output+=text.slice(cursor,ref.start);
    output+=replacementFor(ref.relative);
    cursor=ref.end;
  }
  output+=text.slice(cursor);
  return output;
}

function jdbcPropertyText(value){
  const text=String(value==null?'':value);
  if(!/^jdbc:/i.test(text)) return text;

  // For a full JDBC URL, inspect only property-bearing portions. This preserves
  // legitimate file-backed database URLs such as jdbc:sqlite:/path/db.sqlite,
  // while still blocking ?cert=/host/path and ;trustStore=C:\\host\\path.
  const propertyParts=[];
  const queryIndex=text.indexOf('?');
  if(queryIndex>=0) propertyParts.push(text.slice(queryIndex+1));
  for(const part of text.split(';').slice(1)){
    if(part.includes('=')) propertyParts.push(part);
  }
  return propertyParts.join('&');
}

function assertManagedJdbcLocalFileReferences(value){
  // First parse/mask valid dv-certs references. This both validates traversal
  // syntax and prevents their deliberate file:dv-certs/... form from matching
  // the generic local-file checks below.
  let inspect=replaceCertificateReferences(value,()=>MANAGED_REFERENCE_MASK);
  inspect=inspect.replace(new RegExp(`file:${MANAGED_REFERENCE_MASK}`,'gi'),MANAGED_REFERENCE_MASK);
  inspect=jdbcPropertyText(inspect);

  if(FILE_URI_RE.test(inspect) || WINDOWS_ABSOLUTE_RE.test(inspect) || POSIX_ABSOLUTE_RE.test(inspect) || RELATIVE_ESCAPE_RE.test(inspect)){
    throw new Error('Local JDBC file references must use the project dv-certs/ directory.');
  }
  return String(value==null?'':value);
}

function resolveHostCertificateReferences(value, projectRoot){
  assertManagedJdbcLocalFileReferences(value);
  const root=path.resolve(projectRoot,'dv-certs');
  return replaceCertificateReferences(value,relative=>{
    const parts=validateRelativeCertificateReference(relative);
    const resolved=path.resolve(root,...parts);
    const rel=path.relative(root,resolved);
    if(!rel || rel.startsWith('..'+path.sep) || path.isAbsolute(rel)){
      throw new Error('Project certificate reference must resolve to a file beneath dv-certs/.');
    }
    assertNoSymlinkTraversal(root,parts);
    // Deliberately do not check file existence or certificate validity here.
    // The JDBC driver owns those checks and returns its normal connection error.
    return resolved;
  });
}

function resolveContainerCertificateReferences(value, containerRoot=HOP_CERTS_ROOT){
  assertManagedJdbcLocalFileReferences(value);
  const root=String(containerRoot||HOP_CERTS_ROOT).replace(/\/+$/,'');
  return replaceCertificateReferences(value,relative=>`${root}/${relative}`);
}

module.exports = {
  PROJECT_CERTS_REFERENCE_PREFIX,
  HOP_CERTS_ROOT,
  validateRelativeCertificateReference,
  certificateReferencesIn,
  assertManagedJdbcLocalFileReferences,
  resolveHostCertificateReferences,
  resolveContainerCertificateReferences,
};
