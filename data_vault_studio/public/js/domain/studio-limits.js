/*
 * Studio-level limits and input rules that do not come directly from pdi_meta.
 *
 * Keep these separate from pdi-meta-limits.js so it remains clear which
 * restrictions are imposed by PDI metadata and which are Studio/target-schema
 * rules or usability guardrails.
 */
const STUDIO_LIMITS = Object.freeze({
  fields: Object.freeze({
    stagingPrefix: Object.freeze({
      label: 'Staging prefix',
      maxLength: 30,
      reason: 'keeps generated staging identifiers readable before Studio needs to shorten and hash them',
    }),
    tenantId: Object.freeze({
      label: 'Tenant ID literal',
      maxLength: 20,
      reason: 'generated Data Vault tenant_id columns are VARCHAR(20)',
    }),
  }),
});

/*
 * Character rules for important naming/key fields.
 * These are deliberately product rules rather than database-width rules.
 * The framework has been verified to accept spaces in source-system description
 * and tenant ID, so spaces remain allowed there. Leading/trailing spaces are
 * rejected because they are visually ambiguous and source-system description is
 * reused as the source_tables.source_system join value.
 */
const STUDIO_INPUT_RULES = Object.freeze({
  vaultShortName: Object.freeze({
    label: 'Vault short name',
    pattern: /^[A-Za-z0-9_-]+$/,
    message: 'Only letters, numbers, hyphens and underscores are allowed. Spaces are not allowed.',
  }),
  stagingPrefix: Object.freeze({
    label: 'Staging prefix',
    pattern: /^[A-Za-z0-9_-]+$/,
    message: 'Only letters, numbers, hyphens and underscores are allowed. Spaces are not allowed.',
  }),
  sourceSystemCode: Object.freeze({
    label: 'Source system code',
    pattern: /^[A-Za-z0-9_-]+$/,
    message: 'Only letters, numbers, hyphens and underscores are allowed. Spaces are not allowed.',
  }),
  sourceSystemDescription: Object.freeze({
    label: 'Source system description',
    pattern: /^[A-Za-z0-9 _-]+$/,
    message: 'Only letters, numbers, spaces, hyphens and underscores are allowed.',
    rejectOuterSpaces: true,
  }),
  tenantId: Object.freeze({
    label: 'Tenant ID literal',
    pattern: /^[A-Za-z0-9 _-]+$/,
    message: 'Only letters, numbers, spaces, hyphens and underscores are allowed.',
    rejectOuterSpaces: true,
  }),
});

function studioField(fieldKey){ return STUDIO_LIMITS.fields[fieldKey] || null; }
function studioMaxLength(fieldKey){ const field=studioField(fieldKey); return field ? field.maxLength : null; }
function studioLengthIssue(fieldKey, value, label=''){
  const field=studioField(fieldKey);
  if(!field || value==null) return '';
  const actual=Array.from(String(value)).length;
  if(actual<=field.maxLength) return '';
  return `${label || field.label} is ${actual} characters; Studio supports a maximum of ${field.maxLength} because ${field.reason}.`;
}
function studioInputRule(fieldKey){ return STUDIO_INPUT_RULES[fieldKey] || null; }
function studioInputIssue(fieldKey, value, label=''){
  const rule=studioInputRule(fieldKey);
  if(!rule || value==null || String(value)==='') return '';
  const text=String(value);
  if(rule.rejectOuterSpaces && text.trim()!==text) return `${label || rule.label} cannot start or end with a space.`;
  if(!rule.pattern.test(text)) return `${label || rule.label}: ${rule.message}`;
  return '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { STUDIO_LIMITS, STUDIO_INPUT_RULES, studioField, studioMaxLength, studioLengthIssue, studioInputRule, studioInputIssue };
}
