/**
 * Test harness: loads every local <script> from public/index.html into a Node
 * `vm` sandbox with a minimal DOM
 * stub, so the app's pure functions (generators, validation, diffing,
 * suggestion logic, undo/autosave) can be unit-tested without a browser.
 *
 * Usage:
 *   const { loadApp } = require('./helpers/load-app');
 *   const app = loadApp();
 *   app.eval('hubName("customer")')  // evaluate any expression in the app
 *   app.eval('state.vault.name = "sales"')
 *
 * `let`/`const` bindings at the top level of a script block live in the
 * context's global lexical environment (not on globalThis), so access goes
 * through app.eval(...) rather than property reads.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeClassList(){
  return { add(){}, remove(){}, toggle(){}, contains(){ return false; } };
}

function makeElement(tag){
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {},
    dataset: {},
    classList: makeClassList(),
    children: [],
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    className: '',
    placeholder: '',
    type: '',
    addEventListener(){},
    removeEventListener(){},
    appendChild(child){ this.children.push(child); return child; },
    removeChild(){},
    remove(){},
    querySelector(){ return makeElement(); },
    querySelectorAll(){ return []; },
    setAttribute(){},
    getAttribute(){ return null; },
    focus(){},
    click(){},
    closest(){ return null; },
  };
  return el;
}

class TestHeaders {
  constructor(initial = {}){
    this.values = new Map();
    if (initial && typeof initial.forEach === 'function') initial.forEach((value,key)=>this.set(key,value));
    else Object.entries(initial || {}).forEach(([key,value])=>this.set(key,value));
  }
  set(name,value){ this.values.set(String(name).toLowerCase(),String(value)); }
  get(name){ return this.values.get(String(name).toLowerCase()) || null; }
  forEach(callback){ this.values.forEach((value,key)=>callback(value,key,this)); }
}

function makeLocalStorage(){
  const store = new Map();
  return {
    getItem(k){ return store.has(k) ? store.get(k) : null; },
    setItem(k, v){ store.set(k, String(v)); },
    removeItem(k){ store.delete(k); },
    clear(){ store.clear(); },
    _store: store,
  };
}

function listLocalScripts(htmlPath){
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scripts = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))){
    const attrs = match[1] || '';
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch){
      scripts.push({ type:'inline', source:match[2], filename:`inline-script-${scripts.length + 1}.js` });
      continue;
    }
    const src = srcMatch[1];
    if (/^(?:https?:)?\/\//i.test(src)) continue;
    scripts.push({ type:'local', source:fs.readFileSync(path.resolve(path.dirname(htmlPath), src), 'utf8'), filename:src });
  }
  return scripts;
}

function readFrontendSources(htmlPath = path.join(__dirname, '..', '..', 'public', 'index.html')){
  const html = fs.readFileSync(htmlPath, 'utf8');
  const assets = [];
  const seen = new Set();
  const assetPattern = /(?:src|href)=["']([^"']+)["']/gi;
  let match;
  while ((match = assetPattern.exec(html))){
    const ref = match[1];
    if (/^(?:https?:)?\/\//i.test(ref) || !/\.(?:css|js)(?:\?|$)/i.test(ref)) continue;
    const file = path.resolve(path.dirname(htmlPath), ref.split('?')[0]);
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    assets.push(fs.readFileSync(file, 'utf8'));
  }
  return [html, ...assets].join('\n');
}

function readServerSources(root = path.join(__dirname, '..', '..')){
  const files = [path.join(root, 'server.js')];
  const serverDir = path.join(root, 'server');
  if (fs.existsSync(serverDir)){
    const visit = dir => fs.readdirSync(dir, { withFileTypes:true })
      .sort((a,b)=>a.name.localeCompare(b.name))
      .forEach(entry=>{
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
      });
    visit(serverDir);
  }
  return files.filter(file=>fs.existsSync(file)).map(file=>fs.readFileSync(file, 'utf8')).join('\n');
}

function loadApp(options = {}){
  const htmlPath = options.htmlPath
    || path.join(__dirname, '..', '..', 'public', 'index.html');
  const runtimeMode = options.runtimeMode === 'production' ? 'production' : 'demo';
  const apiToken = options.apiToken || 'dvs-gui-test-token';

  const localStorage = makeLocalStorage();
  const documentStub = {
    getElementById(){ return makeElement(); },
    createElement(tag){ return makeElement(tag); },
    querySelector(selector){ return selector === 'meta[name="dvs-api-token"]' ? { content:apiToken } : makeElement(); },
    querySelectorAll(){ return []; },
    addEventListener(){},
    removeEventListener(){},
    documentElement: Object.assign(makeElement('html'), {
      setAttribute(){}, getAttribute(){ return 'light'; },
    }),
    body: makeElement('body'),
  };

  const sandbox = {
    console,
    document: documentStub,
    localStorage,
    location: options.location || { origin: 'file://', protocol: 'file:', href: 'file:///app.html', port: '' },
    navigator: { userAgent: 'node-test' },
    Headers: TestHeaders,
    fetch: options.fetch || function(){ return Promise.reject(new Error('fetch disabled in tests')); },
    confirm: options.confirm || function(){ return false; },   // never auto-restore/consent in tests
    alert(){},
    setTimeout(){ return 1; },    // fire-and-forget UI timers are inert in tests
    clearTimeout(){},
    setInterval(){ return 1; },
    clearInterval(){},
    XLSX: {                        // only exercised if a test builds a workbook
      utils: {
        book_new(){ return { SheetNames: [], Sheets: {} }; },
        aoa_to_sheet(rows){ return { _rows: rows }; },
        book_append_sheet(wb, ws, name){ wb.SheetNames.push(name); wb.Sheets[name] = ws; },
      },
      write(){ return ''; },
    },
    cytoscape: undefined,
    Blob: function(parts){ this.parts = parts; },
    URL: { createObjectURL(){ return 'blob:test'; }, revokeObjectURL(){} },
    FileReader: function(){ this.readAsText = () => {}; },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  // Execute inline and local external scripts in document order. Remote CDN
  // scripts are represented by the sandbox stubs above and are skipped.
  const scripts = listLocalScripts(htmlPath);
  for (const script of scripts){
    try {
      const source = script.source.replace(/__STUDIO_RUNTIME_MODE__/g, runtimeMode);
      vm.runInContext(source, context, { filename: script.filename });
    } catch (err) {
      throw new Error(`${script.filename} failed to execute: ${err.message}`);
    }
  }

  return {
    context,
    localStorage,
    // Objects created inside the vm belong to a different realm (their
    // Array/Object prototypes differ), which breaks deepStrictEqual on the
    // host side — JSON-normalise anything structured before returning it.
    eval(expr){
      const v = vm.runInContext(expr, context);
      if (v && typeof v === 'object') return JSON.parse(JSON.stringify(v));
      return v;
    },
    evalRaw(expr){ return vm.runInContext(expr, context); },
    fn(name){ return (...args) => vm.runInContext(name, context)(...args); },
  };
}

module.exports = { loadApp, makeElement, listLocalScripts, readFrontendSources, readServerSources };
