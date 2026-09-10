'use strict';

// Audit events deliberately accept metadata rather than request bodies. This
// keeps operational visibility separate from diagnostics, which may contain
// credentials or SQL text.
const SENSITIVE_KEY = /(?:pass(?:word|wd|phrase)?|secret|token|authorization|credential|api[-_]?key|connection|string|jdbc|url|sql|query|statement)/i;
const CONNECTION_STRING = /(?:\w+:\/\/[^\s]+@|\bjdbc:|\b(?:password|pwd)\s*=)/i;

function safeValue(value){
  if (value === undefined || typeof value === 'function') return undefined;
  if (typeof value === 'string') return CONNECTION_STRING.test(value) ? undefined : value;
  if (Array.isArray(value)) return value.map(safeValue).filter(entry => entry !== undefined);
  return value && typeof value === 'object' ? safeMetadata(value) : value;
}

function safeMetadata(value){
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).reduce((result, [key, entry]) => {
    if (SENSITIVE_KEY.test(key)) return result;
    const safeEntry = safeValue(entry);
    if (safeEntry !== undefined) result[key] = safeEntry;
    return result;
  }, {});
}

function requestMetadata(req){
  return safeMetadata({
    method:req && req.method,
    path:req && (req.originalUrl || req.path),
    remoteAddress:req && req.socket && req.socket.remoteAddress,
  });
}

function createAuditLogger(options = {}){
  const write = options.write || (event => console.info(JSON.stringify(event)));
  function audit(event, metadata = {}){
    const record = {
      timestamp:new Date().toISOString(),
      category:'security-audit',
      event:String(event),
      ...safeMetadata(metadata),
    };
    write(record);
    return record;
  }
  return { audit, requestMetadata };
}

module.exports = { createAuditLogger, safeMetadata, requestMetadata };
