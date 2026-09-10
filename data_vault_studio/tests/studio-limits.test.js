const { test, describe } = require('node:test');
const assert = require('node:assert');
const { STUDIO_LIMITS, studioMaxLength, studioLengthIssue } = require('../public/js/domain/studio-limits');

describe('Studio-only limits', () => {
  test('staging prefix uses the 30-character usability guardrail', () => {
    assert.strictEqual(STUDIO_LIMITS.fields.stagingPrefix.maxLength, 30);
    assert.strictEqual(studioMaxLength('stagingPrefix'), 30);
    assert.strictEqual(studioLengthIssue('stagingPrefix', 'x'.repeat(30)), '');
    assert.match(studioLengthIssue('stagingPrefix', 'x'.repeat(31)), /31 characters.*maximum of 30/i);
  });

  test('tenant ID is capped at the generated VARCHAR(20) target width', () => {
    assert.strictEqual(STUDIO_LIMITS.fields.tenantId.maxLength, 20);
    assert.strictEqual(studioLengthIssue('tenantId', 'x'.repeat(20)), '');
    assert.match(studioLengthIssue('tenantId', 'x'.repeat(21)), /21 characters.*maximum of 20.*VARCHAR\(20\)/i);
  });
});

describe('important naming character rules', () => {
  test('vault short name, staging prefix and source-system code reject spaces and special characters', () => {
    const { studioInputIssue } = require('../public/js/domain/studio-limits');
    for (const key of ['vaultShortName','stagingPrefix','sourceSystemCode']) {
      assert.strictEqual(studioInputIssue(key, 'sales_data-01'), '');
      assert.match(studioInputIssue(key, 'sales data'), /Spaces are not allowed/i);
      assert.match(studioInputIssue(key, 'sales@data'), /Only letters, numbers, hyphens and underscores/i);
    }
  });

  test('source-system description and tenant ID allow internal spaces but reject punctuation and outer spaces', () => {
    const { studioInputIssue } = require('../public/js/domain/studio-limits');
    for (const key of ['sourceSystemDescription','tenantId']) {
      assert.strictEqual(studioInputIssue(key, 'Sales Data UK'), '');
      assert.strictEqual(studioInputIssue(key, 'Sales_Data-UK'), '');
      assert.match(studioInputIssue(key, ' Sales Data'), /cannot start or end with a space/i);
      assert.match(studioInputIssue(key, 'Sales Data '), /cannot start or end with a space/i);
      assert.match(studioInputIssue(key, 'Sales@Data'), /Only letters, numbers, spaces, hyphens and underscores/i);
    }
  });
});
