const { test, describe } = require('node:test');
const assert = require('node:assert');
const { PDI_META_LIMITS, pdiMetaLengthIssue, pdiMetaMaxItems, pdiMetaItemCountIssue } = require('../public/js/domain/pdi-meta-limits');
const { expectedColumns, checkLimitsSelfConsistency, checkMetadataRows } = require('../scripts/pdi-meta-schema-check-lib');

describe('pdi_meta limits', () => {
  test('effective Studio limits match the narrowest declared database column', () => {
    assert.deepStrictEqual(checkLimitsSelfConsistency(), []);
    assert.strictEqual(PDI_META_LIMITS.fields.vaultShortName.maxLength, 54);
    assert.strictEqual(PDI_META_LIMITS.fields.connectionHost.maxLength, 256);
    assert.strictEqual(PDI_META_LIMITS.fields.connectionDatabase.maxLength, 256);
    assert.strictEqual(PDI_META_LIMITS.fields.connectionUser.maxLength, 128);
    assert.strictEqual(PDI_META_LIMITS.fields.connectionPassword, undefined, 'runtime passwords are not constrained by ref_connections.password');
    assert.strictEqual(PDI_META_LIMITS.fields.sourceTableName.maxLength, 128);
    assert.deepStrictEqual(
      PDI_META_LIMITS.fields.sourceTableName.dbColumns.map(c=>c.expectedMaxLength),
      [128, 256, 256]
    );
    assert.ok(!expectedColumns().some(c=>c.table==='ref_connections' && c.column==='password'), 'ref_connections.password must not be part of the Studio limits contract');
    assert.ok(!expectedColumns().some(c=>c.table==='ref_connections_hist' && c.column==='password'), 'ref_connections_hist.password must not be part of the Studio limits contract');
  });

  test('length helper allows the boundary and rejects the next character', () => {
    assert.strictEqual(pdiMetaLengthIssue('sourceSystemCode', 'X'.repeat(16)), '');
    assert.match(pdiMetaLengthIssue('sourceSystemCode', 'X'.repeat(17)), /17 characters.*maximum of 16/i);
    assert.strictEqual(pdiMetaLengthIssue('stagingSqlOverride', 'x'.repeat(8192)), '');
    assert.match(pdiMetaLengthIssue('stagingSqlOverride', 'x'.repeat(8193)), /8193 characters.*maximum of 8192/i);
  });


  test('link hub count is capped at the pdi_meta structural limit', () => {
    assert.strictEqual(pdiMetaMaxItems('linkHubs'), 10);
    assert.strictEqual(pdiMetaItemCountIssue('linkHubs', Array(10).fill({})), '');
    assert.match(
      pdiMetaItemCountIssue('linkHubs', Array(11).fill({}), 'Link "orders_customers"'),
      /11 hubs.*maximum of 10.*hub positions 1-10/i
    );
  });

  test('schema checker accepts matching information_schema metadata', () => {
    const rows = expectedColumns().map(c=>({
      table_name:c.table,
      column_name:c.column,
      data_type:'character varying',
      character_maximum_length:c.expectedMaxLength,
    }));
    assert.deepStrictEqual(checkMetadataRows(rows), []);
  });

  test('schema checker fails when the DB drifts from the explicit limits', () => {
    const rows = expectedColumns().map(c=>({
      table_name:c.table,
      column_name:c.column,
      data_type:'character varying',
      character_maximum_length:c.expectedMaxLength,
    }));
    const changed=rows.find(r=>r.table_name==='stg_management_source_tables' && r.column_name==='table_name');
    changed.character_maximum_length=200;
    const errors=checkMetadataRows(rows);
    assert.ok(errors.some(e=>/stg_management_source_tables\.table_name expected VARCHAR\(128\).*VARCHAR\(200\)/i.test(e)));
  });
});
