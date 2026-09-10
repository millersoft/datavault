/* =========================================================================
   TARGET SCHEMA DIFF — compares the generated staging/vault DDL against
   what actually exists on the target database and produces an INCREMENTAL
   script: CREATE TABLE for missing objects, ALTER TABLE ADD COLUMN for
   missing columns. This is how a drift merge (new tables/columns) reaches
   an already-deployed vault without re-running the full DDL. Type changes
   are reported as warnings only — never auto-altered.
   ========================================================================= */
// Parses the app's OWN generated DDL (format is under our control) into
// {schema, name, columns:[{name,type}], obsoleteColumns:[], createSql}
// objects. Pure, testable.
function parseGeneratedDdlObjects(sql){
  const objects = [];
  const idPattern = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[(?:[^\\]]|\\]\\])*\\]|[A-Za-z_][A-Za-z0-9_]*)';
  const unquoteIdentifier = value => {
    const text=String(value||'');
    if(text.startsWith('"') && text.endsWith('"')) return text.slice(1,-1).replace(/""/g,'"');
    if(text.startsWith('`') && text.endsWith('`')) return text.slice(1,-1).replace(/``/g,'`');
    if(text.startsWith('[') && text.endsWith(']')) return text.slice(1,-1).replace(/]]/g,']');
    return text;
  };
  const parseMatches = re => {
    let m;
    while ((m = re.exec(sql))){
      const cols = [];
      m[3].split('\n').forEach(line=>{
        const t = line.trim().replace(/,\s*$/, '');
        if (!t || /^(PRIMARY|CONSTRAINT|UNIQUE|FOREIGN|CHECK)\b/i.test(t)) return;
        const cm = t.match(new RegExp(`^(${idPattern})\\s+(.+)$`, 'i'));
        if (cm){
          const type = cm[2]
            .replace(/\s+OPTIONS\s*\([^)]*\)/ig, '')
            .replace(/\s+NOT NULL\b/ig, '')
            .trim();
          cols.push({ name:unquoteIdentifier(cm[1]).toLowerCase(), type });
        }
      });
      const foreign = /^CREATE FOREIGN TABLE/i.test(m[0]);
      const schema=unquoteIdentifier(m[1]).toLowerCase();
      const name=unquoteIdentifier(m[2]).toLowerCase();
      if(objects.some(o=>o.schema===schema && o.name===name)) continue;
      objects.push({ schema, name, columns:cols, createSql:m[0], foreign, relationKind:foreign?'f':'r', indexes:[], obsoleteColumns:[] });
    }
  };
  parseMatches(new RegExp(`CREATE (?:FOREIGN )?TABLE IF NOT EXISTS\\s+(${idPattern})\\.(${idPattern})\\s*\\(([\\s\\S]*?)\\n\\)(?:\\s*SERVER\\s+\\S+)?;`, 'g'));
  // Generic Pack DDL uses preflight table-existence checks rather than assuming
  // DDL wraps a normal CREATE TABLE statement in an OBJECT_ID guard.
  parseMatches(new RegExp(`CREATE TABLE\\s+(${idPattern})\\.(${idPattern})\\s*\\(([\\s\\S]*?)\\n\\);`, 'g'));
  let m;
  const indexRe = /CREATE INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*\((\w+)\);/g;
  while ((m = indexRe.exec(sql))){
    const schema = m[2].toLowerCase();
    const table = m[3].toLowerCase();
    const column = m[4].toLowerCase();
    const object = objects.find(o=>o.schema===schema && o.name===table);
    if (!object) continue;
    const index = { name:m[1].toLowerCase(), column, createSql:m[0] };
    object.indexes.push(index);
    const col = object.columns.find(c=>c.name===column);
    if (col) col.indexSql = m[0];
  }
  // Repair metadata is intentionally not printed in the full/fresh DDL.
  // It belongs only to a live target diff: a new database must never show
  // the obsolete Hub columns in its Link Satellite definition at all.
  (state.linkSats||[]).forEach(s=>{
    const name = lsatName(s.entity, s.concern).toLowerCase();
    const obsoleteColumns = legacyLinkSatHubColumns(s).map(c=>c.toLowerCase());
    [name, `${name}_err`].forEach(tableName=>{
      const object = objects.find(o=>o.schema==='data_vault' && o.name===tableName);
      if (object) object.obsoleteColumns.push(...obsoleteColumns.filter(c=>!object.obsoleteColumns.includes(c)));
    });
  });
  return objects;
}
// Normalises an information_schema.columns row to the same vocabulary the
// generated DDL uses, so types can be compared meaningfully.
function normalizeCatalogType(row){
  const t = String(row.data_type||'').toLowerCase();
  if (t === 'character varying') return row.character_maximum_length ? `varchar(${row.character_maximum_length})` : 'varchar';
  if (t === 'character') return `char(${row.character_maximum_length||1})`;
  if (t === 'numeric' || t === 'decimal'){
    return (row.numeric_precision!=null && row.numeric_scale!=null) ? `numeric(${row.numeric_precision},${row.numeric_scale})` : 'numeric';
  }
  if (t === 'timestamp without time zone') return 'timestamp';
  if (t === 'timestamp with time zone') return 'timestamptz';
  if (t === 'array') return `${String(row.udt_name||'text').replace(/^_/,'')}[]`;
  return t;
}
function normalizeExpectedType(type){
  let t = String(type||'').toLowerCase().trim().replace(/\s+/g,' ');
  const alias = { 'int':'integer', 'int4':'integer', 'int8':'bigint', 'int2':'smallint', 'bool':'boolean', 'float':'double precision', 'float8':'double precision' };
  if (alias[t]) return alias[t];
  return t;
}

function singleColumnIndexCatalogSql(){
  return `
    SELECT ns.nspname AS table_schema,
           tbl.relname AS table_name,
           att.attname AS column_name,
           idx.relname AS index_name
    FROM pg_index ix
    JOIN pg_class tbl ON tbl.oid = ix.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    JOIN pg_class idx ON idx.oid = ix.indexrelid
    JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ordinal_position)
      ON key.ordinal_position = 1
    JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = key.attnum
    WHERE ns.nspname IN ('staging','data_vault')
      AND ix.indnkeyatts = 1
      AND ix.indexprs IS NULL
      AND ix.indpred IS NULL
    ORDER BY ns.nspname, tbl.relname, att.attname
  `;
}

// live rows: [{table_schema, table_name, column_name, data_type, ...}]
// liveIndexes: null skips index comparison; otherwise rows identify an
// equivalent single-column index by schema + table + column.
function computeTargetDelta(expectedObjects, liveRows, liveIndexes=null, liveRelations=null){
  const live = {};
  (liveRows||[]).forEach(r=>{
    const key = `${String(r.table_schema).toLowerCase()}.${String(r.table_name).toLowerCase()}`;
    (live[key] = live[key] || {})[String(r.column_name).toLowerCase()] = normalizeCatalogType(r);
  });
  const liveIndexKeys = liveIndexes == null ? null : new Set((liveIndexes||[]).map(r=>
    `${String(r.table_schema).toLowerCase()}.${String(r.table_name).toLowerCase()}.${String(r.column_name).toLowerCase()}`
  ));
  const liveRelationKinds = liveRelations == null ? null : new Map((liveRelations||[]).map(r=>[
    `${String(r.table_schema).toLowerCase()}.${String(r.table_name).toLowerCase()}`, String(r.relkind||'')
  ]));
  const delta = { missingTables: [], missingColumns: [], missingIndexes: [], obsoleteColumns: [], typeMismatches: [], relationKindMismatches: [], checkedTables: expectedObjects.length, expectedObjects };
  expectedObjects.forEach(obj=>{
    const key = `${obj.schema}.${obj.name}`;
    const liveCols = live[key];
    if (!liveCols){ delta.missingTables.push(obj); return; }
    if (liveRelationKinds && liveRelationKinds.has(key)){
      const actual=liveRelationKinds.get(key), expected=obj.relationKind|| (obj.foreign?'f':(obj.name==='vw_information_schema_columns_data_vault'?'v':'r'));
      if (actual!==expected) delta.relationKindMismatches.push({schema:obj.schema,table:obj.name,live:actual,expected});
    }
    const missingColumnNames = new Set();
    obj.columns.forEach(c=>{
      const liveType = liveCols[c.name];
      if (liveType === undefined){
        const missing = { schema: obj.schema, table: obj.name, column: c.name, type: c.type };
        if (obj.foreign===true) missing.foreign = true;
        if (c.indexSql) missing.indexSql = c.indexSql;
        delta.missingColumns.push(missing);
        missingColumnNames.add(c.name);
      } else if (liveType !== normalizeExpectedType(c.type)){
        delta.typeMismatches.push({ schema: obj.schema, table: obj.name, column: c.name, live: liveType, expected: normalizeExpectedType(c.type) });
      }
    });
    (obj.obsoleteColumns||[]).forEach(column=>{
      if (liveCols[column] !== undefined){
        const obsolete = { schema:obj.schema, table:obj.name, column };
        if (obj.foreign===true) obsolete.foreign = true;
        delta.obsoleteColumns.push(obsolete);
      }
    });
    if (liveIndexKeys){
      (obj.indexes||[]).forEach(index=>{
        const indexKey = `${obj.schema}.${obj.name}.${index.column}`;
        if (!missingColumnNames.has(index.column) && !liveIndexKeys.has(indexKey)){
          delta.missingIndexes.push({
            schema:obj.schema, table:obj.name, column:index.column,
            name:index.name, createSql:index.createSql,
          });
        }
      });
    }
  });
  return delta;
}
function targetDeltaIsEmpty(delta){
  return !delta.missingTables.length && !delta.missingColumns.length
    && !(delta.missingIndexes||[]).length && !(delta.obsoleteColumns||[]).length
    && !(delta.relationKindMismatches||[]).length && !delta.typeMismatches.length;
}
function buildIncrementalSql(delta){
  const parts = [
    `-- =========================================================`,
    `-- INCREMENTAL DDL — required target schema updates`,
    `-- Generated by Data Vault Studio (Diff against target)`,
    `-- =========================================================`,
    ``,
  ];
  const ownerFor = schema => schema === 'staging' ? 'staging' : 'data_vault';
  delta.typeMismatches.forEach(x=>{
    parts.push(`-- WARNING: ${x.schema}.${x.table}.${x.column} is "${x.live}" on the target but "${x.expected}" in the generated DDL.`);
    parts.push(`--          Review manually — column types are never auto-altered by this script.`);
  });
  if (delta.typeMismatches.length) parts.push('');
  (delta.relationKindMismatches||[]).forEach(x=>{
    parts.push(`-- FATAL: ${x.schema}.${x.table} has relation kind "${x.live}" but the design requires "${x.expected}".`);
    parts.push(`--        Relation-kind collisions are never auto-repaired; remove or rename the conflicting local relation first.`);
  });
  if ((delta.relationKindMismatches||[]).length) parts.push('');
  const bySchema = {};
  const schemaItems = schema => (bySchema[schema] = bySchema[schema] || { tables:[], views:[], columns:[], indexes:[], obsoleteColumns:[] });
  delta.missingTables.forEach(t=>{ const items=schemaItems(t.schema); (t.relationKind==='v'?items.views:items.tables).push(t); });
  delta.missingColumns.forEach(c=>schemaItems(c.schema).columns.push(c));
  (delta.missingIndexes||[]).forEach(index=>schemaItems(index.schema).indexes.push(index));
  (delta.obsoleteColumns||[]).forEach(column=>schemaItems(column.schema).obsoleteColumns.push(column));
  Object.entries(bySchema).forEach(([schema, items])=>{
    parts.push(schemaOwnershipFixSql(schema, ownerFor(schema)));
    parts.push(`SET ROLE ${ownerFor(schema)};`);
    parts.push('');
    items.tables.forEach(t=>{
      parts.push(`-- New table: ${schema}.${t.name}`);
      parts.push(t.createSql);
      parts.push(`${t.foreign?'ALTER FOREIGN TABLE':'ALTER TABLE'} ${schema}.${t.name} OWNER TO ${ownerFor(schema)};`);
      (t.indexes||[]).forEach(index=>parts.push(index.createSql));
      parts.push('');
    });
    items.views.forEach(v=>{
      parts.push(`-- New staging view: ${schema}.${v.name}`);
      parts.push(v.createSql);
      parts.push(`ALTER VIEW ${schema}.${v.name} OWNER TO ${ownerFor(schema)};`);
      parts.push('');
    });
    const refreshedViews=new Set();
    items.columns.forEach(c=>{
      const expected=(delta.expectedObjects||[]).find(t=>t.schema===c.schema&&t.name===c.table);
      if(expected&&expected.relationKind==='v'){
        if(!refreshedViews.has(c.table)){
          parts.push(`-- Refresh derived staging view: ${c.schema}.${c.table}`);
          parts.push(expected.createSql);
          parts.push(`ALTER VIEW ${c.schema}.${c.table} OWNER TO ${ownerFor(schema)};`);
          refreshedViews.add(c.table);
        }
        return;
      }
      const foreign = c.foreign === true || (expected&&expected.foreign);
      parts.push(`${foreign?'ALTER FOREIGN TABLE':'ALTER TABLE'} ${c.schema}.${c.table} ADD COLUMN IF NOT EXISTS ${c.column} ${c.type};`);
      if (c.indexSql) parts.push(c.indexSql);
    });
    if (items.columns.length) parts.push('');
    items.indexes.forEach(index=>parts.push(index.createSql));
    if (items.indexes.length) parts.push('');
    items.obsoleteColumns.forEach(column=>{
      parts.push(`-- Remove a redundant Link Satellite Hub key from older Studio DDL.`);
      const foreign = column.foreign === true || (delta.expectedObjects||[]).some(t=>t.schema===column.schema&&t.name===column.table&&t.foreign);
      parts.push(`${foreign?'ALTER FOREIGN TABLE':'ALTER TABLE'} ${column.schema}.${column.table} DROP COLUMN IF EXISTS ${column.column};`);
    });
    if (items.obsoleteColumns.length) parts.push('');
    parts.push(crossRoleGrantsSql(schema, ownerFor(schema), schema === 'staging' ? ['pdi_meta', 'data_vault'] : ['pdi_meta', 'staging']));
    parts.push('RESET ROLE;');
    parts.push('');
  });
  return parts.join('\n');
}

let targetDelta = null;
let targetDeltaSql = '';

async function runTargetDiff(){
  const el = document.getElementById('target-diff-result');
  const v = state.vault;
  if (!v.dvHost || !v.dvDatabase || !v.dvUser){
    if (el) el.innerHTML = `<div class="ai-status err mt">Set the target connection (host, database, user) on the Connections step first.</div>`;
    return;
  }
  if (el) el.innerHTML = `<div class="ai-status busy mt"><span class="dot"></span>Reading the target's live schema…</div>`;
  try {
    const expected = expectedStagingObjects()
      .concat(parseGeneratedDdlObjects(getExportSql('datavault')));
    const rows = await queryTarget(`
      SELECT table_schema, table_name, column_name, data_type,
             character_maximum_length, numeric_precision, numeric_scale, udt_name
      FROM information_schema.columns
      WHERE table_schema IN ('staging','data_vault')
    `);
    const indexes = await queryTarget(singleColumnIndexCatalogSql());
    const relations = await queryTarget(`SELECT n.nspname AS table_schema, c.relname AS table_name, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('staging','data_vault')`);
    targetDelta = computeTargetDelta(expected, rows, indexes, relations);
    targetDeltaSql = targetDeltaIsEmpty(targetDelta) ? '' : buildIncrementalSql(targetDelta);
    renderTargetDiffResult(el);
  } catch(err){
    if (el) el.innerHTML = `<div class="ai-status err mt">${escapeHtml(err.message)}</div>`;
  }
}

function renderTargetDiffResult(el){
  if (!el || !targetDelta) return;
  const d = targetDelta;
  if (targetDeltaIsEmpty(d)){
    el.innerHTML = `<div class="ai-status ok mt">Target matches the generated DDL — all ${d.checkedTables} expected object(s) exist with all expected columns.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="ai-status ${d.missingTables.length || d.missingColumns.length || d.missingIndexes.length || d.obsoleteColumns.length ? 'err' : 'busy'} mt" style="align-items:flex-start;">
      <span>
        ${d.missingTables.length ? `${d.missingTables.length} table(s) missing on the target: ${d.missingTables.slice(0,10).map(t=>`<span class="mono">${escapeHtml(t.schema+'.'+t.name)}</span>`).join(', ')}${d.missingTables.length>10?'…':''}<br>` : ''}
        ${d.missingColumns.length ? `${d.missingColumns.length} column(s) missing: ${d.missingColumns.slice(0,10).map(c=>`<span class="mono">${escapeHtml(c.schema+'.'+c.table+'.'+c.column)}</span>`).join(', ')}${d.missingColumns.length>10?'…':''}<br>` : ''}
        ${d.missingIndexes.length ? `${d.missingIndexes.length} hash index(es) missing: ${d.missingIndexes.slice(0,10).map(i=>`<span class="mono">${escapeHtml(i.schema+'.'+i.table+'.'+i.column)}</span>`).join(', ')}${d.missingIndexes.length>10?'…':''}<br>` : ''}
        ${d.obsoleteColumns.length ? `${d.obsoleteColumns.length} obsolete Link Satellite column(s) to remove: ${d.obsoleteColumns.slice(0,10).map(c=>`<span class="mono">${escapeHtml(c.schema+'.'+c.table+'.'+c.column)}</span>`).join(', ')}${d.obsoleteColumns.length>10?'…':''}<br>` : ''}
        ${d.typeMismatches.length ? `${d.typeMismatches.length} type mismatch(es) — see warnings in the script (never auto-altered).` : ''}
      </span>
    </div>
    <div class="field mt">
      <label>Incremental DDL <span class="hint">(only required schema changes; obsolete Link Satellite columns are clearly listed before removal)</span></label>
      <textarea class="code-edit" id="target-diff-sql" spellcheck="false" wrap="off" style="min-height:180px;">${escapeHtml(targetDeltaSql)}</textarea>
    </div>
    <div class="grid cols-2 mt">
      <button class="btn" id="btn-target-diff-dl">⬇ Download incremental DDL</button>
      <button class="btn primary" id="btn-target-diff-run">Execute against target</button>
    </div>`;
  const ta = document.getElementById('target-diff-sql');
  if (ta) ta.addEventListener('input', e=> targetDeltaSql = e.target.value);
  document.getElementById('btn-target-diff-dl').addEventListener('click', ()=>
    downloadBlob(targetDeltaSql, `${state.vault.name||'vault'}_incremental_ddl.sql`, 'text/plain'));
  document.getElementById('btn-target-diff-run').addEventListener('click', async ()=>{
    // This SQL is user-editable free text. Generated Link Satellite repairs
    // can contain a narrowly-scoped DROP COLUMN, and any destructive statement
    // still requires explicit confirmation before execution.
    const destr = destructiveSqlKeywords(targetDeltaSql);
    if (destr.length){
      const kinds = [...new Set(destr)].join(', ');
      if (!confirm(`This SQL contains ${destr.length} destructive statement keyword(s) (${kinds}).\n\nReview the listed obsolete columns carefully. Execute against the target?`)) return;
    }
    await runSqlAgainstTarget(targetDeltaSql, 'Incremental DDL');
    runTargetDiff(); // re-diff so the panel reflects the now-updated target
  });
}
