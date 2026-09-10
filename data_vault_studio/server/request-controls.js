'use strict';

const crypto = require('node:crypto');

function positiveInteger(value, fallback, name){
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function bodyLimit(value, fallback, name){
  const text = String(value == null || value === '' ? fallback : value).trim();
  if (!/^\d+(?:b|kb|mb)$/i.test(text)) throw new Error(`${name} must be a byte size such as 256kb or 10mb.`);
  return text.toLowerCase();
}

function stableValue(value){
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object'){
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stableValue(value[key]);
      return out;
    }, {});
  }
  return value;
}

function requestFingerprint(value){
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value || {}))).digest('base64url');
}

function createRequestControls(options = {}){
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const config = {
    rateLimitRequests: positiveInteger(env.DVS_API_RATE_LIMIT_REQUESTS, 120, 'DVS_API_RATE_LIMIT_REQUESTS'),
    rateLimitWindowMs: positiveInteger(env.DVS_API_RATE_LIMIT_WINDOW_MS, 60000, 'DVS_API_RATE_LIMIT_WINDOW_MS'),
    connectionTestConcurrency: positiveInteger(env.DVS_CONNECTION_TEST_CONCURRENCY, 3, 'DVS_CONNECTION_TEST_CONCURRENCY'),
    introspectionConcurrency: positiveInteger(env.DVS_INTROSPECTION_CONCURRENCY, 2, 'DVS_INTROSPECTION_CONCURRENCY'),
    driverDownloadConcurrency: positiveInteger(env.DVS_DRIVER_DOWNLOAD_CONCURRENCY, 2, 'DVS_DRIVER_DOWNLOAD_CONCURRENCY'),
    maxJdbcDriverBytes: positiveInteger(env.DVS_MAX_JDBC_DRIVER_BYTES, 100 * 1024 * 1024, 'DVS_MAX_JDBC_DRIVER_BYTES'),
    jdbcDownloadTimeoutMs: positiveInteger(env.DVS_JDBC_DOWNLOAD_TIMEOUT_MS, 120000, 'DVS_JDBC_DOWNLOAD_TIMEOUT_MS'),
    defaultBodyLimit: bodyLimit(env.DVS_API_BODY_LIMIT, '1mb', 'DVS_API_BODY_LIMIT'),
    deployBodyLimit: bodyLimit(env.DVS_DEPLOY_BODY_LIMIT, '25mb', 'DVS_DEPLOY_BODY_LIMIT'),
    workbookBodyLimit: bodyLimit(env.DVS_WORKBOOK_BODY_LIMIT, '25mb', 'DVS_WORKBOOK_BODY_LIMIT'),
  };

  const groups = new Map([
    ['container-build', { limit:1, active:new Set() }],
    ['etl-transition', { limit:1, active:new Set() }],
    ['connection-test', { limit:config.connectionTestConcurrency, active:new Set() }],
    ['introspection', { limit:config.introspectionConcurrency, active:new Set() }],
    ['driver-download', { limit:config.driverDownloadConcurrency, active:new Set() }],
  ]);
  let rateWindowStartedAt = now();
  let rateWindowCount = 0;

  function retryAfterSeconds(ms){ return Math.max(1, Math.ceil(ms / 1000)); }

  function rateLimit(req, res, next){
    const current = now();
    if (current - rateWindowStartedAt >= config.rateLimitWindowMs){
      rateWindowStartedAt = current;
      rateWindowCount = 0;
    }
    rateWindowCount++;
    const remaining = Math.max(0, config.rateLimitRequests - rateWindowCount);
    const resetMs = Math.max(1, config.rateLimitWindowMs - (current - rateWindowStartedAt));
    res.set('X-RateLimit-Limit', String(config.rateLimitRequests));
    res.set('X-RateLimit-Remaining', String(remaining));
    if (rateWindowCount <= config.rateLimitRequests) return next();
    res.set('Retry-After', String(retryAfterSeconds(resetMs)));
    return res.status(429).json({
      ok:false,
      code:'RATE_LIMITED',
      error:`Too many API requests. Try again in ${retryAfterSeconds(resetMs)} second(s).`,
      retryAfterMs:resetMs,
      retryable:true,
    });
  }

  function acquire(groupName, key){
    const group = groups.get(groupName);
    if (!group) throw new Error(`Unknown request-control group: ${groupName}`);
    const operationKey = String(key || groupName);
    if (group.active.has(operationKey)){
      return { ok:false, httpStatus:409, code:'OPERATION_IN_PROGRESS', group:groupName };
    }
    if (group.active.size >= group.limit){
      return { ok:false, httpStatus:429, code:'CONCURRENCY_LIMIT_REACHED', group:groupName };
    }
    group.active.add(operationKey);
    let released = false;
    return {
      ok:true,
      release(){
        if (released) return;
        released = true;
        group.active.delete(operationKey);
      },
    };
  }

  function rejectedOperation(ticket){
    const duplicate = ticket.httpStatus === 409;
    return {
      ok:false,
      httpStatus:ticket.httpStatus,
      code:ticket.code,
      error:duplicate
        ? `A matching ${ticket.group} operation is already running.`
        : `The ${ticket.group} concurrency limit has been reached. Try again shortly.`,
      operation:ticket.group,
      retryAfterMs:1000,
      retryable:true,
    };
  }

  async function execute(requests, task){
    const list = Array.isArray(requests) ? requests : [requests];
    const acquired = [];
    for (const request of list){
      const ticket = acquire(request.group, request.key);
      if (!ticket.ok){
        acquired.reverse().forEach(item => item.release());
        return rejectedOperation(ticket);
      }
      acquired.push(ticket);
    }
    try {
      return await task();
    } finally {
      acquired.reverse().forEach(item => item.release());
    }
  }

  function guard(group, keyForRequest = req => requestFingerprint({
    method:req.method,
    path:req.originalUrl || req.path,
    body:req.body,
  })){
    return function requestControlGuard(req, res, next){
      const ticket = acquire(group, keyForRequest(req));
      if (!ticket.ok) return sendResult(res, rejectedOperation(ticket));
      if (typeof res.once === 'function'){
        res.once('finish', ticket.release);
        res.once('close', ticket.release);
      } else {
        const originalJson = res.json;
        const originalSend = res.send;
        if (typeof originalJson === 'function') res.json = function controlledJson(...args){ ticket.release(); return originalJson.apply(this, args); };
        if (typeof originalSend === 'function') res.send = function controlledSend(...args){ ticket.release(); return originalSend.apply(this, args); };
      }
      next();
    };
  }

  function sendResult(res, result, extra = {}){
    const value = result || { ok:false, error:'The operation did not return a result.' };
    const { httpStatus, ...body } = value;
    if (httpStatus){
      const retryMs = Number(body.retryAfterMs || 0);
      if (retryMs > 0) res.set('Retry-After', String(retryAfterSeconds(retryMs)));
      res.status(httpStatus);
    }
    return res.json({ ...body, ...extra });
  }

  return { config, rateLimit, acquire, execute, guard, sendResult, requestFingerprint };
}

module.exports = { createRequestControls, requestFingerprint };
