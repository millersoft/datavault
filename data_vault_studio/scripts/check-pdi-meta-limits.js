#!/usr/bin/env node
const { Client } = require('pg');
const { PDI_META_LIMITS } = require('../public/js/domain/pdi-meta-limits');
const { checkMetadataRows } = require('./pdi-meta-schema-check-lib');

async function main(){
  const hasConnection = process.env.PDI_META_DATABASE_URL || process.env.DATABASE_URL || process.env.PGHOST;
  if(!hasConnection){
    console.error('PDI metadata schema check needs PDI_META_DATABASE_URL, DATABASE_URL, or standard PG* connection variables.');
    process.exitCode=2;
    return;
  }
  const client = new Client({ connectionString: process.env.PDI_META_DATABASE_URL || process.env.DATABASE_URL || undefined });
  await client.connect();
  try{
    const { rows } = await client.query(`
      SELECT table_name, column_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = $1
    `, [PDI_META_LIMITS.schema]);
    const errors=checkMetadataRows(rows);
    if(errors.length){
      console.error(`pdi_meta limits check failed with ${errors.length} issue(s):`);
      errors.forEach(error=>console.error(` - ${error}`));
      process.exitCode=1;
      return;
    }
    console.log(`pdi_meta limits OK: ${Object.keys(PDI_META_LIMITS.fields).length} Studio fields verified against ${PDI_META_LIMITS.schema}.`);
  } finally {
    await client.end();
  }
}

main().catch(err=>{
  console.error('pdi_meta limits check failed:', err && err.message ? err.message : err);
  process.exitCode=1;
});
