#!/usr/bin/env node
'use strict';

// Compatibility entry point for maintainers who previously ran
// build-database-types.js. The old implementation contained a hand-maintained
// list of Hop database modules. That made Studio drift from the Hop engine.
//
// This version consumes HopCatalogExtractor.java output, so the exact pinned
// Hop runtime is the only source of database-type truth.
//
// Usage:
//   node build-database-types.js <hop-extract.json> [database-types.json]

const fs = require('node:fs');
const path = require('node:path');
const { buildCatalogue } = require('./build-database-packs');

const extractFile = process.argv[2] || process.env.HOP_EXTRACT_FILE;
const outFile = process.argv[3] || process.env.CATALOG_OUT || path.join(__dirname, 'database-types.json');

if (!extractFile) {
  console.error('Usage: node build-database-types.js <hop-extract.json> [database-types.json]');
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

const catalogue = buildCatalogue(rows);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(catalogue, null, 2) + '\n', 'utf8');
console.log(`Wrote ${catalogue.databaseTypes.length} Hop Table Input database types to ${outFile}`);
console.log('Source of truth: DatabasePluginType registry from the extracted Hop runtime.');
