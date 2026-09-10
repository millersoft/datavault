'use strict';

const crypto = require('node:crypto');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function createApiToken(){
  return crypto.randomBytes(32).toString('base64url');
}

function parseHostHeader(value){
  const input = String(value || '').trim();
  if (!input) return null;

  let hostname;
  let port = '';
  const ipv6 = input.match(/^\[([^\]]+)\](?::([0-9]+))?$/);
  if (ipv6){
    hostname = ipv6[1].toLowerCase();
    port = ipv6[2] || '';
  } else {
    const ordinary = input.match(/^([^:]+?)(?::([0-9]+))?$/);
    if (!ordinary) return null;
    hostname = ordinary[1].toLowerCase();
    port = ordinary[2] || '';
  }

  if (!LOOPBACK_HOSTS.has(hostname)) return null;
  if (port && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) return null;
  return { hostname, port, authority: hostname === '::1' ? `[::1]${port ? `:${port}` : ''}` : `${hostname}${port ? `:${port}` : ''}` };
}

function originMatchesRequest(originValue, hostValue){
  if (originValue === undefined || originValue === null || originValue === '') return true;
  const origin = String(originValue).trim();
  if (!origin || origin === 'null') return false;

  const host = parseHostHeader(hostValue);
  if (!host) return false;

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password) return false;
    return parsed.host.toLowerCase() === host.authority.toLowerCase();
  } catch (_) {
    return false;
  }
}

function tokensMatch(expected, supplied){
  if (typeof supplied !== 'string') return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function createApiAccess(options = {}){
  const apiToken = options.apiToken || createApiToken();
  const audit = options.audit || (() => {});
  if (typeof apiToken !== 'string' || !apiToken) throw new Error('A non-empty API token is required.');

  function validateLocalHost(req, res, next){
    if (!parseHostHeader(req.headers && req.headers.host)) {
      audit('host.rejected', { method:req.method, path:req.originalUrl || req.url, reason:'non-loopback-host' });
      return res.status(403).json({ ok:false, error:'Data Vault Studio only accepts local loopback hosts.' });
    }
    next();
  }

  function validateApiRequest(req, res, next){
    res.set('Cache-Control', 'no-store');
    const headers = req.headers || {};
    if (!originMatchesRequest(headers.origin, headers.host)) {
      audit('origin.rejected', { method:req.method, path:req.originalUrl || req.url, reason:'origin-mismatch' });
      return res.status(403).json({ ok:false, error:'API request origin is not allowed.' });
    }
    if (!tokensMatch(apiToken, headers['x-dvs-token'])) {
      audit('authentication.failed', { method:req.method, path:req.originalUrl || req.url, reason:'invalid-api-token' });
      return res.status(401).json({ ok:false, error:'API authorization failed.' });
    }
    next();
  }

  return { apiToken, validateLocalHost, validateApiRequest };
}

module.exports = {
  LOOPBACK_HOSTS,
  createApiToken,
  createApiAccess,
  parseHostHeader,
  originMatchesRequest,
  tokensMatch,
};
