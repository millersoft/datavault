/* =========================================================================
   HOPPER EDW MODEL IMPORT

   Hopper models are deliberately parsed in the browser.  They never contain
   credentials and importing them must not cause a network request until the
   user has selected and tested the Studio source connection.
   ========================================================================= */
function hopperImportError(message){ const error=new Error(message); error.hopperImport=true; return error; }
function hopperImportDecode(value){ return String(value||'').replace(/&(?:amp|lt|gt|quot|apos);/g,x=>({ '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'" })[x]); }
function parseHopperXml(xml){
  const source=String(xml||'').replace(/^\uFEFF/,'');
  if(!source.trim()) throw hopperImportError('The model file is empty.');
  if(/<!DOCTYPE|<!ENTITY/i.test(source)) throw hopperImportError('DOCTYPE and ENTITY declarations are not supported in Hopper model files.');
  const root={name:'#document',children:[],text:''}, stack=[root];
  const token=/<(?:!--[\s\S]*?--|!\[CDATA\[[\s\S]*?\]\]|\?[^]*?\?|\/[^>]+|[^>]+)>|[^<]+/g;
  let match;
  while((match=token.exec(source))){
    const part=match[0], current=stack[stack.length-1];
    if(part.startsWith('<!--')||part.startsWith('<?')) continue;
    if(part.startsWith('<![CDATA[')){ current.text+=part.slice(9,-3); continue; }
    if(!part.startsWith('<')){ current.text+=hopperImportDecode(part); continue; }
    if(part.startsWith('</')){
      const name=part.slice(2,-1).trim();
      if(stack.length===1||current.name!==name) throw hopperImportError(`Malformed XML near closing tag </${name}>.`);
      stack.pop(); continue;
    }
    if(part.startsWith('<!')) throw hopperImportError('Unsupported XML declaration in model file.');
    const selfClosing=/\/\s*>$/.test(part), name=(part.slice(1,selfClosing?-2:-1).trim().match(/^([^\s/>]+)/)||[])[1];
    if(!name) throw hopperImportError('Malformed XML element.');
    const node={name,children:[],text:''}; current.children.push(node);
    if(!selfClosing) stack.push(node);
  }
  if(stack.length!==1) throw hopperImportError(`Malformed XML: <${stack[stack.length-1].name}> is not closed.`);
  if(root.children.length!==1) throw hopperImportError('The model file must contain exactly one root element.');
  return root.children[0];
}
function hopperChild(node,name){ return (node.children||[]).find(child=>child.name===name)||null; }
function hopperChildren(node,name){ return (node.children||[]).filter(child=>child.name===name); }
function hopperText(node,name,required=false){ const child=hopperChild(node,name), value=child?String(child.text||'').trim():''; if(required&&!value) throw hopperImportError(`Missing required <${name}> in <${node.name}>.`); return value; }
function hopperTextList(node,container,item){ const box=hopperChild(node,container); return box?hopperChildren(box,item).map(x=>String(x.text||'').trim()).filter(Boolean):[]; }
function hopperNonEmpty(node,name){ const child=hopperChild(node,name); return !!(child&&((child.children||[]).length||String(child.text||'').trim())); }
function hopperUnique(items,key,label){ const seen=new Set(); items.forEach(item=>{ const value=String(item[key]||'').toLowerCase(); if(!value||seen.has(value)) throw hopperImportError(`Duplicate or blank ${label} "${item[key]||'?'}".`); seen.add(value); }); }
function hopperModelEntity(name,prefix,modelName,label){
  const required=`${prefix}_${modelName}_`;
  const value=String(name||'');
  // Studio exports include the model name (hub_sales_customer), while
  // Hopper's own designer emits its conventional short forms (hub_customer
  // and lnk_customer_address). Both are unambiguous model constructs.
  const nativePrefix=prefix==='link' ? 'lnk_' : `${prefix}_`;
  if(!value.startsWith(required) && !value.startsWith(nativePrefix)) throw hopperImportError(`${label} "${name}" does not use a supported ${prefix}_ naming convention.`);
  const entity=value.startsWith(required) ? value.slice(required.length) : value.slice(nativePrefix.length);
  if(!entity) throw hopperImportError(`${label} "${name}" has no entity name.`);
  return entity;
}

function parseHopperSourceModel(xml){
  const root=parseHopperXml(xml);
  if(root.name!=='source-model') throw hopperImportError('Expected a Hopper <source-model> (.hsm) file.');
  const config=hopperChild(root,'configuration');
  if(hopperNonEmpty(root,'queries')) throw hopperImportError('Hopper source-model queries are not supported; import database tables instead.');
  const model={ name:hopperText(root,'name',true), sourceConnection:config?hopperText(config,'defaultDatabase'): '', schema:config?hopperText(config,'defaultSchema'): '', catalogConnection:config?hopperText(config,'catalogConnection'): '', tables:[], relationships:[], warnings:[] };
  if(!config) model.warnings.push('This Hopper source model has no <configuration>; Studio will use the selected source connection and each table\'s declared database name only as a label.');
  const tables=hopperChild(root,'tables'); if(!tables) throw hopperImportError('The source model has no <tables> section.');
  hopperChildren(tables,'table').forEach(node=>{
    const physicalType=hopperText(node,'physicalType',true);
    if(physicalType!=='DATABASE') throw hopperImportError(`Source "${hopperText(node,'name')||'?'}" is ${physicalType}; only DATABASE sources are supported.`);
    const tableName=hopperText(node,'tableName',true), databaseName=hopperText(node,'databaseName');
    const table={ recordName:hopperText(node,'catalogSourceName')||tableName, name:tableName, schema:hopperText(node,'schemaName')||model.schema, databaseName, columns:[] };
    if(!model.sourceConnection && databaseName) model.sourceConnection=databaseName;
    const columns=hopperChild(node,'columns'); if(!columns) throw hopperImportError(`Source table "${table.name}" has no columns.`);
    hopperChildren(columns,'column').forEach(column=>table.columns.push({ name:hopperText(column,'name',true), type:hopperText(column,'sourceDataType'), length:hopperText(column,'length'), precision:hopperText(column,'precision'), pkPosition:Number(hopperText(column,'primaryKeyPosition')||0) }));
    hopperUnique(table.columns,'name',`column in source table ${table.name}`); model.tables.push(table);
  });
  hopperUnique(model.tables,'recordName','Hopper source record');
  const rels=hopperChild(root,'relationships');
  hopperChildren(rels||{children:[]},'relationship').forEach(node=>{
    const relationship={ name:hopperText(node,'name')||'relationship', childTable:hopperText(node,'childTableName',true), parentTable:hopperText(node,'parentTableName',true), childColumns:hopperTextList(node,'child_columns','child_column'), parentColumns:hopperTextList(node,'parent_columns','parent_column') };
    if(!relationship.childColumns.length||relationship.childColumns.length!==relationship.parentColumns.length) throw hopperImportError(`Relationship "${relationship.name}" has incomplete column mappings.`);
    model.relationships.push(relationship);
  });
  return model;
}

function parseHopperDataVaultModel(xml, source){
  const root=parseHopperXml(xml);
  if(root.name!=='data-vault-model') throw hopperImportError('Expected a Hopper <data-vault-model> (.hdv) file.');
  const modelName=hopperText(root,'name',true);
  const result={name:modelName,hubs:[],links:[],hubSats:[],linkSats:[],warnings:[]};
  const tables=hopperChild(root,'tables'); if(!tables) throw hopperImportError('The Data Vault model has no <tables> section.');
  const sourceByRecord=new Map(source.tables.map(table=>[table.recordName,table]));
  const raw=hopperChildren(tables,'table');
  raw.forEach(node=>{
    const type=hopperText(node,'tableType',true), name=hopperText(node,'tableName',true);
    if(hopperText(node,'integrationMode')&&hopperText(node,'integrationMode')!=='HOP_MANAGED') throw hopperImportError(`${type} "${name}" is not HOP_MANAGED.`);
    if(hopperNonEmpty(node,'customUpdatePipelinePaths')||hopperNonEmpty(node,'dependentChildKeys')||hopperNonEmpty(node,'drivingKey')||hopperNonEmpty(node,'drivingKeySourceField')) throw hopperImportError(`${type} "${name}" uses a Hopper feature not supported by Studio import.`);
    if(type==='HUB'){
      const keys=hopperChildren(node,'businessKeys').map(key=>({ name:hopperText(key,'name',true), sourceField:hopperText(key,'sourceFieldName',true), recordSource:hopperText(key,'recordSourceName',true) }));
      if(!keys.length) throw hopperImportError(`Hub "${name}" has no business keys.`);
      result.hubs.push({name,entity:hopperModelEntity(name,'hub',modelName,'Hub'),keys,recordSources:hopperTextList(node,'recordSources','recordSource')});
    } else if(type==='LINK') {
      const sources=hopperChildren(hopperChild(node,'linkHubSources')||{children:[]},'linkHubSource').map(sourceNode=>({ source:hopperText(sourceNode,'source',true), hubs:hopperChildren(hopperChild(sourceNode,'hubSourceKeyFields')||{children:[]},'hubSourceKeyField').map(hub=>({ hubName:hopperText(hub,'hubName',true), keys:hopperChildren(hopperChild(hub,'businessKeySources')||{children:[]},'businessKeySource').map(key=>({businessKey:hopperText(key,'businessKeyField',true),sourceField:hopperText(key,'sourceFieldName',true)})) })) }));
      if(sources.length!==1) throw hopperImportError(`Link "${name}" must have exactly one Studio-compatible link source.`);
      result.links.push({name,entity:hopperModelEntity(name,'link',modelName,'Link'),source:sources[0]});
    } else if(type==='SATELLITE') {
      const attrs=hopperChildren(node,'attributes').map(attr=>({name:hopperText(attr,'name',true)}));
      if(!attrs.length) throw hopperImportError(`Satellite "${name}" has no attributes.`);
      const hub=hopperText(node,'hub'), link=hopperText(node,'link'), recordSource=hopperText(node,'recordSource',true);
      if((hub?1:0)+(link?1:0)!==1) throw hopperImportError(`Satellite "${name}" must reference exactly one Hub or Link.`);
      const parentName=hub||link;
      result[hub?'hubSats':'linkSats'].push({name,parentName,recordSource,attrs});
    } else if(type==='REFERENCE') {
      // Hopper Reference tables have no Studio model equivalent. The source
      // table itself remains available after import, but this vault object is
      // deliberately not silently converted into a Hub or Satellite.
      result.warnings.push(`Reference table "${name}" was skipped because Studio does not model Hopper REFERENCE tables.`);
    } else throw hopperImportError(`Unsupported Hopper table type "${type}" in "${name}".`);
  });
  hopperUnique(result.hubs,'name','Hub'); hopperUnique(result.links,'name','Link');
  const hubs=new Map(result.hubs.map(h=>[h.name,h])); const links=new Map(result.links.map(l=>[l.name,l]));
  result.hubSats.forEach(s=>{ const hub=hubs.get(s.parentName); if(!hub) throw hopperImportError(`Satellite "${s.name}" references missing Hub "${s.parentName}".`); const studioBase=`sat_${modelName}_${hub.entity}`, nativeBase=`sat_${hub.entity}`; if(!s.name.startsWith(studioBase)&&!s.name.startsWith(nativeBase)) throw hopperImportError(`Satellite "${s.name}" does not use a supported Hub Satellite naming convention.`); const base=s.name.startsWith(studioBase)?studioBase:nativeBase; s.entity=hub.entity; s.concern=s.name.slice(base.length).replace(/^_/,''); });
  result.linkSats.forEach(s=>{ const link=links.get(s.parentName); if(!link) throw hopperImportError(`Satellite "${s.name}" references missing Link "${s.parentName}".`); const studioBase=`lsat_${modelName}_${link.entity}`, nativeBase=`sat_${s.parentName}`; if(!s.name.startsWith(studioBase)&&!s.name.startsWith(nativeBase)) throw hopperImportError(`Satellite "${s.name}" does not use a supported Link Satellite naming convention.`); const base=s.name.startsWith(studioBase)?studioBase:nativeBase; s.entity=link.entity; s.concern=s.name.slice(base.length).replace(/^_/,''); });
  // Link satellites carry their attribute sources under their parent Link.
  raw.filter(node=>hopperText(node,'tableType')==='LINK').forEach(node=>{
    hopperChildren(hopperChild(node,'linkSatelliteSources')||{children:[]},'linkSatelliteSource').forEach(src=>{
      const record=hopperText(src,'source',true);
      hopperChildren(hopperChild(src,'satelliteSourceKeyFields')||{children:[]},'satelliteSourceKeyField').forEach(item=>{
        const satellite=result.linkSats.find(s=>s.name===hopperText(item,'satelliteName',true)); if(!satellite) throw hopperImportError(`Link satellite mapping references an unknown satellite.`);
        satellite.recordSource=record;
        const maps=hopperChildren(hopperChild(item,'attributeSources')||{children:[]},'attributeSource');
        maps.forEach(map=>{ const attr=satellite.attrs.find(a=>a.name===hopperText(map,'attributeField',true)); if(attr) attr.sourceField=hopperText(map,'sourceFieldName',true); });
      });
    });
  });
  [...result.hubs,...result.links,...result.hubSats,...result.linkSats].forEach(item=>{ const records=item.recordSources||[item.recordSource||item.source&&item.source.source].filter(Boolean); records.forEach(record=>{if(!sourceByRecord.has(record)) throw hopperImportError(`Hopper record source "${record}" is not present in the HSM.`);}); });
  return result;
}

function buildHopperImportDraft(hsm,hdv){ const source=parseHopperSourceModel(hsm); const vault=hdv?parseHopperDataVaultModel(hdv,source):null; if(vault&&vault.name!==source.name) throw hopperImportError(`The HDV model name "${vault.name}" does not match HSM model name "${source.name}".`); return {source,vault,warnings:[...(source.warnings||[]),...(vault&&vault.warnings||[])]}; }
function hopperFindLiveTable(tables, schema, name){
  // Native Hopper source models may omit schemaName. In that case the
  // selected connection is authoritative, provided the table name is unique
  // across what that connection returns.
  const scoped=(schema==null||String(schema).trim()==='') ? tables : tables.filter(t=>String(t.schema||'')===String(schema||''));
  const exact=scoped.filter(t=>String(t.name)===String(name)); if(exact.length===1)return exact[0];
  const folded=scoped.filter(t=>String(t.name).toLowerCase()===String(name).toLowerCase()); return folded.length===1?folded[0]:null;
}
function hopperFindLiveColumn(table,name){ const exact=(table.columns||[]).filter(c=>String(c.name)===String(name)); if(exact.length===1)return exact[0]; const folded=(table.columns||[]).filter(c=>String(c.name).toLowerCase()===String(name).toLowerCase()); return folded.length===1?folded[0]:null; }
function validateHopperImportAgainstLive(draft, liveTables, choices={}){
  const errors=[],warnings=[],resolved=new Map();
  draft.source.tables.forEach(source=>{
    const live=hopperFindLiveTable(liveTables,source.schema,source.name);
    if(!live){ errors.push(`Source table "${source.schema?source.schema+'.':''}${source.name}" was not found on the selected connection.`); return; }
    const fields=new Map(); source.columns.forEach(column=>{ const selected=choices[`${source.recordName}.${column.name}`]; const field=hopperFindLiveColumn(live,selected||column.name); if(!field) errors.push(`Source field "${source.recordName}.${column.name}" needs a mapping to a live column.`); else { fields.set(column.name,field); if(column.type&&field.type&&String(column.type).toLowerCase()!==String(field.type).toLowerCase()) warnings.push(`Type differs for ${source.recordName}.${column.name}: Hopper ${column.type}, live ${field.type}.`); } });
    resolved.set(source.recordName,{source,live,fields});
  });
  const field=(record,name)=>{const entry=resolved.get(record);return entry&&entry.fields.get(name);};
  draft.source.relationships.forEach(rel=>{ const child=draft.source.tables.find(t=>t.name===rel.childTable),parent=draft.source.tables.find(t=>t.name===rel.parentTable); if(!child||!parent){errors.push(`Relationship "${rel.name}" references a source table not in the HSM.`);return;} rel.childColumns.forEach((name,i)=>{if(!field(child.recordName,name)||!field(parent.recordName,rel.parentColumns[i]))errors.push(`Relationship "${rel.name}" references an unresolved source field.`);}); });
  if(draft.vault){
    draft.vault.hubs.forEach(h=>h.keys.forEach(k=>{if(!field(k.recordSource,k.sourceField))errors.push(`Hub "${h.name}" business key "${k.name}" has no resolved source field.`);}));
    draft.vault.links.forEach(l=>l.source.hubs.forEach(h=>h.keys.forEach(k=>{if(!field(l.source.source,k.sourceField))errors.push(`Link "${l.name}" has no resolved source field "${k.sourceField}".`);})));
    draft.vault.hubSats.forEach(s=>s.attrs.forEach(a=>{if(!field(s.recordSource,a.sourceField||a.name))errors.push(`Hub satellite "${s.name}" attribute "${a.name}" needs a source-field mapping.`);}));
    draft.vault.linkSats.forEach(s=>s.attrs.forEach(a=>{if(!field(s.recordSource,a.sourceField||a.name))errors.push(`Link satellite "${s.name}" attribute "${a.name}" needs a source-field mapping.`);}));
  }
  return {errors:[...new Set(errors)],warnings:[...new Set(warnings)],resolved};
}

function applyHopperImportUnsafe(draft, validated){
  if(validated.errors.length) throw hopperImportError('Resolve all Hopper import validation errors before applying the model.');
  // Connections owns the target database.  Vault identity normally inherits
  // that value when the Vault page first opens; import happens earlier, so
  // apply the same harmless default here.
  if(!state.vault.vaultDbName && state.vault.dvDatabase) state.vault.vaultDbName=state.vault.dvDatabase;
  const identityKeys=['name','prefix','tenantId','srcCod','srcDescription','vaultDbName'];
  const missing=identityKeys.filter(key=>!String(state.vault[key]||'').trim());
  if(missing.length) throw hopperImportError(`Complete Studio identity settings before import: ${missing.join(', ')}.`);
  state.tables=[]; state.hubs=[]; state.links=[]; state.hubSats=[]; state.linkSats=[]; state.sourceMeta={foreignKeys:[],approxRows:{},relationshipSuggestions:[],hopCapabilities:state.sourceMeta&&state.sourceMeta.hopCapabilities||null};
  const byRecord=new Map();
  validated.resolved.forEach(({source,live,fields},record)=>{ const table=newTable(live.name); table.schema=live.schema||source.schema||''; table.objectType=normalizeSourceObjectType(live.objectType); table.columns=source.columns.map(spec=>{const raw=fields.get(spec.name),col=Object.assign(newColumn(raw.name,raw.type),{nullable:raw.pk?false:raw.nullable,pk:!!raw.pk,nativeType:raw.nativeType||'',jdbcType:raw.jdbcType||'',semanticType:raw.semanticType||'',profile:profileFromIntrospection(raw),typeReviewRequired:!!raw.typeReviewRequired}); if(col.name!==spec.name){col.targetName=spec.name;col.targetNameAuto=false;} return col;}); state.tables.push(table); byRecord.set(record,table); });
  const sourceForTable=name=>draft.source.tables.find(t=>t.name===name);
  draft.source.relationships.forEach(rel=>{const child=sourceForTable(rel.childTable),parent=sourceForTable(rel.parentTable); rel.childColumns.forEach((column,index)=>state.sourceMeta.foreignKeys.push({table:byRecord.get(child.recordName).name,tableSchema:byRecord.get(child.recordName).schema,column:validated.resolved.get(child.recordName).fields.get(column).name,refTable:byRecord.get(parent.recordName).name,refSchema:byRecord.get(parent.recordName).schema,refColumn:validated.resolved.get(parent.recordName).fields.get(rel.parentColumns[index]).name,constraintName:rel.name,provenance:'hopper'}));});
  if(draft.vault){
    draft.vault.hubs.forEach(h=>{const first=h.keys[0],table=byRecord.get(first.recordSource), cols=h.keys.map(k=>validated.resolved.get(k.recordSource).fields.get(k.sourceField).name),r=addHubProgrammatic(h.entity,table,cols,false); if(!r.ok) throw hopperImportError(r.reason); const hub=r.hub; const feedByRecord=new Map(); h.keys.forEach(k=>{if(!feedByRecord.has(k.recordSource))feedByRecord.set(k.recordSource,[]);feedByRecord.get(k.recordSource).push(validated.resolved.get(k.recordSource).fields.get(k.sourceField).name);}); hub.sourceFeeds=[]; feedByRecord.forEach((names,record)=>{const feedTable=byRecord.get(record),ids=names.map(name=>stagedColumns(feedTable).find(c=>c.name===name).id);hub.sourceFeeds.push({tableId:feedTable.id,keyColIds:ids});ensureKeyDerivation(feedTable,hub.entity,names,'both');}); });
    draft.vault.links.forEach(l=>{const table=byRecord.get(l.source.source),pairs=l.source.hubs.map(h=>({hub:(draft.vault.hubs.find(x=>x.name===h.hubName)||{}).entity,columns:h.keys.map(k=>validated.resolved.get(l.source.source).fields.get(k.sourceField).name)})),r=addLinkProgrammatic(l.entity,table,pairs);if(!r.ok)throw hopperImportError(r.reason);});
    draft.vault.hubSats.forEach(s=>{const table=byRecord.get(s.recordSource),hub=(draft.vault.hubs.find(h=>h.name===s.parentName)||{}).entity,attrs=s.attrs.map(a=>({column:validated.resolved.get(s.recordSource).fields.get(a.sourceField||a.name).name,target:a.name})),r=addHubSatProgrammatic(s.entity,s.concern,table,hub,attrs);if(!r.ok)throw hopperImportError(r.reason);});
    draft.vault.linkSats.forEach(s=>{const table=byRecord.get(s.recordSource),link=(draft.vault.links.find(l=>l.name===s.parentName)||{}).entity,attrs=s.attrs.map(a=>({column:validated.resolved.get(s.recordSource).fields.get(a.sourceField||a.name).name,target:a.name})),r=addLinkSatProgrammatic(s.entity,s.concern,table,link,attrs);if(!r.ok)throw hopperImportError(r.reason);});
  }
  invalidateStagingConfirmation();
  return {tables:state.tables.length,hubs:state.hubs.length,links:state.links.length,satellites:state.hubSats.length+state.linkSats.length};
}
function applyHopperImport(draft, validated){
  const before=JSON.parse(JSON.stringify(state)), beforeUid=uidCounter;
  try { return applyHopperImportUnsafe(draft,validated); }
  catch(err){ Object.assign(state,before); uidCounter=beforeUid; throw err; }
}

let hopperImportUi={draft:null,validation:null,files:null,choices:{}};
function hopperUnresolvedMappings(draft, validation){
  if(!validation) return [];
  const out=[];
  draft.source.tables.forEach(source=>{
    const entry=validation.resolved.get(source.recordName); if(!entry||!entry.live) return;
    source.columns.forEach(column=>{ if(!entry.fields.get(column.name)) out.push({key:`${source.recordName}.${column.name}`,record:source.recordName,field:column.name,columns:entry.live.columns||[]}); });
  });
  return out;
}
function renderHopperImportModal(){
  let modal=document.getElementById('hopper-import-modal'); if(!modal){modal=document.createElement('div');modal.id='hopper-import-modal';modal.className='modal-backdrop';document.body.appendChild(modal);}
  const x=hopperImportUi, draft=x.draft, result=x.validation;
  const unresolved=hopperUnresolvedMappings(draft,result);
  modal.innerHTML=`<div class="modal-card" style="max-width:850px;max-height:85vh;overflow:auto;"><div class="flex-between" style="margin-bottom:4px;"><h3 style="font-family:var(--font-display);font-size:15px;margin:0;">Import Hopper EDW models</h3><button class="btn small ghost" id="hopper-import-close">&times;</button></div>${!draft?`<p class="section-desc" style="margin-bottom:14px;">Choose the required source model and optional Data Vault model. Studio will validate them against the configured live source before changing this project.</p><div class="field"><label>Source model (.hsm)</label><input id="hopper-import-hsm" type="file" accept=".hsm,application/xml,text/xml"></div><div class="field mt"><label>Data Vault model (.hdv, optional)</label><input id="hopper-import-hdv" type="file" accept=".hdv,application/xml,text/xml"></div><button class="btn primary mt" id="hopper-import-parse">Review models</button>`:`<p class="hint">Model <span class="mono">${escapeHtml(draft.source.name)}</span> · source <span class="mono">${escapeHtml(draft.source.sourceConnection)}</span> · ${draft.source.tables.length} table(s)${draft.vault?`, ${draft.vault.hubs.length} Hub(s), ${draft.vault.links.length} Link(s)`:''}.</p><p class="hint">Using the Vault short name and staging prefix configured on Connections.</p>${result?`${result.errors.length?`<div class="ai-status err">${escapeHtml(result.errors.join(' '))}</div>`:'<div class="ai-status ok">Source model matches the selected connection.</div>'}${result.warnings.length?`<div class="ai-status busy mt">${escapeHtml(result.warnings.join(' '))}</div>`:''}${unresolved.length?`<div class="panel mt"><label>Map Hopper fields to live source columns</label><p class="hint">These logical Hopper field names differ from the selected database. The Hopper name will be retained as the Studio staging name.</p>${unresolved.map(item=>`<div class="field mt"><label>${escapeHtml(item.record)}.${escapeHtml(item.field)}</label><select data-hopper-map="${escapeHtml(item.key)}"><option value="">Choose a live column</option>${item.columns.map(column=>`<option value="${escapeHtml(column.name)}" ${hopperImportUi.choices[item.key]===column.name?'selected':''}>${escapeHtml(column.name)} · ${escapeHtml(column.type||'source column')}</option>`).join('')}</select></div>`).join('')}</div>`:''}`:''}<div class="flex-between mt"><button class="btn" id="hopper-import-restart">Choose different files</button><div><button class="btn" id="hopper-import-validate">Validate live source</button><button class="btn primary" id="hopper-import-apply" ${result&&!result.errors.length?'':'disabled'}>Apply import</button></div></div>`}</div>`;
  if(draft&&draft.warnings&&draft.warnings.length){ const note=document.createElement('div'); note.className='ai-status busy mt'; note.textContent=draft.warnings.join(' '); modal.querySelector('.modal-card').appendChild(note); }
  modal.querySelector('#hopper-import-close').addEventListener('click',()=>modal.remove());
  modal.querySelector('#hopper-import-parse')?.addEventListener('click',async()=>{try{const h=modal.querySelector('#hopper-import-hsm').files[0],d=modal.querySelector('#hopper-import-hdv').files[0];if(!h)throw hopperImportError('Choose an HSM source model file.');hopperImportUi.draft=buildHopperImportDraft(await h.text(),d?await d.text():null);hopperImportUi.files={h,d};hopperImportUi.validation=null;renderHopperImportModal();}catch(err){toast(err.message,'err');}});
  modal.querySelector('#hopper-import-restart')?.addEventListener('click',()=>{hopperImportUi={draft:null,validation:null,files:null,choices:{}};renderHopperImportModal();});
  modal.querySelectorAll('[data-hopper-map]').forEach(select=>select.addEventListener('change',()=>{hopperImportUi.choices[select.dataset.hopperMap]=select.value; hopperImportUi.validation=validateHopperImportAgainstLive(hopperImportUi.draft,hopperImportUi.liveTables||[],hopperImportUi.choices); renderHopperImportModal();}));
  modal.querySelector('#hopper-import-validate')?.addEventListener('click',async()=>{try{if(sourceConnStatus!=='ok'||targetConnStatus!=='ok')throw hopperImportError('Test both the source and Data Vault connections on Step 1 before importing.');const fallbackSchema=state.vault.dialect==='mysql'?state.vault.srcDatabase:state.vault.sourceSchema,schemas=[...new Set(hopperImportUi.draft.source.tables.map(t=>t.schema||fallbackSchema).filter(Boolean))],responses=[];for(const schema of schemas)responses.push(await fetchIntrospection(true,schema));hopperImportUi.liveTables=responses.flatMap(response=>(response.tables||[]).map(table=>({...table,schema:table.schema||response.schema||''})));hopperImportUi.validation=validateHopperImportAgainstLive(hopperImportUi.draft,hopperImportUi.liveTables,hopperImportUi.choices);renderHopperImportModal();}catch(err){toast(err.message,'err');}});
  modal.querySelector('#hopper-import-apply')?.addEventListener('click',()=>{try{const has=state.tables.length||state.hubs.length||state.links.length||state.hubSats.length||state.linkSats.length;if(has&&!confirm('Replace the current source and Vault model? Save the project first if you need to keep it.'))return;pushUndo('import Hopper EDW models');const summary=applyHopperImport(hopperImportUi.draft,hopperImportUi.validation);modal.remove();activeTab='tables';renderAll();toastUndo(`Imported ${summary.tables} table(s), ${summary.hubs} Hub(s), ${summary.links} Link(s), and ${summary.satellites} Satellite(s). Review Tables and Staging before export.`);}catch(err){toast(err.message,'err');}});
}
function hopperImportConnectionsReady(){ return appMode==='designer' && sourceConnStatus==='ok' && targetConnStatus==='ok'; }
function openHopperImport(){
  if(!hopperImportConnectionsReady()){
    appMode='designer';
    navigateDesignerTab('connections');
    toast('Complete and test both connections before importing Hopper models.','info');
    return;
  }
  hopperImportUi={draft:null,validation:null,files:null,choices:{}};
  renderHopperImportModal();
}
