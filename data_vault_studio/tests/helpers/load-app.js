/**
 * Test harness: loads every inline <script> block from
 * millersoft_vault_studio.html into a Node `vm` sandbox with a minimal DOM
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

function loadApp(options = {}){
  const htmlPath = options.htmlPath
    || path.join(__dirname, '..', '..', 'millersoft_vault_studio.html');
  const runtimeMode = options.runtimeMode === 'production' ? 'production' : 'demo';
  const html = fs.readFileSync(htmlPath, 'utf8')
    .replace(/__STUDIO_RUNTIME_MODE__/g, runtimeMode);

  const localStorage = makeLocalStorage();
  const documentStub = {
    getElementById(){ return makeElement(); },
    createElement(tag){ return makeElement(tag); },
    querySelector(){ return makeElement(); },
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
    location: { origin: 'file://', protocol: 'file:', href: 'file:///app.html', port: '' },
    navigator: { userAgent: 'node-test' },
    fetch(){ return Promise.reject(new Error('fetch disabled in tests')); },
    confirm(){ return false; },   // never auto-restore/consent in tests
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

  // Execute every inline script block (skip CDN <script src=...> tags).
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match, blockIndex = 0;
  while ((match = re.exec(html))){
    blockIndex++;
    try {
      vm.runInContext(match[1], context, { filename: `inline-script-${blockIndex}.js` });
    } catch (err) {
      throw new Error(`Inline script block #${blockIndex} failed to execute: ${err.message}`);
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

module.exports = { loadApp, makeElement };
