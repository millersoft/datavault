const { PDI_META_LIMITS } = require('../public/js/domain/pdi-meta-limits');

function expectedColumns(limits = PDI_META_LIMITS){
  const out=[];
  for(const [fieldKey,field] of Object.entries(limits.fields || {})){
    for(const col of field.dbColumns || []) out.push({ fieldKey, ...col });
  }
  return out;
}

function checkLimitsSelfConsistency(limits = PDI_META_LIMITS){
  const errors=[];
  for(const [fieldKey,field] of Object.entries(limits.fields || {})){
    const widths=(field.dbColumns || []).map(c=>c.expectedMaxLength).filter(Number.isFinite);
    if(!widths.length) continue;
    const effective=Math.min(...widths);
    if(field.maxLength !== effective){
      errors.push(`${fieldKey}: Studio maxLength=${field.maxLength}, but the narrowest declared database column is ${effective}.`);
    }
  }
  return errors;
}

function checkMetadataRows(rows, limits = PDI_META_LIMITS){
  const errors=[...checkLimitsSelfConsistency(limits)];
  const actual=new Map();
  for(const row of rows || []){
    actual.set(`${row.table_name}.${row.column_name}`, row);
  }
  for(const expected of expectedColumns(limits)){
    const key=`${expected.table}.${expected.column}`;
    const row=actual.get(key);
    if(!row){
      errors.push(`${expected.fieldKey}: missing ${limits.schema}.${key}.`);
      continue;
    }
    const width=row.character_maximum_length == null ? null : Number(row.character_maximum_length);
    if(width !== expected.expectedMaxLength){
      errors.push(`${expected.fieldKey}: ${limits.schema}.${key} expected VARCHAR(${expected.expectedMaxLength}) but database reports ${width == null ? row.data_type : `VARCHAR(${width})`}.`);
    }
  }
  return errors;
}

module.exports={ expectedColumns, checkLimitsSelfConsistency, checkMetadataRows };
