/* =========================================================================
   AI ASSIST — contextual modal, triggered from Staging or Vault steps.
   Only ever sends table/column *schema* (names, types, nullability, PK
   flags) — never row data, never connection credentials or passwords.
   ========================================================================= */
/* Provider-agnostic AI settings. OpenAI, Anthropic, or any OpenAI-compatible
   endpoint (Ollama, LM Studio, a corporate gateway) via a custom base URL.
   Provider/model/base-URL choices persist in localStorage; the API key is
   only remembered if explicitly opted in. */
const AI_PROVIDERS = {
  openai:    { label:'OpenAI',    defaultModel:'gpt-4o',            keyPlaceholder:'sk-...' },
  anthropic: { label:'Anthropic', defaultModel:'claude-sonnet-4-5', keyPlaceholder:'sk-ant-...' },
  custom:    { label:'Custom (OpenAI-compatible)', defaultModel:'gpt-4o', keyPlaceholder:'key (or blank for local endpoints)' },
};
let aiProvider = (function(){ try { return localStorage.getItem('vaultStudioAiProvider') || 'openai'; } catch(_){ return 'openai'; } })();
if (!AI_PROVIDERS[aiProvider]) aiProvider = 'openai';
let aiModel = (function(){ try { return localStorage.getItem('vaultStudioAiModel') || AI_PROVIDERS[aiProvider].defaultModel; } catch(_){ return AI_PROVIDERS[aiProvider].defaultModel; } })();
let aiBaseUrl = (function(){ try { return localStorage.getItem('vaultStudioAiBaseUrl') || ''; } catch(_){ return ''; } })();
// Keep GPT-5 request behaviour consistent across users and modelling runs.
// This is an internal product setting rather than a user preference: changing
// it can alter latency and the shape of a proposal. Medium provides the
// product's fixed quality/latency balance; deterministic normalisation and
// validation remain the authority for coverage and physical object generation.
const AI_OPENAI_REASONING_EFFORT = 'medium';
// The API key lives in this variable only — remembered for as long as the
// tab is open, NEVER written to localStorage. (Also scrub any key a previous
// build may have persisted.)
let aiKey = '';
try { localStorage.removeItem('vaultStudioAiKey'); localStorage.removeItem('vaultStudioAiRememberKey'); } catch(_){}
function persistAiSettings(){
  try {
    localStorage.setItem('vaultStudioAiProvider', aiProvider);
    localStorage.setItem('vaultStudioAiModel', aiModel);
    localStorage.setItem('vaultStudioAiBaseUrl', aiBaseUrl);
    // Remove the preference used by v7. AI request behaviour is now fixed by
    // the product so two users cannot unknowingly request different designs.
    localStorage.removeItem('vaultStudioAiResponseSpeed');
  } catch(_){}
}

// Models (Anthropic especially) often wrap JSON in markdown fences or add a
// sentence around it — extract the outermost JSON object robustly.
function extractJsonObject(text){
  if (!text) throw new Error('No content returned from the model.');
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch(_){}
  const first = t.indexOf('{'), last = t.lastIndexOf('}');
  if (first !== -1 && last > first){
    try { return JSON.parse(t.slice(first, last+1)); } catch(_){}
  }
  throw new Error('Could not parse JSON from the model response.');
}

// Models which reject an explicit temperature are remembered for the life of
// the page. This avoids paying for the same failed request on every AI action.
const aiNoTemperatureModels = new Set();
const aiNoReasoningEffortModels = new Set();
function aiModelCapabilityKey(){
  const endpoint = aiProvider==='custom' ? (aiBaseUrl || '').replace(/\/+$/,'').toLowerCase() : aiProvider;
  return `${endpoint}|${String(aiModel || '').trim().toLowerCase()}`;
}
function aiModelUsesDefaultTemperature(model){
  const m = String(model || '').trim().toLowerCase();
  // GPT-5 reasoning models reject non-default temperature values. Omit the
  // optional field up front rather than deliberately causing a 400 + retry.
  return /^gpt-5(?:[.\-]|$)/.test(m);
}
function aiModelUsesReasoningEffort(model){
  return /^gpt-5(?:[.\-]|$)/.test(String(model || '').trim().toLowerCase());
}

// One call surface for every AI feature in the app (Staging/Vault assist,
// jdbc_fdw helper, Studio Plus). Returns the parsed JSON object.
async function aiChat(rules, userMsg, temperature){
  if (!aiKey && aiProvider!=='custom'){ throw new Error(`Enter your ${AI_PROVIDERS[aiProvider].label} API key first.`); }
  if (aiProvider === 'anthropic'){
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers: {
        'Content-Type':'application/json',
        'x-api-key': aiKey,
        'anthropic-version':'2023-06-01',
        // Explicit opt-in required by Anthropic for browser-side calls —
        // the key never leaves this page except to api.anthropic.com.
        'anthropic-dangerous-direct-browser-access':'true',
      },
      body: JSON.stringify({
        model: aiModel,
        max_tokens: 8192,
        system: rules,
        messages: [{ role:'user', content: userMsg }],
        temperature: temperature!=null ? temperature : 0.2,
      }),
    });
    if (!resp.ok){ const errText = await resp.text(); throw new Error(`Anthropic API error ${resp.status}: ${errText.slice(0,300)}`); }
    const data = await resp.json();
    const content = data.content && data.content[0] && data.content[0].text;
    return extractJsonObject(content);
  }
  const base = aiProvider==='custom'
    ? (aiBaseUrl || '').replace(/\/+$/,'')
    : 'https://api.openai.com/v1';
  if (!base) throw new Error('Enter the base URL of your OpenAI-compatible endpoint (e.g. http://localhost:11434/v1).');
  const headers = Object.assign({ 'Content-Type':'application/json' }, aiKey ? { 'Authorization': `Bearer ${aiKey}` } : {});
  const body = {
    model: aiModel,
    messages: [{ role:'system', content: rules }, { role:'user', content: userMsg }],
    response_format: { type:'json_object' },
  };
  const capabilityKey = aiModelCapabilityKey();
  if (!aiModelUsesDefaultTemperature(aiModel) && !aiNoTemperatureModels.has(capabilityKey)){
    body.temperature = temperature!=null ? temperature : 0.2;
  }
  // Use one product-controlled reasoning level for every GPT-5 request.
  // Exposing this as a preference made otherwise identical modelling runs use
  // different model behaviour. Unsupported endpoints still fall back safely.
  if (aiProvider==='openai' && aiModelUsesReasoningEffort(aiModel) && !aiNoReasoningEffortModels.has(capabilityKey)){
    body.reasoning_effort = AI_OPENAI_REASONING_EFFORT;
  }
  const send = payload => fetch(`${base}/chat/completions`, {
    method:'POST', headers, body:JSON.stringify(payload),
  });
  let requestBody = Object.assign({}, body);
  let resp;
  for (let attempt=0; attempt<3; attempt++){
    resp = await send(requestBody);
    if (resp.ok) break;
    const errText = await resp.text();
    const temperatureUnsupported = resp.status===400
      && Object.prototype.hasOwnProperty.call(requestBody, 'temperature')
      && /temperature/i.test(errText)
      && /(unsupported|does not support|only the default|default\s*\(?1\)?)/i.test(errText);
    if (temperatureUnsupported){
      aiNoTemperatureModels.add(capabilityKey);
      requestBody = Object.assign({}, requestBody);
      delete requestBody.temperature;
      continue;
    }
    const reasoningUnsupported = resp.status===400
      && Object.prototype.hasOwnProperty.call(requestBody, 'reasoning_effort')
      && /reasoning[_ .-]*effort/i.test(errText)
      && /(unsupported|unknown|unrecognized|does not support|invalid)/i.test(errText);
    if (reasoningUnsupported){
      aiNoReasoningEffortModels.add(capabilityKey);
      requestBody = Object.assign({}, requestBody);
      delete requestBody.reasoning_effort;
      continue;
    }
    throw new Error(`${aiProvider==='custom'?'API':'OpenAI API'} error ${resp.status}: ${errText.slice(0,300)}`);
  }
  if (!resp || !resp.ok) throw new Error(`${aiProvider==='custom'?'API':'OpenAI API'} request failed after retrying compatible settings.`);
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return extractJsonObject(content);
}

// Shared provider/key/model settings UI. `prefix` keeps element ids unique
// per surface (main modal vs Studio Plus).
function aiSettingsHtml(prefix){
  return `
    <div class="grid cols-3">
      <div class="field"><label>Provider</label>
        <select id="${prefix}-ai-provider">
          ${Object.entries(AI_PROVIDERS).map(([k,p])=>`<option value="${k}" ${aiProvider===k?'selected':''}>${p.label}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>API key</label><input type="password" id="${prefix}-ai-key" value="${escapeHtml(aiKey)}" placeholder="${AI_PROVIDERS[aiProvider].keyPlaceholder}"></div>
      <div class="field"><label>Model</label><input type="text" id="${prefix}-ai-model" value="${escapeHtml(aiModel)}" placeholder="${AI_PROVIDERS[aiProvider].defaultModel}"></div>
    </div>
    ${aiProvider==='custom' ? `
    <div class="field mt"><label>Base URL <span class="hint">(OpenAI-compatible, e.g. http://localhost:11434/v1)</span></label>
      <input type="text" id="${prefix}-ai-baseurl" value="${escapeHtml(aiBaseUrl)}" placeholder="http://localhost:11434/v1"></div>` : ''}
    <p class="hint mt mb0">The key is remembered while this tab is open — never saved to disk or localStorage. Compatible model settings are selected automatically so AI Assist behaves consistently across users.</p>
  `;
}
function wireAiSettings(root, prefix, rerender){
  const providerEl = root.querySelector(`#${prefix}-ai-provider`);
  if (providerEl) providerEl.addEventListener('change', e=>{
    const prevDefault = AI_PROVIDERS[aiProvider].defaultModel;
    aiProvider = e.target.value;
    // Only swap the model if it was still the previous provider's default —
    // never clobber a hand-typed model name.
    if (!aiModel || aiModel===prevDefault) aiModel = AI_PROVIDERS[aiProvider].defaultModel;
    persistAiSettings();
    if (typeof rerender==='function') rerender();
  });
  const keyEl = root.querySelector(`#${prefix}-ai-key`);
  if (keyEl) keyEl.addEventListener('input', e=>{ aiKey = e.target.value; }); // in-memory only, never persisted
  const modelEl = root.querySelector(`#${prefix}-ai-model`);
  if (modelEl) modelEl.addEventListener('input', e=>{ aiModel = e.target.value; persistAiSettings(); });
  const baseEl = root.querySelector(`#${prefix}-ai-baseurl`);
  if (baseEl) baseEl.addEventListener('input', e=>{ aiBaseUrl = e.target.value; persistAiSettings(); });
}

let aiLog = [];
let aiModalContext = null; // 'staging' | 'vault'
let aiScope = { derivations:true, incremental:FEATURE_INCREMENTAL, hubs:true, links:true, hubSats:true, linkSats:FEATURE_LINK_SATELLITES };

function openAiModal(context){
  aiModalContext = context;
  renderAiModal();
}
function closeAiModal(){
  aiModalContext = null;
  const mount = document.getElementById('ai-modal-mount');
  if (mount) mount.innerHTML = '';
}
document.addEventListener('keydown', e=>{
  if (e.key==='Escape' && aiModalContext) closeAiModal();
});

function aiModeSwitcherHtml(){ return ''; }

function wireAiModeSwitcher(mount){
  mount.querySelectorAll('[data-ai-mode]').forEach(b=>{
    b.addEventListener('click', ()=>{ aiModalContext = b.dataset.aiMode; renderAiModal(); });
  });
}

function renderAiModal(){
  const mount = document.getElementById('ai-modal-mount');
  if (!mount) return;
  const isStaging = aiModalContext==='staging';
  const scopeOptions = isStaging
    ? [ ['derivations','Key derivations (hash / business key columns)'], ...(FEATURE_INCREMENTAL?[['incremental','Incremental load columns']]:[]) ]
    : [ ['hubs','Hubs'], ['links','Links'], ['hubSats','Hub satellites'], ...(FEATURE_LINK_SATELLITES?[['linkSats','Link satellites']]:[]) ];
  const readyTables = state.tables.filter(t=>t.included!==false && t.columns.length>0);

  mount.innerHTML = `
    <div class="modal-backdrop" id="ai-backdrop">
      <div class="modal-card">
        <div class="flex-between" style="margin-bottom:4px;">
          <h3 style="font-family:var(--font-display);font-size:15px;margin:0;">AI Assist${isStaging?' — Staging':''}</h3>
          <button class="btn small ghost" id="ai-modal-close">&times;</button>
        </div>
        ${aiModeSwitcherHtml()}
        <p class="section-desc" style="margin-bottom:14px;">Scope of what's sent to the assistant: column names and types only, never row data or credentials.</p>

        <div class="panel" style="margin-bottom:12px;">
          <label>What should the AI fill in?</label>
          <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:6px;">
            ${scopeOptions.map(([key,label])=>`
              <label class="checkbox-row"><input type="checkbox" data-scope="${key}" ${aiScope[key]?'checked':''}><span>${label}</span></label>
            `).join('')}
          </div>
          ${isStaging ? `
            <div class="field mt">
              <label>Hash algorithm for hub/link/satellite keys <span class="hint">(locked to SHA-256 for now)</span></label>
              <select id="ai-hashalgo" disabled title="Locked to SHA-256 for now" style="opacity:.6;cursor:not-allowed;">
                ${Object.entries(HASH_ALGORITHMS).map(([k,a])=>`<option value="${k}" ${hashAlgo()===k?'selected':''}>${a.label} — ${a.sqlLabel}</option>`).join('')}
              </select>
            </div>
          ` : ''}
        </div>

        ${aiSettingsHtml('ai')}

        <div class="hint mt">${readyTables.length} of ${state.tables.filter(t=>t.included!==false).length} included table(s) have columns defined and will be sent.</div>
        <div id="ai-status-wrap"></div>

        <div class="flex-between mt">
          <button class="btn ghost" id="ai-modal-cancel">Cancel</button>
          <button class="btn primary" id="ai-modal-run" ${readyTables.length===0?'disabled':''}>Generate</button>
        </div>

        <div class="panel mt" style="margin-bottom:0;">
          <div class="panel-head" style="margin:-18px -20px 10px;"><h3>Log</h3></div>
          <pre class="code" id="ai-log" style="max-height:180px;">${aiLog.length? aiLog.join('\n') : 'No AI runs yet.'}</pre>
        </div>
      </div>
    </div>
  `;
  mount.querySelectorAll('[data-scope]').forEach(cb=>{
    cb.addEventListener('change', e=>{ aiScope[cb.dataset.scope] = e.target.checked; });
  });
  wireAiSettings(mount, 'ai', renderAiModal);
  mount.querySelector('#ai-modal-close').addEventListener('click', closeAiModal);
  mount.querySelector('#ai-modal-cancel').addEventListener('click', closeAiModal);
  mount.querySelector('#ai-backdrop').addEventListener('click', (e)=>{ if (e.target.id==='ai-backdrop') closeAiModal(); });
  mount.querySelector('#ai-modal-run').addEventListener('click', runAiModelling);
  wireAiModeSwitcher(mount);
}

function renderFdwAiModal(mount){
  mount.innerHTML = `
    <div class="modal-backdrop" id="ai-backdrop">
      <div class="modal-card">
        <div class="flex-between" style="margin-bottom:4px;">
          <h3 style="font-family:var(--font-display);font-size:15px;margin:0;">AI Assist</h3>
          <button class="btn small ghost" id="ai-modal-close">&times;</button>
        </div>
        ${aiModeSwitcherHtml()}
        <p class="section-desc" style="margin-bottom:14px;">Say what database engine you're connecting to and it'll propose the JDBC driver class and URL format. Nothing sent but this description — your actual host, database, and credentials stay local.</p>

        <div class="field">
          <label>What are you connecting to?</label>
          <textarea id="fdw-description" style="min-height:80px;" placeholder="e.g. &quot;Oracle 19c&quot;, &quot;SQL Server 2022&quot;, &quot;MySQL 8&quot;, or &quot;another PostgreSQL 16 database&quot;"></textarea>
        </div>

        <div class="mt">${aiSettingsHtml('ai')}</div>

        <div id="ai-status-wrap"></div>

        <div class="flex-between mt">
          <button class="btn ghost" id="ai-modal-cancel">Cancel</button>
          <button class="btn primary" id="ai-modal-run">Generate</button>
        </div>

        <div class="panel mt" style="margin-bottom:0;">
          <div class="panel-head" style="margin:-18px -20px 10px;"><h3>Log</h3></div>
          <pre class="code" id="ai-log" style="max-height:180px;">${aiLog.length? aiLog.join('\n') : 'No AI runs yet.'}</pre>
        </div>
      </div>
    </div>
  `;
  wireAiSettings(mount, 'ai', ()=>renderFdwAiModal(mount));
  mount.querySelector('#ai-modal-close').addEventListener('click', closeAiModal);
  mount.querySelector('#ai-modal-cancel').addEventListener('click', closeAiModal);
  mount.querySelector('#ai-backdrop').addEventListener('click', (e)=>{ if (e.target.id==='ai-backdrop') closeAiModal(); });
  mount.querySelector('#ai-modal-run').addEventListener('click', runFdwAiAssist);
  wireAiModeSwitcher(mount);
}

function aiStatus(msg, kind){
  const wrap = document.getElementById('ai-status-wrap');
  if (!wrap) return;
  wrap.innerHTML = `<div class="ai-status ${kind||''}">${kind==='busy'?'<span class="dot"></span>':''}${msg}</div>`;
}

function schemaPayload(){
  // Schema only — no row data is ever available to or sent by this tool.
  const tables = state.tables.filter(t=>t.included!==false);
  const fks = effectiveForeignKeys();
  return tables.map(t=>{
    const plan = tableRelationshipPlan(t, fks);
    return {
      name: t.name,
      entity: plan.ownEntity,
      description: t.description,
      primaryKeyColumns: plan.primaryKeyColumns.map(c=>c.name),
      tableRole: plan.type,
      foreignKeys: plan.foreignKeyGroups.map(f=>({
        columns:f.columns,
        referencedTable:f.refTable,
        referencedEntity:f.refEntity,
        referencedColumns:f.refColumns,
        role:f.role,
      })),
      relationshipAttributes: plan.type==='relationship' ? plan.attributes.map(c=>c.name) : [],
      columns: stagedColumns(t).map(c=>({ name:c.name, type:c.type, nullable:c.nullable, primaryKey:c.pk })),
    };
  });
}

function buildFdwPrompt(description){
  const rules = `You are a PostgreSQL infrastructure expert helping someone configure jdbc_fdw so that Data Vault hub/link/satellite tables can be stored as foreign tables pointing at another database, reached via JDBC.

Ground truth you must follow, do not contradict it:
- jdbc_fdw (the pgspider/jdbc_fdw fork, compatible with Postgres 13-17) is NOT a packaged/bundled Postgres extension. It must be built from source, requires Java (JDK/JRE) installed on the Postgres server with a libjvm.so symlink in place, and needs the actual JDBC driver .jar file for whatever engine is being connected to.
- CREATE SERVER options for jdbc_fdw are exactly: drivername (the fully-qualified JDBC driver class name), url (the full JDBC connection URL), jarfile (absolute path to the driver .jar on the Postgres server), querytimeout (seconds, integer), and optionally maxheapsize. There are no other server options — do not invent host/port/dbname as separate server options, they belong inside the url string.
- CREATE USER MAPPING options for jdbc_fdw are exactly: username and password. Nothing else.
- jdbc_fdw's CREATE FOREIGN TABLE has NO table-level options at all — the foreign table's name must match the remote table's name exactly. The only supported option is a column-level OPTIONS (key 'true') flag on the primary key column, which this app already adds automatically.
- Your job, given the person's description of what database engine/version they're connecting to, is to supply the correct drivername and a URL template for that JDBC driver (using placeholder host/port/dbname the person will fill in), plus install guidance specific to that engine's driver (where to get the .jar, minimum Java version if notable).

Respond with ONLY minified JSON, no prose, no markdown fences, matching exactly this shape:
{"drivername":"org.postgresql.Driver","url":"jdbc:postgresql://<host>:<port>/<database>","installNotes":"3-5 plain-English sentences: where to get the JDBC driver jar for this engine, the Java/libjvm.so setup jdbc_fdw needs, and anything else specific to this engine."}
Use literal placeholder text like <host>, <port>, <database> in the url for the person to fill in — never invent real connection details.`;
  const userMsg = `What they want to connect to: ${description}\nVault name: ${state.vault.name || '(unnamed)'}`;
  return { rules, userMsg };
}

async function runFdwAiAssist(){
  const description = document.getElementById('fdw-description').value.trim();
  if (!aiKey && aiProvider!=='custom'){ toast(`Enter your ${AI_PROVIDERS[aiProvider].label} API key first.`,'err'); return; }
  if (!description){ toast('Describe which database engine you want to connect to first.','err'); return; }
  const { rules, userMsg } = buildFdwPrompt(description);
  aiStatus(`Contacting ${AI_PROVIDERS[aiProvider].label}…`, 'busy');
  aiLog.unshift(`[${new Date().toLocaleTimeString()}] Requesting jdbc_fdw setup for: ${description}`);
  try {
    const parsed = await aiChat(rules, userMsg, 0.2);

    const ext = state.externalTables;
    ext.enabled = true;
    if (parsed.drivername) ext.drivername = parsed.drivername;
    if (parsed.url) ext.url = parsed.url;
    if (parsed.installNotes) ext.installNotes = parsed.installNotes;
    if (!ext.serverName) ext.serverName = `${state.vault.name || 'vault'}_external_srv`;
    if (!ext.querytimeout) ext.querytimeout = '30';

    aiStatus('Driver class and URL template applied — fill in the jar path and credentials.', 'ok');
    aiLog.unshift(`[${new Date().toLocaleTimeString()}] Applied drivername "${ext.drivername}".`);
    renderAiLogOnly();
    toast('jdbc_fdw driver info proposed — fill in your actual host/db/jar path.', 'ok');
    setTimeout(()=>{ closeAiModal(); renderAll(); setActiveTabViewOnly('vault'); }, 900);
  } catch(err){
    console.error(err);
    aiStatus(err.message || 'Request failed.', 'err');
    aiLog.unshift(`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`);
    renderAiLogOnly();
    toast('AI request failed — see the log for details.','err');
  }
}

function buildStagingPrompt(){
  const wantDerivations = aiScope.derivations;
  const wantIncremental = FEATURE_INCREMENTAL && aiScope.incremental;
  const shapeParts=[];
  if(wantDerivations) shapeParts.push('"tableDerivations":[{"table":"customers","derivations":[{"columns":["company_code","customer_number"],"targetEntity":"customer","role":"customer","kind":"both"},{"column":"region_id","targetEntity":"region","role":"region","kind":"hash"}]}]');
  if(wantIncremental) shapeParts.push('"incremental":[{"table":"orders","column":"updated_at"}]');
  const rules = `You are an expert Data Vault 2.0 / Apache Hop staging engineer. You are given source table SCHEMA ONLY (table and column names, types, nullability, PK flags) — no row data exists in this context and none should be assumed.

${wantDerivations ? `For "tableDerivations": for each table, list the columns that should become hashed keys in staging.
- For a normal table with exactly one primary-key column, that own PK may use kind "both" (produces hash_<entity>_id and <entity>_bk).
- For a composite primary key that identifies an entity, return one derivation with "columns":["part_1","part_2"] and kind "both". Never create a separate business-key alias for each component.
- The response fields are "targetEntity" and "role". They are different concepts: targetEntity is the Hub/entity being referenced; role describes how that Hub participates in this source table.
- For every supplied foreign key, copy targetEntity exactly from foreignKeys[].referencedEntity and copy role exactly from foreignKeys[].role. Never turn a role such as "original_language", "billing_address", "manager" or "parent" into a separate targetEntity.
- When tableRole is "relationship", do not create a business key for that table. Each FK/PK key must use kind "hash", its exact referencedEntity as targetEntity, and its supplied role. Example: membership.user_id -> targetEntity "user", role "user", kind "hash"; membership.group_id -> targetEntity "group", role "group", kind "hash". Never emit the relationship-table name as a Hub business key.
- A composite foreign key must be returned as one derivation using "columns" in the supplied source-key order, with the exact referencedEntity and role from the matching foreignKeys entry.
- For a table's own business key, targetEntity and role must both use the table's supplied entity name.
- Do not return two derivations for the same source column(s) and role, and do not return two derivations that generate the same target alias.` : ''}
${wantIncremental ? `For "incremental": for each table that has an obvious update/change timestamp such as "updated_at", "modified_at", "ModifiedDate" or "last_modified", name that column; omit tables that only have creation dates or do not have a timestamp/datetime change column.` : ''}

Respond with ONLY minified JSON, no prose, no markdown fences, matching exactly this shape (omit a top-level key entirely if not requested):
{${shapeParts.join(',')}}`;

  const userMsg = `Hash algorithm in use: ${HASH_ALGORITHMS[hashAlgo()].label}\nTables (schema only):\n${JSON.stringify(schemaPayload())}`;
  return { rules, userMsg };
}

function buildVaultPrompt(){
  const rules = `You are an expert Data Vault 2.0 modeller working with the Apache Hop framework. Given source table SCHEMA ONLY (names, types, nullability, PK flags — no row data), propose the requested parts of a Data Vault model.

Naming and structural rules you must follow exactly:
- Hubs: one per uniquely identifiable business entity with a natural key. Entity names are lowercase snake_case single words or short phrases, e.g. "customer", "order".
- Links: for relationships between hubs. A link needs 2+ role references, referenced by their exact hub entity names.
- For a tableRole of "relationship", create one Link containing all listed foreign-key roles. Any relationshipAttributes belong on a Link Satellite.
- For a tableRole of "entity_with_relationships", create a separate binary Link for each foreign key: the table's own Hub plus that one referenced Hub. Do not combine unrelated foreign keys into one multi-Hub Link.
- Preserve the supplied foreign-key role. Self-references and repeated references to the same Hub must remain distinct, for example employee.employee_id (role employee) and employee.manager_id (role manager).
- Satellites: descriptive attributes go on hub satellites grouped by concern (e.g. "profile", "address")${FEATURE_LINK_SATELLITES?'; relationship attributes go on link satellites':''}.
- Only reference hubs/links that already exist (see "Existing model" below) when proposing links or satellites, unless you are also proposing the hub/link itself in this same response.
- Do not invent columns that are not present in the provided tables. The supplied column lists are the user's SELECTED STAGING COLUMNS; excluded source columns are already absent.
- Every supplied non-key, non-foreign-key descriptive column must appear exactly once in a hub satellite or link satellite. Never silently omit a staged column. If a concern grouping is uncertain, put the column in one sensible default satellite rather than dropping it.
- Relationship-table descriptive or audit columns belong on a link satellite.
- A table with under ~10 non-key columns should usually get one satellite; split into concern groups only when attributes clearly change at different rates.

Respond with ONLY minified JSON, no prose, no markdown fences. Include only these top-level keys, and only if requested: ${['hubs','links','hubSats','linkSats'].filter(k=>aiScope[k] && (k!=='linkSats' || FEATURE_LINK_SATELLITES)).map(k=>`"${k==='hubSats'?'hubSatellites':k==='linkSats'?'linkSatellites':k}"`).join(', ')}.
Shape reference:
{
 "hubs": [{"entity":"customer","table":"customers","pkColumns":["company_code","customer_number"],"statusSat":true}],
 "links": [{"entity":"customer_order","table":"orders","hubs":[{"hub":"customer","columns":["customer_id"],"role":"customer"},{"hub":"order","columns":["order_id"],"role":"order"}]}],
 "hubSatellites": [{"entity":"customer","concern":"profile","table":"customers","hub":"customer","attributes":[{"column":"name","target":"name"}]}]${FEATURE_LINK_SATELLITES?`,
 "linkSatellites": [{"entity":"customer_order","concern":"","table":"orders","link":"customer_order","attributes":[{"column":"order_date","target":"order_date"}]}]`:''}
}`;

  const existing = {
    hubs: state.hubs.map(h=>h.entity),
    links: state.links.map(l=>({ entity:l.entity, hubs: l.hubs.map(h=>findHub(h.hubId).entity) })),
  };
  const userMsg = `Vault name: ${state.vault.name || '(unnamed)'}\nSource dialect: ${state.vault.dialect}\nExisting model:\n${JSON.stringify(existing)}\nTables (schema only):\n${JSON.stringify(schemaPayload())}`;
  return { rules, userMsg };
}

async function runAiModelling(){
  if (!aiKey && aiProvider!=='custom'){ toast(`Enter your ${AI_PROVIDERS[aiProvider].label} API key first.`,'err'); return; }
  pruneDownstreamModel({ dropExcluded:true });
  const { rules, userMsg } = aiModalContext==='staging' ? buildStagingPrompt() : buildVaultPrompt();
  aiStatus(`Contacting ${AI_PROVIDERS[aiProvider].label}…`, 'busy');
  aiLog.unshift(`[${new Date().toLocaleTimeString()}] Requesting ${aiModalContext} proposal from ${aiModel}…`);
  try {
    const parsed = await aiChat(rules, userMsg, 0.2);

    let summaryText;
    pushUndo(`AI Assist ${aiModalContext} proposal`);
    if (aiModalContext==='staging'){
      const summary = applyAiStaging(parsed);
      summaryText = `${summary.derivations} derivation(s), ${summary.incremental} incremental column(s) applied.`;
      aiLog.unshift(`[${new Date().toLocaleTimeString()}] ${summaryText} ${summary.adjusted.length?('Adjusted: '+summary.adjusted.join('; ')+'. '):''}${summary.skipped.length?('Skipped: '+summary.skipped.join('; ')):''}`);
    } else {
      const summary = applyAiModel(parsed);
      const completed = (summary.autoHubs||summary.autoLinks)
        ? `; completed ${summary.autoHubs||0} missing hub(s) and ${summary.autoLinks||0} missing relationship(s)`
        : '';
      summaryText = `${summary.hubs} hubs, ${summary.links} links, ${summary.hubSats} hub satellites, ${summary.linkSats} link satellites applied${completed}${summary.autoCovered?`; ${summary.autoCovered} omitted staged column(s) added automatically`:''}.`;
      aiLog.unshift(`[${new Date().toLocaleTimeString()}] ${summaryText} ${summary.skipped.length?('Skipped: '+summary.skipped.join('; ')):''}`);
    }
    aiStatus(summaryText, 'ok');
    renderAiLogOnly();
    toast('AI proposal applied — review it before exporting.', 'ok');
    setTimeout(()=>{ closeAiModal(); renderAll(); }, 900);
  } catch(err){
    console.error(err);
    aiStatus(err.message || 'Request failed.', 'err');
    aiLog.unshift(`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`);
    renderAiLogOnly();
    toast('AI request failed — see the log for details.','err');
  }
}

function renderAiLogOnly(){
  const logEl = document.getElementById('ai-log');
  if (logEl) logEl.textContent = aiLog.join('\n');
}

/* Programmatic model builders, shared by AI import */
// Deterministic suggestions already have the selected table object. Preserve
// it through the builders: bare names are unsafe when schemas share a name.
function resolveIncludedTable(tableRef){
  if (tableRef && typeof tableRef==='object' && tableRef.id){
    const table=findTable(tableRef.id);
    return table&&table.included!==false ? table : null;
  }
  return findIncludedTableByName(tableRef);
}
function programmaticTableLabel(tableRef, table){
  return table ? sourceTableLabel(table) : String(tableRef||'');
}
function addHubProgrammatic(entity, tableRef, pkColumnName, statusSat){
  entity = sqlNamePart(entity);
  const table = resolveIncludedTable(tableRef);
  const tableLabel=programmaticTableLabel(tableRef,table);
  if (!table) return { ok:false, reason:`included table "${tableLabel}" not found` };
  const names = (Array.isArray(pkColumnName) ? pkColumnName : [pkColumnName]).filter(Boolean);
  const cols = names.map(name=>stagedColumns(table).find(c=>c.name===name));
  if (!names.length || cols.some(c=>!c)) return { ok:false, reason:`business-key column(s) "${names.join(', ')}" not found on "${tableLabel}"` };
  if (state.hubs.some(h=>h.entity===entity)) return { ok:false, reason:`hub "${entity}" already exists` };
  ensureKeyDerivation(table, entity, names, 'both');
  const hub = { id: uid('hub'), entity, description:'', tableId: table.id, pkColId: cols[0].id, keyColIds: cols.map(c=>c.id), sourceFeeds:[{tableId:table.id,keyColIds:cols.map(c=>c.id)}], statusSat: statusSat!==false };
  state.hubs.push(hub);
  return { ok:true, hub };
}
function addLinkProgrammatic(entity, tableRef, hubColPairs){
  entity = sqlNamePart(entity);
  const table = resolveIncludedTable(tableRef);
  const tableLabel=programmaticTableLabel(tableRef,table);
  if (!table) return { ok:false, reason:`included table "${tableLabel}" not found` };
  const rows = [];
  for (const p of hubColPairs){
    const hub = state.hubs.find(h=>h.entity===p.hub);
    const names = (Array.isArray(p.columns) && p.columns.length ? p.columns : [p.column]).filter(Boolean);
    const cols = names.map(name=>stagedColumns(table).find(c=>c.name===name));
    if (!hub || !names.length || cols.some(c=>!c)) return { ok:false, reason:`link "${entity}": hub "${p.hub}" or column(s) "${names.join(', ')}" not found` };
    rows.push({ hubId: hub.id, colId: cols[0].id, colIds:cols.map(c=>c.id), role:p.role||'' });
  }
  if (rows.length<2) return { ok:false, reason:`link "${entity}" needs 2+ resolvable hubs` };
  if (state.links.some(l=>l.entity===entity)) return { ok:false, reason:`link "${entity}" already exists` };
  const issue = linkHubRowsIssue(entity, table, rows);
  if (issue) return { ok:false, reason:issue };
  const normalizedRows = normalizeLinkHubRows(table, rows);
  const link = { id: uid('lnk'), entity, description:'', tableId: table.id, hubs: normalizedRows };
  normalizedRows.forEach(r=>{
    const cols = linkHubCols(table, r);
    ensureKeyDerivation(table, linkHubDerivationEntity(link, r), cols.map(c=>c.name), 'hash', r.role || linkHubRoleFromSource(table,r));
  });
  state.links.push(link);
  return { ok:true, link };
}
function stagedSourceColumnsForHub(table, hub){
  if(!table||!hub) return [];
  const feed=hubSourceFeeds(hub).find(f=>f.tableId===table.id);
  if(feed) return (feed.keyColIds||[]).map(id=>findStagedColumn(table,id)).filter(Boolean);
  const hubTable=findTable(hub.tableId);
  const hubKeys=hubKeyCols(hub);
  if(table.id===hub.tableId) return hubKeyColIds(hub).map(id=>findStagedColumn(table,id)).filter(Boolean);
  if(!hubTable||!hubKeys.length) return [];
  const groups=groupForeignKeysForTable(table,effectiveForeignKeys()).filter(g=>g.refTable===hubTable.name);
  const keyNames=hubKeys.map(c=>c.name);
  const exact=groups.find(g=>g.refColumns.length===keyNames.length&&g.refColumns.every((name,i)=>!name||name===keyNames[i]));
  if(exact){
    const cols=exact.columns.map(name=>stagedColumns(table).find(c=>c.name===name));
    if(cols.every(Boolean)) return cols;
  }
  // One-to-one extension tables often repeat the parent key names but omit
  // FK constraints. An explicit satellite-to-Hub choice makes this mapping
  // unambiguous, so use exact matching staged names as a safe fallback.
  const direct=keyNames.map(name=>stagedColumns(table).find(c=>c.name===name));
  return direct.every(Boolean)?direct:[];
}
function stagedSourceColumnForHub(table, hub){
  return stagedSourceColumnsForHub(table, hub)[0] || null;
}
function repairAllSatelliteParentDerivations(){
  let repaired = 0;
  state.hubSats.forEach(s=>{
    const table = findTable(s.tableId);
    const hub = findHub(s.hubId);
    const sourceCols = stagedSourceColumnsForHub(table, hub);
    if (!table || !hub || !sourceCols.length) return;
    const names = sourceCols.map(c=>c.name);
    const exact = tableHasHashForColumns(table,hub.entity,names,hub.entity);
    if (exact) return;
    const before = JSON.stringify(table.derivations);
    ensureKeyDerivation(table, hub.entity, names, 'hash');
    if (before!==JSON.stringify(table.derivations)) repaired++;
  });
  return repaired;
}
function addHubSatProgrammatic(entity, concern, tableRef, hubEntity, attributes){
  entity = sqlNamePart(entity); concern = concern ? sqlNamePart(concern) : '';
  const table = resolveIncludedTable(tableRef);
  const tableLabel=programmaticTableLabel(tableRef,table);
  const hub = state.hubs.find(h=>h.entity===hubEntity);
  if (!table || !hub) return { ok:false, reason:`hub satellite "${entity}": table or hub not found` };
  const normalizedConcern = concern || '';
  if (state.hubSats.some(s=>s.hubId===hub.id && (s.concern||'')===normalizedConcern)) {
    return { ok:false, reason:`hub satellite for "${hubEntity}"${normalizedConcern?` (concern "${normalizedConcern}")`:''} already exists` };
  }
  const parentSourceCols = stagedSourceColumnsForHub(table, hub);
  if (!parentSourceCols.length) return { ok:false, reason:`hub satellite "${entity}": no staged source column(s) on "${tableLabel}" can identify hub "${hubEntity}"` };
  ensureKeyDerivation(table, hub.entity, parentSourceCols.map(c=>c.name), 'hash');
  const attrs = attributes.map(a=>{
    const col = stagedColumns(table).find(c=>c.name===a.column);
    return col ? { colId: col.id, target: targetIdentifierBase(a.target || targetColumnName(col)) } : null;
  }).filter(Boolean);
  if (attrs.length===0) return { ok:false, reason:`hub satellite "${entity}" has no resolvable attributes` };
  const attrDup = findDuplicateHubSatByAttrs(hub.id, table.id, attrs);
  if (attrDup) return { ok:false, reason:`hub satellite for "${hubEntity}" already covers attribute(s) ${satAttrLabel(table.id, attrs)} in "${satName(attrDup.entity, attrDup.concern)}"` };
  state.hubSats.push({ id: uid('sat'), entity, concern: normalizedConcern, description:'', hubId: hub.id, tableId: table.id, attrs });
  return { ok:true };
}
function addLinkSatProgrammatic(entity, concern, tableRef, linkEntity, attributes){
  entity = sqlNamePart(entity); concern = concern ? sqlNamePart(concern) : '';
  const table = resolveIncludedTable(tableRef);
  const link = state.links.find(l=>l.entity===linkEntity);
  if (!table || !link) return { ok:false, reason:`link satellite "${entity}": table or link not found` };
  const normalizedConcern = concern || '';
  if (state.linkSats.some(s=>s.linkId===link.id && (s.concern||'')===normalizedConcern)) {
    return { ok:false, reason:`link satellite for "${linkEntity}"${normalizedConcern?` (concern "${normalizedConcern}")`:''} already exists` };
  }
  const attrs = attributes.map(a=>{
    const col = stagedColumns(table).find(c=>c.name===a.column);
    return col ? { colId: col.id, target: targetIdentifierBase(a.target || targetColumnName(col)) } : null;
  }).filter(Boolean);
  if (attrs.length===0) return { ok:false, reason:`link satellite "${entity}" has no resolvable attributes` };
  const attrDup = findDuplicateLinkSatByAttrs(link.id, table.id, attrs);
  if (attrDup) return { ok:false, reason:`link satellite for "${linkEntity}" already covers attribute(s) ${satAttrLabel(table.id, attrs)} in "${lsatName(attrDup.entity, attrDup.concern)}"` };
  state.linkSats.push({ id: uid('lsat'), entity, concern: normalizedConcern, description:'', linkId: link.id, tableId: table.id, attrs });
  return { ok:true };
}

function applyAiStaging(json){
  const skipped = [], adjusted = [];
  let derivations=0, incremental=0;
  (json.tableDerivations||[]).forEach(entry=>{
    const table = state.tables.find(t=>t.name===entry.table);
    if (!table){ skipped.push(`table "${entry.table}" not found`); return; }
    repairJunctionDerivations(table);
    repairForeignKeyDerivations(table);
    (entry.derivations||[]).forEach(d=>{
      const normalized = normalizeAiStagingDerivation(table, d);
      if (!normalized.ok){ skipped.push(normalized.reason); return; }
      if (normalized.adjusted) adjusted.push(normalized.adjusted);
      const n = normalized.value;
      const applied = ensureKeyDerivationWithoutCollision(table, n.entity, n.columns||[n.column], n.kind, n.role||'');
      if (!applied.ok){
        skipped.push(`"${entry.table}"."${(n.columns||[n.column]).join(' + ')}" ${applied.reason}`);
        return;
      }
      if (applied.changed) derivations++;
    });
  });
  if (FEATURE_INCREMENTAL) (json.incremental||[]).forEach(entry=>{
    const table = state.tables.find(t=>t.name===entry.table);
    if (!table){ skipped.push(`table "${entry.table}" not found`); return; }
    const col = incrementalColumnOptions(table).find(c=>c.name===entry.column);
    if (!col){ skipped.push(`"${entry.table}"."${entry.column}" is not a staged timestamp/datetime column`); return; }
    configureIncrementalColumn(table, col.name);
    incremental++;
  });
  const reconciled=repairAllForeignKeyDerivations();
  if(reconciled) adjusted.push(`Reconciled ${reconciled} duplicate or role-labelled foreign-key derivation(s).`);
  const completed=ensureStagingKeyCoverage();
  derivations += completed.derivations;
  skipped.push(...completed.skipped);
  return { derivations, incremental, skipped, adjusted, autoDerivations:completed.derivations };
}

function vaultEligibleAttributeColumns(table){
  if (!table) return [];
  const fkCols = new Set(effectiveForeignKeys().filter(f=>f.table===table.name).map(f=>f.column));
  const derivCols = new Set((table.derivations||[]).flatMap(d=>derivationSourceColumns(d)));
  return stagedColumns(table).filter(c=> !c.pk && !fkCols.has(c.name) && !derivCols.has(c.name));
}
function satelliteCoveredColumnIds(table){
  const covered = new Set();
  state.hubSats.concat(state.linkSats).filter(s=>s.tableId===table.id).forEach(s=>
    (s.attrs||[]).forEach(a=>{ if (findStagedColumn(table, a.colId)) covered.add(a.colId); })
  );
  return covered;
}
// AI decides grouping and names, but it is not allowed to decide that staged
// data disappears. Any eligible staged column omitted by the proposal is
// deterministically appended to an existing satellite, or placed in a
// default satellite when no group exists yet.
function ensureVaultAttributeCoverage(){
  let attrsAdded = 0, satsCreated = 0;
  const skipped = [];
  includedTables().forEach(table=>{
    const plan = tableRelationshipPlan(table);
    const covered = satelliteCoveredColumnIds(table);
    const missing = vaultEligibleAttributeColumns(table).filter(c=>!covered.has(c.id));
    if (!missing.length) return;
    const attrs = missing.map(c=>({ column:c.name, target:targetColumnName(c) }));
    if (plan.type==='relationship'){
      const link = plan.groups.length ? findLinkForRelationshipGroup(table, plan.groups[0]) : null;
      if (!link){ skipped.push(`"${table.name}": ${missing.length} staged attribute(s) need a link before they can be placed`); return; }
      let sat = state.linkSats.find(x=>x.linkId===link.id && x.tableId===table.id);
      if (!sat){
        const r = addLinkSatProgrammatic(link.entity, '', table, link.entity, attrs);
        if (r.ok){ satsCreated++; attrsAdded += missing.length; } else skipped.push(r.reason);
        return;
      }
      missing.forEach(c=>sat.attrs.push({ colId:c.id, target:targetColumnName(c) }));
      attrsAdded += missing.length;
      return;
    }
    let sat = state.hubSats.find(x=>x.tableId===table.id);
    if (sat){
      missing.forEach(c=>sat.attrs.push({ colId:c.id, target:targetColumnName(c) }));
      attrsAdded += missing.length;
      return;
    }
    const hub = state.hubs.find(h=>h.tableId===table.id) || state.hubs.find(h=>h.entity===entityForTable(table.name));
    if (!hub){ skipped.push(`"${table.name}": ${missing.length} staged attribute(s) need a hub before they can be placed`); return; }
    const r = addHubSatProgrammatic(hub.entity, '', table, hub.entity, attrs);
    if (r.ok){ satsCreated++; attrsAdded += missing.length; } else skipped.push(r.reason);
  });
  return { attrsAdded, satsCreated, skipped };
}

function applyAiModel(json){
  const skipped = [];
  let hubs=0, links=0, hubSats=0, linkSats=0;
  if (aiScope.hubs !== false) (json.hubs||[]).forEach(h=>{
    const r = addHubProgrammatic(h.entity, h.table, h.pkColumns||h.pkColumn, h.statusSat);
    if (r.ok) hubs++; else skipped.push(r.reason);
  });
  if (aiScope.links !== false) (json.links||[]).forEach(l=>{
    const allowed = aiLinkMatchesRelationshipPlan(l);
    if (!allowed.ok){ skipped.push(allowed.reason); return; }
    const r = addLinkProgrammatic(l.entity, l.table, l.hubs||[]);
    if (r.ok) links++; else skipped.push(r.reason);
  });
  const structure = ensurePlannedVaultStructure();
  skipped.push(...structure.skipped);
  if (aiScope.hubSats !== false) (json.hubSatellites||[]).forEach(s=>{
    const r = addHubSatProgrammatic(s.entity, s.concern, s.table, s.hub, s.attributes||[]);
    if (r.ok) hubSats++; else skipped.push(r.reason);
  });
  if (FEATURE_LINK_SATELLITES && aiScope.linkSats !== false) (json.linkSatellites||[]).forEach(s=>{
    const r = addLinkSatProgrammatic(s.entity, s.concern, s.table, s.link, s.attributes||[]);
    if (r.ok) linkSats++; else skipped.push(r.reason);
  });
  const coverage = ensureVaultAttributeCoverage();
  skipped.push(...coverage.skipped);
  return {
    hubs,
    links,
    hubSats,
    linkSats,
    autoHubs:structure.hubsAdded,
    autoLinks:structure.linksAdded,
    autoCovered:coverage.attrsAdded,
    autoSats:coverage.satsCreated,
    skipped,
  };
}
