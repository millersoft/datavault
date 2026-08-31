function buildStagingBaseColumns(table){
  // Physical landing table is a copy of the selected source columns only.
  return stagedColumns(table).map(c => ({
    name:targetColumnName(c),
    type:mapColumnType(c),
    notNull:stagingColumnUsesNotNull(c),
  }));
}

function ddlFromColumns(tableName, cols){
  const body = cols.map(c=>`  ${c.name} ${c.type}${c.notNull?' NOT NULL':''}`).join(',\n');
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n${body}\n);`;
}
