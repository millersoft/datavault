#!/usr/bin/env node
'use strict';

// Build Studio Database Packs from the exact Apache Hop runtime extract.
//
// Design rule:
//   Hop decides WHAT database types Studio supports.
//   Studio only translates Hop's database metadata into its Pack format.
//
// No Hop database type is omitted because Studio already has a special path for
// it, or because the JDBC jar is not installed.  Driver installation metadata
// is a property of the Pack, not a compatibility filter.
//
// Usage:
//   node build-database-packs.js hop-extract.json out/database-packs [out/database-types.json]

const fs = require('node:fs');
const path = require('node:path');

function normaliseId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pluginKey(row) {
  return String(row && row.pluginId || '').trim().toUpperCase();
}

function tableInputCapable(row) {
  if (!row || row.error) return false;
  const key = pluginKey(row);
  if (key === 'NONE' || /^no connection type$/i.test(String(row.pluginName || row.label || ''))) return false;
  const capability = row.capabilities && row.capabilities.tableInput;
  if (typeof capability === 'boolean') return capability;
  if (typeof row.hopSqlCapable === 'boolean') return row.hopSqlCapable;
  return true;
}

function artifactIdFromDownload(row) {
  const coordinate = String(row?.driverDownload?.mavenCoordinate || '').trim();
  if (!coordinate) return '';
  const parts = coordinate.split(':');
  return parts.length >= 2 ? parts[1].trim() : '';
}

function stableJarTokenFromName(filename) {
  const base = path.basename(String(filename || '')).replace(/\.jar$/i, '');
  if (!base) return '';
  const parts = base.split('-');
  const keep = [];
  for (const part of parts) {
    if (/^v?\d+(?:[._]\d+)*(?:[._-].*)?$/i.test(part)) break;
    keep.push(part);
  }
  return (keep.join('-') || base).replace(/[^A-Za-z0-9._+-]/g, '');
}

function exactJarPattern(row) {
  // 1) Hop's own driver-download descriptor.
  const artifactId = artifactIdFromDownload(row);
  if (artifactId) return { pattern: `*${artifactId}*.jar`, source: 'hop-driver-download', confidence: 'exact' };

  // 2) The actual jar containing the driver in this pinned Hop runtime.
  const token = stableJarTokenFromName(row && row.driverJar);
  if (token) return { pattern: `*${token}*.jar`, source: 'hop-runtime-jar', confidence: 'exact' };

  return null;
}

// Hop always tells us the JDBC driver class for a concrete relational database
// plugin, but vendor licensing means the jar itself is often not bundled and
// older plugins do not expose IDatabase.getDriverDownload() metadata.  These
// rules infer only the FILE MATCH used to locate a user-supplied jar.  They do
// not decide database compatibility, driver class, URL format, port, or Hop
// plugin identity -- all of those still come from Hop.
const DRIVER_JAR_GUESSES = [
  [/com\.microsoft\.sqlserver\.jdbc\./i, '*mssql-jdbc*.jar'],
  [/net\.sourceforge\.jtds\./i, '*jtds*.jar'],
  [/com\.mysql\.|mysql\.jdbc/i, '*mysql-connector*.jar'],
  [/org\.mariadb\.jdbc/i, '*mariadb-java-client*.jar'],
  [/org\.postgresql\./i, '*postgresql*.jar'],
  [/oracle\.jdbc\./i, '*ojdbc*.jar'],
  [/com\.ibm\.db2\.jcc\./i, '*db2jcc*.jar'],
  [/org\.firebirdsql\./i, '*jaybird*.jar'],
  [/com\.intersystems\.jdbc\.iris/i, '*intersystems-jdbc*.jar'],
  [/com\.intersys\.jdbc\.|cachedriver/i, '*cachejdbc*.jar'],
  [/teradata/i, '*terajdbc*.jar'],
  [/vertica/i, '*vertica-jdbc*.jar'],
  [/netezza/i, '*nzjdbc*.jar'],
  [/exasol/i, '*exajdbc*.jar'],
  [/databricks/i, '*databricks*.jar'],
  [/cloudera.*impala|impala.*jdbc/i, '*ImpalaJDBC*.jar'],
  [/simba.*bigquery|googlebigquery|bigquery.*jdbc/i, '*GoogleBigQueryJDBC*.jar'],
  [/ucanaccess/i, '*ucanaccess*.jar'],
  [/sqlite/i, '*sqlite-jdbc*.jar'],
  [/duckdb/i, '*duckdb_jdbc*.jar'],
  [/clickhouse/i, '*clickhouse-jdbc*.jar'],
  [/crate/i, '*crate-jdbc*.jar'],
  [/org\.h2\.|h2driver/i, '*h2*.jar'],
  [/hsqldb|hypersonic/i, '*hsqldb*.jar'],
  [/derby/i, '*derby*.jar'],
  [/hive/i, '*hive-jdbc*.jar'],
  [/kingbase/i, '*kingbase*.jar'],
  [/sybase|sybdriver/i, '*jconn*.jar'],
  [/informix|ifxdriver/i, '*ifxjdbc*.jar'],
  [/ingres|vectorwise/i, '*iijdbc*.jar'],
  [/sap\.dbtech|sapdb/i, '*sapdbc*.jar'],
  [/singlestore|memsql/i, '*singlestore-jdbc*.jar'],
  [/interbase|interclient/i, '*interclient*.jar'],
  [/sqlbase|centura/i, '*sqlbase*.jar'],
  [/universe|com\.ibm\.u2|u2\.jdbc/i, '*unijdbc*.jar'],
  [/snowflake/i, '*snowflake-jdbc*.jar'],
  [/redshift/i, '*redshift-jdbc*.jar'],
  [/as400|jtopen|com\.ibm\.as400/i, '*jt400*.jar'],
  [/monetdb/i, '*monetdb-jdbc*.jar'],
];

function inferredJarPattern(row) {
  const driverClass = String(row && row.driverClass || '').trim();
  const identity = `${driverClass} ${row?.pluginId || ''} ${row?.pluginName || row?.label || ''}`;
  for (const [matcher, pattern] of DRIVER_JAR_GUESSES) {
    if (matcher.test(identity)) return { pattern, source: 'inferred-from-driver-class', confidence: 'high' };
  }

  // Last-resort deterministic fallback.  This is deliberately visible in the
  // manifest as inferred/low-confidence; it is still better than deleting a
  // Hop-supported database from Studio's generated catalogue.
  const token = normaliseId(row?.pluginId || row?.module || driverClass.split('.').slice(-2, -1)[0] || 'jdbc-driver');
  return { pattern: `*${token || 'jdbc-driver'}*.jar`, source: 'inferred-from-hop-plugin-id', confidence: 'low' };
}

function driverRequirement(row) {
  return exactJarPattern(row) || inferredJarPattern(row);
}

const URL_FALLBACKS = new Map([
  ['MSACCESS', 'jdbc:ucanaccess://{database}'],
  ['SQLITE', 'jdbc:sqlite:{database}'],
  ['DUCKDB', 'jdbc:duckdb:{database}'],
]);

function resolvedUrl(row) {
  const extracted = String(row && row.urlTemplate || '').trim();
  if (extracted) {
    return {
      template: extracted,
      source: 'hop-getURL',
      confidence: String(row.urlStatus || row.status || '') === 'extracted' ? 'exact' : 'review',
    };
  }
  const fallback = URL_FALLBACKS.get(pluginKey(row));
  if (fallback) return { template: fallback, source: 'inferred-fallback', confidence: 'review' };
  return null;
}

function cleanObject(value) {
  if (Array.isArray(value)) return value.map(cleanObject);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined || item === '') continue;
    if (Array.isArray(item) && item.length === 0) continue;
    if (typeof item === 'object' && !Array.isArray(item)) {
      const nested = cleanObject(item);
      if (Object.keys(nested).length) out[key] = nested;
    } else {
      out[key] = cleanObject(item);
    }
  }
  return out;
}


function safeFieldKey(value) {
  let key = String(value || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!key) return '';
  if (!/^[A-Za-z_]/.test(key)) key = `field_${key}`;
  return key;
}

// The Data Vault engine has a deliberately small, stable source connection
// profile.  The GUI may learn much more about a Hop database plugin, but it
// must only ask the user for values that can be persisted into this profile.
// Everything else remains preserved under hop.connectionForm for diagnostics
// and future engine versions, but is not rendered as a Studio source field.
const SOURCE_ENGINE_PROFILE = Object.freeze({
  hostname:     { key: 'host',     mapsTo: 'host',     label: 'Host',     variable: 'source_host_name' },
  port:         { key: 'port',     mapsTo: 'port',     label: 'Port',     variable: 'source_port_number' },
  databaseName: { key: 'database', mapsTo: 'database', label: 'Database', variable: 'source_database_name' },
  username:     { key: 'user',     mapsTo: 'user',     label: 'Username', variable: 'source_user_name' },
  password:     { key: 'password', mapsTo: 'password', label: 'Password', variable: 'source_password' },
});
const SOURCE_SCHEMA_PROFILE = Object.freeze({
  key: 'schema', mapsTo: 'schema', label: 'Schema', variable: 'source_schema_name',
  hopField: 'PREFERRED_SCHEMA_NAME', hopProperty: 'preferredSchemaName',
});

function sourceProfileMappingForHopField(field) {
  const hopId = String(field?.hopFieldId || field?.key || '').trim();
  return SOURCE_ENGINE_PROFILE[hopId] || null;
}

function hopFieldToStudio(field) {
  const hopId = String(field?.hopFieldId || field?.key || '').trim();
  const profile = sourceProfileMappingForHopField(field);
  if (!profile) return null;
  const hopType = String(field?.hopType || 'TEXT').toUpperCase();
  const type = field?.password || hopId === 'password'
    ? 'password'
    : hopType === 'CHECKBOX'
      ? 'checkbox'
      : hopType === 'COMBO'
        ? 'select'
        : hopId === 'port'
          ? 'number'
          : 'text';

  const out = {
    key: profile.key,
    label: String(field?.label || profile.label),
    type,
    required: false,
    mapsTo: profile.mapsTo,
    runtimeVariable: profile.variable,
    hopField: hopId,
    hopProperty: String(field?.property || hopId),
    hopType,
    hopOrder: field?.order || '',
    hopGroup: field?.group || '',
    hopGroupOrder: field?.groupOrder || '',
    metadataSource: String(field?.sourceClass || 'Hop DatabaseMetaEditor'),
  };
  if (field?.toolTip) out.help = String(field.toolTip);
  if (field?.default !== undefined && field?.default !== null && field?.default !== '') out.default = field.default;
  if (type === 'select' && Array.isArray(field?.options) && field.options.length) out.options = field.options;
  return out;
}

function annotatedHopConnectionForm(row) {
  const form = row?.connectionForm && typeof row.connectionForm === 'object'
    ? JSON.parse(JSON.stringify(row.connectionForm))
    : { fields: [] };
  form.fields = (Array.isArray(form.fields) ? form.fields : []).map(field => {
    const mapping = sourceProfileMappingForHopField(field);
    const hopId = String(field?.hopFieldId || '').trim();
    const hopVisible = field?.visible === true;
    return {
      ...field,
      studioSourceVisible: Boolean(hopVisible && mapping),
      studioSourceVariable: hopVisible && mapping ? mapping.variable : null,
      studioSourceMapsTo: hopVisible && mapping ? mapping.mapsTo : null,
      studioSourceReason: !hopVisible
        ? 'Hidden by Hop for this database type'
        : mapping
          ? 'Mapped into the Data Vault engine source_* profile'
          : hopId === 'manualUrl'
            ? 'The current Data Vault engine profile has no manual URL parameter'
            : 'Hop field is outside the current Data Vault engine source_* profile',
    };
  });
  return form;
}

function connectionFieldsFromHop(row, url) {
  const raw = Array.isArray(row?.connectionForm?.fields) ? row.connectionForm.fields : [];
  const fields = [];
  const seen = new Set();
  for (const hopField of raw) {
    if (hopField?.visible !== true) continue;
    const field = hopFieldToStudio(hopField);
    if (!field || seen.has(field.key)) continue;
    if (field.key === 'port' && (field.default === undefined || field.default === '') && row.defaultPort != null) {
      field.default = String(row.defaultPort);
    }
    fields.push(field);
    seen.add(field.key);
  }

  // source_schema_name is part of the engine profile even though Hop exposes
  // preferred schema as Advanced connection metadata rather than a General-tab
  // widget.  Only show it for database types where Hop reports schema support.
  if (row?.namespace?.supportsSchemas === true && !seen.has('schema')) {
    fields.push({
      key: SOURCE_SCHEMA_PROFILE.key,
      label: SOURCE_SCHEMA_PROFILE.label,
      type: 'text',
      required: false,
      mapsTo: SOURCE_SCHEMA_PROFILE.mapsTo,
      runtimeVariable: SOURCE_SCHEMA_PROFILE.variable,
      hopField: SOURCE_SCHEMA_PROFILE.hopField,
      hopProperty: SOURCE_SCHEMA_PROFILE.hopProperty,
      hopType: 'ADVANCED_ATTRIBUTE',
      metadataSource: 'Hop DatabaseMetaEditor Advanced / PREFERRED_SCHEMA_NAME',
      ...(row?.namespace?.preferredSchema ? { default: String(row.namespace.preferredSchema) } : {}),
    });
    seen.add('schema');
  }

  // Requiredness is only meaningful for fields the engine can actually store.
  // Standard URL tokens plus Hop's isRequiresName() give us that information
  // without promoting optional Hop-specific widgets into the source profile.
  const template = String(row?.baseUrlTemplate || url?.template || '');
  for (const field of fields) {
    if (template.includes(`{${field.key}}`)) field.required = true;
    if (field.mapsTo === 'database' && row?.requiresDatabaseName === true) field.required = true;
  }
  return fields;
}

function engineProfileForRow(row, url) {
  const form = annotatedHopConnectionForm(row);
  const ignored = (form.fields || [])
    .filter(field => field.visible === true && field.studioSourceVisible !== true)
    .map(field => ({
      hopField: String(field.hopFieldId || field.key || ''),
      hopProperty: String(field.property || field.hopFieldId || ''),
      label: String(field.label || field.hopFieldId || ''),
      reason: field.studioSourceReason,
    }));

  // Hop's base URL is captured before the extractor injects sentinels into
  // database-specific GUI properties.  A non-empty base URL therefore proves
  // that Hop can at least construct this database connection from the canonical
  // host/port/database inputs plus the plugin's own defaults.  We keep all Hop
  // plugins in the extraction output, but only profile-compatible packs are
  // offered in Studio's source selector.
  const baseTemplate = String(row?.baseUrlTemplate || '').trim();
  const compatible = Boolean(baseTemplate);
  return cleanObject({
    id: 'data-vault-source-v1',
    compatible,
    compatibilityBasis: compatible
      ? 'Hop getURL(host, port, database) succeeds with database-specific fields left at Hop defaults'
      : 'Hop did not produce a base JDBC URL from the engine profile inputs',
    variables: [
      'source_host_name',
      'source_port_number',
      'source_database_name',
      'source_user_name',
      'source_password',
      'source_schema_name',
    ],
    baseUrlTemplate: baseTemplate || null,
    ignoredHopFields: ignored,
  });
}

function catalogueEntry(row) {
  const module = normaliseId(row.pluginId || row.module);
  const hopModule = normaliseId(row.module);
  const pluginName = String(row.pluginName || row.label || row.pluginId || module).trim();
  const attributes = row.defaultAttributes && typeof row.defaultAttributes === 'object'
    ? { ...row.defaultAttributes }
    : {};
  const req = String(row.driverClass || '').trim() ? driverRequirement(row) : null;
  const url = resolvedUrl(row);

  return cleanObject({
    module,
    hopModule: hopModule && hopModule !== module ? hopModule : undefined,
    pluginId: String(row.pluginId || '').trim(),
    pluginName,
    aliases: [...new Set([module, String(row.pluginId || '').trim(), ...(Array.isArray(row.pluginIds) ? row.pluginIds : []), pluginName].filter(Boolean))],
    connectionDefaults: {
      accessType: Number.isFinite(Number(row.accessType)) ? Number(row.accessType) : 0,
      attributes,
    },
    connectionModel: {
      requiresDatabaseName: row.requiresDatabaseName,
      accessType: row.accessType,
      accessTypes: row.accessTypes || [],
      removeItems: row.removeItems || [],
    },
    connectionForm: annotatedHopConnectionForm(row),
    engineProfile: engineProfileForRow(row, url),
    jdbc: {
      driverClass: String(row.driverClass || '').trim(),
      driverJar: row.driverJar || null,
      jarPattern: req?.pattern || null,
      jarPatternSource: req?.source || null,
      jarPatternConfidence: req?.confidence || null,
      driverDownload: row.driverDownload || null,
      defaultPort: row.defaultPort ?? null,
      urlTemplate: String(row.baseUrlTemplate || '').trim() || url?.template || null,
      urlSource: String(row.baseUrlTemplate || '').trim() ? 'hop-getURL-base-profile' : (url?.source || null),
      urlConfidence: String(row.baseUrlTemplate || '').trim() ? 'exact' : (url?.confidence || null),
      hopFullUrlTemplate: url?.template || null,
      hopFullUrlRaw: row.urlRaw || null,
      baseUrlRaw: row.baseUrlRaw || null,
      defaultOptions: row.defaultOptions || {},
      optionSyntax: row.optionSyntax || {},
    },
    namespace: row.namespace || {},
    capabilities: row.capabilities || {},
    hopRuntime: {
      className: row.className || null,
      pluginLibraries: row.pluginLibraries || [],
      databaseFactoryName: row.databaseFactoryName || null,
    },
    studio: {
      tableInputSupported: tableInputCapable(row),
      generatedPack: tableInputCapable(row) && pluginKey(row) !== 'GENERIC',
      driverProvisioning: req ? req.source : 'user-supplied',
    },
  });
}

function buildCatalogue(rows) {
  const relational = rows
    .filter(row => tableInputCapable(row))
    .filter(row => pluginKey(row) !== 'GENERIC')
    .map(catalogueEntry)
    .sort((a, b) => String(a.pluginName).localeCompare(String(b.pluginName)));

  const genericRow = rows.find(row => pluginKey(row) === 'GENERIC');
  const generic = genericRow
    ? catalogueEntry(genericRow)
    : { pluginId: 'GENERIC', pluginName: 'Generic database', module: 'generic', connectionDefaults: { accessType: 0, attributes: {} } };

  return {
    catalogVersion: '5.0.0',
    generatedBy: 'data_vault_studio/hop/HopCatalogExtractor.java + build-database-packs.js',
    source: 'Exact DatabasePluginType registry from the pinned Apache Hop runtime',
    databaseTypes: relational,
    generic,
  };
}

function packForRow(row) {
  const key = pluginKey(row);
  const id = normaliseId(row.pluginId || row.module);
  const label = String(row.pluginName || row.label || row.pluginId || id).trim();
  const driverClass = String(row.driverClass || '').trim();

  if (!id) return { error: key || '?', reason: 'missing Hop plugin id' };
  if (!tableInputCapable(row)) return { excluded: id, reason: 'not Table Input capable' };
  if (key === 'GENERIC') {
    // Generic JDBC is intentionally represented in database-types.json rather
    // than as a static Pack: its driver class, jar and URL are supplied by the
    // user, so there is no concrete driver definition for us to pre-generate.
    return { generic: id, reason: 'user-supplied JDBC driver/class/URL' };
  }
  if (!driverClass) {
    return { error: id, reason: 'Hop marks this type as Table Input capable but did not expose a JDBC driver class' };
  }

  const req = driverRequirement(row);
  const url = resolvedUrl(row);
  if (!url || !url.template) {
    return { error: id, reason: 'Hop marks this type as Table Input capable but no JDBC URL could be extracted or safely inferred' };
  }

  const baseUrlTemplate = String(row.baseUrlTemplate || '').trim();
  const runtimeUrl = baseUrlTemplate
    ? { template: baseUrlTemplate, source: 'hop-getURL-base-profile', confidence: 'exact' }
    : url;
  const jdbc = {
    driverClass,
    jarPattern: req.pattern,
    jarPatternSource: req.source,
    jarPatternConfidence: req.confidence,
    urlTemplate: runtimeUrl.template,
    urlSource: runtimeUrl.source,
    urlConfidence: runtimeUrl.confidence,
    hopFullUrlTemplate: url.template,
  };
  if (row.defaultPort != null && Number.isFinite(Number(row.defaultPort)) && Number(row.defaultPort) > 0) {
    jdbc.defaultPort = Number(row.defaultPort);
  }
  if (row.driverDownload && typeof row.driverDownload === 'object') {
    jdbc.driverDownload = cleanObject(row.driverDownload);
  }
  if (row.defaultOptions && Object.keys(row.defaultOptions).length) {
    jdbc.hopDefaultOptions = { ...row.defaultOptions };
  }

  const namespace = {};
  const ns = row.namespace || {};
  if (typeof ns.supportsSchemas === 'boolean') namespace.usesSchema = ns.supportsSchemas;
  if (ns.preferredSchema) namespace.defaultSchema = String(ns.preferredSchema);
  namespace.discovery = cleanObject({ supportsSchemas: ns.supportsSchemas, supportsCatalogs: ns.supportsCatalogs });
  const connectionFields = connectionFieldsFromHop(row, url);
  const engineProfile = engineProfileForRow(row, url);

  const hop = cleanObject({
    enabled: true,
    pluginId: String(row.pluginId || '').trim(),
    pluginName: label,
    pluginIds: row.pluginIds || [],
    module: row.module || null,
    className: row.className || null,
    attributes: row.defaultAttributes || {},
    defaultOptions: row.defaultOptions || {},
    connectionModel: {
      requiresDatabaseName: row.requiresDatabaseName,
      accessType: row.accessType,
      accessTypes: row.accessTypes || [],
      removeItems: row.removeItems || [],
    },
    connectionForm: annotatedHopConnectionForm(row),
  });

  const notes = cleanObject({
    generatedFromHop: true,
    metadataPolicy: 'Hop defines database metadata; Studio exposes only the intersection with the Data Vault engine source_* profile and preserves all other Hop fields as non-rendered metadata.',
    extractedDriverJar: row.driverJar || null,
    driverPatternSource: req.source,
    driverPatternConfidence: req.confidence,
    hopUrlStatus: row.urlStatus || row.status || null,
    urlSource: jdbc.urlSource,
    urlConfidence: jdbc.urlConfidence,
    hopFullUrlSource: url.source,
    hopFullUrlConfidence: url.confidence,
    connectionReview: jdbc.urlConfidence !== 'exact',
  });

  return cleanObject({
    schemaVersion: 1,
    id,
    label,
    version: '1.0.0',
    certified: false,
    jdbc,
    connectionFields,
    engineProfile,
    namespace,
    hop,
    source: {
      enabled: engineProfile.compatible === true,
      ...(engineProfile.compatible === true ? {} : { disabledReason: engineProfile.compatibilityBasis }),
    },
    capabilities: {
      tableInput: true,
      hop: row.capabilities || {},
    },
    notes,
  });
}

function main() {
  const extractFile = process.argv[2] || process.env.HOP_EXTRACT_FILE;
  const outDir = process.argv[3] || process.env.PACK_OUT_DIR || path.join(process.cwd(), 'database-packs');
  const catalogueOut = process.argv[4] || process.env.CATALOG_OUT || '';

  if (!extractFile) {
    console.error('Usage: node build-database-packs.js <hop-extract.json> <out-database-packs-dir> [out-database-types.json]');
    process.exit(2);
  }

  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(extractFile, 'utf8'));
  } catch (err) {
    console.error(`Cannot read extract file ${extractFile}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(rows) || !rows.length) {
    console.error('Extract file must be a non-empty JSON array.');
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) {
    if (/^[a-z0-9][a-z0-9._-]*\.json$/i.test(name)) fs.unlinkSync(path.join(outDir, name));
  }

  const expected = rows.filter(row => tableInputCapable(row) && pluginKey(row) !== 'GENERIC');
  const written = [];
  const inferredDrivers = [];
  const reviewUrls = [];
  const profileDisabled = [];
  const profileIgnoredFields = [];
  const errors = [];
  const excluded = [];
  let generic = null;
  const seenIds = new Set();

  for (const row of rows) {
    const result = packForRow(row || {});
    if (result.generic) {
      generic = result;
      continue;
    }
    if (result.excluded) {
      excluded.push(`${result.excluded}: ${result.reason}`);
      continue;
    }
    if (result.error) {
      errors.push(`${result.error}: ${result.reason}`);
      continue;
    }

    if (seenIds.has(result.id)) {
      errors.push(`${result.id}: duplicate generated Pack id from Hop plugin registry`);
      continue;
    }
    seenIds.add(result.id);

    const file = path.join(outDir, `${result.id}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', 'utf8');
    written.push(result.id);
    if (result.jdbc?.jarPatternSource?.startsWith('inferred')) inferredDrivers.push(result.id);
    if (result.jdbc?.urlConfidence !== 'exact') reviewUrls.push(result.id);
    if (result.source?.enabled === false) profileDisabled.push(result.id);
    const ignored = result.engineProfile?.ignoredHopFields || [];
    if (ignored.length) profileIgnoredFields.push(`${result.id}: ${ignored.map(x=>x.label||x.hopField).join(', ')}`);
  }

  if (catalogueOut) {
    fs.mkdirSync(path.dirname(catalogueOut), { recursive: true });
    const catalogue = buildCatalogue(rows);
    fs.writeFileSync(catalogueOut, JSON.stringify(catalogue, null, 2) + '\n', 'utf8');
    console.log(`Wrote Hop database catalogue (${catalogue.databaseTypes.length} concrete Table Input types + Generic JDBC) to ${catalogueOut}`);
  }

  written.sort();
  inferredDrivers.sort();
  reviewUrls.sort();
  profileDisabled.sort();
  profileIgnoredFields.sort();

  console.log(`Wrote ${written.length} generated Database Pack manifests to ${outDir}`);
  console.log(`  generated: ${written.join(', ') || '(none)'}`);
  if (inferredDrivers.length) console.log(`  inferred JDBC jar patterns: ${inferredDrivers.join(', ')}`);
  if (reviewUrls.length) console.log(`  REVIEW JDBC URL extraction: ${reviewUrls.join(', ')}`);
  if (profileDisabled.length) console.log(`  not offered as Studio sources (engine profile mismatch): ${profileDisabled.join(', ')}`);
  if (profileIgnoredFields.length) console.log(`  Hop-only fields hidden from Studio source form: ${profileIgnoredFields.join('; ')}`);
  if (generic) console.log(`  Generic JDBC: catalogued separately (${generic.reason})`);
  if (excluded.length) console.log(`  excluded non-Table-Input types: ${excluded.join('; ')}`);

  // Fundamental invariant: every concrete Hop Table Input database type must
  // produce exactly one Pack.  Never silently ship a partial compatibility set.
  if (errors.length || written.length !== expected.length) {
    console.error('\nERROR: Hop -> Studio Database Pack coverage is incomplete.');
    console.error(`  Hop concrete Table Input types: ${expected.length}`);
    console.error(`  generated Pack manifests:       ${written.length}`);
    if (errors.length) console.error(`  failures: ${errors.join('; ')}`);
    const missing = expected
      .map(row => normaliseId(row.pluginId || row.module))
      .filter(id => id && !seenIds.has(id));
    if (missing.length) console.error(`  missing: ${[...new Set(missing)].sort().join(', ')}`);
    process.exit(1);
  }

  console.log(`\nCoverage OK: ${written.length}/${expected.length} concrete Hop Table Input database types have generated Packs.`);
  console.log('Generic JDBC remains the user-supplied custom-driver path and is present in database-types.json.');
  console.log('Generated Packs are certified:false; Hop SQL capability and Data Vault target certification are separate concerns.');
}

if (require.main === module) main();

module.exports = {
  buildCatalogue,
  catalogueEntry,
  packForRow,
  tableInputCapable,
  pluginKey,
  driverRequirement,
  resolvedUrl,
  connectionFieldsFromHop,
  engineProfileForRow,
  annotatedHopConnectionForm,
};
