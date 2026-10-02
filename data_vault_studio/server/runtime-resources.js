'use strict';

const nodePath = require('node:path');

const SERVICES = ['hop', 'postgres', 'mysql'];
const MANAGED_FILE = 'docker-compose.resources.yaml';
const MANAGED_HEADER = '# Managed by Data Vault Studio. Do not edit while the Studio server is running.';
const MIN_CPU = 0.1;
const MAX_CPU = 64;
const MIN_MEMORY_MIB = 128;
const MAX_MEMORY_MIB = 1024 * 1024; // 1 TiB

function parseMemory(value, field = 'memory'){
  if (typeof value !== 'string') throw new Error(`${field} must be a MiB or GiB string.`);
  const match = /^\s*(\d+(?:\.\d+)?)\s*(MiB|GiB)\s*$/i.exec(value);
  if (!match) throw new Error(`${field} must use MiB or GiB, for example "512MiB" or "8GiB".`);
  const amount = Number(match[1]);
  const mib = amount * (match[2].toLowerCase() === 'gib' ? 1024 : 1);
  if (!Number.isFinite(mib) || mib < MIN_MEMORY_MIB || mib > MAX_MEMORY_MIB) {
    throw new Error(`${field} must be between ${MIN_MEMORY_MIB}MiB and ${MAX_MEMORY_MIB / 1024}GiB.`);
  }
  if (!Number.isInteger(mib)) throw new Error(`${field} must resolve to a whole number of MiB.`);
  return mib;
}

function formatMemory(mib){
  return mib % 1024 === 0 ? `${mib / 1024}GiB` : `${mib}MiB`;
}

function parseComposeMemory(value){
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]i?b?|b)?\s*$/i.exec(String(value || ''));
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const factor = unit === 'g' || unit === 'gb' || unit === 'gib' ? 1024
    : unit === 'm' || unit === 'mb' || unit === 'mib' ? 1
      : unit === 'k' || unit === 'kb' || unit === 'kib' ? 1 / 1024
        : 1 / (1024 * 1024);
  const mib = amount * factor;
  return Number.isFinite(mib) && Number.isInteger(mib) ? mib : null;
}

function parseResourceYaml(text, { managed = false } = {}){
  if (managed && !text.startsWith(`${MANAGED_HEADER}\n`)) {
    throw new Error(`${MANAGED_FILE} is not managed by Data Vault Studio; refusing to overwrite it.`);
  }
  const result = {};
  let service = null;
  for (const line of String(text).split(/\r?\n/)) {
    const serviceMatch = /^  (hop|postgres|mysql):\s*$/.exec(line);
    if (serviceMatch) { service = serviceMatch[1]; result[service] = {}; continue; }
    if (/^  \S/.test(line)) { service = null; continue; }
    if (!service) continue;
    const cpuMatch = /^    cpus:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/.exec(line);
    const memoryMatch = /^    mem_limit:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/.exec(line);
    if (cpuMatch) {
      const cpu = Number(cpuMatch[1]);
      if (Number.isFinite(cpu)) result[service].cpu = cpu;
    }
    if (memoryMatch) {
      const mib = parseComposeMemory(memoryMatch[1]);
      if (mib !== null) result[service].memory = formatMemory(mib);
    }
  }
  for (const name of Object.keys(result)) if (!Object.keys(result[name]).length) delete result[name];
  return result;
}

function validateResources(input){
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('resources must be an object keyed by service.');
  const names = Object.keys(input);
  if (!names.length) throw new Error('resources must include at least one service.');
  const result = {};
  for (const name of names) {
    if (!SERVICES.includes(name)) throw new Error(`Unknown service "${name}" — allowed: ${SERVICES.join(', ')}.`);
    const value = input[name];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} resources must be an object.`);
    if (Object.keys(value).some(key => !['cpu', 'memory'].includes(key))) throw new Error(`${name} resources only support cpu and memory.`);
    if (!Object.prototype.hasOwnProperty.call(value, 'cpu') || !Object.prototype.hasOwnProperty.call(value, 'memory')) {
      throw new Error(`${name} resources require both cpu and memory.`);
    }
    const cpu = typeof value.cpu === 'number' ? value.cpu : Number(value.cpu);
    if (!Number.isFinite(cpu) || cpu < MIN_CPU || cpu > MAX_CPU) throw new Error(`${name} cpu must be a number between ${MIN_CPU} and ${MAX_CPU}.`);
    result[name] = { cpu:Number(cpu.toFixed(3)), memory:formatMemory(parseMemory(value.memory, `${name} memory`)) };
  }
  return result;
}

function serializeResources(resources){
  const lines = [MANAGED_HEADER, '# This file contains only runtime CPU and memory limits.', 'services:'];
  for (const name of SERVICES) {
    const resource = resources[name];
    if (!resource) continue;
    lines.push(`  ${name}:`, `    cpus: ${resource.cpu}`, `    mem_limit: ${resource.memory}`);
  }
  return `${lines.join('\n')}\n`;
}

function createRuntimeResourceService({ fs, path = nodePath, projectRoot }){
  const composePath = path.join(projectRoot, 'docker-compose.yaml');
  const resourcePath = path.join(projectRoot, MANAGED_FILE);

  function assertSafeTarget(){
    try {
      const stat = fs.lstatSync(resourcePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${MANAGED_FILE} must be a regular file.`);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
  }

  function defaults(){
    if (!fs.existsSync(composePath)) throw new Error('docker-compose.yaml was not found in the project root.');
    return parseResourceYaml(fs.readFileSync(composePath, 'utf8'));
  }

  function configured(){
    // lstat first: existsSync follows links and would miss a dangling symlink.
    assertSafeTarget();
    if (!fs.existsSync(resourcePath)) return {};
    return parseResourceYaml(fs.readFileSync(resourcePath, 'utf8'), { managed:true });
  }

  function current(){
    const defaultResources = defaults();
    const configuredResources = configured();
    const effective = {};
    for (const name of SERVICES) {
      if (defaultResources[name] || configuredResources[name]) effective[name] = { ...defaultResources[name], ...configuredResources[name] };
    }
    return { defaults:defaultResources, configured:configuredResources, effective };
  }

  function save(input){
    const resources = validateResources(input);
    assertSafeTarget();
    const existing = configured(); // validates ownership before a replacement
    const next = { ...existing, ...resources };
    const tempPath = path.join(projectRoot, `.${MANAGED_FILE}.${process.pid}.${Date.now()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, serializeResources(next), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(tempPath, resourcePath);
      try {
        const directory = fs.openSync(projectRoot, 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } catch (_) { /* Directory fsync is not available on every platform. */ }
    } finally {
      if (descriptor !== undefined && descriptor !== null) try { fs.closeSync(descriptor); } catch (_) {}
      try { fs.rmSync(tempPath, { force:true }); } catch (_) {}
    }
    return current();
  }

  return { current, save, resourcePath, validateResources };
}

module.exports = { SERVICES, MANAGED_FILE, createRuntimeResourceService, parseResourceYaml, validateResources };
