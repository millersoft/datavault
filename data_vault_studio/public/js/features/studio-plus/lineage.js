/* Studio Plus — lineage model and its Focus / Concept / Entire / Matrix views. */
function spLineageModelSources(view){
  const declared=new Set((view&&view.sourceObjects||[]).filter(Boolean));
  const sql=String(view&&view.sql||'');
  if(!sql.trim())return [...declared];
  const candidates=[
    ...spSchemaTables.map(t=>t.name),
    ...spManagedBvObjects().flatMap(o=>[o.name,o.deployedName].filter(Boolean)),
    ...spManagedViews().flatMap(v=>[v.name,v.deployedName].filter(Boolean)),
  ].filter(n=>n&&!spIsTechnicalViewName(n)&&String(n).toLowerCase()!==String(view&&view.name||'').toLowerCase());
  candidates.forEach(name=>{
    const escaped=String(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp(`(?:^|[^A-Za-z0-9_])(?:["\\[]?${escaped}["\\]]?)(?=$|[^A-Za-z0-9_])`,'i');
    if(re.test(sql))declared.add(name);
  });
  return [...declared];
}
function spLineageModel(){
  const nodes=new Map(),edges=[];
  const addNode=(id,name,kind,status='',detail={})=>{if(!nodes.has(id))nodes.set(id,{id,name,kind,status,...detail});return id;};
  const addEdge=(from,to)=>{if(from&&to&&from!==to&&!edges.some(e=>e.from===from&&e.to===to))edges.push({from,to});};
  const rawByName=new Map();
  // Lineage should preserve the original source ancestry even for restored or
  // imported projects where an old source table is no longer marked included.
  // If a Hub/Link/Satellite still references a source table, it is part of the
  // model's provenance and must remain visible in Focus lineage.
  const modelSourceIds=new Set([
    ...(state.hubs||[]).map(o=>o.tableId),
    ...(state.links||[]).map(o=>o.tableId),
    ...(state.hubSats||[]).map(o=>o.tableId),
    ...(state.linkSats||[]).map(o=>o.tableId),
  ].filter(Boolean));
  const lineageSources=(state.tables||[]).filter(t=>!spIsTechnicalViewName(t.name) && (t.included!==false || modelSourceIds.has(t.id)));
  lineageSources.forEach(t=>{
    const src=addNode(`source:${t.id}`,t.name,'source',isSourceView(t)?'Source view':'Source table',{tableId:t.id});
    const stgName=typeof stagingViewName==='function'?stagingViewName(t.name):`stg_${t.name}`;
    const stg=addNode(`staging:${t.id}`,stgName,'staging','Staging',{tableId:t.id});
    addEdge(src,stg);
  });
  const addRaw=(name,label,tableId,subtype)=>{
    const id=addNode(`raw:${name}`,label||name,'raw',subtype||'Raw Vault',{tableId,physicalName:name,schema:spConn.schema||spConn.database});
    rawByName.set(String(name).toLowerCase(),id);
    if(tableId)addEdge(`staging:${tableId}`,id);
    return id;
  };
  (state.hubs||[]).forEach(h=>addRaw(hubName(h.entity),hubName(h.entity),h.tableId,'Hub'));
  (state.links||[]).forEach(l=>addRaw(linkNameOf(l.entity),linkNameOf(l.entity),l.tableId,'Link'));
  (state.hubSats||[]).forEach(sat=>addRaw(satName(sat.entity,sat.concern),satName(sat.entity,sat.concern),sat.tableId,'Satellite'));
  (state.linkSats||[]).forEach(sat=>addRaw(lsatName(sat.entity,sat.concern),lsatName(sat.entity,sat.concern),sat.tableId,'Link Satellite'));
  spSchemaTables.filter(t=>spBusinessObjectKind(t)==='Raw Vault' && !spIsTechnicalViewName(t.name)).forEach(t=>{
    if(!rawByName.has(String(t.name).toLowerCase()))rawByName.set(String(t.name).toLowerCase(),addNode(`raw:${t.name}`,t.name,'raw','Raw Vault',{physicalName:t.name,schema:t.schema||spConn.schema}));
  });

  const bvByName=new Map();
  spManagedBvObjects().forEach(o=>{
    const id=addNode(`bv:${o.name}`,o.label||o.name,'bv',`${o.type==='bridge'?'Bridge':'PIT'} · ${spBvStatusLabel(o)}`,{managedId:o.id,schema:o.deployedSchema||spBusinessSchemaName()});
    bvByName.set(String(o.name).toLowerCase(),id);if(o.deployedName)bvByName.set(String(o.deployedName).toLowerCase(),id);
    const inputs=o.type==='pit'?[o.parentHub,...(o.satellites||[])]:[...(o.links||[])];
    inputs.filter(Boolean).forEach(name=>{
      const raw=rawByName.get(String(name).toLowerCase())||addNode(`raw:${name}`,name,'raw','Raw Vault',{physicalName:name,schema:spConn.schema||spConn.database});
      rawByName.set(String(name).toLowerCase(),raw);addEdge(raw,id);
    });
  });

  // Add every Business Model node first, then wire dependencies. This matters
  // for older projects that accidentally composed one Business Model from
  // another: lineage should reveal that dependency rather than misclassifying
  // the upstream model as a Raw Vault "Other" object. New AI planning excludes
  // Business Models from valid source inputs.
  const curatedByName=new Map();
  spManagedViews().filter(v=>!spIsTechnicalViewName(v.name)).forEach(v=>{
    const id=addNode(`curated:${v.name}`,v.label||v.name,'curated',`${spMaterializationLabel(v)} · ${spViewStatusLabel(v)}`,{managedId:v.id,schema:v.deployedSchema||spBusinessSchemaName()});
    curatedByName.set(String(v.name).toLowerCase(),id);if(v.deployedName)curatedByName.set(String(v.deployedName).toLowerCase(),id);
  });
  spManagedViews().filter(v=>!spIsTechnicalViewName(v.name)).forEach(v=>{
    const id=curatedByName.get(String(v.name).toLowerCase());
    spLineageModelSources(v).filter(name=>!spIsTechnicalViewName(name)).forEach(name=>{
      const key=String(name).toLowerCase();
      const upstreamModel=curatedByName.get(key),bv=bvByName.get(key),raw=rawByName.get(key);
      if(upstreamModel&&upstreamModel!==id)addEdge(upstreamModel,id);
      else if(bv)addEdge(bv,id);
      else if(raw)addEdge(raw,id);
      else {
        const table=spRawSchemaTable(name);
        if(table&&spBusinessObjectKind(table)==='Raw Vault')addEdge(addNode(`raw:${name}`,name,'raw','Raw Vault',{physicalName:name,schema:spConn.schema||spConn.database}),id);
      }
    });
  });

  // Only saved reports are lineage consumers. A selected reporting scope or a
  // transient generated preview is not yet a managed dependency, so it should
  // not appear as if something downstream has been deployed/saved.
  spManagedReports().forEach(saved=>{
    const report=addNode(`report:${saved.id}`,saved.name||'Report','report','Saved report',{managedId:saved.id});
    (saved.sourceModels||[]).filter(name=>!spIsTechnicalViewName(name)).forEach(name=>{
      const curated=curatedByName.get(String(name).toLowerCase());if(curated)addEdge(curated,report);
    });
  });
  return {nodes:[...nodes.values()],edges};
}

function spLineageRelations(model,id){
  const up=new Set(),down=new Set();
  const walk=(current,direction,set)=>{
    model.edges.forEach(e=>{
      const next=direction==='up'?(e.to===current?e.from:null):(e.from===current?e.to:null);
      if(next&&!set.has(next)){set.add(next);walk(next,direction,set);}
    });
  };
  if(id){walk(id,'up',up);walk(id,'down',down);}return {up,down};
}
function spLineageFocusedIds(model,id,depth=2,direction='both'){
  const keep=new Set();if(!id)return keep;keep.add(id);
  const walk=(start,dir)=>{
    let frontier=new Set([start]);const seen=new Set([start]);
    for(let level=0;level<depth;level++){
      const next=new Set();
      frontier.forEach(current=>model.edges.forEach(e=>{
        const candidate=dir==='up'?(e.to===current?e.from:null):(e.from===current?e.to:null);
        if(candidate&&!seen.has(candidate)){seen.add(candidate);keep.add(candidate);next.add(candidate);}
      }));
      if(!next.size)break;frontier=next;
    }
  };
  if(direction==='up'||direction==='both')walk(id,'up');
  if(direction==='down'||direction==='both')walk(id,'down');
  return keep;
}
function spLineageCollapseStaging(model){
  const stagingIds=new Set(model.nodes.filter(n=>n.kind==='staging').map(n=>n.id));
  if(!stagingIds.size)return model;
  const nodes=model.nodes.filter(n=>!stagingIds.has(n.id));
  const edges=[];const add=(from,to)=>{if(from&&to&&from!==to&&!edges.some(e=>e.from===from&&e.to===to))edges.push({from,to});};
  model.edges.forEach(e=>{if(!stagingIds.has(e.from)&&!stagingIds.has(e.to))add(e.from,e.to);});
  stagingIds.forEach(stg=>{
    const upstream=model.edges.filter(e=>e.to===stg).map(e=>e.from);
    const downstream=model.edges.filter(e=>e.from===stg).map(e=>e.to);
    upstream.forEach(a=>downstream.forEach(b=>add(a,b)));
  });
  return {nodes,edges};
}
function spLineageFocusModel(full,id){
  if(!id)return {nodes:[],edges:[]};
  // Focus is deliberately asymmetric: show the complete upstream lineage for
  // the selected Business Model, then only reports that directly consume it.
  // Do not fan out into other downstream Business Models — that is impact
  // analysis rather than the model-focused view the user is asking for.
  const keep=spLineageFocusedIds(full,id,99,'up');keep.add(id);
  full.edges.forEach(e=>{
    if(e.from===id){const n=full.nodes.find(x=>x.id===e.to);if(n&&n.kind==='report')keep.add(n.id);}
  });
  const visible=new Set(full.nodes.filter(n=>keep.has(n.id)&&!spIsTechnicalViewName(n.name)).map(n=>n.id));
  const focused={nodes:full.nodes.filter(n=>visible.has(n.id)),edges:full.edges.filter(e=>visible.has(e.from)&&visible.has(e.to))};
  return spLineageCollapseStaging(focused);
}
function spLineagePreferredSelection(model){
  if(spLineageSelection&&model.nodes.some(n=>n.id===spLineageSelection&&!spIsTechnicalViewName(n.name)))return spLineageSelection;
  const curated=model.nodes.find(n=>n.kind==='curated'&&!spIsTechnicalViewName(n.name));
  if(curated)return curated.id;
  const preferred=['report','bv','raw','staging','source'];
  for(const kind of preferred){const node=model.nodes.find(n=>n.kind===kind&&!spIsTechnicalViewName(n.name));if(node)return node.id;}
  return '';
}
function spLineageLayerLabel(kind){return ({source:'Source',staging:'Staging',raw:'Raw Vault',bv:'Business Vault',curated:'Business Models',report:'Reporting'})[kind]||kind;}
function spLineageGraphHtml(full,model,{compact=false,mini=false}={}){
  const order=['source','staging','raw','bv','curated','report'].filter(k=>model.nodes.some(n=>n.kind===k));
  if(!order.length)return '<div class="ai-status">No lineage objects match the current selection.</div>';
  const groups=Object.fromEntries(order.map(k=>[k,model.nodes.filter(n=>n.kind===k&&!spIsTechnicalViewName(n.name)).sort((a,b)=>a.name.localeCompare(b.name))]));
  const maxCount=Math.max(1,...order.map(k=>groups[k].length));
  const rowGap=mini?25:(compact?34:32),nodeH=mini?18:(compact?26:22),nodeW=mini?112:(compact?144:122),colGap=mini?140:(compact?178:158);
  const height=Math.max(mini?170:(compact?220:230),maxCount*rowGap+36),width=Math.max(520,20+order.length*colGap);
  const xs=Object.fromEntries(order.map((k,i)=>[k,20+i*colGap]));const pos=new Map();
  order.forEach(kind=>{const arr=groups[kind];const total=(arr.length-1)*rowGap+nodeH;const y0=Math.max(20,(height-total)/2);arr.forEach((n,i)=>pos.set(n.id,{x:xs[kind],y:y0+i*rowGap,kind}));});
  const paths=model.edges.map(e=>{const a=pos.get(e.from),b=pos.get(e.to);if(!a||!b)return '';const x1=a.x+nodeW,y1=a.y+nodeH/2,x2=b.x,y2=b.y+nodeH/2,mid=(x1+x2)/2;return `<path class="sp-lineage-link ${mini?'mini':''}" data-sp-lineage-from="${escapeHtml(e.from)}" data-sp-lineage-to="${escapeHtml(e.to)}" d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}"/>`;}).join('');
  const boxes=model.nodes.filter(n=>!spIsTechnicalViewName(n.name)).map(n=>{const p=pos.get(n.id);if(!p)return '';const limit=mini?17:(compact?21:17);const text=String(n.name||'').length>limit?String(n.name).slice(0,limit-1)+'…':String(n.name||'');const cls=['sp-lineage-node',`sp-lineage-${n.kind}`,mini?'mini':'',n.id===spLineageSelection?'selected':''].filter(Boolean).join(' ');return `<g class="${cls}" data-sp-lineage-node="${escapeHtml(n.id)}" data-sp-lineage-name="${escapeHtml(String(n.name||'').toLowerCase())}" data-sp-lineage-kind="${escapeHtml(n.kind)}" tabindex="0" role="button"><title>${escapeHtml(n.name)}${n.status?` — ${escapeHtml(n.status)}`:''}</title><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="${mini?4:6}"/><text x="${p.x+8}" y="${p.y+(mini?13:compact?17:15)}">${escapeHtml(text)}</text></g>`;}).join('');
  return `<div class="sp-lineage-scroll ${mini?'sp-lineage-entire-scroll':''}"><svg class="sp-lineage-svg ${mini?'sp-lineage-svg-mini':''}" style="width:${Math.round(100*spLineageZoom)}%;min-width:${Math.round(width*spLineageZoom)}px" data-sp-lineage-base-width="${width}" viewBox="0 0 ${width} ${height}" role="img" aria-label="End-to-end data lineage">${paths}${boxes}</svg></div>`;
}
function spLineageNodeDetail(model){
  const node=model.nodes.find(n=>n.id===spLineageSelection);if(!node)return '';
  const rel=spLineageRelations(model,node.id);const names=set=>[...set].map(id=>model.nodes.find(n=>n.id===id)).filter(n=>n&&!spIsTechnicalViewName(n.name)).map(n=>n.name);
  const upstream=names(rel.up),downstream=names(rel.down);
  return `<div class="sp-lineage-detail"><div><span class="sp-bv-source-kind">${escapeHtml(spLineageLayerLabel(node.kind))}</span><strong>${escapeHtml(node.name)}</strong><p class="hint">${escapeHtml(node.status||'')}</p></div><div><strong>${upstream.length}</strong><span class="hint"> upstream</span></div><div><strong>${downstream.length}</strong><span class="hint"> downstream</span></div>${upstream.length?`<p class="hint"><strong>Upstream:</strong> ${escapeHtml(upstream.slice(0,6).join(' · '))}${upstream.length>6?' …':''}</p>`:''}${downstream.length?`<p class="hint"><strong>Downstream:</strong> ${escapeHtml(downstream.slice(0,6).join(' · '))}${downstream.length>6?' …':''}</p>`:''}</div>`;
}
function spApplyLineageSearchDom(el){
  const q=String(spLineageSearch||'').trim().toLowerCase();
  el.querySelectorAll('[data-sp-lineage-node]').forEach(node=>node.classList.toggle('search-dim',!!q&&!String(node.dataset.spLineageName||'').includes(q)));
}
function spApplyLineageSelectionDom(el){
  const model=spLineageModel(),rel=spLineageRelations(model,spLineageSelection);const related=new Set([spLineageSelection,...rel.up,...rel.down].filter(Boolean));
  el.querySelectorAll('[data-sp-lineage-node]').forEach(node=>{const id=node.dataset.spLineageNode;node.classList.toggle('selected',!!spLineageSelection&&id===spLineageSelection);node.classList.toggle('related',!!spLineageSelection&&id!==spLineageSelection&&related.has(id));node.classList.toggle('dim',spLineageMode==='entire'&&!!spLineageSelection&&!related.has(id));});
  el.querySelectorAll('[data-sp-lineage-from]').forEach(path=>{const from=path.dataset.spLineageFrom,to=path.dataset.spLineageTo;const active=!spLineageSelection||(related.has(from)&&related.has(to))||from===spLineageSelection||to===spLineageSelection;path.classList.toggle('dim',spLineageMode==='entire'&&!active);});
  const host=el.querySelector('#sp-lineage-detail-host');if(host)host.innerHTML=spLineageNodeDetail(model);
}
function spApplyLineageZoomDom(el){
  const svg=el.querySelector('.sp-lineage-svg');if(svg){const base=Number(svg.dataset.spLineageBaseWidth)||900;svg.style.width=`${Math.round(100*spLineageZoom)}%`;svg.style.minWidth=`${Math.round(base*spLineageZoom)}px`;}
  const label=el.querySelector('#sp-lineage-zoom-label');if(label)label.textContent=`${Math.round(spLineageZoom*100)}%`;
}
function spLineageFocusOptions(full){
  const curated=full.nodes.filter(n=>n.kind==='curated'&&!spIsTechnicalViewName(n.name)).sort((a,b)=>a.name.localeCompare(b.name));
  if(curated.length)return `<optgroup label="Business Models">${curated.map(n=>`<option value="${escapeHtml(n.id)}" ${n.id===spLineageSelection?'selected':''}>${escapeHtml(n.name)}</option>`).join('')}</optgroup>`;
  const fallback=full.nodes.filter(n=>['bv','raw'].includes(n.kind)&&!spIsTechnicalViewName(n.name)).sort((a,b)=>a.name.localeCompare(b.name));
  return fallback.length?`<optgroup label="Available objects">${fallback.map(n=>`<option value="${escapeHtml(n.id)}" ${n.id===spLineageSelection?'selected':''}>${escapeHtml(n.name)}</option>`).join('')}</optgroup>`:'';
}
function spLineageFocusHtml(full){
  spLineageSelection=spLineagePreferredSelection(full);
  const focused=spLineageFocusModel(full,spLineageSelection);
  const options=spLineageFocusOptions(full);
  const selected=full.nodes.find(n=>n.id===spLineageSelection);
  const legacyUpstream=selected&&focused.nodes.some(n=>n.kind==='curated'&&n.id!==selected.id);
  return `<div class="sp-lineage-focusbar sp-lineage-focusbar-simple"><div class="field"><label>Focus Business Model</label><select id="sp-lineage-focus">${options}</select></div><div class="sp-lineage-focus-note"><strong>Full relevant chain</strong><span class="hint">Starts at the original source tables. Staging is collapsed because it is a 1:1 technical step; only the selected model's upstream dependencies and reports using it are shown.</span></div></div>${legacyUpstream?`<div class="ai-status mt">This model currently depends on another Business Model. New AI plans no longer create model-on-model dependencies; review this model's sources if you want to flatten it onto Raw/Business Vault objects.</div>`:''}<div id="sp-lineage-detail-host">${spLineageNodeDetail(focused)}</div>${spLineageGraphHtml(full,focused,{compact:true})}`;
}

function spConceptLineageModel(){
  const nodes=[],edges=[];const hubById=new Map();
  (state.hubs||[]).forEach(h=>{const sats=(state.hubSats||[]).filter(s=>s.hubId===h.id||s.parentHubId===h.id||s.entity===h.entity);const sourceIds=new Set([h.tableId,...sats.map(s=>s.tableId)].filter(Boolean));const id=`concept:hub:${h.id}`;hubById.set(h.id,id);nodes.push({id,name:hubName(h.entity),kind:'hub',sub:`${sats.length} sat${sats.length===1?'':'s'} · ${sourceIds.size} src${sourceIds.size===1?'':'s'}`});});
  (state.links||[]).forEach(l=>{const id=`concept:link:${l.id}`;nodes.push({id,name:linkNameOf(l.entity),kind:'link',sub:'Link'});(l.hubs||[]).forEach(hr=>{const hub=hubById.get(hr.hubId);if(hub)edges.push({from:hub,to:id});});});
  return {nodes,edges};
}
function spConceptHtml(){
  const model=spConceptLineageModel();if(!model.nodes.length)return '<div class="ai-status">The loaded project does not contain enough design metadata for Concept view.</div>';
  const hubs=model.nodes.filter(n=>n.kind==='hub'),links=model.nodes.filter(n=>n.kind==='link');
  const hubIds=new Set(hubs.map(h=>h.id));
  const linkHubs=new Map();
  links.forEach(l=>linkHubs.set(l.id,model.edges.filter(e=>e.to===l.id&&hubIds.has(e.from)).map(e=>e.from)));
  const adj=new Map(hubs.map(h=>[h.id,new Set()]));
  linkHubs.forEach(ids=>{ids.forEach(a=>ids.forEach(b=>{if(a!==b)adj.get(a)?.add(b);}));});

  // Lay out each connected business concept component from its most-connected
  // Hub. This is deliberately simpler than a force graph: stable columns and
  // compact rows remain readable even for large CRM/HubSpot models.
  const remaining=new Set(hubs.map(h=>h.id)),components=[];
  while(remaining.size){
    const start=[...remaining][0],members=[],q=[start];remaining.delete(start);
    while(q.length){const id=q.shift();members.push(id);(adj.get(id)||[]).forEach(n=>{if(remaining.has(n)){remaining.delete(n);q.push(n);}});}
    components.push(members);
  }
  components.sort((a,b)=>b.length-a.length);
  const pos=new Map(),nodeW=126,nodeH=40,colGap=170,rowGap=58,padX=20,padY=22,componentGap=28;
  let yCursor=padY,maxDepth=0;
  components.forEach(members=>{
    const root=[...members].sort((a,b)=>(adj.get(b)?.size||0)-(adj.get(a)?.size||0)||a.localeCompare(b))[0];
    const depth=new Map([[root,0]]),queue=[root];
    while(queue.length){const id=queue.shift(),d=depth.get(id)||0;(adj.get(id)||[]).forEach(n=>{if(members.includes(n)&&!depth.has(n)){depth.set(n,d+1);queue.push(n);}});}
    members.forEach(id=>{if(!depth.has(id))depth.set(id,0);});
    const levels=new Map();members.forEach(id=>{const d=depth.get(id)||0;if(!levels.has(d))levels.set(d,[]);levels.get(d).push(id);maxDepth=Math.max(maxDepth,d);});
    const maxRows=Math.max(...[...levels.values()].map(a=>a.length),1);
    levels.forEach((ids,d)=>{ids.sort((a,b)=>{const na=model.nodes.find(n=>n.id===a)?.name||a,nb=model.nodes.find(n=>n.id===b)?.name||b;return na.localeCompare(nb);});ids.forEach((id,i)=>pos.set(id,{x:padX+d*colGap,y:yCursor+i*rowGap}));});
    yCursor += maxRows*rowGap + componentGap;
  });

  const linkPos=new Map();
  links.forEach((l,i)=>{const pts=(linkHubs.get(l.id)||[]).map(id=>pos.get(id)).filter(Boolean);if(!pts.length)return;let x=pts.reduce((a,p)=>a+p.x+nodeW/2,0)/pts.length,y=pts.reduce((a,p)=>a+p.y+nodeH/2,0)/pts.length;if(pts.length===1){x+=nodeW/2+24;}x+=(i%3-1)*5;y+=(Math.floor(i/3)%3-1)*4;linkPos.set(l.id,{x,y});});
  const width=Math.max(560,padX*2+(maxDepth+1)*colGap+nodeW+40),height=Math.max(180,yCursor+10);
  const paths=model.edges.map(e=>{const a=pos.get(e.from),b=linkPos.get(e.to);if(!a||!b)return '';const x1=a.x+nodeW/2,y1=a.y+nodeH/2;return `<line x1="${x1}" y1="${y1}" x2="${b.x}" y2="${b.y}" class="sp-concept-link"/>`;}).join('');
  const hubSvg=hubs.map(n=>{const p=pos.get(n.id);if(!p)return '';const max=18,label=n.name.length>max?n.name.slice(0,max-1)+'…':n.name;return `<g class="sp-concept-hub"><title>${escapeHtml(n.name)} — ${escapeHtml(n.sub)}</title><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="6"/><text x="${p.x+nodeW/2}" y="${p.y+17}" text-anchor="middle">${escapeHtml(label)}</text><text class="sub" x="${p.x+nodeW/2}" y="${p.y+31}" text-anchor="middle">${escapeHtml(n.sub)}</text></g>`;}).join('');
  const linkSvg=links.map(n=>{const p=linkPos.get(n.id);if(!p)return '';return `<g class="sp-concept-link-node"><polygon points="${p.x},${p.y-6} ${p.x+6},${p.y} ${p.x},${p.y+6} ${p.x-6},${p.y}"/><title>${escapeHtml(n.name)}</title></g>`;}).join('');
  return `<div class="sp-lineage-scroll sp-concept-scroll"><svg class="sp-concept-svg" style="min-width:${width}px" viewBox="0 0 ${width} ${height}" role="img" aria-label="Business concept relationships">${paths}${hubSvg}${linkSvg}</svg></div><p class="hint mt">Concept view shows only Hubs and their relationship Links. Long names are shortened visually; hover for the full object name.</p>`;
}

function spLineageEntireHtml(full){
  const visibleIds=new Set(full.nodes.filter(n=>spLineageLayerFilter.has(n.kind)&&!spIsTechnicalViewName(n.name)).map(n=>n.id));
  const model={nodes:full.nodes.filter(n=>visibleIds.has(n.id)),edges:full.edges.filter(e=>visibleIds.has(e.from)&&visibleIds.has(e.to))};
  return `<div class="sp-lineage-toolbar"><input type="search" id="sp-lineage-search" class="sp-source-search" placeholder="Search entire map…" value="${escapeHtml(spLineageSearch)}"><div class="sp-lineage-layers">${['source','staging','raw','bv','curated','report'].map(k=>`<label><input type="checkbox" data-sp-lineage-layer="${k}" ${spLineageLayerFilter.has(k)?'checked':''}>${spLineageLayerLabel(k)}</label>`).join('')}</div></div>${spLineageGraphHtml(full,model,{mini:true})}`;
}
function spCoverageMatrixData(){
  const sourceTables=(state.tables||[]).filter(t=>t.included!==false&&!isSourceView(t));
  const sourceById=new Map(sourceTables.map(t=>[t.id,t]));const rows=[];
  (state.hubs||[]).forEach(h=>{const related=[h,...(state.hubSats||[]).filter(s=>s.hubId===h.id||s.parentHubId===h.id||s.entity===h.entity)];const counts=new Map();related.forEach(o=>{if(o.tableId&&sourceById.has(o.tableId))counts.set(o.tableId,(counts.get(o.tableId)||0)+1);});rows.push({name:hubName(h.entity),counts});});
  (state.links||[]).forEach(l=>{const related=[l,...(state.linkSats||[]).filter(s=>s.linkId===l.id||s.parentLinkId===l.id||s.entity===l.entity)];const counts=new Map();related.forEach(o=>{if(o.tableId&&sourceById.has(o.tableId))counts.set(o.tableId,(counts.get(o.tableId)||0)+1);});rows.push({name:linkNameOf(l.entity),counts});});
  return {sourceTables,rows};
}
function spCoverageMatrixHtml(){
  const {sourceTables,rows}=spCoverageMatrixData();if(!sourceTables.length||!rows.length)return '<div class="ai-status">The loaded project does not contain enough source/design metadata for the coverage matrix.</div>';
  return `<div class="sp-matrix-scroll"><table class="sp-lineage-matrix"><thead><tr><th>Concept</th>${sourceTables.map(t=>`<th title="${escapeHtml(t.name)}">${escapeHtml(t.name.length>14?t.name.slice(0,12)+'…':t.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><th>${escapeHtml(r.name)}</th>${sourceTables.map(t=>{const n=r.counts.get(t.id)||0;return `<td class="${n?'has-value':''}">${n||''}</td>`;}).join('')}</tr>`).join('')}</tbody></table></div><p class="hint mt">Numbers show how many Hub/Link/Satellite objects for each concept are sourced from each included source table.</p>`;
}
function spLineageHtml(){
  const full=spLineageModel();
  if(!full.nodes.length)return `<div class="panel"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>Lineage</h3></div><div class="ai-status">Create or load project metadata to see end-to-end lineage.</div></div>`;
  const modeButtons=[['focus','Focus'],['concept','Concept'],['entire','Entire'],['matrix','Matrix']].map(([mode,label])=>`<button type="button" class="btn small ${spLineageMode===mode?'primary':'ghost'}" data-sp-lineage-mode="${mode}">${label}</button>`).join('');
  let body='';
  if(spLineageMode==='focus')body=spLineageFocusHtml(full);
  else if(spLineageMode==='concept')body=spConceptHtml();
  else if(spLineageMode==='entire')body=spLineageEntireHtml(full);
  else body=spCoverageMatrixHtml();
  const zoomControls=['focus','entire'].includes(spLineageMode)?`<div class="sp-bv-actions"><button class="btn small ghost" id="btn-sp-lineage-out">−</button><span class="hint" id="sp-lineage-zoom-label">${Math.round(spLineageZoom*100)}%</span><button class="btn small ghost" id="btn-sp-lineage-in">+</button><button class="btn small ghost" id="btn-sp-lineage-reset">Reset</button></div>`:'';
  return `<div class="panel sp-lineage-panel"><div class="panel-head" style="margin:-18px -20px 16px;"><h3>Lineage</h3></div><p class="section-desc">Focus is the default: choose a business model and see only its relevant end-to-end chain. Concept groups the Vault by business concept; Entire is a compact estate map; Matrix shows source-to-concept coverage.</p><div class="sp-lineage-modebar"><div class="sp-bv-actions">${modeButtons}</div>${zoomControls}</div>${body}<div class="sp-workflow-next mt"><button class="btn ghost" data-sp-workflow-step="build">← Back to Build</button><button class="btn primary" data-sp-workflow-step="reporting">Continue to Reporting →</button></div></div>`;
}
