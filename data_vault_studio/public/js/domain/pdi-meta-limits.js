/*
 * Data Vault Studio's explicit view of downstream pdi_meta field limits.
 *
 * The database remains the source of truth. This file exists so the GUI/model
 * can fail early instead of discovering a VARCHAR limit during workbook load or
 * the PDI design job. `npm run check:pdi-meta-schema` verifies every dbColumn
 * below against PostgreSQL information_schema.columns.
 *
 * `maxLength` is the effective Studio limit across the full population path.
 * A field can therefore be narrower than a final ref_* column when its staging
 * table is narrower (sourceTableName is the deliberate example).
 */
const PDI_META_LIMITS = Object.freeze({
  schema: 'pdi_meta',
  structures: Object.freeze({
    linkHubs: Object.freeze({
      label: 'Hubs per link',
      maxItems: 10,
      itemLabel: 'hubs',
      reason: 'the PDI metadata model only provides hub positions 1-10',
    }),
  }),
  fields: Object.freeze({
    vaultShortName: Object.freeze({
      label: 'Vault short name',
      // The longest generated connection suffix is _datavault (10 chars),
      // and ref_connections.name is VARCHAR(64).
      maxLength: 54,
      generatedConstraint: true,
      reason: 'generated <vault>_datavault connection names must fit VARCHAR(64)',
      dbColumns: Object.freeze([]),
    }),
    connectionName: Object.freeze({
      label: 'Connection name',
      maxLength: 64,
      workbookColumns: Object.freeze([
        { sheet:'connections', column:'name' },
        { sheet:'source_systems', column:'source_connection' },
        { sheet:'source_systems', column:'staging_connection' },
      ]),
      dbColumns: Object.freeze([
        { table:'ref_connections', column:'name', expectedMaxLength:64 },
        { table:'ref_connections_hist', column:'name', expectedMaxLength:64 },
        { table:'stg_management_source_systems', column:'source_connection', expectedMaxLength:128 },
        { table:'stg_management_source_systems', column:'staging_connection', expectedMaxLength:128 },
      ]),
    }),
    connectionHost: Object.freeze({
      label: 'Connection host',
      maxLength: 256,
      dbColumns: Object.freeze([
        { table:'ref_connections', column:'host_name', expectedMaxLength:256 },
        { table:'ref_connections_hist', column:'host_name', expectedMaxLength:256 },
      ]),
    }),
    connectionDatabase: Object.freeze({
      label: 'Connection database',
      maxLength: 256,
      dbColumns: Object.freeze([
        { table:'ref_connections', column:'database_name', expectedMaxLength:256 },
        { table:'ref_connections_hist', column:'database_name', expectedMaxLength:256 },
      ]),
    }),
    connectionUser: Object.freeze({
      label: 'Connection username',
      maxLength: 128,
      dbColumns: Object.freeze([
        { table:'ref_connections', column:'user_name', expectedMaxLength:128 },
        { table:'ref_connections_hist', column:'user_name', expectedMaxLength:128 },
      ]),
    }),
    dataVaultName: Object.freeze({
      label: 'Data vault name',
      maxLength: 128,
      workbookColumns: Object.freeze([{ sheet:'data_vault', column:'data_vault_name' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_data_vaults', column:'data_vault_name', expectedMaxLength:128 },
        { table:'ref_data_vaults', column:'data_vault_name', expectedMaxLength:128 },
        { table:'ref_data_vaults_hist', column:'data_vault_name', expectedMaxLength:128 },
      ]),
    }),
    dataVaultDescription: Object.freeze({
      label: 'Data vault description',
      maxLength: 512,
      workbookColumns: Object.freeze([{ sheet:'data_vault', column:'data_vault_description' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_data_vaults', column:'data_vault_description', expectedMaxLength:512 },
        { table:'ref_data_vaults', column:'data_vault_description', expectedMaxLength:512 },
        { table:'ref_data_vaults_hist', column:'data_vault_description', expectedMaxLength:512 },
      ]),
    }),
    sourceSystemCode: Object.freeze({
      label: 'Source system code',
      maxLength: 16,
      workbookColumns: Object.freeze([{ sheet:'source_systems', column:'cod_srcsys' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_source_systems', column:'cod_srcsys', expectedMaxLength:16 },
        { table:'ref_source_systems', column:'cod_srcsys', expectedMaxLength:16 },
        { table:'ref_source_systems_hist', column:'cod_srcsys', expectedMaxLength:16 },
      ]),
    }),
    sourceSystemDescription: Object.freeze({
      label: 'Source system description',
      maxLength: 128,
      workbookColumns: Object.freeze([
        { sheet:'source_systems', column:'description' },
        { sheet:'source_tables', column:'source_system' },
      ]),
      dbColumns: Object.freeze([
        { table:'stg_management_source_systems', column:'description', expectedMaxLength:128 },
        { table:'stg_management_source_tables', column:'source_system', expectedMaxLength:128 },
        { table:'ref_source_systems', column:'description', expectedMaxLength:128 },
        { table:'ref_source_systems_hist', column:'description', expectedMaxLength:128 },
      ]),
    }),
    sourceTableName: Object.freeze({
      label: 'Source table name',
      // Effective limit is 128 because workbook rows must pass through the
      // staging table even though ref_source_tables currently allows 256.
      maxLength: 128,
      workbookColumns: Object.freeze([{ sheet:'source_tables', column:'table_name' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_source_tables', column:'table_name', expectedMaxLength:128 },
        { table:'ref_source_tables', column:'table_name', expectedMaxLength:256 },
        { table:'ref_source_tables_hist', column:'table_name', expectedMaxLength:256 },
      ]),
    }),
    sourceSchema: Object.freeze({
      label: 'Source schema', maxLength: 128,
      workbookColumns: Object.freeze([{ sheet:'source_tables', column:'source_schema' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_source_tables', column:'source_schema', expectedMaxLength:128 },
        { table:'ref_source_tables', column:'source_schema', expectedMaxLength:128 },
        { table:'ref_source_tables_hist', column:'source_schema', expectedMaxLength:128 },
      ]),
    }),
    sourceTableDescription: Object.freeze({
      label: 'Source table description',
      maxLength: 128,
      workbookColumns: Object.freeze([{ sheet:'source_tables', column:'table_description' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_source_tables', column:'table_description', expectedMaxLength:128 },
        { table:'ref_source_tables', column:'description', expectedMaxLength:128 },
        { table:'ref_source_tables_hist', column:'description', expectedMaxLength:128 },
      ]),
    }),
    stagingTableName: Object.freeze({
      label: 'Staging table name',
      maxLength: 128,
      workbookColumns: Object.freeze([{ sheet:'source_tables', column:'staging_table_name' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_source_tables', column:'staging_table_name', expectedMaxLength:128 },
        { table:'ref_source_tables', column:'staging_table_name', expectedMaxLength:128 },
        { table:'ref_source_tables_hist', column:'staging_table_name', expectedMaxLength:128 },
      ]),
    }),
    sourceConcat: Object.freeze({
      label: 'Generated source_concat',
      maxLength: 256,
      generated: true,
      workbookColumns: Object.freeze([
        { sheet:'source_tables', column:'source_concat' },
        { sheet:'hubs', column:'hub_source' },
        { sheet:'links', column:'source_concat' },
        { sheet:'link_attributes', column:'source_concat' },
        { sheet:'hub_satellites', column:'source_concat' },
        { sheet:'link_satellites', column:'source_concat' },
      ]),
      dbColumns: Object.freeze([
        { table:'stg_management_source_tables', column:'source_concat', expectedMaxLength:256 },
        { table:'stg_management_hubs', column:'hub_source', expectedMaxLength:256 },
        { table:'stg_management_links', column:'source_concat', expectedMaxLength:256 },
        { table:'stg_management_link_attributes', column:'source_concat', expectedMaxLength:256 },
        { table:'stg_management_satellites', column:'source_concat', expectedMaxLength:256 },
        { table:'stg_management_link_satellites', column:'source_concat', expectedMaxLength:256 },
      ]),
    }),
    incrementDateColumn: Object.freeze({
      label: 'Increment date column',
      maxLength: 256,
      workbookColumns: Object.freeze([{ sheet:'source_tables', column:'increment_date_column' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_source_tables', column:'increment_date_column', expectedMaxLength:256 },
        { table:'ref_source_tables', column:'increment_date_column', expectedMaxLength:256 },
        { table:'ref_source_tables_hist', column:'increment_date_column', expectedMaxLength:256 },
      ]),
    }),
    stagingSqlOverride: Object.freeze({
      label: 'Staging SQL override',
      maxLength: 8192,
      workbookColumns: Object.freeze([{ sheet:'source_tables', column:'staging_sql_override' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_source_tables', column:'staging_sql_override', expectedMaxLength:8192 },
        { table:'ref_source_tables', column:'staging_sql_override', expectedMaxLength:8192 },
        { table:'ref_source_tables_hist', column:'staging_sql_override', expectedMaxLength:8192 },
      ]),
    }),
    hubDescription: Object.freeze({
      label: 'Hub description',
      // Deliberately 128: final ref_* is narrower than staging (256).
      maxLength: 128,
      workbookColumns: Object.freeze([{ sheet:'hubs', column:'hub_description' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_hubs', column:'hub_description', expectedMaxLength:256 },
        { table:'ref_data_vault_hubs', column:'hub_description', expectedMaxLength:128 },
        { table:'ref_data_vault_hubs_hist', column:'hub_description', expectedMaxLength:128 },
      ]),
    }),
    linkDescription: Object.freeze({
      label: 'Link description',
      maxLength: 128,
      workbookColumns: Object.freeze([{ sheet:'links', column:'link_description' }]),
      dbColumns: Object.freeze([
        { table:'stg_management_links', column:'link_description', expectedMaxLength:128 },
        { table:'ref_data_vault_links', column:'description', expectedMaxLength:128 },
        { table:'ref_data_vault_links_hist', column:'description', expectedMaxLength:128 },
      ]),
    }),
    satelliteDescription: Object.freeze({
      label: 'Satellite description',
      maxLength: 128,
      workbookColumns: Object.freeze([
        { sheet:'hub_satellites', column:'sat_description' },
        { sheet:'link_satellites', column:'sat_description' },
      ]),
      dbColumns: Object.freeze([
        { table:'stg_management_satellites', column:'sat_description', expectedMaxLength:128 },
        { table:'stg_management_link_satellites', column:'sat_description', expectedMaxLength:128 },
      ]),
    }),
    attributeColumn: Object.freeze({
      label: 'Satellite attribute column',
      maxLength: 128,
      workbookColumns: Object.freeze([
        { sheet:'link_attributes', column:'attribute_source_column' },
        { sheet:'link_attributes', column:'attribute_target_column' },
        { sheet:'hub_satellites', column:'attribute_source_column' },
        { sheet:'hub_satellites', column:'attribute_target_column' },
        { sheet:'link_satellites', column:'attribute_source_column' },
        { sheet:'link_satellites', column:'attribute_target_column' },
      ]),
      dbColumns: Object.freeze([
        { table:'stg_management_satellites', column:'attribute_source_column', expectedMaxLength:128 },
        { table:'stg_management_satellites', column:'attribute_target_column', expectedMaxLength:128 },
        { table:'stg_management_link_satellites', column:'attribute_source_column', expectedMaxLength:128 },
        { table:'stg_management_link_satellites', column:'attribute_target_column', expectedMaxLength:128 },
        { table:'stg_management_link_attributes', column:'attribute_source_column', expectedMaxLength:128 },
        { table:'stg_management_link_attributes', column:'attribute_target_column', expectedMaxLength:128 },
      ]),
    }),
  }),
});

function pdiMetaField(fieldKey){ return PDI_META_LIMITS.fields[fieldKey] || null; }
function pdiMetaStructure(structureKey){ return PDI_META_LIMITS.structures[structureKey] || null; }
function pdiMetaMaxLength(fieldKey){ const field=pdiMetaField(fieldKey); return field ? field.maxLength : null; }
function pdiMetaMaxItems(structureKey){ const rule=pdiMetaStructure(structureKey); return rule ? rule.maxItems : null; }
function pdiMetaLengthIssue(fieldKey, value, label=''){
  const field=pdiMetaField(fieldKey);
  if(!field || value==null) return '';
  const actual=Array.from(String(value)).length;
  if(actual<=field.maxLength) return '';
  return `${label || field.label} is ${actual} characters; pdi_meta supports a maximum of ${field.maxLength}.`;
}
function pdiMetaItemCountIssue(structureKey, value, label=''){
  const rule=pdiMetaStructure(structureKey);
  if(!rule || value==null) return '';
  const actual=Array.isArray(value) ? value.length : Number(value);
  if(!Number.isFinite(actual) || actual<=rule.maxItems) return '';
  return `${label || rule.label} has ${actual} ${rule.itemLabel}; pdi_meta supports a maximum of ${rule.maxItems} because ${rule.reason}.`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PDI_META_LIMITS, pdiMetaField, pdiMetaStructure, pdiMetaMaxLength, pdiMetaMaxItems, pdiMetaLengthIssue, pdiMetaItemCountIssue };
}
