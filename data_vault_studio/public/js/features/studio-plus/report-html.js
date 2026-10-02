/* Studio Plus — standalone HTML report shell (with optional embedded data snapshot). */
// The Millersoft mark, used verbatim from the main app's own header so
// the banner is guaranteed present on every generated report rather than
// depending on the model remembering to include it.
// Pulled live from millersoft.co rather than embedded, so every time
// someone opens a generated report, this image request shows up in your
// own server's access logs -- a simple, standard way to get a usage signal
// out of an otherwise fully offline static file, without building any
// dedicated analytics into the report itself.
const SP_MILLERSOFT_LOGO = "https://millersoft.co/img/data-vault/dvs-header-image.png";

const SP_REPORT_CSS = "*{box-sizing:border-box;}"
  + "body{font-family:'Inter',sans-serif;margin:0;background-color:#faf7fc;background-image:radial-gradient(circle, rgba(123,31,162,0.10) 1px, transparent 1px);background-size:24px 24px;color:#1a0a1e;}"
  + "header{background:#4a2060;color:#fff;padding:14px 24px;display:flex;align-items:center;gap:14px;}"
  + "header img{height:30px;width:auto;display:block;}"
  + "header h1{margin:0;font-size:18px;font-weight:800;letter-spacing:.2px;}"
  + "main{padding:22px;max-width:1200px;margin:0 auto;}"
  + "input[type=file]{margin:12px 0 20px;font-family:'IBM Plex Mono',monospace;font-size:12.5px;background:#fff;border:1px solid #e2d3ec;border-radius:4px;padding:8px 10px;color:#1a0a1e;}"
  + ".sp-section{background:#fff;border:1px solid #e2d3ec;border-radius:4px;padding:18px;margin:0 0 18px;box-shadow:0 1px 2px rgba(74,32,96,.05);}"
  + ".sp-section h2{margin:0 0 12px;font-family:'Inter',sans-serif;font-size:15px;font-weight:700;color:#4a2060;text-transform:uppercase;letter-spacing:.3px;}"
  + ".sp-section table{width:100%;border-collapse:collapse;font-size:12.5px;font-family:'IBM Plex Mono',monospace;}"
  + ".sp-section th,.sp-section td{border-bottom:1px solid #ede1f4;padding:8px 10px;text-align:left;vertical-align:top;}"
  + ".sp-section th{background:#f6eefb;color:#4a2060;font-weight:600;}"
  + ".sp-section tr:hover td{background:#f5eefa;}"
  + ".sp-empty{padding:28px;border:2px dashed #e2d3ec;border-radius:4px;background:#fff;color:#7a6b84;}"
  + ".sp-error{padding:14px;border:1px solid #f3c9c9;border-radius:4px;background:#fdf1f1;color:#b3261e;font-family:'IBM Plex Mono',monospace;font-size:12px;white-space:pre-wrap;}"
  + ".sp-pill{background:#f3e6fa;color:#4a2060;border-radius:999px;padding:6px 12px;font-size:12px;font-family:'IBM Plex Mono',monospace;font-weight:600;display:inline-block;margin:0 8px 8px 0;}"
  + ".sp-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:0 0 18px;}"
  + ".sp-kpi{padding:15px 16px;border:1px solid #e7dcec;border-radius:12px;background:linear-gradient(180deg,#fff,#fbf8fd);}"
  + ".sp-kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#7a6b84;font-weight:700;}"
  + ".sp-kpi-value{font-size:26px;line-height:1.1;font-weight:800;color:#2c1238;margin-top:7px;}"
  + ".sp-kpi-sub{font-size:11px;color:#7a6b84;margin-top:5px;}"
  + ".sp-grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;}"
  + ".sp-chart{width:100%;min-height:320px;}"
  + ".sp-insight{border-left:4px solid #7b1fa2;background:#f8f0fc;padding:12px 14px;border-radius:0 9px 9px 0;line-height:1.55;margin:12px 0;}"
  + ".sp-toolbar{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:0 0 14px;}"
  + ".sp-toolbar label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7a6b84;}"
  + ".sp-toolbar select,.sp-toolbar input{display:block;margin-top:4px;padding:7px 9px;border:1px solid #dbcbe5;border-radius:7px;background:#fff;}"
  + ".sp-section-nav{position:sticky;top:0;z-index:20;display:flex;gap:6px;overflow-x:auto;padding:9px 0 10px;margin:0 0 16px;background:rgba(250,247,252,.96);backdrop-filter:blur(8px);border-bottom:1px solid #eadff0;}"
  + ".sp-section-nav a{white-space:nowrap;text-decoration:none;color:#4a2060;background:#fff;border:1px solid #decfe7;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:700;}"
  + ".sp-section-nav a:hover{background:#f3e6fa;border-color:#caa9dc;}"
  + "@media(max-width:760px){.sp-grid-2{grid-template-columns:1fr;}main{padding:14px;}}"
  + "svg{max-width:100%;height:auto;background:#fff;}"
  // Containment: model-written sections must never push past the card.
  + ".sp-section{overflow-x:auto;min-width:0;color:#1a0a1e;}"
  + ".sp-section>div{min-width:0;max-width:100%;}"
  + ".sp-section img,.sp-section canvas,.sp-section video{max-width:100%;}"
  + ".sp-section [style*='display:grid'],.sp-section [style*='display: grid']{max-width:100%;}"
  + ".sp-section pre{max-width:100%;overflow-x:auto;}"
  + ".sp-chart,.sp-section [_echarts_instance_]{max-width:100%;overflow:hidden;}"
  + ".sp-section input,.sp-section select,.sp-section button{color:#1a0a1e;background-color:#fff;font-family:inherit;max-width:100%;}"
  + ".sp-section button{border:1px solid #dbcbe5;border-radius:7px;padding:6px 10px;cursor:pointer;}"
  + ".sp-section details>summary{cursor:pointer;color:#4a2060;font-weight:600;}";

// Safety net for model-written sections. Runs in the downloaded report (it is
// serialised with Function.prototype.toString), so it must be self-contained.
// 1) Any text whose colour has too little contrast against its effective
//    background (white-on-white, purple-on-purple, ...) is switched to the
//    report's dark ink or white, whichever reads better.
// 2) echarts.init is wrapped so every chart fills, and stays within, its
//    container, resizes with the window, and defaults to the report palette.
function spReportStyleGuard(){
  var INK = '#1a0a1e', MIN_RATIO = 4.5, MAX_NODES = 4000;
  var PALETTE = ['#7b1fa2','#2a7f9e','#e08a1e','#2e8b57','#c2410c','#4a2060','#6b7280','#b83280'];
  function parse(c){
    var m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    var p = m[1].split(/[,\/ ]+/).filter(Boolean).map(Number);
    return { r:p[0], g:p[1], b:p[2], a:p.length > 3 ? p[3] : 1 };
  }
  function lum(c){
    function ch(v){ v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  function ratio(a, b){
    var la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function over(top, bottom){
    var a = top.a + bottom.a * (1 - top.a);
    if (!a) return { r:255, g:255, b:255, a:1 };
    function mix(t, b){ return (t * top.a + b * bottom.a * (1 - top.a)) / a; }
    return { r:mix(top.r, bottom.r), g:mix(top.g, bottom.g), b:mix(top.b, bottom.b), a:a };
  }
  function background(el, cache){
    if (cache.has(el)) return cache.get(el);
    var own = el.nodeType === 1 ? parse(getComputedStyle(el).backgroundColor) : null;
    var result;
    if (own && own.a >= 1) result = own;
    else {
      var below = el.parentElement ? background(el.parentElement, cache) : { r:255, g:255, b:255, a:1 };
      result = own && own.a > 0 ? over(own, below) : below;
    }
    cache.set(el, result);
    return result;
  }
  function hasOwnText(el){
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }
  function fixContrast(root){
    var cache = new Map(), nodes = root.querySelectorAll('*'), limit = Math.min(nodes.length, MAX_NODES);
    for (var i = 0; i < limit; i++){
      var el = nodes[i], isSvg = el instanceof SVGElement;
      if (!hasOwnText(el)) continue;
      var cs = getComputedStyle(el);
      var fg = parse(isSvg ? cs.fill : cs.color);
      if (!fg || fg.a === 0) continue;
      var bg = background(isSvg ? (el.closest('svg') || el) : el, cache);
      if (ratio(over(fg, bg), bg) >= MIN_RATIO) continue;
      var fix = lum(bg) > 0.4 ? INK : '#ffffff';
      el.style.setProperty(isSvg ? 'fill' : 'color', fix, 'important');
    }
  }
  function wrapEcharts(lib){
    if (!lib || !lib.init) return lib;
    var wrapped = Object.assign({}, lib);
    wrapped.init = function(dom, theme, opts){
      if (dom && dom.style){
        dom.style.width = '100%';
        dom.style.maxWidth = '100%';
        dom.style.boxSizing = 'border-box';
        if (!dom.style.height && !dom.offsetHeight) dom.style.height = '340px';
      }
      var chart = lib.init(dom, theme, opts);
      if (typeof ResizeObserver !== 'undefined' && dom) new ResizeObserver(function(){ chart.resize(); }).observe(dom);
      else window.addEventListener('resize', function(){ chart.resize(); });
      var setOption = chart.setOption.bind(chart);
      chart.setOption = function(option){
        var o = option && typeof option === 'object' ? Object.assign({}, option) : option;
        if (o && typeof o === 'object' && !Array.isArray(o)){
          if (!o.color) o.color = PALETTE;
          if (!o.textStyle) o.textStyle = { color:INK };
          if (o.grid && !Array.isArray(o.grid) && o.grid.containLabel === undefined) o.grid = Object.assign({}, o.grid, { containLabel:true });
          else if (!o.grid) o.grid = { containLabel:true, left:16, right:24, top:48, bottom:16 };
        }
        return setOption.apply(null, [o].concat([].slice.call(arguments, 1)));
      };
      return chart;
    };
    return wrapped;
  }
  function watch(root){
    var timer = 0;
    fixContrast(root);
    new MutationObserver(function(){
      clearTimeout(timer);
      timer = setTimeout(function(){ fixContrast(root); }, 60);
    }).observe(root, { childList:true, subtree:true });
  }
  return { wrapEcharts:wrapEcharts, watch:watch, fixContrast:fixContrast };
}

// Deterministic report shell: the app owns file loading, sheet parsing,
// branding, and layout. Sheet lookup uses the same Excel-safe names written
// into the workbook (31 characters, the Excel sheet-name limit). The model's
// render_js only ever runs against rows already parsed into the shape it was
// told to expect.
function spReportScriptJson(value){
  return JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
}
function spBuildReportHtml(options){
  const snapshot = options && options.snapshot;
  const g = spGenerated;
  const title = spCurrentReportTitle();
  const viewsJson = spReportScriptJson(spViewsWithExcelSheetNames(g.views || []));
  const sectionsJson = spReportScriptJson((g.sections||[]).map((s,i)=>({
    view_name: s.view_name,
    title: s.title,
    render_js: spNormalizeSectionRenderJs(spSectionOverrides[i] != null ? spSectionOverrides[i] : (s.render_js||'')),
  })));
  const parts = [];
  parts.push('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">');
  parts.push('<title>' + escapeHtml(title) + '</title>');
  parts.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
  parts.push('<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">');
  parts.push('<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"><' + '/script>');
  parts.push('<script src="https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js"><' + '/script>');
  parts.push('<style>' + SP_REPORT_CSS + '</style>');
  parts.push('</head><body>');
  parts.push('<header><a href="https://millersoft.co/data-vault-services" target="_blank" rel="noopener"><img src="' + SP_MILLERSOFT_LOGO + '" alt="Millersoft"></a><h1>' + escapeHtml(title) + '</h1></header>');
  parts.push('<main>');
  if (g.report_goal) parts.push('<div class="sp-insight"><strong>Report purpose</strong><br>' + escapeHtml(g.report_goal) + '</div>');
  parts.push('<input id="sp-report-file" type="file" accept=".xlsx,.xls">');
  parts.push('<div id="sp-report-status" class="sp-empty">No workbook loaded yet.</div>');
  parts.push('<nav id="sp-report-nav" class="sp-section-nav" style="display:none"></nav>');
  parts.push('<div id="sp-report-content"></div>');
  parts.push('</main>');
  parts.push('<' + 'script>');
  parts.push('var SP_VIEWS = ' + viewsJson + ';');
  parts.push('var SP_SECTIONS = ' + sectionsJson + ';');
  if (snapshot){
    parts.push('var SP_EMBEDDED = ' + spReportScriptJson(snapshot.rows) + ';');
    parts.push('var SP_EMBEDDED_AT = ' + spReportScriptJson(snapshot.takenAt) + ';');
    parts.push('var SP_EMBEDDED_NOTE = ' + spReportScriptJson(snapshot.note || '') + ';');
  }
  parts.push('var spStyleGuard = (' + spReportStyleGuard.toString() + ')();');
  parts.push([
    'var statusEl = document.getElementById("sp-report-status");',
    'var contentEl = document.getElementById("sp-report-content");',
    'var navEl = document.getElementById("sp-report-nav");',
    'function renderReport(rowsBySheet){',
    '  contentEl.innerHTML = "";',
    '  if (navEl) { navEl.innerHTML = ""; navEl.style.display = SP_SECTIONS.length > 1 ? "flex" : "none"; }',
    '  SP_SECTIONS.forEach(function(sec, idx){ if (!navEl || SP_SECTIONS.length <= 1) return; var a=document.createElement("a"); a.href="#sp-report-section-"+idx; a.textContent=sec.title||sec.view_name; navEl.appendChild(a); });',
    '  SP_SECTIONS.forEach(function(sec, secIndex){',
    '    var card = document.createElement("div");',
    '    card.className = "sp-section";',
    '    card.id = "sp-report-section-" + secIndex;',
    '    var h2 = document.createElement("h2");',
    '    h2.textContent = sec.title || sec.view_name;',
    '    var body = document.createElement("div");',
    '    card.appendChild(h2); card.appendChild(body);',
    '    contentEl.appendChild(card);',
    '    var rows = rowsBySheet[sec.view_name] || [];',
    '    try {',
    '      var renderFn = new Function("rows", "el", "echarts", sec.render_js || "");',
    '      renderFn(rows, body, spStyleGuard.wrapEcharts(window.echarts));',
    '    } catch(err){',
    '      var errDiv = document.createElement("div");',
    '      errDiv.className = "sp-error";',
    '      errDiv.textContent = "This section failed to render: " + err.message;',
    '      body.appendChild(errDiv);',
    '    }',
    '  });',
    '}',
    'spStyleGuard.watch(contentEl);',
    'document.getElementById("sp-report-file").addEventListener("change", function(e){',
    '  var f = e.target.files && e.target.files[0];',
    '  if (!f) return;',
    '  var reader = new FileReader();',
    '  reader.onload = function(ev){',
    '    var wb;',
    '    try { wb = XLSX.read(new Uint8Array(ev.target.result), {type:"array"}); }',
    '    catch(err){ statusEl.className = "sp-error"; statusEl.textContent = "Could not read that file: " + err.message; return; }',
    '    var missing = SP_VIEWS.filter(function(v){ return !wb.Sheets[v.sheet_name]; }).map(function(v){ return v.sheet_name; });',
    '    statusEl.className = missing.length ? "sp-error" : "sp-pill";',
    '    statusEl.textContent = missing.length ? ("Loaded, but missing expected sheet(s): " + missing.join(", ")) : ("Loaded " + f.name + " successfully.");',
    '    var rowsBySheet = {};',
    '    SP_VIEWS.forEach(function(v){',
    '      var sheet = wb.Sheets[v.sheet_name];',
    '      rowsBySheet[v.view_name] = sheet ? XLSX.utils.sheet_to_json(sheet, {defval:""}) : [];',
    '    });',
    '    renderReport(rowsBySheet);',
    '  };',
    '  reader.readAsArrayBuffer(f);',
    '});',
    'if (typeof SP_EMBEDDED !== "undefined") {',
    '  statusEl.className = "sp-pill";',
    '  statusEl.textContent = "Showing the data snapshot taken " + new Date(SP_EMBEDDED_AT).toLocaleString() + ". Load a refreshed workbook to update it." + (SP_EMBEDDED_NOTE ? " " + SP_EMBEDDED_NOTE : "");',
    '  renderReport(SP_EMBEDDED);',
    '}',
  ].join('\n'));
  parts.push('<' + '/script>');
  parts.push('</body></html>');
  return parts.join('');
}

function spDownloadReportHtml(){
  if (!spGenerated) return;
  if (spRejectInvalidSectionScripts()) return;
  downloadBlob(spBuildReportHtml(), `${spReportFilenameBase()}.html`, 'text/html');
}

// Each dataset is capped so a large fact table cannot produce a multi-hundred
// megabyte HTML file. The Excel export remains the route for full extracts.
const SP_SNAPSHOT_MAX_ROWS = 20000;
async function spCollectDataSnapshot(){
  const rows = {}, truncated = [], failed = [];
  for (const v of (spGenerated.views||[])){
    try {
      const result = await spQuery(spSelectLimit(spNormalizeReportSql(spGetViewSql(v)), SP_SNAPSHOT_MAX_ROWS + 1));
      const header = (v.columns && v.columns.length) ? v.columns : (result[0] ? Object.keys(result[0]) : []);
      if (result.length > SP_SNAPSHOT_MAX_ROWS){ truncated.push(v.sheet_name||spViewKey(v)); result.length = SP_SNAPSHOT_MAX_ROWS; }
      rows[v.view_name] = result.map(r=>Object.fromEntries(header.map(h=>[h, r[h]!==undefined && r[h]!==null ? r[h] : ''])));
    } catch(err){
      failed.push(`${v.sheet_name||spViewKey(v)}: ${err.message}`);
      rows[v.view_name] = [];
    }
  }
  return { rows, truncated, failed, takenAt:new Date().toISOString() };
}
async function spDownloadReportHtmlWithData(){
  if (!spGenerated) return;
  if (spRejectInvalidSectionScripts()) return;
  const btn = document.getElementById('btn-sp-dl-html-data');
  if (btn){ btn.disabled = true; btn.textContent = 'Running queries…'; }
  try {
    const snapshot = await spCollectDataSnapshot();
    if (snapshot.truncated.length) snapshot.note = `Showing the first ${SP_SNAPSHOT_MAX_ROWS.toLocaleString()} rows of: ${snapshot.truncated.join(', ')}.`;
    downloadBlob(spBuildReportHtml({ snapshot }), `${spReportFilenameBase()}_with_data.html`, 'text/html');
    if (snapshot.failed.length){
      toast(`HTML downloaded, but ${snapshot.failed.length} dataset(s) failed and are empty.`, 'err');
      snapshot.failed.forEach(e=>toast(e, 'err'));
    } else toast(snapshot.truncated.length ? `HTML report downloaded; ${snapshot.truncated.length} dataset(s) were capped at ${SP_SNAPSHOT_MAX_ROWS.toLocaleString()} rows.` : 'HTML report downloaded with a data snapshot.', snapshot.truncated.length ? 'err' : 'ok');
  } catch(err){
    toast('Could not build the HTML report: ' + err.message, 'err');
  }
  if (btn){ btn.disabled = false; btn.textContent = '⬇ HTML report with current data'; }
}
