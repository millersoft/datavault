/* =========================================================================
   GENERATORS — staging DDL, data vault DDL, pdi_meta, xlsx workbook
   ========================================================================= */
function mapColumnType(col){
  // Database Pack JDBC discovery normalises vendor-native types to Studio's
  // semantic/PostgreSQL-facing type before they reach this generator. Keep the
  // DDL mapper generic: no SQL Server/Oracle/etc. source branches belong here.
  const raw = String(col && col.type || '').trim();
  if (isBooleanType(raw)) return 'VARCHAR(5)';
  if (isJsonLikeType(raw) || isUnboundedTextType(raw)) return 'TEXT';
  return raw.toUpperCase();
}

function satelliteAttributeType(sat, attr){
  const table = sat && findTable(sat.tableId);
  const sourceCol = table && findStagedColumn(table, attr && attr.colId);
  if (!sourceCol) return 'VARCHAR(256)';
  const mapped = mapColumnType(sourceCol);
  const upper = String(mapped||'').trim().toUpperCase();
  // Keep the historical 256-character default for ordinary descriptive
  // values, but never narrow source columns that can legitimately exceed it.
  if (upper === 'TEXT' || upper === 'BYTEA') return upper;
  const sized = upper.match(/^(?:VAR)?CHAR\((\d+)\)$/);
  if (sized && Number(sized[1]) > 256) return upper;
  return 'VARCHAR(256)';
}

function normalizedColumnProfile(col){
  const p = col && col.profile;
  if (!p || typeof p!=='object') return null;
  return {
    totalRows:Number(p.totalRows||0),
    distinctValues:p.distinctValues==null ? null : Number(p.distinctValues||0),
    nullValues:Number(p.nullValues||0),
    blankValues:Number(p.blankValues||0),
    profiledAt:p.profiledAt||'',
    source:p.source||'manual',
  };
}

function columnProfileIsUserRequested(col){
  const p = normalizedColumnProfile(col);
  return !!p && p.source!=='infer-schema';
}

function stagingColumnUsesNotNull(col){
  if (!col) return false;
  // Match the declared source constraint by default. Primary keys are
  // inherently non-null even when imported metadata is internally
  // inconsistent. Profiling is an exception layer: if live data contains a
  // SQL NULL or a blank/whitespace value that the engine can normalise to
  // NULL, make the staging landing column nullable so the row can load.
  const sourceRequiresNotNull = col.pk===true || col.nullable===false;
  if (!sourceRequiresNotNull) return false;
  const profile = normalizedColumnProfile(col);
  return !profile || (profile.nullValues===0 && profile.blankValues===0);
}

function columnProfileSummary(col){
  const p = normalizedColumnProfile(col);
  if (!p) return '';
  const hasDistinct = p.distinctValues!=null;
  const uniq = hasDistinct && p.totalRows>0 ? Math.round((p.distinctValues/p.totalRows)*100) : 0;
  const distinctText = hasDistinct
    ? `${p.distinctValues.toLocaleString()} distinct (${uniq}% unique)`
    : 'distinct not measured';
  const keyNote = hasDistinct && p.totalRows>0 && p.distinctValues===p.totalRows && p.nullValues===0 && p.blankValues===0
    ? ' · fully unique, strong business-key candidate' : '';
  const ddlNote = stagingColumnUsesNotNull(col)
    ? ' · staging NOT NULL'
    : ' · staging nullable';
  return `${col.name}: ${p.totalRows.toLocaleString()} rows · ${distinctText} · ${p.nullValues.toLocaleString()} null · ${p.blankValues.toLocaleString()} blank${ddlNote}${keyNote}`;
}

