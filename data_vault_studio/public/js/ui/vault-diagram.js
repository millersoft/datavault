/* ---------------- DIAGRAM ---------------- */
function buildVaultDiagramSvg(){
  const COL = { hub:'#c96a12', hubDim:'#faead4', link:'#5c5266', linkDim:'#eee7f2', sat:'#1c7fa0', satDim:'#dcf0f6', muted:'#8a7a93' };
  const hubs = state.hubs;
  const marginX = 110;
  // Rough monospace character width estimate — used so labels never overflow
  // their node, regardless of how long an entity/vault name is.
  const textWidth = (str, fontSize) => String(str||'').length * fontSize * 0.62;

  const hubSatsByHub = {};
  state.hubSats.forEach(s=>{ (hubSatsByHub[s.hubId] = hubSatsByHub[s.hubId]||[]).push(s); });
  const linkSatsByLink = {};
  state.linkSats.forEach(s=>{ (linkSatsByLink[s.linkId] = linkSatsByLink[s.linkId]||[]).push(s); });

  const maxHubSatStack = hubs.length ? Math.max(0, ...hubs.map(h=>(hubSatsByHub[h.id]||[]).length)) : 0;
  const maxLinkSatStack = state.links.length ? Math.max(0, ...state.links.map(l=>(linkSatsByLink[l.id]||[]).length)) : 0;

  const hubY = 70 + maxHubSatStack*82;
  const linkY = hubY + 170;

  // Size every node from its own label so text never overflows the shape.
  const hubBox = {};
  hubs.forEach(h=>{ hubBox[h.id] = Math.max(140, textWidth(hubName(h.entity), 11.5) + 32); });
  const hubSatBox = {};
  state.hubSats.forEach(s=>{ hubSatBox[s.id] = Math.max(128, textWidth(satName(s.entity, s.concern), 9) + 28); });
  const linkBox = {};
  state.links.forEach(l=>{ linkBox[l.id] = Math.max(130, textWidth(linkNameOf(l.entity), 9.5) + 56); });
  const linkSatBox = {};
  state.linkSats.forEach(s=>{ linkSatBox[s.id] = Math.max(128, textWidth(lsatName(s.entity, s.concern), 9) + 28); });

  const maxHubWidth = hubs.length ? Math.max(...hubs.map(h=>hubBox[h.id])) : 140;
  const colWidth = maxHubWidth + 80;

  const hubPositions = {};
  hubs.forEach((h,i)=>{ hubPositions[h.id] = { x: marginX + i*colWidth, y: hubY }; });

  const usedBuckets = {};
  const linkPositions = {};
  state.links.forEach((l,i)=>{
    const xs = l.hubs.map(h=>hubPositions[h.hubId] && hubPositions[h.hubId].x).filter(x=>x!=null);
    let x = xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : marginX + i*colWidth;
    const bucket = Math.round(x/50)*50;
    usedBuckets[bucket] = (usedBuckets[bucket]||0) + 1;
    x += (usedBuckets[bucket]-1) * (linkBox[l.id]+20);
    linkPositions[l.id] = { x, y: linkY };
  });

  const width = Math.max(640, marginX*2 + Math.max(0, hubs.length-1)*colWidth + 180);
  const height = linkY + 90 + maxLinkSatStack*82 + 50;

  // Compute the real bounding box from every node's actual extent — a very
  // long satellite/link/hub name can push a shape's edge past the naive
  // column layout, especially for the outermost hubs.
  let minX = 0, maxX = width;
  hubs.forEach(h=>{ const p = hubPositions[h.id], w = hubBox[h.id]; minX = Math.min(minX, p.x-w/2); maxX = Math.max(maxX, p.x+w/2); });
  state.links.forEach(l=>{ const p = linkPositions[l.id], w = linkBox[l.id]; minX = Math.min(minX, p.x-w/2); maxX = Math.max(maxX, p.x+w/2); });
  hubs.forEach(h=>{ (hubSatsByHub[h.id]||[]).forEach(s=>{ const p = hubPositions[h.id], w = hubSatBox[s.id]; minX = Math.min(minX, p.x-w/2); maxX = Math.max(maxX, p.x+w/2); }); });
  state.links.forEach(l=>{ (linkSatsByLink[l.id]||[]).forEach(s=>{ const p = linkPositions[l.id], w = linkSatBox[s.id]; minX = Math.min(minX, p.x-w/2); maxX = Math.max(maxX, p.x+w/2); }); });
  const padding = 24;
  const viewX = minX - padding;
  const viewWidth = (maxX - minX) + padding*2;

  const esc = s => String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const parts = [`<svg viewBox="${viewX} 0 ${viewWidth} ${height}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Mono, monospace">`];

  // connector lines (drawn first, underneath nodes)
  state.links.forEach(l=>{
    const lp = linkPositions[l.id];
    l.hubs.forEach(h=>{
      const hp = hubPositions[h.hubId];
      if (hp) parts.push(`<line x1="${hp.x}" y1="${hp.y+22}" x2="${lp.x}" y2="${lp.y-20}" stroke="${COL.link}" stroke-width="1.5"/>`);
    });
  });
  hubs.forEach(h=>{
    const hp = hubPositions[h.id];
    (hubSatsByHub[h.id]||[]).forEach((s,j)=>{
      const sy = hp.y - 60 - j*82;
      parts.push(`<line x1="${hp.x}" y1="${hp.y-22}" x2="${hp.x}" y2="${sy+20}" stroke="${COL.sat}" stroke-width="1.5" stroke-dasharray="3,3"/>`);
    });
  });
  state.links.forEach(l=>{
    const lp = linkPositions[l.id];
    (linkSatsByLink[l.id]||[]).forEach((s,j)=>{
      const sy = lp.y + 60 + j*82;
      parts.push(`<line x1="${lp.x}" y1="${lp.y+20}" x2="${lp.x}" y2="${sy-20}" stroke="${COL.sat}" stroke-width="1.5" stroke-dasharray="3,3"/>`);
    });
  });

  // hub nodes
  hubs.forEach(h=>{
    const p = hubPositions[h.id];
    const table = findTable(h.tableId);
    const w = hubBox[h.id];
    parts.push(`
      <rect x="${p.x-w/2}" y="${p.y-22}" width="${w}" height="44" rx="4" fill="${COL.hubDim}" stroke="${COL.hub}" stroke-width="2"/>
      <text x="${p.x}" y="${p.y-3}" text-anchor="middle" font-size="11.5" font-weight="700" fill="${COL.hub}">${esc(hubName(h.entity))}</text>
      <text x="${p.x}" y="${p.y+13}" text-anchor="middle" font-size="9" fill="${COL.muted}">from ${esc(table?table.name:'?')}</text>
    `);
  });

  // link nodes (diamond — sized so the label always fits at its widest,
  // vertical-center cross-section)
  state.links.forEach(l=>{
    const p = linkPositions[l.id];
    const w = linkBox[l.id], hh = 44;
    const pts = `${p.x},${p.y-hh/2} ${p.x+w/2},${p.y} ${p.x},${p.y+hh/2} ${p.x-w/2},${p.y}`;
    parts.push(`
      <polygon points="${pts}" fill="${COL.linkDim}" stroke="${COL.link}" stroke-width="2"/>
      <text x="${p.x}" y="${p.y+4}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${COL.link}">${esc(linkNameOf(l.entity))}</text>
    `);
  });

  // hub satellite nodes
  hubs.forEach(h=>{
    const hp = hubPositions[h.id];
    (hubSatsByHub[h.id]||[]).forEach((s,j)=>{
      const sy = hp.y - 60 - j*82;
      const rx = hubSatBox[s.id]/2;
      parts.push(`
        <ellipse cx="${hp.x}" cy="${sy}" rx="${rx}" ry="21" fill="${COL.satDim}" stroke="${COL.sat}" stroke-width="2"/>
        <text x="${hp.x}" y="${sy+4}" text-anchor="middle" font-size="9" font-weight="700" fill="${COL.sat}">${esc(satName(s.entity, s.concern))}</text>
      `);
    });
  });

  // link satellite nodes
  state.links.forEach(l=>{
    const lp = linkPositions[l.id];
    (linkSatsByLink[l.id]||[]).forEach((s,j)=>{
      const sy = lp.y + 60 + j*82;
      const rx = linkSatBox[s.id]/2;
      parts.push(`
        <ellipse cx="${lp.x}" cy="${sy}" rx="${rx}" ry="21" fill="${COL.satDim}" stroke="${COL.sat}" stroke-width="2"/>
        <text x="${lp.x}" y="${sy+4}" text-anchor="middle" font-size="9" font-weight="700" fill="${COL.sat}">${esc(lsatName(s.entity, s.concern))}</text>
      `);
    });
  });

  parts.push('</svg>');
  return parts.join('');
}

/* =========================================================================
   Interactive diagram — Cytoscape.js + dagre, mirrors the drag/zoom/pan/
   hover-highlight/click-detail pattern used elsewhere. Falls back to the
   static SVG above if the CDN libraries didn't load (e.g. offline).
   ========================================================================= */
let CY = null;
let CY_LAYOUT_NAME = 'dagre';

function buildCyElements(){
  const elements = [];
  const COL = { hub:'#c96a12', hubDim:'#faead4', link:'#5c5266', linkDim:'#eee7f2', sat:'#1c7fa0', satDim:'#dcf0f6' };

  state.hubs.forEach(h=>{
    const table = findTable(h.tableId);
    elements.push({ group:'nodes', data: {
      id: 'hub_'+h.id, label: hubName(h.entity), kind:'hub',
      table: table?table.name:'?', key: hubKey(h.entity), bk: businessKeyColumnName(h.entity),
      statusSat: h.statusSat?'Yes':'No', description: h.description||'',
      col: COL.hub, colDim: COL.hubDim,
    }});
  });

  state.links.forEach(l=>{
    const table = findTable(l.tableId);
    const hubNames = l.hubs.map(h=>{ const hub=findHub(h.hubId); return hub?hubName(hub.entity):'?'; }).join(', ');
    elements.push({ group:'nodes', data: {
      id: 'link_'+l.id, label: linkNameOf(l.entity), kind:'link',
      table: table?table.name:'?', hubList: hubNames, description: l.description||'',
      col: COL.link, colDim: COL.linkDim,
    }});
    l.hubs.forEach(h=>{
      elements.push({ group:'edges', data: {
        id: 'e_lh_'+l.id+'_'+h.hubId, source:'hub_'+h.hubId, target:'link_'+l.id, kind:'link-hub', col: COL.link,
      }});
    });
  });

  state.hubSats.forEach(s=>{
    const table = findTable(s.tableId);
    const hub = findHub(s.hubId);
    elements.push({ group:'nodes', data: {
      id: 'hsat_'+s.id, label: satName(s.entity, s.concern), kind:'satellite',
      table: table?table.name:'?', parentLabel: hub?hubName(hub.entity):'?',
      attrCount: s.attrs.length, attrList: s.attrs.map(a=>a.target).join(', '),
      col: COL.sat, colDim: COL.satDim,
    }});
    elements.push({ group:'edges', data: { id:'e_hsat_'+s.id, source:'hub_'+s.hubId, target:'hsat_'+s.id, kind:'sat', col: COL.sat } });
  });

  state.linkSats.forEach(s=>{
    const table = findTable(s.tableId);
    const link = findLink(s.linkId);
    elements.push({ group:'nodes', data: {
      id: 'lsat_'+s.id, label: lsatName(s.entity, s.concern), kind:'satellite',
      table: table?table.name:'?', parentLabel: link?linkNameOf(link.entity):'?',
      attrCount: s.attrs.length, attrList: s.attrs.map(a=>a.target).join(', '),
      col: COL.sat, colDim: COL.satDim,
    }});
    elements.push({ group:'edges', data: { id:'e_lsat_'+s.id, source:'link_'+s.linkId, target:'lsat_'+s.id, kind:'sat', col: COL.sat } });
  });

  return elements;
}

function cyStyleSheet(){
  return [
    { selector: 'node[kind="hub"]', style: {
        'shape':'round-rectangle', 'width':150, 'height':46,
        'background-color':'data(colDim)', 'border-color':'data(col)', 'border-width':2,
        'label':'data(label)', 'color':'data(col)',
        'text-valign':'center','text-halign':'center','text-wrap':'wrap','text-max-width':136,
        'font-family':'IBM Plex Mono, monospace','font-size':10.5,'font-weight':700,
        'transition-property':'opacity, border-width','transition-duration':'150ms',
    }},
    { selector: 'node[kind="link"]', style: {
        'shape':'diamond', 'width':120, 'height':70,
        'background-color':'data(colDim)', 'border-color':'data(col)', 'border-width':2,
        'label':'data(label)', 'color':'data(col)',
        'text-valign':'center','text-halign':'center','text-wrap':'wrap','text-max-width':84,
        'font-family':'IBM Plex Mono, monospace','font-size':9,'font-weight':700,
        'transition-property':'opacity, border-width','transition-duration':'150ms',
    }},
    { selector: 'node[kind="satellite"]', style: {
        'shape':'ellipse', 'width':132, 'height':50,
        'background-color':'data(colDim)', 'border-color':'data(col)', 'border-width':2,
        'label':'data(label)', 'color':'data(col)',
        'text-valign':'center','text-halign':'center','text-wrap':'wrap','text-max-width':112,
        'font-family':'IBM Plex Mono, monospace','font-size':8.5,'font-weight':700,
        'transition-property':'opacity, border-width','transition-duration':'150ms',
    }},
    { selector: 'edge', style: {
        'width':2, 'line-color':'data(col)', 'target-arrow-color':'data(col)',
        'target-arrow-shape':'none', 'curve-style':'bezier', 'opacity':0.65,
        'transition-property':'opacity, width','transition-duration':'150ms',
    }},
    { selector: 'edge[kind="sat"]', style: { 'line-style':'dashed', 'line-dash-pattern':[5,3] } },
    { selector: '.dimmed', style: { 'opacity':0.12 } },
    { selector: 'node.highlighted', style: { 'border-width':4, 'z-index':999 } },
    { selector: 'edge.highlighted', style: { 'opacity':1, 'width':3, 'z-index':999 } },
  ];
}

function layoutOptionsFor(name){
  if (name==='cose'){
    return { name:'cose', animate:true, animationDuration:500, idealEdgeLength:130, nodeRepulsion:12000, nodeOverlap:16, gravity:0.7, padding:30, fit:true };
  }
  return { name:'dagre', rankDir:'TB', nodeSep:45, edgeSep:16, rankSep:90, animate:true, animationDuration:450, padding:30, fit:true };
}

function setCyLayout(name){
  CY_LAYOUT_NAME = name;
  ['cy-layout-dagre','cy-layout-cose'].forEach(id=>{
    const b = document.getElementById(id);
    if (b) b.classList.toggle('primary', id==='cy-layout-'+name);
  });
  if (CY) CY.layout(layoutOptionsFor(name)).run();
}

function cyFit(){ if (CY) CY.fit(undefined, 40); }

function wireCyInteractions(){
  CY.on('mouseover', 'node', e=>{
    const n = e.target, nh = n.closedNeighborhood();
    CY.elements().difference(nh).addClass('dimmed');
    nh.removeClass('dimmed').addClass('highlighted');
  });
  CY.on('mouseout', 'node', ()=>{ CY.elements().removeClass('dimmed').removeClass('highlighted'); });
  CY.on('tap', 'node', e=> showCyDetail(e.target));
  CY.on('tap', e=>{ if (e.target===CY){ closeCyDetail(); CY.elements().removeClass('dimmed').removeClass('highlighted'); } });
}

function showCyDetail(node){
  const d = node.data();
  const KIND_LABEL = { hub:'Hub', link:'Link', satellite:'Satellite' };
  const rows = [];
  if (d.kind==='hub'){
    rows.push(['Source table', d.table]);
    rows.push(['Hash key', d.key]);
    rows.push(['Business key', d.bk]);
    rows.push(['Status satellite', d.statusSat]);
    if (d.description) rows.push(['Description', d.description]);
  } else if (d.kind==='link'){
    rows.push(['Source table', d.table]);
    rows.push(['Connected hubs', d.hubList]);
    if (d.description) rows.push(['Description', d.description]);
  } else {
    rows.push(['Parent', d.parentLabel]);
    rows.push(['Source table', d.table]);
    rows.push(['Attributes', String(d.attrCount)]);
    if (d.attrList) rows.push(['Columns', d.attrList]);
  }
  const deg = node.connectedEdges().length;
  rows.push(['Connections', String(deg)]);
  const esc = escapeHtml;
  document.getElementById('cy-detail-body').innerHTML =
    `<div style="font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:.3px;color:${d.col}">${KIND_LABEL[d.kind]}</div>
     <div style="font-family:var(--font-mono);font-weight:700;font-size:13px;margin:2px 0 10px;color:var(--brand-deep)">${esc(d.label)}</div>
     ${rows.map(r=>`<div class="flex-between" style="margin-bottom:6px;gap:12px;"><span class="hint mb0" style="flex-shrink:0;">${esc(r[0])}</span><span class="mono" style="font-size:11px;text-align:right;">${esc(r[1])}</span></div>`).join('')}`;
  document.getElementById('cy-detail').classList.add('visible');
  CY.elements().removeClass('dimmed').removeClass('highlighted');
  const nh = node.closedNeighborhood();
  CY.elements().difference(nh).addClass('dimmed');
  nh.addClass('highlighted');
}

function closeCyDetail(){
  const el = document.getElementById('cy-detail');
  if (el) el.classList.remove('visible');
  if (CY) CY.elements().removeClass('dimmed').removeClass('highlighted');
}

function renderVaultDiagram(el){
  if (state.hubs.length===0){
    el.innerHTML = `<div class="empty">No hubs yet — build at least one hub to see the diagram.</div>`;
    return;
  }
  const cyAvailable = typeof cytoscape !== 'undefined';
  el.innerHTML = `
    <div class="panel-flush panel" style="padding:0;">
      <div class="panel-head">
        <h3>Vault diagram</h3>
        <button class="btn small" id="btn-download-diagram">⬇ Download SVG</button>
      </div>
      ${cyAvailable ? `
        <div class="cy-wrap" id="cy-wrap">
          <div id="cy"></div>
          <div class="cy-toolbar">
            <button class="btn small" id="cy-layout-dagre" title="Top-down hierarchy">Hierarchy</button>
            <button class="btn small" id="cy-layout-cose" title="Force-directed">Force</button>
            <button class="btn small" id="cy-fit" title="Reset zoom to fit">Fit</button>
          </div>
          <div class="cy-detail" id="cy-detail">
            <button class="cy-detail-close" id="cy-detail-close">&times;</button>
            <div id="cy-detail-body"></div>
          </div>
        </div>
        <p class="hint" style="padding:12px 16px 16px;margin:0;">Drag nodes to rearrange. Scroll to zoom, hover to highlight connections, click a node for details.</p>
      ` : `
        <div style="padding:20px;overflow:auto;background:var(--panel);" id="diagram-wrap"></div>
        <p class="hint" style="padding:0 16px 16px;margin:0;">Interactive view needs an internet connection to load its diagramming library — showing the static version instead.</p>
      `}
    </div>
  `;
  document.getElementById('btn-download-diagram').addEventListener('click', ()=>{
    downloadBlob(buildVaultDiagramSvg(), `${state.vault.name||'vault'}_diagram.svg`, 'image/svg+xml');
  });

  if (!cyAvailable){
    document.getElementById('diagram-wrap').innerHTML = buildVaultDiagramSvg();
    return;
  }

  if (CY){ try{ CY.destroy(); }catch(_){} CY = null; }
  CY = cytoscape({
    container: document.getElementById('cy'),
    elements: buildCyElements(),
    style: cyStyleSheet(),
    layout: layoutOptionsFor(CY_LAYOUT_NAME),
    wheelSensitivity: 0.25,
    minZoom: 0.25,
    maxZoom: 2.5,
    boxSelectionEnabled: false,
  });
  wireCyInteractions();
  document.getElementById('cy-layout-dagre').addEventListener('click', ()=> setCyLayout('dagre'));
  document.getElementById('cy-layout-cose').addEventListener('click', ()=> setCyLayout('cose'));
  document.getElementById('cy-fit').addEventListener('click', cyFit);
  document.getElementById('cy-detail-close').addEventListener('click', closeCyDetail);
  setCyLayout(CY_LAYOUT_NAME);
}

