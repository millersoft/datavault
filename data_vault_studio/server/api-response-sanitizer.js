'use strict';

const SENSITIVE_KEY = /(?:password|passwd|pwd|passphrase|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|connection[-_]?string|jdbc[-_]?url|url|host|hostname|server|user|username|sql|query|statement)$/i;
const SECRET_KEY = /(?:password|passwd|pwd|passphrase|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)$/i;
const CREDENTIAL_REF_KEY = /credentialRef$/i;
const DIAGNOSTIC_KEY = /(?:error|message|detail|hint|where|stdout|stderr|logs|raw|diagnostic|statement)$/i;

function addSensitiveValue(values, value, minimumLength=3){
  if (typeof value !== 'string') return;
  const text=value.trim();
  if (text.length >= minimumLength && text !== '[redacted]') values.add(text);
}

function collectRequestSensitiveValues(value, values=new Set(), seen=new Set(), connectionValues=false){
  if (!value || typeof value !== 'object' || seen.has(value)) return values;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)){
    const nestedConnectionValues=connectionValues||key==='packValues'||key==='options';
    if (SENSITIVE_KEY.test(key)||nestedConnectionValues) addSensitiveValue(values,entry,(SECRET_KEY.test(key)||nestedConnectionValues)?1:3);
    if (entry && typeof entry === 'object') collectRequestSensitiveValues(entry,values,seen,nestedConnectionValues);
  }
  return values;
}

function collectCredentialRefs(value, refs=new Set(), seen=new Set()){
  if (!value || typeof value !== 'object' || seen.has(value)) return refs;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)){
    if (CREDENTIAL_REF_KEY.test(key) && typeof entry === 'string' && entry) refs.add(entry);
    if (entry && typeof entry === 'object') collectCredentialRefs(entry,refs,seen);
  }
  return refs;
}

function collectResolvedCredentialValues(body, resolveCredential){
  const values=new Set();
  if (typeof resolveCredential !== 'function') return values;
  for (const ref of collectCredentialRefs(body)){
    try{
      const credential=resolveCredential(ref);
      if (!credential || typeof credential !== 'object') continue;
      for (const [key,value] of Object.entries(credential)) addSensitiveValue(values,value,SECRET_KEY.test(key)?1:3);
    }catch(_){ /* Invalid references are handled by their owning route. */ }
  }
  return values;
}

function escapeRegExp(value){
  return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function replaceAllLiteral(text, value, replacement){
  if (!value) return text;
  if (value.length >= 3) return text.split(value).join(replacement);
  const pattern=new RegExp(`(^|[\\s'"=:;,()\\[\\]{}])${escapeRegExp(value)}(?=$|[\\s'"=:;,()\\[\\]{}])`,'g');
  return text.replace(pattern,match=>match.slice(0,match.length-value.length)+replacement);
}

function sanitizeDiagnosticText(value, sensitiveValues=[]){
  let text=String(value == null ? '' : value);
  const ordered=[...new Set(sensitiveValues)].filter(v=>typeof v==='string'&&v.length>=1).sort((a,b)=>b.length-a.length);
  for (const secret of ordered) text=replaceAllLiteral(text,secret,'[redacted]');

  // Remove complete connection URLs before applying individual property rules.
  text=text
    .replace(/\bjdbc:[^\s"'<>]+/gi,'[redacted connection string]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mariadb|sqlserver|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,'[redacted connection string]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s"'<>]+/gi,'[redacted connection string]')
    .replace(/\b(?:server|host|data source)\s*=\s*[^\r\n;]+(?:\s*;\s*[^\r\n;=]+\s*=\s*[^\r\n;]*)+/gi,'[redacted connection string]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[redacted host]')
    .replace(/\[[0-9a-f:%.]+\]/gi,'[redacted host]')
    .replace(/\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{1,39}\b/gi,'[redacted host]');

  // Cover common driver/config and SQL credential formats even when the secret
  // was generated server-side and was not available in the request body.
  text=text
    .replace(/((?:["']?\b(?:password|passwd|pwd|passphrase|secret|token|api[-_ ]?key)["']?)\s*(?:=|:)\s*)(?:'[^']*'|"[^"]*"|[^\s,;)}\]]+)/gi,'$1[redacted]')
    .replace(/(\b[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN)\b\s*=\s*)(?:'[^']*'|"[^"]*"|[^\s,;)}\]]+)/g,'$1[redacted]')
    .replace(/(\bpassword\b\s+)(?:'[^']*'|"[^"]*")/gi,'$1[redacted]')
    .replace(/(\bidentified\s+by\s+)(?:'[^']*'|"[^"]*"|[^\s,;)}\]]+)/gi,'$1[redacted]');

  // Known project roots are replaced above. These final patterns prevent raw
  // platform paths from escaping through lower-level filesystem/JDBC errors.
  return text
    .replace(/(^|[\s(])\/[^\s:'",;)\]}]+/g,'$1[redacted path]')
    .replace(/\b[A-Za-z]:\\(?:[^\r\n<>:"|?*]+\\)*[^\r\n<>:"|?*]*/g,'[redacted path]')
    .replace(/\\\\[^\s\\]+\\[^\r\n<>:"|?*]+/g,'[redacted path]');
}

function payloadHasFailure(value, seen=new Set()){
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (value.ok === false) return true;
  return Object.values(value).some(entry=>payloadHasFailure(entry,seen));
}

function isPlainObject(value){
  if (!value || typeof value !== 'object') return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function sanitizePayload(value, sensitiveValues, seen=new Map()){
  if (typeof value === 'string') return sanitizeDiagnosticText(value,sensitiveValues);
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && !isPlainObject(value))) return value;
  if (seen.has(value)) return seen.get(value);
  const output=Array.isArray(value)?[]:{};
  seen.set(value,output);
  for (const [key,entry] of Object.entries(value)) output[key]=sanitizePayload(entry,sensitiveValues,seen);
  return output;
}

function sanitizeDiagnosticFields(value, sensitiveValues, key='', seen=new Map(), inheritedDiagnostic=false){
  const isDiagnostic=inheritedDiagnostic||DIAGNOSTIC_KEY.test(key);
  if (typeof value === 'string') return isDiagnostic?sanitizeDiagnosticText(value,sensitiveValues):value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && !isPlainObject(value))) return value;
  if (seen.has(value)) return seen.get(value);
  if (value.ok === false) return sanitizePayload(value,sensitiveValues);
  const output=Array.isArray(value)?[]:{};
  seen.set(value,output);
  for (const [childKey,entry] of Object.entries(value)) output[childKey]=sanitizeDiagnosticFields(entry,sensitiveValues,childKey,seen,isDiagnostic);
  return output;
}

function createApiResponseSanitizer(options={}){
  const configuredValues=(options.sensitiveValues||[]).filter(value=>typeof value==='string'&&value);
  return function sanitizeApiResponse(req,res,next){
    const originalJson=res.json.bind(res);
    res.json=function jsonWithSanitizedDiagnostics(payload){
      const values=collectRequestSensitiveValues(req.body);
      for (const value of configuredValues) addSensitiveValue(values,value);
      for (const value of collectResolvedCredentialValues(req.body,options.resolveCredential)) values.add(value);
      const sanitized=res.statusCode >= 400 || payloadHasFailure(payload)
        ? sanitizePayload(payload,values)
        : sanitizeDiagnosticFields(payload,values);
      return originalJson(sanitized);
    };
    next();
  };
}

module.exports={
  collectRequestSensitiveValues,
  sanitizeDiagnosticText,
  sanitizePayload,
  sanitizeDiagnosticFields,
  payloadHasFailure,
  createApiResponseSanitizer,
};
