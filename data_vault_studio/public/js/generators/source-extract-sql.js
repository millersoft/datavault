/* =========================================================================
   Staging SQL override builder (spreadsheet-spec.md pattern)
   ========================================================================= */
function sqlLiteral(s){
  // Escapes a value for safe embedding as a single-quoted SQL string literal
  // (doubles any embedded single quotes) — defense in depth against anyone
  // typing an apostrophe into a name/description field.
  return String(s || '').replace(/'/g, "''");
}

function sourceSqlIdent(name){
  // Keep common identifiers unquoted for readability. Database Packs declare
  // the exceptional quote pair, so adding a source does not add core SQL branches.
  const raw = String(name || '');
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(raw) && !RESERVED_SQL_WORDS.has(raw.toLowerCase())) return raw;
  const pack=databasePackForDialect(state.vault.dialect);
  if(pack){
    const q=pack.source&&pack.source.identifierQuote;
    const open=String(q&&q.open!=null?q.open:'"');
    const close=String(q&&q.close!=null?q.close:open);
    const escape=String(q&&q.escape!=null?q.escape:close+close);
    return open + raw.split(close).join(escape) + close;
  }
  const dialect = state.vault.dialect || 'postgresql';
  if (dialect === 'mysql') return '`' + raw.replace(/`/g, '``') + '`';
  return '"' + raw.replace(/"/g, '""') + '"';
}
function sourceSqlCol(c){
  const name = String(c || '');
  return `src.${sourceSqlIdent(name)}`;
}
function sourceSqlQualifiedName(schema, table){
  // Database Packs may be catalog/database scoped and legitimately have no
  // schema at all (MariaDB is the first certified example). Never manufacture
  // a PostgreSQL-style qualifier when the active source namespace is empty.
  const ns=String(schema||'').trim();
  return ns ? `${sourceSqlIdent(ns)}.${sourceSqlIdent(table)}` : sourceSqlIdent(table);
}
function sourceSqlEffectiveSchema(){
  const pack=databasePackForDialect(state.vault.dialect);
  if(!pack) return state.vault.sourceSchema||'';
  const values=packConnectionValues('source');
  return packValueMappedTo(pack,values,'schema') || String(pack.namespace?.defaultSchema||'');
}
function sourceSqlColumnSelectItems(table){
  // Do not emit `*` here. MySQL rejects `expr, *`, and explicit source
  // columns make the staging override stable even when Hop validates SQL or
  // when a source table later gains a column.
  return stagedColumns(table)
    .filter(c => c && c.name)
    .map(c => `${sourceSqlCol(c.name)} as ${targetColumnName(c)}`);
}

function buildOverride(table){
  // v0.2.0 contract: source SQL is extraction only. Business keys, SHA-256
  // hashes and tenant metadata are derived by the PostgreSQL staging view so
  // every source database produces identical Vault key bytes.
  const selectItems=sourceSqlColumnSelectItems(table);
  return 'select\n  ' + selectItems.join(',\n  ') + `\nfrom ${sourceSqlQualifiedName(sourceSqlEffectiveSchema(), table.name)} src\nwhere 1=1`;
}

function effectiveOverride(table){
  // Respects a hand-edited override; falls back to the auto-generated one.
  return table.customOverride != null ? table.customOverride : buildOverride(table);
}
function customOverrideDerivedOutputColumns(table){
  if(table.customOverride==null) return [];
  // v0.1 custom overrides sometimes returned hash/BK/tenant columns because the
  // physical staging table owned them. In v0.2 those are computed/read-only view
  // columns, so an old override must not try to INSERT values into them.
  const selectPart=String(table.customOverride).split(/\bfrom\b/i)[0];
  const derived=buildStagingViewColumns(table).filter(c=>c.derived).map(c=>c.name);
  return derived.filter(name=>new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}\\b`,'i').test(selectPart));
}

