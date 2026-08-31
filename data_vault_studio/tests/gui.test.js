/**
 * GUI unit tests — run the app's inline scripts in a Node vm sandbox
 * (tests/helpers/load-app.js) and exercise the pure logic: naming,
 * parsing, validation, DDL generation, schema drift, FK-based model
 * suggestion, undo, and autosave.
 *
 * Run:  npm test        (or: node --test tests/)
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { loadApp, readFrontendSources, readServerSources } = require('./helpers/load-app');

// Tests marked `test.skip` below document the superseded v0.1
// source-hashing/built-in-SQL-Server contract. The active replacement is
// database-packs-v020.test.js: PostgreSQL staging views own hashing and SQL
// Server is installed through a Database Pack.

// One fresh app per test file run; individual tests reset state as needed.
let app;

function resetApp(){
  app = loadApp();
}

/** Builds a small but complete e-commerce-ish model in the sandbox. */
function seedFixture(){
  app.eval(`
    startNewProject(true);
    state.vault.name = 'sales';
    state.vault.prefix = 'sales';
    state.vault.tenantId = 'SALES';
    state.vault.srcDescription = 'Sales data';
    state.vault.srcCod = 'SALES';
    state.vault.vaultDbName = 'datavault_sales';
    state.vault.sourceSchema = 'public';

    const customers = newTable('customers');
    customers.columns = [
      Object.assign(newColumn('id','integer'), { pk:true, nullable:false }),
      Object.assign(newColumn('name','varchar(100)'), {}),
      Object.assign(newColumn('email','varchar(255)'), {}),
      Object.assign(newColumn('updated_at','timestamp'), {}),
    ];
    state.tables.push(customers);

    const orders = newTable('orders');
    orders.columns = [
      Object.assign(newColumn('id','integer'), { pk:true, nullable:false }),
      Object.assign(newColumn('customer_id','integer'), { nullable:false }),
      Object.assign(newColumn('order_date','date'), {}),
      Object.assign(newColumn('total','numeric(10,2)'), {}),
    ];
    state.tables.push(orders);

    const orderTags = newTable('order_tags'); // pure junction
    orderTags.columns = [
      Object.assign(newColumn('order_id','integer'), { nullable:false }),
      Object.assign(newColumn('tag_id','integer'), { nullable:false }),
      Object.assign(newColumn('created_at','timestamp'), {}),
    ];
    state.tables.push(orderTags);

    const tags = newTable('tags');
    tags.columns = [
      Object.assign(newColumn('id','integer'), { pk:true, nullable:false }),
      Object.assign(newColumn('label','varchar(50)'), {}),
    ];
    state.tables.push(tags);

    state.sourceMeta.foreignKeys = [
      { table:'orders',     column:'customer_id', refTable:'customers', refColumn:'id' },
      { table:'order_tags', column:'order_id',    refTable:'orders',    refColumn:'id' },
      { table:'order_tags', column:'tag_id',      refTable:'tags',      refColumn:'id' },
    ];
  `);
}

describe('naming helpers', () => {
  beforeEach(resetApp);

  test('hub/link/sat names follow <type>_<vault>_<entity>', () => {
    app.eval(`state.vault.name = 'sales'; state.vault.prefix = 'sl';`);
    assert.strictEqual(app.eval(`hubName('customer')`), 'hub_sales_customer');
    assert.strictEqual(app.eval(`hubKey('customer')`), 'hub_sales_customer_id');
    assert.strictEqual(app.eval(`linkNameOf('customer_order')`), 'link_sales_customer_order');
    assert.strictEqual(app.eval(`satName('customer','profile')`), 'sat_sales_customer_profile');
    assert.strictEqual(app.eval(`satName('customer','')`), 'sat_sales_customer');
    assert.strictEqual(app.eval(`lsatName('customer_order','notes')`), 'lsat_sales_customer_order_notes');
    assert.strictEqual(app.eval(`stagingTableName('orders')`), 'stg_sl_orders');
  });

  test('singularizeTableName handles common English plurals', () => {
    assert.strictEqual(app.eval(`singularizeTableName('customers')`), 'customer');
    assert.strictEqual(app.eval(`singularizeTableName('categories')`), 'category');
    assert.strictEqual(app.eval(`singularizeTableName('addresses')`), 'address');
    assert.strictEqual(app.eval(`singularizeTableName('order_items')`), 'order_item');
    assert.strictEqual(app.eval(`singularizeTableName('data')`), 'data'); // no trailing s
  });
});

describe('parsers', () => {
  beforeEach(resetApp);

  test('parseCreateTable extracts columns, PKs and nullability', () => {
    const parsed = app.eval(`parseCreateTable(
      "CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL, active BOOLEAN);"
    )`);
    assert.strictEqual(parsed.name, 'customers');
    assert.strictEqual(parsed.columns.length, 3);
    const [id, name, active] = parsed.columns;
    assert.strictEqual(id.pk, true);
    assert.strictEqual(id.nullable, false);
    assert.strictEqual(name.nullable, false);
    assert.strictEqual(active.nullable, true);
  });

  test('parseCreateTable handles table-level PRIMARY KEY constraint', () => {
    const parsed = app.eval(`parseCreateTable(
      "CREATE TABLE t (a INT, b INT, PRIMARY KEY (a, b));"
    )`);
    assert.ok(parsed.columns.find(c => c.name === 'a').pk);
    assert.ok(parsed.columns.find(c => c.name === 'b').pk);
    assert.strictEqual(parsed.columns.find(c => c.name === 'a').nullable, false);
    assert.strictEqual(parsed.columns.find(c => c.name === 'b').nullable, false);
  });

  test('parseInfoSchemaBulk parses CSV with a header', () => {
    const byTable = app.eval(`parseInfoSchemaBulk(
      "table_name,column_name,data_type,is_nullable,is_pk\\ncustomers,id,int,NO,YES\\ncustomers,name,varchar,YES,NO"
    )`);
    assert.deepStrictEqual(Object.keys(byTable), ['customers']);
    assert.strictEqual(byTable.customers.length, 2);
    assert.strictEqual(byTable.customers[0].pk, true);
    assert.strictEqual(byTable.customers[0].nullable, false);
    assert.strictEqual(byTable.customers[1].nullable, true);
  });

  test('extractJsonObject parses fenced and prose-wrapped JSON', () => {
    assert.deepStrictEqual(app.eval(`extractJsonObject('{"a":1}')`), { a: 1 });
    assert.deepStrictEqual(app.eval("extractJsonObject('```json\\n{\"a\":1}\\n```')"), { a: 1 });
    assert.deepStrictEqual(app.eval(`extractJsonObject('Here you go: {"a":{"b":2}} hope that helps')`), { a: { b: 2 } });
    assert.throws(() => app.eval(`extractJsonObject('no json here')`));
  });
});

describe('staging type mapping', () => {
  beforeEach(resetApp);

  test('booleans widen to VARCHAR(5), json-ish types to TEXT', () => {
    app.eval(`state.vault.dialect = 'postgresql';`);
    assert.strictEqual(app.eval(`mapColumnType({ type:'boolean' })`), 'VARCHAR(5)');
    assert.strictEqual(app.eval(`mapColumnType({ type:'jsonb' })`), 'TEXT');
    assert.strictEqual(app.eval(`mapColumnType({ type:'integer' })`), 'INTEGER');
  });
});

describe('wizard step navigation', () => {
  beforeEach(resetApp);

  test('explicit navigation resets the main application scroller', () => {
    const result = app.eval(`
      startNewProject(true);
      const source = newTable('address');
      source.columns = [Object.assign(newColumn('address_id','smallint'), { pk:true, nullable:false })];
      state.tables = [source]; // no derivations, so the initial hash warning is rendered
      const originalGetElementById = document.getElementById;
      const mainScroller = { scrollTop:920, scrollLeft:30, innerHTML:'', style:{}, scrollTo(x,y){ this.scrollLeft=x; this.scrollTop=y; } };
      document.getElementById = id => id==='main' ? mainScroller : originalGetElementById(id);
      document.documentElement.scrollTop = 920;
      document.body.scrollTop = 920;
      navigateDesignerTab('staging');
      [activeTab, stagingTablesMissingHashColumns().length, mainScroller.scrollTop, mainScroller.scrollLeft, document.documentElement.scrollTop, document.body.scrollTop]
    `);
    assert.deepStrictEqual(result, ['staging', 1, 0, 0, 0, 0]);
  });
});

describe('profile-driven staging nullability', () => {
  beforeEach(resetApp);

  test('unprofiled source NOT NULL columns match the source', () => {
    const result = app.eval(`
      startNewProject(true);
      state.vault.prefix = 'sak';
      const address = newTable('address');
      address.columns = [Object.assign(newColumn('district','varchar(20)'), { nullable:false })];
      state.tables = [address];
      const cols = buildStagingColumns(address);
      ({ column: cols[0], ddl: buildStagingDdl() })
    `);
    assert.strictEqual(result.column.notNull, true);
    assert.match(result.ddl, /district VARCHAR\(20\) NOT NULL/);
    assert.doesNotMatch(result.ddl, /ALTER TABLE[\s\S]*DROP NOT NULL/);
  });

  test('primary keys are NOT NULL even when imported nullable metadata is inconsistent', () => {
    const result = app.eval(`
      startNewProject(true);
      state.vault.prefix = 'sak';
      const address = newTable('address');
      address.columns = [Object.assign(newColumn('address_id','smallint'), { nullable:true, pk:true })];
      state.tables = [address];
      ({ column: buildStagingColumns(address)[0], ddl: buildStagingDdl() })
    `);
    assert.strictEqual(result.column.notNull, true);
    assert.match(result.ddl, /address_id SMALLINT NOT NULL/);
  });

  test('clean profile preserves source NOT NULL in the initial CREATE TABLE', () => {
    const result = app.eval(`
      startNewProject(true);
      state.vault.prefix = 'sak';
      const address = newTable('address');
      const district = Object.assign(newColumn('district','varchar(20)'), {
        nullable:false,
        profile:{ totalRows:603, distinctValues:378, nullValues:0, blankValues:0 }
      });
      address.columns = [district];
      state.tables = [address];
      ({ column: buildStagingColumns(address)[0], ddl: buildStagingDdl(), summary: columnProfileSummary(district) })
    `);
    assert.strictEqual(result.column.notNull, true);
    assert.match(result.ddl, /district VARCHAR\(20\) NOT NULL/);
    assert.match(result.summary, /staging NOT NULL/);
    assert.doesNotMatch(result.ddl, /ALTER TABLE[\s\S]*DROP NOT NULL/);
  });

  test('blank or SQL-null profile values make the initial staging column nullable', () => {
    const result = app.eval(`
      const table = newTable('address');
      const blank = Object.assign(newColumn('district','varchar(20)'), {
        nullable:false,
        profile:{ totalRows:603, distinctValues:378, nullValues:0, blankValues:4 }
      });
      const withNull = Object.assign(newColumn('address2','varchar(50)'), {
        nullable:false,
        profile:{ totalRows:603, distinctValues:599, nullValues:4, blankValues:0 }
      });
      const blankPk = Object.assign(newColumn('address_id','smallint'), {
        nullable:false,
        pk:true,
        profile:{ totalRows:603, distinctValues:602, nullValues:0, blankValues:1 }
      });
      table.columns = [blank, withNull, blankPk];
      buildStagingColumns(table).slice(0,3)
    `);
    assert.deepStrictEqual(result.map(c => c.notNull), [false, false, false]);
  });

  test('unprofiled source-nullable columns match the source and stay nullable', () => {
    const notNull = app.eval(`
      const table = newTable('address');
      table.columns = [Object.assign(newColumn('address2','varchar(50)'), { nullable:true })];
      buildStagingColumns(table)[0].notNull
    `);
    assert.strictEqual(notNull, false);
  });

  test('source-nullable columns stay nullable even when their profile is clean', () => {
    const notNull = app.eval(`
      const table = newTable('address');
      table.columns = [Object.assign(newColumn('address2','varchar(50)'), {
        nullable:true,
        profile:{ totalRows:603, distinctValues:603, nullValues:0, blankValues:0 }
      })];
      buildStagingColumns(table)[0].notNull
    `);
    assert.strictEqual(notNull, false);
  });

  test.skip('table profiling reports blanks separately and stores the DDL inputs', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = readServerSources();
    const html = readFrontendSources();
    assert.match(server, /AS blank_values/);
    assert.match(server, /blankValues: Number\(row\.blank_values \|\| 0\)/);
    assert.match(server, /app\.post\('\/api\/profile-table'/);
    assert.match(server, /COUNT\(DISTINCT CAST\(\$\{qCol\} AS text\)\)/);
    assert.match(html, /applyManualTableProfiles\(t, data\.profiles\)/);
    assert.match(html, /stagingColumnUsesNotNull\(c\)/);
    assert.match(html, /profiled blanks or nulls make that staging column nullable/);
    assert.match(html, /data-profiletable=/);
    assert.doesNotMatch(html, /data-profilecol=/);
    assert.match(html, /\/api\/profile-table/);
  });


  test('automatic infer profiles stay hidden until a user-requested table profile exists', () => {
    const result = app.eval(`
      const automatic = Object.assign(newColumn('district','varchar(20)'), {
        nullable:false,
        profile:{ totalRows:603, distinctValues:null, nullValues:0, blankValues:4, source:'infer-schema' }
      });
      const manual = Object.assign(newColumn('address','varchar(50)'), {
        nullable:false,
        profile:{ totalRows:603, distinctValues:599, nullValues:0, blankValues:0, source:'manual' }
      });
      [columnProfileIsUserRequested(automatic), columnProfileIsUserRequested(manual)]
    `);
    assert.deepStrictEqual(result, [false, true]);
  });

  test('the Tables page renders automatic profiles hidden and manual table profiles visible', () => {
    const html = app.eval(`
      const table = newTable('address');
      table.columns = [
        Object.assign(newColumn('district','varchar(20)'), {
          nullable:false,
          profile:{ totalRows:603, distinctValues:null, nullValues:0, blankValues:4, source:'infer-schema' }
        }),
        Object.assign(newColumn('address','varchar(50)'), {
          nullable:false,
          profile:{ totalRows:603, distinctValues:599, nullValues:0, blankValues:0, source:'manual' }
        })
      ];
      const el = document.createElement('div');
      renderTableDetail(el, table);
      el.innerHTML
    `);
    assert.doesNotMatch(html, /district: 603 rows/);
    assert.match(html, /address: 603 rows/);
    assert.match(html, />Profile table</);
  });

  test('one table profile result is applied to every returned column', () => {
    const result = app.eval(`
      const table = newTable('address');
      table.columns = [newColumn('address_id','smallint'), newColumn('district','varchar(20)')];
      const applied = applyManualTableProfiles(table, [
        { column:'address_id', totalRows:603, distinctValues:603, nullValues:0, blankValues:0 },
        { column:'district', totalRows:603, distinctValues:378, nullValues:0, blankValues:4 },
      ]);
      ({ applied, sources:table.columns.map(c=>c.profile.source), blanks:table.columns.map(c=>c.profile.blankValues) })
    `);
    assert.deepStrictEqual(result, { applied:2, sources:['manual','manual'], blanks:[0,4] });
  });

  test('source detection profiles constrained columns and feeds blank counts into DDL', () => {
    const result = app.eval(`
      const table = newTable('address');
      const clean = Object.assign(newColumn('address_id','smallint'), {
        pk:true, nullable:false,
        profile:profileFromIntrospection({ profile:{ totalRows:603, nullValues:0, blankValues:0, distinctValues:null, source:'infer-schema' } })
      });
      const blank = Object.assign(newColumn('district','varchar(20)'), {
        nullable:false,
        profile:profileFromIntrospection({ profile:{ totalRows:603, nullValues:0, blankValues:4, distinctValues:null, source:'infer-schema' } })
      });
      table.columns = [clean, blank];
      ({ notNulls:buildStagingColumns(table).slice(0,2).map(c=>c.notNull), summary:columnProfileSummary(blank) })
    `);
    assert.deepStrictEqual(result.notNulls, [true, false]);
    assert.match(result.summary, /distinct not measured/);
    assert.match(result.summary, /staging nullable/);
  });

  test('source detection requests automatic profiling while drift checks stay metadata-only', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = readServerSources();
    const html = readFrontendSources();
    assert.match(html, /const data = await fetchIntrospection\(true\)/);
    assert.match(html, /async function runDriftCheck\(\)[\s\S]*?const data = await fetchIntrospection\(\)/);
    assert.match(server, /profileConstraintSensitiveColumns/);
    assert.match(server, /table\.columns\.filter\(c => c\.pk === true \|\| c\.nullable === false\)/);
    assert.match(server, /expressions = \['COUNT\(\*\) AS total_rows'\]/);
  });
});

describe('validateModel', () => {
  beforeEach(resetApp);

  test('new demo project supplies identity defaults but still requires source tables', () => {
    app.eval(`startNewProject(true);`);
    const { errors } = app.eval(`validateModel()`);
    assert.strictEqual(app.eval(`state.vault.name`), 'sak');
    assert.strictEqual(app.eval(`state.vault.prefix`), 'sak');
    assert.strictEqual(app.eval(`state.vault.tenantId`), 'SAK');
    assert.ok(!errors.some(e => /Vault short name|Staging prefix|Tenant ID/.test(e)));
    assert.ok(errors.some(e => /No included source tables/.test(e)));
  });

  test('complete fixture with suggested model has no blocking errors', () => {
    seedFixture();
    app.eval(`suggestModelFromKeys()`);
    const { errors } = app.eval(`validateModel()`);
    assert.deepStrictEqual(errors, []);
  });
});

describe('suggestModelFromKeys (deterministic modelling)', () => {
  beforeEach(() => { resetApp(); seedFixture(); });

  test('creates hubs for PK tables, skips the junction table', () => {
    const summary = app.eval(`suggestModelFromKeys()`);
    const hubEntities = app.eval(`state.hubs.map(h => h.entity)`).sort();
    assert.deepStrictEqual(hubEntities, ['customer', 'order', 'tag']);
    assert.strictEqual(summary.hubs, 3);
    // junction table order_tags must NOT be a hub
    assert.ok(!hubEntities.includes('order_tag'));
  });

  test('creates links: order↔customer (FK) and the order_tags junction', () => {
    app.eval(`suggestModelFromKeys()`);
    const links = app.eval(`state.links.map(l => l.entity)`).sort();
    assert.strictEqual(links.length, 2);
    assert.ok(links.includes('order_tag'));           // junction link
    assert.ok(links.some(e => e.includes('customer') && e.includes('order')));
    const allHubCounts = app.eval(`state.links.map(l => l.hubs.length)`);
    allHubCounts.forEach(n => assert.ok(n >= 2, 'every link needs 2+ hubs'));
  });

  test('creates satellites from descriptive leftovers', () => {
    app.eval(`suggestModelFromKeys()`);
    const hubSatEntities = app.eval(`state.hubSats.map(s => s.entity)`).sort();
    assert.ok(hubSatEntities.includes('customer'));
    assert.ok(hubSatEntities.includes('order'));
    assert.ok(hubSatEntities.includes('tag'));
    // customer sat should carry name/email/updated_at but not the PK
    const custAttrs = app.eval(`
      (function(){
        const s = state.hubSats.find(x => x.entity === 'customer');
        const t = findTable(s.tableId);
        return s.attrs.map(a => findCol(t, a.colId).name);
      })()
    `).sort();
    assert.deepStrictEqual(custAttrs, ['email', 'name', 'updated_at']);
  });

  test('incremental suggestions configure a column while activation remains an explicit user choice', () => {
    assert.strictEqual(app.eval(`FEATURE_INCREMENTAL`), true);
    const summary = app.eval(`suggestModelFromKeys()`);
    assert.strictEqual(summary.incremental, 1);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incremental`), false);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementCol`), 'updated_at');
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReady`), false);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalConfigPending`), true);
    assert.strictEqual(app.eval(`buildWorkbookRows().source_tables.find(r=>r[1]==='customers')[6]`), 0);
    assert.strictEqual(app.eval(`buildWorkbookRows().source_tables.find(r=>r[1]==='customers')[7]`), 'updated_at');

    app.eval(`state.tables.find(t=>t.name==='customers').incremental = true`);
    assert.strictEqual(app.eval(`buildWorkbookRows().source_tables.find(r=>r[1]==='customers')[6]`), 1,
      'the Hub/user activation flag directly controls the spreadsheet');
  });

  test('falls back to column-name FK inference when no FKs are declared', () => {
    app.eval(`state.sourceMeta.foreignKeys = [];`);
    const summary = app.eval(`suggestModelFromKeys()`);
    assert.strictEqual(summary.usedDeclaredFks, false);
    // orders.customer_id → customers should still be inferred by name
    const links = app.eval(`state.links.map(l => l.entity)`);
    assert.ok(links.some(e => e.includes('customer') && e.includes('order')),
      `expected an order/customer link from name inference, got: ${links}`);
  });

  test('is idempotent — a second run adds nothing new', () => {
    app.eval(`suggestModelFromKeys()`);
    const before = app.eval(`[state.hubs.length, state.links.length, state.hubSats.length + state.linkSats.length]`);
    app.eval(`suggestModelFromKeys()`);
    const after = app.eval(`[state.hubs.length, state.links.length, state.hubSats.length + state.linkSats.length]`);
    assert.deepStrictEqual(after, before);
  });

  test('Staging-page suggestion adds derivations without populating the vault model', () => {
    app.eval(`runSuggestFromKeys('staging')`);
    assert.ok(app.eval(`state.tables.some(t => t.derivations.length > 0)`), 'expected staging derivations');
    assert.deepStrictEqual(app.eval(`[state.hubs.length, state.links.length, state.hubSats.length, state.linkSats.length]`),
      [0, 0, 0, 0], 'the Staging action must not mutate Vault objects');
    const orderDerivations = app.eval(`state.tables.find(t=>t.name==='orders').derivations.map(d=>[d.entity,d.column,d.kind])`);
    assert.ok(orderDerivations.some(d => d[0]==='order' && d[1]==='id' && d[2]==='both'));
    assert.ok(orderDerivations.some(d => d[0]==='customer' && d[1]==='customer_id' && d[2]==='hash'));
  });
});

describe('generic relationship planning', () => {
  beforeEach(resetApp);

  function seedBase(){
    app.eval(`
      startNewProject(true);
      state.vault.name = 'generic'; state.vault.prefix = 'generic'; state.vault.tenantId = 'GEN';
      state.vault.srcCod = 'GEN'; state.vault.srcDescription = 'generic'; state.vault.vaultDbName = 'generic_vault';
    `);
  }

  test('relationship tables with attributes create a Link Satellite', () => {
    seedBase();
    app.eval(`
      const documents = newTable('documents');
      documents.columns = [Object.assign(newColumn('document_id','integer'),{pk:true,nullable:false}), newColumn('title','varchar(100)')];
      const tags = newTable('tags');
      tags.columns = [Object.assign(newColumn('tag_id','integer'),{pk:true,nullable:false}), newColumn('name','varchar(50)')];
      const documentTags = newTable('document_tags');
      documentTags.columns = [
        Object.assign(newColumn('document_id','integer'),{pk:true,nullable:false}),
        Object.assign(newColumn('tag_id','integer'),{pk:true,nullable:false}),
        newColumn('assigned_at','timestamp'),
        newColumn('assignment_role','varchar(30)'),
      ];
      state.tables.push(documents, tags, documentTags);
      state.sourceMeta.foreignKeys = [
        {table:'document_tags',column:'document_id',refTable:'documents',refColumn:'document_id'},
        {table:'document_tags',column:'tag_id',refTable:'tags',refColumn:'tag_id'},
      ];
      suggestModelFromKeys();
    `);
    assert.strictEqual(app.eval(`tableRelationshipPlan(state.tables.find(t=>t.name==='document_tags')).type`), 'relationship');
    assert.deepStrictEqual(app.eval(`state.links.map(l=>l.entity)`), ['document_tag']);
    const attrs = app.eval(`(function(){
      const s=state.linkSats[0], t=findTable(s.tableId);
      return s.attrs.map(a=>findCol(t,a.colId).name).sort();
    })()`);
    assert.deepStrictEqual(attrs, ['assigned_at', 'assignment_role']);
    assert.match(app.eval(`buildDataVaultDdl()`), /lsat_generic_document_tag\b/);
    assert.deepStrictEqual(app.eval(`validateModel().errors`), []);
  });

  test('self-referencing foreign keys retain distinct source roles', () => {
    seedBase();
    app.eval(`
      const employees = newTable('employees');
      employees.columns = [
        Object.assign(newColumn('employee_id','integer'),{pk:true,nullable:false}),
        newColumn('manager_id','integer'),
        newColumn('name','varchar(100)'),
      ];
      state.tables.push(employees);
      state.sourceMeta.foreignKeys = [
        {table:'employees',column:'manager_id',refTable:'employees',refColumn:'employee_id'},
      ];
      suggestModelFromKeys();
    `);
    const link = app.eval(`(function(){
      const l=state.links[0], t=findTable(l.tableId);
      return {entity:l.entity, rows:l.hubs.map(h=>({role:h.role,column:findCol(t,h.colId).name})), cols:linkColumns(l).map(c=>c.name)};
    })()`);
    assert.strictEqual(link.entity, 'employee_manager');
    assert.deepStrictEqual(link.rows, [
      { role:'employee', column:'employee_id' },
      { role:'manager', column:'manager_id' },
    ]);
    assert.ok(link.cols.includes('hub_generic_employee_id'));
    assert.ok(link.cols.includes('hub_generic_manager_id'));
    const saved = app.eval(`JSON.parse(modelSnapshot()).state.links[0].hubs.map(h=>h.role)`);
    assert.deepStrictEqual(saved, ['employee', 'manager']);
    assert.deepStrictEqual(app.eval(`validateModel().errors`), []);
  });

  test('ordinary entity foreign keys become separate binary Links', () => {
    seedBase();
    app.eval(`
      const languages = newTable('languages');
      languages.columns = [Object.assign(newColumn('language_id','integer'),{pk:true,nullable:false}), newColumn('name','varchar(30)')];
      const films = newTable('films');
      films.columns = [
        Object.assign(newColumn('film_id','integer'),{pk:true,nullable:false}),
        newColumn('language_id','integer'),
        newColumn('original_language_id','integer'),
        newColumn('title','varchar(100)'),
      ];
      state.tables.push(languages, films);
      state.sourceMeta.foreignKeys = [
        {table:'films',column:'language_id',refTable:'languages',refColumn:'language_id'},
        {table:'films',column:'original_language_id',refTable:'languages',refColumn:'language_id'},
      ];
      suggestModelFromKeys();
    `);
    const links = app.eval(`state.links.map(l=>({entity:l.entity,count:l.hubs.length})).sort((a,b)=>a.entity.localeCompare(b.entity))`);
    assert.deepStrictEqual(links, [
      { entity:'film_language', count:2 },
      { entity:'film_original_language', count:2 },
    ]);
    assert.ok(!app.eval(`state.links.some(l=>l.hubs.length>2)`));
  });

  test('multi-party relationship tables remain one multi-Hub Link with a Link Satellite', () => {
    seedBase();
    app.eval(`
      for (const name of ['contracts','organisations','people']){
        const t=newTable(name);
        const entity=entityForTable(name);
        t.columns=[Object.assign(newColumn(entity+'_id','integer'),{pk:true,nullable:false})];
        state.tables.push(t);
      }
      const cp=newTable('contract_participants');
      cp.columns=[newColumn('contract_id','integer'),newColumn('organisation_id','integer'),newColumn('person_id','integer'),newColumn('participant_role','varchar(30)')];
      state.tables.push(cp);
      state.sourceMeta.foreignKeys=[
        {table:'contract_participants',column:'contract_id',refTable:'contracts',refColumn:'contract_id'},
        {table:'contract_participants',column:'organisation_id',refTable:'organisations',refColumn:'organisation_id'},
        {table:'contract_participants',column:'person_id',refTable:'people',refColumn:'person_id'},
      ];
      suggestModelFromKeys();
    `);
    assert.strictEqual(app.eval(`state.links.length`), 1);
    assert.strictEqual(app.eval(`state.links[0].hubs.length`), 3);
    assert.strictEqual(app.eval(`state.links[0].entity`), 'contract_participant');
    assert.deepStrictEqual(app.eval(`(function(){const s=state.linkSats[0],t=findTable(s.tableId);return s.attrs.map(a=>findCol(t,a.colId).name)})()`), ['participant_role']);
  });

  test('AI cannot merge independent foreign keys and missing planned links are completed', () => {
    seedBase();
    const summary = app.eval(`(function(){
      const languages = newTable('languages');
      languages.columns = [Object.assign(newColumn('language_id','integer'),{pk:true,nullable:false})];
      const films = newTable('films');
      films.columns = [Object.assign(newColumn('film_id','integer'),{pk:true,nullable:false}),newColumn('language_id','integer'),newColumn('original_language_id','integer'),newColumn('title','varchar(100)')];
      state.tables.push(languages,films);
      state.sourceMeta.foreignKeys=[
        {table:'films',column:'language_id',refTable:'languages',refColumn:'language_id'},
        {table:'films',column:'original_language_id',refTable:'languages',refColumn:'language_id'},
      ];
      return applyAiModel({
        hubs:[
          {entity:'film',table:'films',pkColumn:'film_id',statusSat:true},
          {entity:'language',table:'languages',pkColumn:'language_id',statusSat:true},
        ],
        links:[{entity:'film_languages',table:'films',hubs:[
          {hub:'film',column:'film_id'},{hub:'language',column:'language_id'},{hub:'language',column:'original_language_id'}
        ]}],
        hubSatellites:[], linkSatellites:[],
      });
    })()`);
    assert.ok(summary.skipped.some(s=>/combines unrelated foreign-key relationships/.test(s)));
    assert.strictEqual(summary.autoLinks, 2);
    assert.deepStrictEqual(app.eval(`state.links.map(l=>l.entity).sort()`), ['film_language','film_original_language']);
    assert.strictEqual(app.eval(`unmappedAttributeColumns().length`), 0);
  });
});

describe('DDL generators', () => {
  beforeEach(() => { resetApp(); seedFixture(); app.eval(`suggestModelFromKeys()`); });

  test('staging DDL creates stg_<prefix>_<table> with hash/bk columns', () => {
    const ddl = app.eval(`buildStagingDdl()`);
    assert.match(ddl, /stg_sales_customers/);
    assert.match(ddl, /stg_sales_orders/);
    assert.match(ddl, /hash_customer_id/i);
    assert.match(ddl, /customer_bk/i);
  });

  test.skip('staging DDL indexes every generated hash column exactly once', () => {
    const ddl = app.eval(`buildStagingDdl()`);
    const indexes = ddl.match(/^CREATE INDEX IF NOT EXISTS \w+ ON staging\.\w+ \(\w+\);$/gm) || [];
    const expected = app.eval(`
      includedTables().reduce((sum,t)=>sum + buildStagingColumns(t).filter(c=>c.hashed).length, 0)
    `);
    assert.strictEqual(indexes.length, expected);
    assert.match(ddl, /ON staging\.stg_sales_customers \(hash_customer_id\);/);
    assert.strictEqual(new Set(indexes).size, indexes.length);
  });

  test('data vault DDL creates hubs, links, sats and _err twins', () => {
    const ddl = app.eval(`buildDataVaultDdl()`);
    assert.match(ddl, /hub_sales_customer\b/);
    assert.match(ddl, /hub_sales_customer_err\b/);
    assert.match(ddl, /link_sales_order_tag\b/);
    assert.match(ddl, /sat_sales_customer\b/);
  });

  test('fresh link satellite DDL keeps only the parent Link key', () => {
    const result = app.eval(`
      (function(){
        const sat = state.linkSats[0];
        const name = lsatName(sat.entity, sat.concern);
        return {
          name,
          columns: linkSatColumns(sat).map(c=>c.name),
          legacy: legacyLinkSatHubColumns(sat),
          ddl: buildDataVaultDdl(),
        };
      })()
    `);
    assert.ok(result.legacy.length >= 2, 'fixture Link Satellite should have at least two parent Hubs');
    result.legacy.forEach(column=>{
      assert.ok(!result.columns.includes(column), `${column} must not be a physical Link Satellite column`);
      assert.doesNotMatch(result.ddl, new RegExp(`data_vault\\.${result.name}[^;]*\\b${column}\\b`));
      assert.doesNotMatch(result.ddl, new RegExp(`data_vault\\.${result.name}_err[^;]*\\b${column}\\b`));
    });
    assert.doesNotMatch(result.ddl, /DROP COLUMN/, 'fresh/full DDL must not contain legacy repair operations');
    assert.ok(result.columns.some(c=>/^link_.*_id$/.test(c)), 'the parent Link key must remain');
  });

  test('data vault DDL indexes every hash key and hashdiff on main tables', () => {
    const ddl = app.eval(`buildDataVaultDdl()`);
    const indexes = ddl.match(/^CREATE INDEX IF NOT EXISTS \w+ ON data_vault\.\w+ \(\w+\);$/gm) || [];
    const expected = app.eval(`
      state.hubs.reduce((n,h)=>n+hubColumns(h).filter(c=>c.hashed).length,0)
      + state.links.reduce((n,l)=>n+linkColumns(l).filter(c=>c.hashed).length,0)
      + state.hubSats.reduce((n,s)=>n+hubSatColumns(s).filter(c=>c.hashed).length,0)
      + state.linkSats.reduce((n,s)=>n+linkSatColumns(s).filter(c=>c.hashed).length,0)
    `);
    assert.strictEqual(indexes.length, expected);
    assert.match(ddl, /ON data_vault\.hub_sales_customer \(hub_sales_customer_id\);/);
    assert.match(ddl, /ON data_vault\.sat_sales_customer \(sat_key\);/);
    assert.match(ddl, /ON data_vault\.sat_sales_customer \(sat_attributes_concat\);/);
    assert.doesNotMatch(ddl, /ON data_vault\.\w+_err \(/);
    indexes.forEach(line=>{
      const name = line.match(/^CREATE INDEX IF NOT EXISTS (\w+)/)[1];
      assert.ok(name.length <= 63, `${name} exceeds PostgreSQL's identifier limit`);
    });
  });

  test('pdi_meta SQL carries the tenant and source description', () => {
    const sql = app.eval(`buildPdiMetaSql()`);
    assert.match(sql, /SALES/);
    assert.match(sql, /Sales data/);
  });

  test('pdi_meta target connections use the target password and fixed service users', () => {
    app.eval(`state.vault.dvUser = 'postgres-admin'; state.vault.dvPassword = 'target-secret'; state.vault.vaultPassword = 'old-hidden-secret';`);
    const sql = app.eval(`buildPdiMetaSql()`);
    assert.match(sql, /'staging', 'target-secret'/);
    assert.match(sql, /'data_vault', 'target-secret'/);
    assert.doesNotMatch(sql, /postgres-admin/);
    assert.doesNotMatch(sql, /old-hidden-secret/);
  });

  test('expectedDataVaultTableNames returns each object plus its _err twin', () => {
    const names = app.eval(`expectedDataVaultTableNames()`);
    assert.ok(names.includes('hub_sales_customer'));
    assert.ok(names.includes('hub_sales_customer_err'));
    assert.strictEqual(names.length % 2, 0);
  });
});

describe('schema drift', () => {
  beforeEach(() => { resetApp(); seedFixture(); });

  test('computeSchemaDiff finds new/missing/changed pieces', () => {
    const diff = app.eval(`
      computeSchemaDiff(state.tables, [
        { name:'customers', columns:[
          { name:'id', type:'integer', nullable:false, pk:true },
          { name:'name', type:'varchar(200)', nullable:true, pk:false },   // type changed
          // email removed
          { name:'updated_at', type:'timestamp', nullable:true, pk:false },
          { name:'loyalty_tier', type:'varchar(20)', nullable:true, pk:false }, // new column
        ]},
        // orders/tags/order_tags removed from source
        { name:'suppliers', columns:[ { name:'id', type:'integer', nullable:false, pk:true } ] }, // new table
      ])
    `);
    assert.strictEqual(diff.newTables.length, 1);
    assert.strictEqual(diff.newTables[0].name, 'suppliers');
    assert.deepStrictEqual(diff.missingTables.sort(), ['order_tags', 'orders', 'tags']);
    assert.strictEqual(diff.newColumns.length, 1);
    assert.strictEqual(diff.newColumns[0].column.name, 'loyalty_tier');
    assert.strictEqual(diff.missingColumns.length, 1);
    assert.strictEqual(diff.missingColumns[0].column, 'email');
    assert.strictEqual(diff.changedColumns.length, 1);
    assert.deepStrictEqual(diff.changedColumns[0].changes[0], { field:'type', from:'varchar(100)', to:'varchar(200)' });
  });

  test('identical schemas produce an empty diff', () => {
    const empty = app.eval(`
      schemaDiffIsEmpty(computeSchemaDiff(state.tables, state.tables.map(t => ({
        name: t.name,
        columns: t.columns.map(c => ({ name:c.name, type:c.type, nullable:c.nullable, pk:c.pk })),
      }))))
    `);
    assert.strictEqual(empty, true);
  });

  test('applySchemaDiff merges only what was selected', () => {
    const applied = app.eval(`
      (function(){
        const diff = computeSchemaDiff(state.tables, [
          { name:'customers', columns:[
            { name:'id', type:'bigint', nullable:false, pk:true },        // type change
            { name:'name', type:'varchar(100)', nullable:true, pk:false },
            { name:'email', type:'varchar(255)', nullable:true, pk:false },
            { name:'updated_at', type:'timestamp', nullable:true, pk:false },
            { name:'loyalty_tier', type:'varchar(20)', nullable:true, pk:false },
          ]},
          { name:'orders', columns:[
            { name:'id', type:'integer', nullable:false, pk:true },
            { name:'customer_id', type:'integer', nullable:false, pk:false },
            { name:'order_date', type:'date', nullable:true, pk:false },
            { name:'total', type:'numeric(10,2)', nullable:true, pk:false },
          ]},
          { name:'order_tags', columns:[
            { name:'order_id', type:'integer', nullable:false, pk:false },
            { name:'tag_id', type:'integer', nullable:false, pk:false },
            { name:'created_at', type:'timestamp', nullable:true, pk:false },
          ]},
          { name:'tags', columns:[
            { name:'id', type:'integer', nullable:false, pk:true },
            { name:'label', type:'varchar(50)', nullable:true, pk:false },
          ]},
        ]);
        return applySchemaDiff(diff, { addTables:true, addColumns:true, updateColumns:false, removeColumns:false, excludeMissingTables:false });
      })()
    `);
    assert.strictEqual(applied.columnsAdded, 1);
    assert.strictEqual(applied.columnsUpdated, 0); // update not selected
    // type must be unchanged because updateColumns was false
    assert.strictEqual(
      app.eval(`state.tables.find(t=>t.name==='customers').columns.find(c=>c.name==='id').type`),
      'integer'
    );
    assert.ok(app.eval(`state.tables.find(t=>t.name==='customers').columns.some(c=>c.name==='loyalty_tier')`));
  });

  test('new views are kept separate and unselected while base tables are selected', () => {
    const applied = app.eval(`
      (function(){
        const diff = computeSchemaDiff([], [
          { name:'actor', objectType:'table', columns:[{ name:'actor_id', type:'integer', nullable:false, pk:true }] },
          { name:'actor_info', objectType:'view', columns:[{ name:'actor_id', type:'integer', nullable:true, pk:false }] },
        ]);
        state.tables = [];
        return applySchemaDiff(diff, { addTables:true, addColumns:false, updateColumns:false, removeColumns:false, excludeMissingTables:false });
      })()
    `);
    assert.strictEqual(applied.tablesAdded, 2);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='actor').included`), true);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='actor_info').included`), false);
    assert.strictEqual(app.eval(`isSourceView(state.tables.find(t=>t.name==='actor_info'))`), true);
  });

  test('first typed refresh excludes a legacy unmodelled view but preserves an explicit view selection', () => {
    const result = app.eval(`
      (function(){
        const legacy = newTable('customer_list');
        delete legacy.objectType;
        const autoExcluded = applyDetectedObjectType(legacy, 'VIEW');
        const intentional = newTable('authoritative_view');
        intentional.objectType = 'view';
        intentional.included = true;
        const explicitChanged = applyDetectedObjectType(intentional, 'VIEW');
        return {
          autoExcluded,
          legacyIncluded: legacy.included,
          explicitChanged,
          intentionalIncluded: intentional.included,
        };
      })()
    `);
    assert.deepStrictEqual(result, {
      autoExcluded: true,
      legacyIncluded: false,
      explicitChanged: false,
      intentionalIncluded: true,
    });
  });
});

describe('undo', () => {
  beforeEach(() => { resetApp(); seedFixture(); });

  test('pushUndo + undoLast restores the exact previous model', () => {
    const before = app.eval(`modelSnapshot()`);
    app.eval(`
      pushUndo('test mutation');
      state.tables = [];
      state.hubs = [];
    `);
    assert.strictEqual(app.eval(`state.tables.length`), 0);
    assert.strictEqual(app.eval(`undoLast()`), true);
    assert.strictEqual(app.eval(`modelSnapshot()`), before);
    assert.strictEqual(app.eval(`state.tables.length`), 4);
  });

  test('undoLast with an empty stack is a safe no-op', () => {
    assert.strictEqual(app.eval(`undoLast()`), false);
  });

  test('undo stack is capped at 20 snapshots', () => {
    app.eval(`for (let i=0;i<30;i++) pushUndo('n'+i);`);
    assert.strictEqual(app.eval(`undoStack.length`), 20);
    assert.strictEqual(app.eval(`undoStack[0].label`), 'n10');
  });
});

describe('autosave', () => {
  beforeEach(() => { resetApp(); seedFixture(); });

  test('writeAutosaveNow persists state without any passwords', () => {
    app.eval(`
      state.vault.srcPassword = 'source-secret';
      state.vault.dvPassword = 'target-secret';
      writeAutosaveNow();
    `);
    const raw = app.localStorage.getItem('vaultStudioAutosave');
    assert.ok(raw, 'autosave entry should exist');
    assert.ok(!raw.includes('source-secret'));
    assert.ok(!raw.includes('target-secret'));
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.state.vault.name, 'sales');
    assert.strictEqual(parsed.state.tables.length, 4);
    assert.ok(parsed.savedAt);
  });

  test('trivial (empty) projects are never autosaved', () => {
    app.eval(`startNewProject(true); writeAutosaveNow();`);
    assert.strictEqual(app.localStorage.getItem('vaultStudioAutosave'), null);
  });

  test('readAutosave round-trips and restoreAutosave rebuilds state', () => {
    app.eval(`writeAutosaveNow();`);
    app.eval(`startNewProject(true);`);
    assert.strictEqual(app.eval(`state.tables.length`), 0);
    // startNewProject clears the autosave (deliberately); re-write one first
    app.eval(`
      state.vault.name = 'restoreme';
      const t = newTable('things');
      t.columns = [Object.assign(newColumn('id','integer'), { pk:true, nullable:false })];
      state.tables.push(t);
      writeAutosaveNow();
      startNewProjectWasHere = true;
    `);
    app.eval(`
      const saved = readAutosave();
      state.vault.name = ''; state.tables = [];
      restoreAutosave(saved);
    `);
    assert.strictEqual(app.eval(`state.vault.name`), 'restoreme');
    assert.strictEqual(app.eval(`state.tables.length`), 1);
  });

  test('startNewProject clears any existing autosave', () => {
    app.eval(`writeAutosaveNow();`);
    assert.ok(app.localStorage.getItem('vaultStudioAutosave'));
    app.eval(`startNewProject(true);`);
    assert.strictEqual(app.localStorage.getItem('vaultStudioAutosave'), null);
  });
});

describe('drift propagation into the model', () => {
  beforeEach(() => { resetApp(); seedFixture(); app.eval(`suggestModelFromKeys()`); });

  test('a drift-merged new column is added to the existing satellite on re-suggest', () => {
    const attrsBefore = app.eval(`state.hubSats.find(s=>s.entity==='customer').attrs.length`);
    // Simulate a drift merge adding a column to customers
    app.eval(`
      const t = state.tables.find(x=>x.name==='customers');
      t.columns.push(Object.assign(newColumn('loyalty_tier','varchar(20)'), {}));
    `);
    const summary = app.eval(`suggestModelFromKeys()`);
    assert.ok(summary.satAttrsAdded >= 1, 'new column should extend the existing satellite');
    const attrsAfter = app.eval(`state.hubSats.find(s=>s.entity==='customer').attrs.length`);
    assert.strictEqual(attrsAfter, attrsBefore + 1);
    // …and it must reach the generated DDL
    const ddl = app.eval(`buildDataVaultDdl()`);
    assert.match(ddl, /loyalty_tier/);
  });

  test('a drift-merged new table becomes a hub + satellite on re-suggest', () => {
    app.eval(`
      const t = newTable('suppliers');
      t.columns = [
        Object.assign(newColumn('id','integer'), { pk:true, nullable:false }),
        Object.assign(newColumn('company','varchar(100)'), {}),
      ];
      state.tables.push(t);
    `);
    const summary = app.eval(`suggestModelFromKeys()`);
    assert.strictEqual(summary.hubs, 1);
    assert.ok(app.eval(`state.hubs.some(h=>h.entity==='supplier')`));
    assert.match(app.eval(`buildDataVaultDdl()`), /hub_sales_supplier\b/);
    assert.match(app.eval(`buildStagingDdl()`), /stg_sales_suppliers\b/);
  });

  test('coverage helpers flag unmodelled tables and columns, and clear after suggest', () => {
    assert.strictEqual(app.eval(`vaultUncoveredTables().length`), 0);
    assert.strictEqual(app.eval(`unmappedAttributeColumns().length`), 0);
    app.eval(`
      const t = newTable('regions');
      t.columns = [Object.assign(newColumn('id','integer'), { pk:true, nullable:false }), newColumn('name','varchar(50)')];
      state.tables.push(t);
      state.tables.find(x=>x.name==='customers').columns.push(newColumn('nickname','varchar(30)'));
    `);
    assert.strictEqual(app.eval(`vaultUncoveredTables().map(t=>t.name)`)[0], 'regions');
    assert.strictEqual(app.eval(`stagingUncoveredTables().map(t=>t.name)`)[0], 'regions');
    const unmapped = app.eval(`unmappedAttributeColumns()`);
    // customers.nickname (new column on a modelled table) and regions.name
    // (attribute of the not-yet-modelled table) are both outstanding
    assert.ok(unmapped.some(u => u.table === 'customers' && u.column === 'nickname'));
    assert.ok(unmapped.some(u => u.table === 'regions' && u.column === 'name'));
    assert.strictEqual(unmapped.length, 2);
    app.eval(`suggestModelFromKeys()`);
    assert.strictEqual(app.eval(`vaultUncoveredTables().length`), 0);
    assert.strictEqual(app.eval(`stagingUncoveredTables().length`), 0);
    assert.strictEqual(app.eval(`unmappedAttributeColumns().length`), 0);
  });

  test('staging gap check is about derivations only — a table with keys but no satellites is NOT a staging gap', () => {
    // Model with hub (creates derivations) but deliberately no satellite:
    // staging is complete (all columns are always staged + keys exist);
    // only the VAULT check should flag the unmapped descriptive columns.
    app.eval(`
      state.hubSats = []; state.linkSats = [];
    `);
    assert.strictEqual(app.eval(`stagingUncoveredTables().length`), 0,
      'tables with derivations must never be flagged as staging gaps');
    assert.ok(app.eval(`unmappedAttributeColumns().length`) > 0,
      'the vault check should still flag the satellite-less columns');
  });

  test('columns used as derivation sources (keys) are never flagged as unmapped', () => {
    const unmapped = app.eval(`unmappedAttributeColumns()`);
    // orders.customer_id feeds the customer link hash — must not be listed
    assert.ok(!unmapped.some(u => u.table === 'orders' && u.column === 'customer_id'));
    // PKs must not be listed either
    assert.ok(!unmapped.some(u => u.column === 'id'));
  });
});

describe('target schema diff (incremental DDL)', () => {
  beforeEach(() => { resetApp(); seedFixture(); app.eval(`suggestModelFromKeys()`); });

  test.skip('parseGeneratedDdlObjects reads the generated staging and vault DDL', () => {
    const staging = app.eval(`parseGeneratedDdlObjects(buildStagingDdl())`);
    assert.ok(staging.length >= 4);
    const cust = staging.find(o => o.name === 'stg_sales_customers');
    assert.strictEqual(cust.schema, 'staging');
    assert.ok(cust.columns.some(c => c.name === 'hash_customer_id'));
    assert.ok(cust.columns.some(c => c.name === 'tenant_id'));
    assert.ok(cust.indexes.some(i => i.column === 'hash_customer_id'));

    const vault = app.eval(`parseGeneratedDdlObjects(buildDataVaultDdl())`);
    assert.ok(vault.some(o => o.name === 'hub_sales_customer' && o.schema === 'data_vault'
      && o.indexes.some(i => i.column === 'hub_sales_customer_id')));
    assert.ok(vault.some(o => o.name === 'hub_sales_customer_err'));
  });

  test('computeTargetDelta finds missing tables, missing columns and type mismatches', () => {
    const delta = app.eval(`
      (function(){
        const expected = [
          { schema:'staging', name:'t1', createSql:'CREATE TABLE IF NOT EXISTS staging.t1 (\\n  a integer\\n);', columns:[
            { name:'a', type:'integer' }, { name:'b', type:'varchar(50)' }, { name:'c', type:'timestamp' } ] },
          { schema:'data_vault', name:'t2', createSql:'CREATE TABLE IF NOT EXISTS data_vault.t2 (\\n  x integer\\n);', columns:[ { name:'x', type:'integer' } ] },
        ];
        const live = [
          { table_schema:'staging', table_name:'t1', column_name:'a', data_type:'integer' },
          // b missing entirely
          { table_schema:'staging', table_name:'t1', column_name:'c', data_type:'character varying', character_maximum_length:10 }, // mismatch: varchar(10) vs timestamp
          // t2 missing entirely
        ];
        return computeTargetDelta(expected, live);
      })()
    `);
    assert.strictEqual(delta.missingTables.length, 1);
    assert.strictEqual(delta.missingTables[0].name, 't2');
    assert.deepStrictEqual(delta.missingColumns, [{ schema:'staging', table:'t1', column:'b', type:'varchar(50)' }]);
    assert.strictEqual(delta.typeMismatches.length, 1);
    assert.strictEqual(delta.typeMismatches[0].live, 'varchar(10)');
    assert.strictEqual(delta.typeMismatches[0].expected, 'timestamp');
  });

  test('an exactly-matching target produces an empty delta', () => {
    const empty = app.eval(`
      (function(){
        const expected = parseGeneratedDdlObjects(buildStagingDdl());
        // Fabricate a live catalog that matches the expected objects exactly
        const live = [];
        expected.forEach(o => o.columns.forEach(c => {
          const row = { table_schema:o.schema, table_name:o.name, column_name:c.name };
          const t = normalizeExpectedType(c.type);
          const vm2 = t.match(/^varchar\\((\\d+)\\)$/);
          if (vm2){ row.data_type = 'character varying'; row.character_maximum_length = Number(vm2[1]); }
          else if (t === 'timestamp'){ row.data_type = 'timestamp without time zone'; }
          else { row.data_type = t; }
          live.push(row);
        }));
        return targetDeltaIsEmpty(computeTargetDelta(expected, live));
      })()
    `);
    assert.strictEqual(empty, true);
  });

  test('buildIncrementalSql emits CREATE for missing tables, ALTER ADD COLUMN for missing columns, warnings for mismatches', () => {
    const sql = app.eval(`
      buildIncrementalSql({
        missingTables: [{ schema:'data_vault', name:'hub_sales_supplier', createSql:'CREATE TABLE IF NOT EXISTS data_vault.hub_sales_supplier (\\n  hub_sales_supplier_id BYTEA\\n);', columns:[],
          indexes:[{ createSql:'CREATE INDEX IF NOT EXISTS idx_hub_sales_supplier_id ON data_vault.hub_sales_supplier (hub_sales_supplier_id);' }] }],
        missingColumns: [{ schema:'staging', table:'stg_sales_customers', column:'hash_loyalty_id', type:'BYTEA',
          indexSql:'CREATE INDEX IF NOT EXISTS idx_stg_sales_customers_hash_loyalty_id ON staging.stg_sales_customers (hash_loyalty_id);' }],
        typeMismatches: [{ schema:'staging', table:'stg_sales_orders', column:'total', live:'numeric(12,4)', expected:'numeric(10,2)' }],
        checkedTables: 3,
      })
    `);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS data_vault\.hub_sales_supplier/);
    assert.match(sql, /ALTER TABLE data_vault\.hub_sales_supplier OWNER TO data_vault;/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_hub_sales_supplier_id/);
    assert.match(sql, /ALTER TABLE staging\.stg_sales_customers ADD COLUMN IF NOT EXISTS hash_loyalty_id BYTEA;/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_stg_sales_customers_hash_loyalty_id/);
    assert.match(sql, /WARNING: staging\.stg_sales_orders\.total/);
    assert.match(sql, /SET ROLE staging;/);
    assert.doesNotMatch(sql, /ALTER TABLE .* ALTER COLUMN/, 'types must never be auto-altered');
  });

  test('target diff detects and removes only generated obsolete Link Satellite columns', () => {
    const result = app.eval(`
      (function(){
        const expected = parseGeneratedDdlObjects(buildDataVaultDdl());
        const sat = state.linkSats[0];
        const table = lsatName(sat.entity, sat.concern);
        const object = expected.find(o=>o.schema==='data_vault' && o.name===table);
        const live = object.columns.map(c=>({
          table_schema:object.schema,
          table_name:object.name,
          column_name:c.name,
          data_type:normalizeExpectedType(c.type)==='timestamp' ? 'timestamp without time zone' : normalizeExpectedType(c.type),
        }));
        object.obsoleteColumns.forEach(column=>live.push({
          table_schema:object.schema, table_name:object.name, column_name:column, data_type:'bytea',
        }));
        const delta = computeTargetDelta([object], live);
        return { object, delta, sql:buildIncrementalSql(delta) };
      })()
    `);
    assert.ok(result.object.obsoleteColumns.length >= 2);
    assert.strictEqual(result.delta.obsoleteColumns.length, result.object.obsoleteColumns.length);
    result.delta.obsoleteColumns.forEach(column=>{
      assert.match(result.sql, new RegExp(`ALTER TABLE ${column.schema}\\.${column.table} DROP COLUMN IF EXISTS ${column.column};`));
    });
    assert.doesNotMatch(result.sql, /DROP TABLE|TRUNCATE|DELETE FROM/);
  });

  test('end-to-end: drift-merged column shows up as exactly one ALTER on a previously-matching target', () => {
    const sql = app.eval(`
      (function(){
        // live catalog captured BEFORE the new column arrives
        const before = parseGeneratedDdlObjects(buildStagingDdl()).concat(parseGeneratedDdlObjects(buildDataVaultDdl()));
        const live = [];
        before.forEach(o => o.columns.forEach(c => {
          const t = normalizeExpectedType(c.type);
          const row = { table_schema:o.schema, table_name:o.name, column_name:c.name };
          const vm2 = t.match(/^varchar\\((\\d+)\\)$/);
          if (vm2){ row.data_type='character varying'; row.character_maximum_length=Number(vm2[1]); }
          else if (t==='timestamp'){ row.data_type='timestamp without time zone'; }
          else { row.data_type = t; }
          live.push(row);
        }));
        // drift: new column merged + modelled
        state.tables.find(x=>x.name==='customers').columns.push(Object.assign(newColumn('loyalty_tier','varchar(20)'), {}));
        suggestModelFromKeys();
        const expected = parseGeneratedDdlObjects(buildStagingDdl()).concat(parseGeneratedDdlObjects(buildDataVaultDdl()));
        return buildIncrementalSql(computeTargetDelta(expected, live));
      })()
    `);
    const alters = sql.match(/ADD COLUMN IF NOT EXISTS loyalty_tier/g) || [];
    // staging table + hub satellite (+ its _err twin) should each gain the column
    assert.ok(alters.length >= 2, `expected the new column on staging and satellite tables, got:\n${sql}`);
    assert.doesNotMatch(sql, /CREATE TABLE/, 'no whole tables should be recreated for a column-only drift');
  });
});

describe('deployment status derivation (no manifest — probed live)', () => {
  beforeEach(() => { resetApp(); seedFixture(); app.eval(`suggestModelFromKeys()`); });

  test('pdi_meta SQL uses the canonical fixed ids the engine is pinned to', () => {
    const sql = app.eval(`buildPdiMetaSql()`);
    // The engine runs with id_data_vault=1 (PARAMS in .env) — MAX-based id
    // allocation silently orphans the vault whenever anything pre-seeded the
    // reference tables. One vault per target database this release.
    assert.match(sql, /TRUNCATE pdi_meta\.ref_source_systems, pdi_meta\.ref_data_vaults, pdi_meta\.ref_connections CASCADE/);
    assert.match(sql, /\(1, 'sales_source'/);
    assert.match(sql, /\(2, 'sales_staging'/);
    assert.match(sql, /\(3, 'sales_datavault'/);
    assert.match(sql, /\(1, 'datavault_sales'/, 'data vault id must be 1 to match the engine PARAMS');
    assert.match(sql, /\(1, 'SALES', 'Sales data', 1, 2, 30, 0\)/, 'source system wired to connections 1/2');
    assert.doesNotMatch(sql, /COALESCE\(MAX/, 'no floating id allocation');
  });

  test('deriveFileRow: missing / differing / current', () => {
    assert.strictEqual(app.eval(`deriveFileRow('k','L', null, 'gen').state`), 'missing');
    assert.strictEqual(app.eval(`deriveFileRow('k','L', { exists:false }, 'gen').state`), 'missing');
    assert.strictEqual(app.eval(`deriveFileRow('k','L', { exists:true, content:'old', mtimeMs:1 }, 'new').state`), 'stale');
    assert.strictEqual(app.eval(`deriveFileRow('k','L', { exists:true, content:'same', mtimeMs:1 }, 'same').state`), 'current');
    // whitespace-only differences are not "out of date"
    assert.strictEqual(app.eval(`deriveFileRow('k','L', { exists:true, content:'x' + String.fromCharCode(10), mtimeMs:1 }, 'x').state`), 'current');
    // no content available (e.g. the workbook) -> presence is enough
    assert.strictEqual(app.eval(`deriveFileRow('k','L', { exists:true, mtimeMs:1 }, null).state`), 'current');
  });

  test('deriveDbObjectsRow: missing / partial / current against live columns and indexes', () => {
    const mk = `
      (function(state){
        const expected = parseGeneratedDdlObjects(buildStagingDdl());
        let live = [];
        let liveIndexes = [];
        if (state !== 'missing'){
          expected.forEach((o, oi) => {
            if (state === 'partial' && oi === 0) return;         // first table absent
            o.columns.forEach(c => live.push({ table_schema: 'staging', table_name: o.name,
              column_name: c.name, data_type: normalizeExpectedType(c.type).startsWith('varchar')
                ? 'character varying' : (normalizeExpectedType(c.type) === 'timestamp' ? 'timestamp without time zone' : normalizeExpectedType(c.type)),
              character_maximum_length: (normalizeExpectedType(c.type).match(/varchar\((\d+)\)/)||[])[1] }));
            o.indexes.forEach(i => liveIndexes.push({ table_schema:'staging', table_name:o.name,
              column_name:i.column, index_name:'equivalent_'+i.name }));
          });
        }
        return deriveDbObjectsRow('staging', 'Staging tables', expected, live, liveIndexes, 'staging');
      })`;
    assert.strictEqual(app.eval(`${mk}('missing').state`), 'missing');
    assert.strictEqual(app.eval(`${mk}('partial').state`), 'stale');
    assert.strictEqual(app.eval(`${mk}('full').state`), 'current');
  });

  test.skip('missing hash indexes make deployment stale and produce an index-only update', () => {
    const result = app.eval(`
      (function(){
        const expected = parseGeneratedDdlObjects(buildStagingDdl());
        const live = [];
        expected.forEach(o => o.columns.forEach(c => {
          const type = normalizeExpectedType(c.type);
          live.push({
            table_schema:o.schema, table_name:o.name, column_name:c.name,
            data_type:type.startsWith('varchar') ? 'character varying'
              : (type==='timestamp' ? 'timestamp without time zone' : type),
            character_maximum_length:(type.match(/varchar\\((\\d+)\\)/)||[])[1],
          });
        }));
        const row = deriveDbObjectsRow('staging','Staging tables',expected,live,[],'staging');
        return { state:row.state, detail:row.detail, delta:row.delta, sql:buildIncrementalSql(row.delta) };
      })()
    `);
    assert.strictEqual(result.state, 'stale');
    assert.ok(result.delta.missingIndexes.length > 0);
    assert.match(result.detail, /hash index\(es\) to add/);
    assert.match(result.sql, /CREATE INDEX IF NOT EXISTS/);
    assert.doesNotMatch(result.sql, /CREATE TABLE|ADD COLUMN/, 'existing tables and columns must not be recreated');
  });

  test('Export page: status board present, one-click pipeline gone, advanced collapsed', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const h = readFrontendSources();
    assert.ok(h.includes('Deployment status'), 'board panel exists');
    assert.ok(h.includes('btn-deploy-apply-all'));
    assert.ok(h.includes('id="export-advanced"'), 'advanced section exists');
    assert.ok(h.includes("display:${exportAdvancedOpen?'block':'none'}"), 'advanced collapsed by default');
    assert.ok(!h.includes('btn-run-pipeline'), 'old pipeline removed');
    assert.ok(!h.includes('runDeployPipeline'));
  });
});

describe('source JDBC driver section gating', () => {
  beforeEach(resetApp);

  test.skip('renders only for supported non-PostgreSQL source dialects', () => {
    assert.strictEqual(app.eval(`jdbcDriverSectionHtml({ dialect: 'postgresql' })`), '');
    assert.strictEqual(app.eval(`jdbcDriverSectionHtml({ dialect: 'oracle' })`), '');
    assert.strictEqual(app.eval(`jdbcDriverSectionHtml({})`), '');

    const mysql = app.eval(`jdbcDriverSectionHtml({ dialect: 'mysql' })`);
    assert.match(mysql, /MySQL Connector\/J/);
    assert.match(mysql, /mysql-connector-j-9\.7\.0\.jar/);
    assert.match(mysql, /btn-deploy-jdbc-driver/);

    const sqlserver = app.eval(`jdbcDriverSectionHtml({ dialect: 'sqlserver' })`);
    assert.match(sqlserver, /Microsoft JDBC Driver for SQL Server/);
    assert.match(sqlserver, /mssql-jdbc-13\.4\.0\.jre11\.jar/);
    assert.match(sqlserver, /SQL Server is always external/);
  });

  test.skip('the source driver section is rendered from one Connections call site', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    const sectionCalls = html.match(/\$\{jdbcDriverSectionHtml\(v\)\}/g) || [];
    assert.strictEqual(sectionCalls.length, 1);
    assert.strictEqual((html.match(/filename:'mysql-connector-j-9\.7\.0\.jar'/g)||[]).length,1);
    assert.strictEqual((html.match(/filename:'mssql-jdbc-13\.4\.0\.jre11\.jar'/g)||[]).length,1);
  });
});


describe('physical target JDBC driver checks', () => {
  beforeEach(resetApp);

  test('a separate target check appears only for a non-PostgreSQL target whose type differs from the source', () => {
    const production=loadApp({runtimeMode:'production'});
    production.eval(`
      startNewProject(true);
      state.externalTables.enabled=true;
      state.vault.dialect='postgresql';
      Object.assign(state.externalTables,{
        remoteDialect:'mysql',
        jarfile:'/opt/jdbc-drivers/mysql-connector-j-9.7.0.jar'
      });
    `);
    assert.strictEqual(production.eval(`targetJdbcDriverCheckRequired()`),true);
    const section=production.eval(`targetJdbcDriverSectionHtml()`);
    assert.match(section,/Target JDBC driver/);
    assert.match(section,/id="btn-check-target-jdbc-driver"/);
    assert.match(section,/id="btn-deploy-target-jdbc-driver"/);

    production.eval(`state.vault.dialect='mysql'`);
    assert.strictEqual(production.eval(`targetJdbcDriverCheckRequired()`),false,'same source and target type reuse the same mounted driver');
    production.eval(`state.vault.dialect='mysql'; state.externalTables.remoteDialect='postgresql'`);
    assert.strictEqual(production.eval(`targetJdbcDriverCheckRequired()`),false,'PostgreSQL uses the standard FDW preflight rather than the extra cross-dialect panel');
    production.eval(`state.externalTables.enabled=false; state.externalTables.remoteDialect='mysql'; state.vault.dialect='postgresql'`);
    assert.strictEqual(production.eval(`targetJdbcDriverCheckRequired()`),false,'native target mode has no FDW target driver');
  });

  test('target driver check uses the configured container jar path and target downloads update that path', () => {
    const check=app.eval(`refreshTargetJdbcDriverStatus.toString()`);
    const deploy=app.eval(`deployJdbcDriver.toString()`);
    assert.match(check,/\/api\/driver-path-status/);
    assert.match(check,/state\.externalTables\.jarfile/);
    assert.match(deploy,/context='source'/);
    assert.match(deploy,/context==='target'/);
    assert.match(deploy,/state\.externalTables\.jarfile=`\/opt\/jdbc-drivers\/\$\{spec\.filename\}`/);
  });

  test('model validation rejects FDW storage with an external PostgreSQL engine target', () => {
    const production=loadApp({runtimeMode:'production'});
    production.eval(`startNewProject(true); state.vault.targetPreset=''; state.externalTables.enabled=true;`);
    const result=production.eval(`validateModel()`);
    assert.ok(result.errors.some(x=>/only with the internal PostgreSQL container/i.test(x)));
  });
});


describe('external SQL Server support', () => {
  beforeEach(resetApp);

  test.skip('production exposes SQL Server as a source and FDW physical target, while demo does not', () => {
    const production=loadApp({runtimeMode:'production'});
    assert.match(production.eval(`sourceDialectOptionsHtml()`),/value="sqlserver"[^>]*>SQL Server/);
    const render=production.eval(`renderConnections.toString()`);
    assert.match(render,/\['postgresql','mysql','sqlserver'\]/);

    const demo=loadApp({runtimeMode:'demo'});
    assert.doesNotMatch(demo.eval(`sourceDialectOptionsHtml()`),/SQL Server|sqlserver/);
    assert.match(demo.eval(`renderConnections.toString()`),/demo\?\['mysql'\]:\['postgresql','mysql','sqlserver'\]/);
  });

  test.skip('SQL Server defaults use an external 1433 route, dbo, and Microsoft JDBC', () => {
    assert.deepStrictEqual(app.eval(`externalDialectDefaults('sqlserver')`),{
      port:'1433',schema:'dbo',drivername:'com.microsoft.sqlserver.jdbc.SQLServerDriver',jarfile:'/opt/jdbc-drivers/mssql-jdbc-13.4.0.jre11.jar'
    });
    assert.strictEqual(app.eval(`defaultExternalJdbcUrl('sqlserver','sql.example','1433','vault')`),
      'jdbc:sqlserver://sql.example:1433;databaseName=vault;encrypt=true;trustServerCertificate=true');
    assert.deepStrictEqual(app.eval(`parseJdbcUrlDefaults('jdbc:sqlserver://sql.example:1444;databaseName=vault;encrypt=true')`),
      {dialect:'sqlserver',host:'sql.example',port:'1444',database:'vault',schema:'dbo'});
  });

  test.skip('SQL Server hash override is Unicode-safe, unbounded, and preserves trailing spaces in composite keys', () => {
    app.eval(`
      startNewProject(true);
      state.vault.dialect='sqlserver'; state.vault.sourceSchema='dbo'; state.vault.tenantId='T';
      const t=newTable('orders');
      const a=Object.assign(newColumn('country_code','nvarchar(10)'),{pk:true,nullable:false});
      const b=Object.assign(newColumn('order_number','nvarchar(100)'),{pk:true,nullable:false});
      t.columns=[a,b];
      t.derivations=[{id:'d',kind:'both',entity:'order',role:'order',columns:['country_code','order_number'],column:'country_code'}];
      state.tables=[t];
    `);
    const sql=app.eval(`buildOverride(state.tables[0])`);
    assert.match(sql,/HASHBYTES\('SHA2_256', CONVERT\(VARBINARY\(MAX\), CONVERT\(NVARCHAR\(MAX\),/);
    assert.match(sql,/LEN\(CONVERT\(NVARCHAR\(MAX\), src\.country_code\) \+ N'#'\) - 1/);
    assert.match(sql,/N'\|'/);
    assert.match(sql,/from dbo\.orders src/);
    assert.doesNotMatch(sql,/VARCHAR\(4000\)/i);
  });

  test.skip('Hop source metadata uses the native SQL Server plugin rather than a PostgreSQL fallback', () => {
    app.eval(`state.vault.dialect='sqlserver'; state.vault.sourceSchema='sales';`);
    const json=JSON.parse(app.eval(`buildHopSourceConnectionJson()`));
    assert.ok(json.rdbms.MSSQLNATIVE);
    assert.strictEqual(json.rdbms.MSSQLNATIVE.pluginId,'MSSQLNATIVE');
    assert.strictEqual(json.rdbms.MSSQLNATIVE.pluginName,'MS SQL Server (Native)');
    assert.strictEqual(json.rdbms.MSSQLNATIVE.attributes.PREFERRED_SCHEMA_NAME,'${source_schema_name}');
    assert.strictEqual(json.rdbms.POSTGRESQL,undefined);
  });

  test.skip('remote SQL Server DDL is idempotent and maps PostgreSQL storage types', () => {
    seedFixture();
    app.eval(`
      suggestModelFromKeys();
      Object.assign(state.externalTables,{enabled:true,remoteDialect:'sqlserver',studioDatabase:'vault',remoteDatabase:'vault',studioSchema:'dbo',remoteSchema:'dbo'});
    `);
    const ddl=app.eval(`buildExternalTablesDdl()`);
    assert.match(ddl,/IF OBJECT_ID\(N'\[dbo\]\.\[hub_sales_customer\]', N'U'\) IS NULL/);
    assert.match(ddl,/CREATE TABLE \[dbo\]\.\[hub_sales_customer\]/);
    assert.match(ddl,/VARBINARY\(32\)/);
    assert.match(ddl,/DATETIME2\(6\)/);
    assert.match(ddl,/NVARCHAR\(MAX\)|NVARCHAR\(256\)/);
    assert.doesNotMatch(ddl,/CREATE TABLE IF NOT EXISTS/);
    const objects=app.eval(`parseGeneratedDdlObjects(buildExternalTablesDdl())`);
    assert.strictEqual(objects.length,app.eval(`externalCoreTableCount()`));
    assert.ok(objects.every(o=>o.schema==='dbo'));
  });

  test.skip('Studio Plus quotes SQL Server identifiers and validates with TOP rather than LIMIT', () => {
    app.eval(`spConn={dialect:'sqlserver',host:'sql.example',port:'1433',database:'vault',schema:'dbo',user:'reporter',password:'x',autoDefault:false};`);
    assert.strictEqual(app.eval(`spQualifiedTable('hub_order')`),'[dbo].[hub_order]');
    const validate=app.eval(`spValidateGeneratedViews.toString()`);
    assert.match(validate,/SELECT TOP \(0\)/);
    assert.match(app.eval(`renderStudioPlus.toString()`),/value="sqlserver"/);
  });

  test('SQL Server stays external and does not add a Docker service', () => {
    const fs=require('node:fs');
    const path=require('node:path');
    const root=path.join(__dirname,'..','..');
    const compose=fs.readFileSync(path.join(root,'docker-compose.yaml'),'utf8');
    const start=fs.readFileSync(path.join(root,'start.sh'),'utf8');
    assert.doesNotMatch(compose,/^\s*(sqlserver|mssql):\s*$/m);
    assert.doesNotMatch(start,/sqlserver|mssql/i);
  });
});


describe('SQL Server companion-server wiring', () => {
  test.skip('the Node server carries SQL Server connection, introspection, reporting, and external-target adapters', () => {
    const fs=require('node:fs');
    const path=require('node:path');
    const server=readServerSources();
    const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'),'utf8'));
    assert.strictEqual(pkg.dependencies.mssql,'^12.7.0');
    assert.match(server,/function getMssql\(\)/);
    assert.match(server,/function sqlServerConnectionConfig/);
    assert.match(server,/SQLSERVER_INTROSPECT_SQL/);
    assert.match(server,/SQLSERVER_FK_SQL/);
    assert.match(server,/SQLSERVER_ROWCOUNT_SQL/);
    assert.match(server,/if \(dialect === 'sqlserver'\) return openSqlServerConnection/);
    assert.match(server,/SQL Server reporting queries may not use SELECT INTO/);
    assert.match(server,/\['postgresql','mysql','sqlserver'\]/);
    assert.match(server,/mssql-jdbc/);
    assert.match(server,/SCHEMA_NAME\(\) AS default_schema/);
  });

  test.skip('SQL Server source types are mapped into PostgreSQL-safe staging types', () => {
    const fs=require('node:fs');
    const path=require('node:path');
    const server=readServerSources();
    assert.match(server,/datetime2: 'timestamp'/);
    assert.match(server,/datetimeoffset: 'timestamptz'/);
    assert.match(server,/uniqueidentifier: 'uuid'/);
    assert.match(server,/varbinary: 'bytea'/);
    assert.match(server,/nvarchar/);
  });
});

describe('SHA-256 lock', () => {
  beforeEach(resetApp);

  test('hashAlgo is locked to sha256 regardless of stored state', () => {
    assert.strictEqual(app.eval(`hashAlgo()`), 'sha256');
    app.eval(`state.vault.hashAlgorithm = 'md5';`); // e.g. an old saved project
    assert.strictEqual(app.eval(`hashAlgo()`), 'sha256', 'md5 in loaded state must not change the effective algorithm');
    assert.strictEqual(app.eval(`hashSqlType()`), 'BYTEA');
  });

  test('new projects default to sha256 and the UI selectors are disabled', () => {
    app.eval(`startNewProject(true)`);
    assert.strictEqual(app.eval(`state.vault.hashAlgorithm`), 'sha256');
    const fs = require('node:fs');
    const path = require('node:path');
    const h = readFrontendSources();
    assert.match(h, /<select id="f-hashalgo" disabled/);
    assert.match(h, /<select id="ai-hashalgo" disabled/);
    assert.ok(!h.includes(`getElementById('f-hashalgo').addEventListener`), 'no change handler should remain on the locked selector');
  });
});

describe('PostgreSQL source workflow (sha256)', () => {
  beforeEach(() => {
    resetApp();
    seedFixture(); // fixture dialect defaults to postgresql
    app.eval(`state.vault.dialect = 'postgresql'; suggestModelFromKeys();`);
  });

  test.skip('staging_sql_override uses the built-in sha256(), not pgcrypto digest()', () => {
    const override = app.eval(`buildOverride(state.tables.find(t=>t.name==='customers'))`);
    assert.match(override, /sha256\(src\.id::text::bytea\) as hash_customer_id/i);
    assert.doesNotMatch(override, /digest\(/i, 'digest() needs pgcrypto on the source — must not be used');
    assert.doesNotMatch(override, /md5\(/i);
    assert.match(override, /src\.id as customer_bk/i);
    assert.match(override, /'SALES' as tenant_id/);
    assert.match(override, /from public\.customers src/i);
  });

  test.skip('link-bearing table override hashes every hub reference', () => {
    const override = app.eval(`buildOverride(state.tables.find(t=>t.name==='orders'))`);
    assert.match(override, /sha256\(src\.customer_id::text::bytea\)/i);
    assert.match(override, /sha256\(src\.id::text::bytea\)/i);
  });

  test.skip('staging DDL types hash keys as BYTEA', () => {
    const ddl = app.eval(`buildStagingDdl()`);
    assert.match(ddl, /hash_customer_id BYTEA/);
    assert.doesNotMatch(ddl, /hash_\w+ VARCHAR\(32\)/, 'no md5-width hash columns should remain');
  });

  test('data vault DDL types hub/link/sat keys as BYTEA', () => {
    const ddl = app.eval(`buildDataVaultDdl()`);
    assert.match(ddl, /hub_sales_customer_id BYTEA/i);
    assert.doesNotMatch(ddl, /CREATE EXTENSION IF NOT EXISTS pgcrypto/, 'built-in sha256() needs no extension');
  });

  test('full postgres model validates and the workbook builds', () => {
    const { errors } = app.eval(`validateModel()`);
    assert.deepStrictEqual(errors, []);
    // workbook generation must not throw with the postgres/sha256 model
    const sheets = app.eval(`buildMappingWorkbook().SheetNames`);
    assert.ok(Array.isArray(sheets) && sheets.length >= 5, `expected a multi-sheet workbook, got: ${sheets}`);
  });

  test.skip('MySQL sources still hash with UNHEX(SHA2(...,256))', () => {
    app.eval(`state.vault.dialect = 'mysql';`);
    const override = app.eval(`buildOverride(state.tables.find(t=>t.name==='customers'))`);
    assert.match(override, /UNHEX\(SHA2\(CAST\(src\.id AS CHAR\), 256\)\)/i);
    assert.doesNotMatch(override, /sha256\(src/i);
  });
});

describe('Hop source connection metadata (metadata/rdbms/source.json)', () => {
  beforeEach(() => { resetApp(); seedFixture(); });

  test('PostgreSQL source generates the POSTGRESQL connection block', () => {
    app.eval(`state.vault.dialect = 'postgresql';`);
    const parsed = JSON.parse(app.eval(`buildHopSourceConnectionJson()`));
    assert.strictEqual(parsed.name, 'source');
    assert.ok(parsed.rdbms.POSTGRESQL, 'POSTGRESQL block expected');
    assert.ok(!parsed.rdbms.MYSQL);
    const pg = parsed.rdbms.POSTGRESQL;
    assert.strictEqual(pg.pluginId, 'POSTGRESQL');
    assert.strictEqual(pg.pluginName, 'PostgreSQL');
    assert.strictEqual(pg.accessType, 0);
    // Everything stays as environment-variable references — never real values
    assert.strictEqual(pg.databaseName, '${source_database_name}');
    assert.strictEqual(pg.hostname, '${source_host_name}');
    assert.strictEqual(pg.port, '${source_port_number}');
    assert.strictEqual(pg.username, '${source_user_name}');
    assert.strictEqual(pg.password, '${source_password}');
    assert.strictEqual(pg.attributes.SUPPORTS_BOOLEAN_DATA_TYPE, 'Y');
    assert.strictEqual(pg.attributes.SUPPORTS_TIMESTAMP_DATA_TYPE, 'Y');
  });

  test('MySQL source generates the MYSQL connection block', () => {
    app.eval(`state.vault.dialect = 'mysql';`);
    const parsed = JSON.parse(app.eval(`buildHopSourceConnectionJson()`));
    assert.ok(parsed.rdbms.MYSQL, 'MYSQL block expected');
    assert.ok(!parsed.rdbms.POSTGRESQL);
    assert.strictEqual(parsed.rdbms.MYSQL.pluginId, 'MYSQL');
    assert.strictEqual(parsed.rdbms.MYSQL.pluginName, 'MySQL');
    assert.strictEqual(parsed.rdbms.MYSQL.attributes.SUPPORTS_BOOLEAN_DATA_TYPE, 'N');
    assert.strictEqual(parsed.rdbms.MYSQL.attributes['EXTRA_OPTION_MYSQL.tinyInt1isBit'], 'false');
    assert.strictEqual(parsed.rdbms.MYSQL.attributes['EXTRA_OPTION_MYSQL.yearIsDateType'], 'false');
    assert.strictEqual(parsed.rdbms.MYSQL.username, '${source_user_name}');
  });

  test('never contains real connection details, even when they are set in state', () => {
    app.eval(`
      state.vault.srcHost = 'prod-db.internal';
      state.vault.srcDatabase = 'realdb';
      state.vault.srcUser = 'realuser';
      state.vault.srcPassword = 'supersecret';
    `);
    const json = app.eval(`buildHopSourceConnectionJson()`);
    assert.ok(!json.includes('prod-db.internal'));
    assert.ok(!json.includes('realdb'));
    assert.ok(!json.includes('realuser'));
    assert.ok(!json.includes('supersecret'));
  });
});

describe('packaged container presets (MySQL Demo / Postgres Internal)', () => {
  beforeEach(() => { resetApp(); app.eval(`startNewProject(true)`); });

  test('container start payload sends the selected database only for PostgreSQL', async () => {
    app.eval(`
      capturedContainerStarts=[];
      requireLicenseAccepted=async()=>true;
      localFetch=async(url,options)=>{
        capturedContainerStarts.push({url,body:JSON.parse(options.body)});
        return {json:async()=>({ok:false,error:'stop after payload capture'})};
      };
      state.vault.dvDatabase='Customer_Vault';
    `);
    await app.evalRaw(`startAndConnectContainer('target')`);
    await app.evalRaw(`startAndConnectContainer('source')`);
    assert.deepStrictEqual(app.eval(`capturedContainerStarts`), [
      { url:'/api/docker/start-db', body:{service:'postgres',fdw:false,database:'Customer_Vault'} },
      { url:'/api/docker/start-db', body:{service:'mysql',fdw:false} },
    ]);
  });


  test('MySQL Demo fills the packaged sakila connection and sets the preset flag', () => {
    app.eval(`applyDemoSource(true)`);
    const v = app.eval(`state.vault`);
    assert.strictEqual(v.dialect, 'mysql');
    assert.strictEqual(v.sourcePreset, 'demo');
    assert.strictEqual(v.srcHost, 'localhost');
    assert.strictEqual(v.srcPort, '3306');
    assert.strictEqual(v.srcDatabase, 'sakila');
    assert.strictEqual(v.srcUser, 'sakila');
    assert.strictEqual(v.srcPassword, 'sourcesecret');
    assert.strictEqual(v.sourceSchema, 'sakila');
    assert.strictEqual(app.eval(`demoSourceActive()`), true);
  });

  test('MySQL Demo fills naming defaults only when blank', () => {
    app.eval(`state.vault.name = 'myvault'; applyDemoSource(true)`);
    assert.strictEqual(app.eval(`state.vault.name`), 'myvault', 'user values are never overwritten');
    assert.strictEqual(app.eval(`state.vault.prefix`), 'sak');
    assert.strictEqual(app.eval(`state.vault.tenantId`), 'SAK');
  });

  test('Postgres Internal fills the packaged connection on host port 5433', () => {
    app.eval(`applyDemoTarget(true)`);
    const v = app.eval(`state.vault`);
    assert.strictEqual(v.targetPreset, 'internal');
    assert.strictEqual(v.dvHost, 'localhost');
    assert.strictEqual(v.dvPort, '5433');
    assert.strictEqual(v.dvUser, 'dvuser');
    assert.strictEqual(v.dvPassword, 'secret');
    assert.strictEqual(app.eval(`demoTargetActive()`), true);
  });

  test('Postgres Internal uses DB_USER and VAULT_PASSWORD defaults, never bootstrap credentials', () => {
    app.eval(`
      envDefaults = {
        target:{ user:'db-user', password:'vault-password' },
        bootstrap:{ user:'bootstrap-admin', password:'bootstrap-password' },
        vault:{ password:'vault-password' },
      };
      applyDemoTarget(true);
    `);
    assert.strictEqual(app.eval(`state.vault.dvUser`), 'db-user');
    assert.strictEqual(app.eval(`state.vault.dvPassword`), 'vault-password');
  });

  test('engine mode follows the presets (start.sh flag mapping)', () => {
    assert.strictEqual(app.eval(`engineMode()`), 'demo'); // the Studio now starts in the locked demo mode
    app.eval(`applyDemoSource(false)`);
    assert.strictEqual(app.eval(`engineMode()`), 'internal');
    app.eval(`applyDemoTarget(false)`);
    assert.strictEqual(app.eval(`engineMode()`), 'external');
    app.eval(`applyDemoTarget(true)`);
    app.eval(`applyDemoSource(true)`);
    assert.strictEqual(app.eval(`engineMode()`), 'demo');
    assert.strictEqual(app.eval(`engineModeInvalid()`), false);
  });

  test('selecting the demo source auto-pairs the internal Postgres target', () => {
    app.eval(`applyDemoSource(false); applyDemoTarget(false);`);
    assert.strictEqual(app.eval(`state.vault.targetPreset`), '');
    app.eval(`applyDemoSource(true)`);
    assert.strictEqual(app.eval(`state.vault.targetPreset`), 'internal', '--demo requires internal Postgres');
    assert.strictEqual(app.eval(`state.vault.dvPort`), '5433');
  });

  test('demo source with an external target is flagged invalid', () => {
    app.eval(`applyDemoSource(true); applyDemoTarget(false);`);
    assert.strictEqual(app.eval(`engineModeInvalid()`), true);
    assert.strictEqual(app.eval(`engineMode()`), 'external');
  });

  test('source localhost is translated for Hop while external target localhost remains flagged', () => {
    // packaged presets are exempt — their config is rewritten to service hostnames
    app.eval(`applyDemoSource(true)`); // also pairs internal target
    assert.deepStrictEqual(app.eval(`externalLocalhostIssues()`), []);
    // external target typed as localhost -> still flagged
    app.eval(`applyDemoSource(false); applyDemoTarget(false); Object.assign(state.vault, { dvHost:'localhost', srcHost:'127.0.0.1' });`);
    assert.deepStrictEqual(app.eval(`externalLocalhostIssues()`), ['target']);
    assert.strictEqual(app.eval(`hopRuntimeSourceHost()`), 'host.docker.internal');
    // real target hostname -> clean even when Studio reaches the source through localhost
    app.eval(`state.vault.dvHost='pg.prod';`);
    assert.deepStrictEqual(app.eval(`externalLocalhostIssues()`), []);
  });

  test.skip('Hop runtime source address auto-translates loopback and supports an advanced override', () => {
    app.eval(`startNewProject(true); Object.assign(state.vault,{sourcePreset:'',srcHost:'localhost',srcPort:'3306'});`);
    assert.strictEqual(app.eval(`hopRuntimeSourceHost()`),'host.docker.internal');
    assert.strictEqual(app.eval(`hopRuntimeSourcePort()`),'3306');
    app.eval(`state.vault.srcHost='127.0.0.42';`);
    assert.strictEqual(app.eval(`hopRuntimeSourceHost()`),'host.docker.internal');
    app.eval(`state.vault.srcHost='::1';`);
    assert.strictEqual(app.eval(`hopRuntimeSourceHost()`),'host.docker.internal');
    app.eval(`Object.assign(state.vault,{srcHost:'maria.prod.internal',srcPort:'3307'});`);
    assert.strictEqual(app.eval(`hopRuntimeSourceHost()`),'maria.prod.internal');
    assert.strictEqual(app.eval(`hopRuntimeSourcePort()`),'3307');
    app.eval(`Object.assign(state.vault,{srcRuntimeHost:'maria-runtime',srcRuntimePort:'13307'});`);
    assert.strictEqual(app.eval(`hopRuntimeSourceHost()`),'maria-runtime');
    assert.strictEqual(app.eval(`hopRuntimeSourcePort()`),'13307');
  });

  test.skip('generated Hop environment uses Docker-safe source host without changing the Studio host', () => {
    const env=JSON.parse(app.eval(`startNewProject(true); Object.assign(state.vault,{srcHost:'127.0.0.1',srcPort:'3306',srcDatabase:'sales',srcUser:'alice'}); buildHopEnvironmentJson();`));
    const val=name=>env.variables.find(v=>v.name===name).value;
    assert.strictEqual(val('source_host_name'),'host.docker.internal');
    assert.strictEqual(val('source_port_number'),'3306');
    assert.strictEqual(app.eval(`state.vault.srcHost`),'127.0.0.1');
  });

  test('local DDL deploy panel only renders for the internal Postgres target', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const h = readFrontendSources();
    assert.match(h, /\$\{v\.targetPreset === 'internal' \? `\s*<div class="panel">\s*<div class="panel-head"[^>]*><h3>Deploy files locally/,
      'db-init deploy must be gated on the internal target');
  });

  test('switching away clears the preset and its values', () => {
    app.eval(`applyDemoSource(true); applyDemoSource(false)`);
    assert.strictEqual(app.eval(`state.vault.srcHost`), '');
    assert.strictEqual(app.eval(`state.vault.sourcePreset`), '');
    app.eval(`applyDemoTarget(true); applyDemoTarget(false)`);
    assert.strictEqual(app.eval(`state.vault.dvPort`), '5432');
    assert.strictEqual(app.eval(`state.vault.dvUser`), '');
    assert.strictEqual(app.eval(`state.vault.targetPreset`), '');
  });

  test('hop environment uses docker service hostnames when presets are active', () => {
    app.eval(`applyDemoSource(true); applyDemoTarget(true); state.vault.dvDatabase = 'datavault';`);
    const env = JSON.parse(app.eval(`buildHopEnvironmentJson()`));
    const val = name => env.variables.find(x => x.name === name).value;
    // Inside the compose network: service names + internal ports, NOT localhost:5433
    assert.strictEqual(val('data_vault_host_name'), 'postgres');
    assert.strictEqual(val('data_vault_port_number'), '5432');
    assert.strictEqual(val('pdi_meta_host_name'), 'postgres');
    assert.strictEqual(val('stg_host_name'), 'postgres');
    assert.strictEqual(val('source_host_name'), 'mysql');
    assert.strictEqual(val('source_port_number'), '3306');
    assert.strictEqual(val('source_database_name'), 'sakila');
  });

  test('hop environment declares the load timestamp datatype', () => {
    const env = JSON.parse(app.eval(`buildHopEnvironmentJson()`));
    const matches = env.variables.filter(x => x.name === 'PROP_DATABASE_LOAD_DTS_DATATYPE');
    assert.deepStrictEqual(matches, [{
      name: 'PROP_DATABASE_LOAD_DTS_DATATYPE',
      value: 'TIMESTAMP',
      description: '',
    }]);
  });

  test('hop environment defaults table error logging to disabled', () => {
    const env = JSON.parse(app.eval(`buildHopEnvironmentJson()`));
    const matches = env.variables.filter(x => x.name === 'TABLE_ERRORS');
    assert.deepStrictEqual(matches, [{
      name: 'TABLE_ERRORS',
      value: '',
      description: 'Set to _errors to log table errors',
    }]);
  });

  test('hop environment uses the real host details when no preset is active', () => {
    app.eval(`
      applyDemoSource(false); applyDemoTarget(false);
      Object.assign(state.vault, { dvHost:'db.prod.internal', dvPort:'5432', dvDatabase:'dv',
        srcHost:'src.prod.internal', srcPort:'5432', srcDatabase:'erp', dialect:'postgresql' });
    `);
    const env = JSON.parse(app.eval(`buildHopEnvironmentJson()`));
    const val = name => env.variables.find(x => x.name === name).value;
    assert.strictEqual(val('data_vault_host_name'), 'db.prod.internal');
    assert.strictEqual(val('source_host_name'), 'src.prod.internal');
  });
});

describe('external core Data Vault storage (jdbc_fdw)', () => {
  beforeEach(resetApp);

  function seedExternalModel(){
    seedFixture();
    app.eval(`suggestModelFromKeys(); Object.assign(state.externalTables, {
      enabled:true, serverName:'sales_external_srv', drivername:'org.postgresql.Driver',
      url:'jdbc:postgresql://remote-db:5432/dv_remote?currentSchema=vault',
      jarfile:'/opt/jdbc-drivers/postgresql-42.7.5.jar', username:'remote_writer', password:'secret',
      remoteDialect:'postgresql', remoteDatabase:'dv_remote', remoteSchema:'vault',
      studioHost:'localhost', studioPort:'5544', studioDatabase:'dv_remote', studioSchema:'vault',
      studioUser:'remote_admin', studioPassword:'secret'
    });`);
  }

  test('feature is shipped and loaded projects remain enabled', () => {
    assert.strictEqual(app.eval(`FEATURE_EXTERNAL_STORAGE`), true);
    app.eval(`state.externalTables.enabled = true; applyFeatureGates()`);
    assert.strictEqual(app.eval(`state.externalTables.enabled`), true);
  });

  test('legacy AI-assist FDW mode is not exposed', () => {
    assert.strictEqual(app.eval(`(function(){ aiModalContext='vault'; return aiModeSwitcherHtml(); })()`), '');
  });

  test.skip('Connections exposes the four target choices while MySQL and SQL Server reuse the FDW path', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    const connections = app.eval(`renderConnections.toString()`);
    const fdwConfig = app.eval(`renderExternalSub.toString()`);
    assert.match(connections, /value="mysql"/);
    assert.match(connections, /value="sqlserver"/);
    assert.match(connections, /value="internal-postgres"/);
    assert.match(connections, /value="postgres"/);
    assert.doesNotMatch(connections, /id="f-external-tables"|id="f-external-dialect"/);
    assert.match(connections, /③ Physical storage target/);
    assert.match(connections, /id="btn-connect-external-target"/);
    assert.match(connections, /btn-start-fdw-postgres/);
    assert.match(connections, /ext-storage-mount/);
    assert.match(fdwConfig, /④ PostgreSQL FDW gateway/);
    assert.match(fdwConfig, /Foreign server configuration/);
    assert.match(app.eval(`startAndConnectContainer.toString()`), /fdw:\s*service==='postgres'\s*&&\s*state\.externalTables\.enabled/);
    assert.strictEqual((html.match(/id="ext-storage-mount"/g)||[]).length, 1, 'FDW configuration mount belongs to Connections only');
    assert.doesNotMatch(html, /id="ext-enabled"/);
  });

  test.skip('target choice maps MySQL and SQL Server to the existing internal FDW state', () => {
    app.eval(`startNewProject(true); applyDeploymentTarget('mysql')`);
    assert.strictEqual(app.eval(`selectedDeploymentTarget()`), 'mysql');
    assert.strictEqual(app.eval(`state.vault.targetPreset`), 'internal');
    assert.strictEqual(app.eval(`state.externalTables.enabled`), true);
    assert.strictEqual(app.eval(`state.externalTables.remoteDialect`), 'mysql');
    app.eval(`applyDeploymentTarget('sqlserver')`);
    assert.strictEqual(app.eval(`selectedDeploymentTarget()`), 'sqlserver');
    assert.strictEqual(app.eval(`state.vault.targetPreset`), 'internal');
    assert.strictEqual(app.eval(`state.externalTables.enabled`), true);
    assert.strictEqual(app.eval(`state.externalTables.remoteDialect`), 'sqlserver');
    app.eval(`applyDeploymentTarget('internal-postgres')`);
    assert.strictEqual(app.eval(`selectedDeploymentTarget()`), 'internal-postgres');
    assert.strictEqual(app.eval(`state.externalTables.enabled`), false);
    app.eval(`applyDeploymentTarget('postgres')`);
    assert.strictEqual(app.eval(`selectedDeploymentTarget()`), 'postgres');
    assert.strictEqual(app.eval(`state.vault.targetPreset`), '');
    assert.strictEqual(app.eval(`state.externalTables.enabled`), false);
  });

  test('internal PostgreSQL remains the engine target while FDW details finish the Connections page', () => {
    const connections = app.eval(`renderConnections.toString()`);
    const vault = app.eval(`renderVault.toString()`);
    assert.match(connections, /② Data Vault PostgreSQL[\s\S]*btn-start-fdw-postgres/);
    assert.match(connections, /\$\{ext\.enabled\?'<div id="ext-storage-mount"/);
    assert.match(connections, /renderExternalSub\(document\.getElementById\('ext-storage-mount'\)\)/);
    assert.doesNotMatch(vault, /ext-storage-mount|renderExternalSub/);
  });

  test('demo physical-target and FDW fields are locked and deployment controls exist only on Export', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    const connections = app.eval(`renderConnections.toString()`);
    const fdwConfig = app.eval(`renderExternalSub.toString()`);
    const exportPage = html.slice(html.indexOf('function renderExport'), html.indexOf('function wireExport'));
    assert.match(connections, /const demo=isDemoRuntime\(\)/);
    assert.match(connections, /const lockSelect=demo\?'disabled/);
    assert.match(connections, /const lockInput=demo\?'readonly/);
    assert.match(fdwConfig, /const configLock=demo\?'readonly/);
    assert.doesNotMatch(fdwConfig, /Deploy in safe order|Run read-only preflight|id="ext-deploy"|id="ext-preflight"/);
    assert.match(fdwConfig, /Deployment remains on Export/);
    assert.match(exportPage, /Apply all updates in order/);
    assert.match(exportPage, /single authoritative workflow/);
  });

  test('deployment board groups the external route into concise collapsible stages', () => {
    const groups = app.eval(`deployRowGroup.toString()`);
    const board = app.eval(`deployBoardHtml.toString()`);
    assert.match(groups, /1 · Physical target/);
    assert.match(groups, /2 · PostgreSQL gateway/);
    assert.match(groups, /3 · Engine and project/);
    assert.match(board, /data-deploy-group/);
    assert.match(board, /Expand a stage for detailed checks and individual actions/);
  });

  test.skip('ordered deployment creates both databases, remote tables, FDW infrastructure and foreign tables last', () => {
    const fn = app.eval(`deployExternalStorage.toString()`);
    const positions = [
      'ensureLocalGatewayDatabase(checks)',
      'ensureExternalTargetDatabase(checks)',
      "buildExternalTablesDdl()",
      'buildFdwInfrastructureDdl()',
      'localFdwInfrastructureStatus()',
      'buildFdwForeignTablesDdl()',
      'verifyLocalForeignTables()',
    ].map(token=>fn.indexOf(token));
    assert.ok(positions.every(pos=>pos>=0), `missing deployment step: ${positions}`);
    for (let i=1;i<positions.length;i++) assert.ok(positions[i]>positions[i-1], `step ${i} is out of order`);
  });

  test('ordered deployment verifies the physical target account before creating the FDW mapping', () => {
    const fn = app.eval(`deployExternalStorage.toString()`);
    const verify=fn.indexOf('verifyExternalTargetUserAccess(checks)');
    const mapping=fn.indexOf('buildFdwInfrastructureDdl()');
    assert.ok(verify>=0 && mapping>verify);
  });

  test.skip('live route verification performs real remote reads as data_vault and pdi_meta rather than dvuser', () => {
    const deploy=app.eval(`deployExternalStorage.toString()`);
    const probe=app.eval(`probeDeploymentStatus.toString()`);
    const dataVaultQuery=app.eval(`queryTargetAsDataVault.toString()`);
    const pdiMetaQuery=app.eval(`queryTargetAsPdiMeta.toString()`);
    assert.match(deploy,/queryTargetAsDataVault\(`SELECT \* FROM data_vault\.\$\{smoke\} LIMIT 1`\)/);
    assert.match(deploy,/queryTargetAsPdiMeta\(`SELECT \* FROM data_vault\.\$\{smoke\} LIMIT 1`\)/);
    assert.match(probe,/queryTargetAsDataVault\(`SELECT \* FROM data_vault\.\$\{smoke\} LIMIT 1`\)/);
    assert.match(probe,/queryTargetAsPdiMeta\(`SELECT \* FROM data_vault\.\$\{smoke\} LIMIT 1`\)/);
    assert.match(dataVaultQuery,/role:'data_vault'/);
    assert.match(pdiMetaQuery,/role:'pdi_meta'/);
    assert.doesNotMatch(deploy,/WHERE 1=0/);
    assert.match(probe,/runtime access failed/);
  });

  test('preflight and deployment verify that the PostgreSQL login can assume both FDW service roles', () => {
    const preflight=app.eval(`runExternalStoragePreflight.toString()`);
    const deploy=app.eval(`deployExternalStorage.toString()`);
    const verify=app.eval(`verifyPostgresRoleAssumption.toString()`);
    const verifyDataVault=app.eval(`verifyDataVaultRoleAssumption.toString()`);
    const verifyPdiMeta=app.eval(`verifyPdiMetaRoleAssumption.toString()`);
    assert.match(preflight,/verifyDataVaultRoleAssumption/);
    assert.match(preflight,/verifyPdiMetaRoleAssumption/);
    assert.match(deploy,/verifyDataVaultRoleAssumption/);
    assert.match(deploy,/verifyPdiMetaRoleAssumption/);
    assert.match(verify,/current_user AS effective_user/);
    assert.match(verify,/\{role\}/);
    assert.match(verifyDataVault,/'data_vault'/);
    assert.match(verifyPdiMeta,/'pdi_meta'/);
  });

  test('Connections uses one physical-target credential for target DDL, FDW mappings and Studio Plus', () => {
    const connections = app.eval(`renderConnections.toString()`);
    const fdwConfig = app.eval(`renderExternalSub.toString()`);
    assert.match(connections,/Target username/);
    assert.match(connections,/Target password/);
    assert.match(connections,/target DDL, both PostgreSQL FDW user mappings, and Studio Plus defaults/);
    assert.match(fdwConfig,/physical target credential entered above is mapped to both PostgreSQL runtime roles/);
    assert.doesNotMatch(connections,/f-external-admin-user|f-external-runtime-user|Deployment administrator/);
  });

  test('Apply all prioritises the single ordered external route', () => {
    const attach = app.eval(`probeDeploymentStatus.toString()`);
    const applyAll = app.eval(`applyAllPending.toString()`);
    assert.match(attach, /row\.workflow = 'external-route'/);
    assert.match(applyAll, /workflow==='external-route'/);
  });

  test('deployment status checks both service-role mappings and USAGE grants', () => {
    const probe = app.eval(`probeDeploymentStatus.toString()`);
    const status = app.eval(`localFdwInfrastructureStatus.toString()`);
    const missing = app.eval(`fdwInfrastructureMissing.toString()`);
    assert.match(probe, /fdw-infrastructure/);
    assert.match(status, /pg_extension/);
    assert.match(status, /pg_foreign_server/);
    assert.match(status, /usename='data_vault'/);
    assert.match(status, /usename='pdi_meta'/);
    assert.match(status, /has_server_privilege\('data_vault'/);
    assert.match(status, /has_server_privilege\('pdi_meta'/);
    assert.match(missing, /pdi_meta user mapping/);
    assert.match(missing, /pdi_meta server USAGE grant/);
  });

  test('external deployment status separates physical tables, local support and foreign bindings', () => {
    const probe = app.eval(`probeDeploymentStatus.toString()`);
    assert.match(probe, /Physical Hub\/Link\/Sat\/LSat tables/);
    assert.match(probe, /PostgreSQL local Vault support objects/);
    assert.match(probe, /PostgreSQL foreign-table bindings/);
    assert.match(probe, /not a second copy of the core Vault/);
  });

  test('external mode creates one physical core set, one foreign binding set, and local error tables only', () => {
    seedExternalModel();
    const coreCount=app.eval(`externalCoreTableCount()`);
    const remote=app.eval(`parseGeneratedDdlObjects(buildExternalTablesDdl())`);
    const support=app.eval(`parseGeneratedDdlObjects(buildDataVaultLocalSupportDdl())`);
    const bindings=app.eval(`parseGeneratedDdlObjects(buildFdwForeignTablesDdl())`);
    assert.strictEqual(remote.length, coreCount);
    assert.strictEqual(bindings.length, coreCount);
    assert.ok(bindings.every(x=>x.foreign===true && !x.name.endsWith('_err')));
    assert.strictEqual(support.length, coreCount);
    assert.ok(support.every(x=>x.foreign===false && x.name.endsWith('_err')));
  });

  test('MySQL physical-table verification normalises information_schema field casing', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = readServerSources();
    assert.match(server, /SELECT TABLE_NAME AS table_name FROM information_schema\.tables/);
    assert.match(server, /r\.table_name \?\? r\.TABLE_NAME/);
  });

  test('demo external target defaults to the packaged MySQL service and datavault database', () => {
    app.eval(`startNewProject(true); state.externalTables.enabled=true; applyExternalTargetDefaults(false);`);
    const ext=app.eval(`state.externalTables`);
    assert.strictEqual(ext.remoteDialect,'mysql');
    assert.strictEqual(ext.studioHost,'localhost');
    assert.strictEqual(ext.studioPort,'3306');
    assert.strictEqual(ext.studioDatabase,'datavault');
    assert.strictEqual(ext.remoteDatabase,'datavault');
    assert.strictEqual(ext.drivername,'com.mysql.cj.jdbc.Driver');
    assert.strictEqual(ext.url,'jdbc:mysql://mysql:3306/datavault');
    assert.strictEqual(ext.jarfile,'/opt/jdbc-drivers/mysql-connector-j-9.7.0.jar');
    assert.strictEqual(ext.studioUser,'sakila');
    assert.strictEqual(ext.username,'sakila');
    assert.strictEqual(ext.studioPassword,'sourcesecret');
    assert.strictEqual(app.eval(`externalPhysicalSchemaLabel()`),'datavault');
  });

  test('demo target reuses the locked Sakila credentials', () => {
    app.eval(`startNewProject(true); state.externalTables.enabled=true; state.vault.srcUser='shared_user'; state.vault.srcPassword='shared_secret'; applyExternalTargetDefaults(false);`);
    const ext=app.eval(`state.externalTables`);
    assert.strictEqual(ext.studioUser,'shared_user');
    assert.strictEqual(ext.username,'shared_user');
    assert.strictEqual(ext.studioPassword,'shared_secret');
    assert.strictEqual(ext.password,'shared_secret');
    const payload=app.eval(`externalConnectionPayload('datavault')`);
    assert.strictEqual(payload.user,'shared_user');
    assert.strictEqual(payload.password,'shared_secret');
    const ddl=app.eval(`buildFdwPreamble()`);
    assert.match(ddl,/OPTIONS \(username 'shared_user', password 'shared_secret'\)/);
  });

  test('production FDW uses the user-defined physical target credential, independently of the source', () => {
    const production=loadApp({runtimeMode:'production'});
    production.eval(`
      startNewProject(true);
      state.vault.dialect='postgresql';
      state.vault.srcUser='source_reader'; state.vault.srcPassword='source_secret';
      state.externalTables.enabled=true;
      Object.assign(state.externalTables,{
        remoteDialect:'mysql', studioHost:'db.example', studioPort:'3306',
        studioDatabase:'datavault', studioSchema:'', remoteDatabase:'datavault', remoteSchema:'',
        studioUser:'target_writer', studioPassword:'target_secret',
        username:'target_writer', password:'target_secret',
        drivername:'com.mysql.cj.jdbc.Driver', url:'jdbc:mysql://db.example:3306/datavault',
        jarfile:'/opt/jdbc-drivers/mysql-connector-j-9.7.0.jar', studioConnectionOverridden:true
      });
      applyExternalTargetDefaults(false);
    `);
    const payload=production.eval(`externalConnectionPayload('datavault')`);
    assert.strictEqual(payload.user,'target_writer');
    assert.strictEqual(payload.password,'target_secret');
    const ddl=production.eval(`buildFdwPreamble()`);
    assert.match(ddl,/OPTIONS \(username 'target_writer', password 'target_secret'\)/);
    assert.doesNotMatch(ddl,/source_reader|source_secret/);
    const plus=production.eval(`studioPlusDefaultConnection()`);
    assert.strictEqual(plus.user,'target_writer');
    assert.strictEqual(plus.password,'target_secret');
  });

  test('external storage does not change the Hop PostgreSQL engine connection', () => {
    app.eval(`startNewProject(true); state.externalTables.enabled=true; applyExternalTargetDefaults(false);`);
    const env=JSON.parse(app.eval(`buildHopEnvironmentJson()`));
    const val=name=>env.variables.find(x=>x.name===name).value;
    assert.strictEqual(val('data_vault_host_name'),'postgres');
    assert.strictEqual(val('data_vault_port_number'),'5432');
    assert.strictEqual(val('data_vault_database_name'),'datavault');
    assert.strictEqual(val('source_host_name'),'mysql');
  });

  test('core table selector includes only hubs, links, sats and lsats', () => {
    seedExternalModel();
    const specs=app.eval(`externalCoreTableSpecs().map(x=>({family:x.family,name:x.name}))`);
    assert.ok(specs.length>0);
    assert.ok(specs.every(x=>['hub','link','sat','lsat'].includes(x.family)));
    assert.ok(specs.every(x=>!x.name.endsWith('_err')));
  });

  test('external table count is exactly the four model arrays', () => {
    seedExternalModel();
    assert.strictEqual(app.eval(`externalCoreTableCount()`), app.eval(`state.hubs.length+state.links.length+state.hubSats.length+state.linkSats.length`));
  });

  test('main Data Vault tables are foreign while _err tables stay local', () => {
    seedExternalModel();
    const ddl=app.eval(`buildDataVaultDdl()`);
    assert.match(ddl,/CREATE FOREIGN TABLE IF NOT EXISTS data_vault\.hub_/);
    assert.match(ddl,/CREATE FOREIGN TABLE IF NOT EXISTS data_vault\.link_/);
    assert.match(ddl,/CREATE FOREIGN TABLE IF NOT EXISTS data_vault\.sat_/);
    assert.match(ddl,/CREATE TABLE IF NOT EXISTS data_vault\.[a-z0-9_]+_err/);
    assert.doesNotMatch(ddl,/CREATE FOREIGN TABLE[^;]+_err/);
  });

  test('the verification view remains a local PostgreSQL view', () => {
    seedExternalModel();
    const ddl=app.eval(`buildDataVaultDdl()`);
    assert.match(ddl,/CREATE OR REPLACE VIEW data_vault\.vw_information_schema_columns_data_vault/);
  });

  test('FDW preamble is idempotent and maps both engine roles', () => {
    seedExternalModel();
    const ddl=app.eval(`buildFdwPreamble()`);
    assert.match(ddl,/CREATE SERVER IF NOT EXISTS sales_external_srv/);
    assert.match(ddl,/DROP USER MAPPING IF EXISTS FOR data_vault SERVER sales_external_srv/);
    assert.match(ddl,/CREATE USER MAPPING FOR data_vault SERVER sales_external_srv/);
    assert.match(ddl,/DROP USER MAPPING IF EXISTS FOR pdi_meta SERVER sales_external_srv/);
    assert.match(ddl,/CREATE USER MAPPING FOR pdi_meta SERVER sales_external_srv/);
    assert.match(ddl,/GRANT USAGE ON FOREIGN SERVER sales_external_srv TO data_vault, pdi_meta/);
    assert.doesNotMatch(ddl,/FOR CURRENT_USER/);
  });

  test('foreign-table key OPTIONS precede NOT NULL and parse as the underlying type', () => {
    seedExternalModel();
    const ddl=app.eval(`buildFdwForeignTablesDdl()`);
    assert.match(ddl,/\b[a-z0-9_]+\s+BYTEA OPTIONS \(key 'true'\) NOT NULL/i);
    assert.doesNotMatch(ddl,/NOT NULL\s+OPTIONS \(key 'true'\)/i);
    const objects=app.eval(`parseGeneratedDdlObjects(buildFdwForeignTablesDdl())`);
    assert.ok(objects.length>0);
    assert.strictEqual(objects[0].columns[0].type.toLowerCase(),'bytea');
  });

  test('foreign relations use ALTER FOREIGN TABLE for ownership', () => {
    seedExternalModel();
    const ddl=app.eval(`buildDataVaultDdl()`);
    assert.match(ddl,/ALTER FOREIGN TABLE data_vault\.hub_[a-z0-9_]+ OWNER TO data_vault/);
    assert.match(ddl,/ALTER TABLE data_vault\.[a-z0-9_]+_err OWNER TO data_vault/);
  });

  test('remote DDL contains only the core physical tables', () => {
    seedExternalModel();
    const ddl=app.eval(`buildExternalTablesDdl()`);
    assert.match(ddl,/CREATE TABLE IF NOT EXISTS "vault"\."hub_/);
    assert.doesNotMatch(ddl,/CREATE TABLE IF NOT EXISTS [^;]*_err\b/);
    assert.doesNotMatch(ddl,/CREATE (?:OR REPLACE )?VIEW/i);
  });

  test('demo MySQL remote DDL writes to datavault while local foreign tables stay in data_vault', () => {
    seedExternalModel();
    app.eval(`Object.assign(state.externalTables, externalTargetDefaults(), {enabled:true});`);
    const remote=app.eval(`buildExternalTablesDdl()`);
    const local=app.eval(`buildDataVaultDdl()`);
    assert.match(remote,/CREATE TABLE IF NOT EXISTS `datavault`\.`hub_/);
    assert.doesNotMatch(remote,/CREATE TABLE IF NOT EXISTS [`"]?data_vault[`"]?\./);
    assert.match(local,/CREATE FOREIGN TABLE IF NOT EXISTS data_vault\.hub_/);
  });

  test('generated DDL parser records foreign relation kind', () => {
    seedExternalModel();
    const objects=app.eval(`parseGeneratedDdlObjects(buildDataVaultDdl())`);
    assert.ok(objects.some(o=>o.foreign===true && o.relationKind==='f'));
    assert.ok(objects.some(o=>o.name.endsWith('_err') && o.foreign===false));
  });

  test('incremental additions to core tables use ALTER FOREIGN TABLE', () => {
    seedExternalModel();
    const sql=app.eval(`buildIncrementalSql({
      missingTables:[], missingColumns:[{schema:'data_vault',table:externalCoreTableNames()[0],column:'new_attr',type:'TEXT',foreign:true}],
      missingIndexes:[], obsoleteColumns:[], typeMismatches:[], expectedObjects:parseGeneratedDdlObjects(buildDataVaultDdl())
    })`);
    assert.match(sql,/ALTER FOREIGN TABLE data_vault\.[a-z0-9_]+ ADD COLUMN IF NOT EXISTS new_attr TEXT/);
  });

  test('PostgreSQL JDBC URL defaults are parsed for the Studio route', () => {
    assert.deepStrictEqual(app.eval(`parseJdbcUrlDefaults('jdbc:postgresql://db.internal:5544/dv?currentSchema=vault')`),
      {dialect:'postgresql',host:'db.internal',port:'5544',database:'dv',schema:'vault'});
  });

  test('MySQL JDBC URL defaults use the MySQL port', () => {
    assert.deepStrictEqual(app.eval(`parseJdbcUrlDefaults('jdbc:mysql://mysql.internal/sales')`),
      {dialect:'mysql',host:'mysql.internal',port:'3306',database:'sales',schema:''});
  });

  test('an explicitly overridden Studio route is not replaced by the JDBC URL', () => {
    app.eval(`Object.assign(state.externalTables,{url:'jdbc:postgresql://container-name:5432/dv',studioHost:'host.docker.internal',studioConnectionOverridden:true}); syncExternalStudioConnection(false);`);
    assert.strictEqual(app.eval(`state.externalTables.studioHost`),'host.docker.internal');
  });

  test('validation requires the separate Studio-to-target connection', () => {
    seedExternalModel();
    app.eval(`state.externalTables.studioHost=''`);
    const result=app.eval(`validateModel()`);
    assert.ok(result.errors.some(e=>/Studio-to-target host/.test(e)));
  });
});

describe('branding and support links', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = () => readFrontendSources();

  test('logo is loaded live from millersoft.co (trackable), no embedded base64 copy remains', () => {
    const h = html();
    assert.ok(h.includes('src="https://millersoft.co/img/data-vault/dvs-header-image.png"'),
      'topbar logo must be fetched from the live URL so loads are trackable');
    assert.strictEqual((h.match(/data:image\/png;base64/g) || []).length, 0,
      'no embedded base64 logo should remain');
  });

  test('brand and Support both link to the data-vault-services page; Contact link is gone', () => {
    const h = html();
    assert.ok(h.includes('<a class="brand" href="https://millersoft.co/data-vault-services"'));
    assert.match(h, /<a href="https:\/\/millersoft\.co\/data-vault-services"[^>]*>Support<\/a>/);
    assert.ok(!h.includes('>Contact</a>'), 'Contact link should be removed');
    assert.ok(!h.includes('millersoft.co/contact-us'));
    assert.ok(!h.includes('mailto:support@millersoftltd.com'));
  });

  test('Studio Plus report header links to data-vault-services too', () => {
    const h = html();
    assert.match(h, /<header><a href="https:\/\/millersoft\.co\/data-vault-services"/);
  });
});

describe('landing page layout', () => {
  test('Studio Plus defaults to the selected physical target and its credentials', () => {
    app.eval(`
      state.vault.name='sak';
      state.vault.sourcePreset='demo';
      state.vault.dialect='mysql';
      state.vault.srcHost='localhost'; state.vault.srcPort='3306';
      state.vault.srcUser='sakila'; state.vault.srcPassword='source_secret';
      state.externalTables.enabled=true;
      applyExternalTargetDefaults(true);
    `);
    const external = app.eval(`studioPlusDefaultConnection()`);
    assert.strictEqual(external.dialect, 'mysql');
    assert.strictEqual(external.host, 'localhost');
    assert.strictEqual(external.port, '3306');
    assert.strictEqual(external.database, 'datavault');
    assert.strictEqual(external.schema, 'datavault');
    assert.strictEqual(external.user, 'sakila');
    assert.strictEqual(external.password, 'source_secret');

    app.eval(`state.externalTables.enabled=false; state.vault.dvHost='localhost'; state.vault.dvPort='5433'; state.vault.dvDatabase='datavault'; state.vault.dvUser='dvuser'; state.vault.dvPassword='vault_secret';`);
    const internal = app.eval(`studioPlusDefaultConnection()`);
    assert.strictEqual(internal.dialect, 'postgresql');
    assert.strictEqual(internal.database, 'datavault');
    assert.strictEqual(internal.schema, 'data_vault');
    assert.strictEqual(internal.user, 'dvuser');
    assert.strictEqual(internal.password, 'vault_secret');

    const introspect = app.eval(`spIntrospectSchema.toString()`);
    assert.match(introspect, /\/api\/introspect/);
    assert.match(introspect, /spQualifiedTable/);
    const fs = require('node:fs');
    const path = require('node:path');
    const server = readServerSources();
    const queryRoute = server.slice(server.indexOf("app.post('/api/query'"), server.indexOf('/* =========================================================================', server.indexOf("app.post('/api/query'")));
    assert.match(queryRoute, /openSourceConnection\(req\.body\)/);
    assert.match(queryRoute, /MAX_EXECUTION_TIME/);
    assert.match(queryRoute, /SET LOCAL search_path/);
  });

  test('cards align their icon and copy on a consistent responsive grid', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    assert.match(html, /\.landing-card\{[\s\S]*?text-align:left;[\s\S]*?display:grid;/);
    assert.match(html, /grid-template-columns:44px minmax\(0,1fr\)/);
    assert.match(html, /\.landing-card-icon\{[\s\S]*?grid-row:1 \/ span 2;/);
    assert.match(html, /@media \(max-width:820px\)\{[\s\S]*?\.landing-cards\{grid-template-columns:1fr;\}/);
  });
});

describe('destructive-operation pruning still works with undo wired in', () => {
  beforeEach(() => { resetApp(); seedFixture(); app.eval(`suggestModelFromKeys()`); });

  test('excluding a table prunes dependent hubs/links/sats and undo restores them', () => {
    const hubsBefore = app.eval(`state.hubs.length`);
    app.eval(`
      pushUndo('exclude customers');
      state.tables.find(t=>t.name==='customers').included = false;
      pruneDownstreamModel({ dropExcluded:true });
    `);
    assert.ok(app.eval(`state.hubs.length`) < hubsBefore, 'customer hub should be pruned');
    app.eval(`undoLast()`);
    assert.strictEqual(app.eval(`state.hubs.length`), hubsBefore);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').included`), true);
  });
});


describe('usage guards — anti-footgun protections', () => {
  beforeEach(() => { resetApp(); seedFixture(); });

  test('sanitizeIdentifier: lowercases, strips bad chars and leading digits/underscores', () => {
    assert.strictEqual(app.eval(`sanitizeIdentifier('Sales DB!')`), 'sales_db_');
    assert.strictEqual(app.eval(`sanitizeIdentifier('1sales')`), 'sales');
    assert.strictEqual(app.eval(`sanitizeIdentifier('__9x_sales')`), 'x_sales');
    assert.strictEqual(app.eval(`sanitizeIdentifier('')`), '');
  });

  test('identifierIssue: flags SQL reserved words, accepts normal names', () => {
    assert.match(app.eval(`identifierIssue('table') || ''`), /reserved word/);
    assert.match(app.eval(`identifierIssue('select') || ''`), /reserved word/);
    assert.strictEqual(app.eval(`identifierIssue('sales')`), null);
    assert.strictEqual(app.eval(`identifierIssue('')`), null);
  });

  test('validateModel: reserved-word vault name / prefix is a blocking error', () => {
    app.eval(`state.vault.name = 'table'`);
    let errs = app.eval(`validateModel().errors`);
    assert.ok(errs.some(e => /reserved word/.test(e)), 'vault name reserved word must be an error');
    app.eval(`state.vault.name = 'sales'; state.vault.prefix = 'order'`);
    errs = app.eval(`validateModel().errors`);
    assert.ok(errs.some(e => /Staging prefix/.test(e) && /reserved word/.test(e)));
  });

  test('destructiveSqlKeywords: detects DROP/TRUNCATE/DELETE, ignores comments, passes additive DDL', () => {
    assert.deepStrictEqual(app.eval(`destructiveSqlKeywords('ALTER TABLE t ADD COLUMN c text; CREATE TABLE x(i int);')`), []);
    assert.deepStrictEqual(app.eval(`destructiveSqlKeywords('DROP TABLE t; TRUNCATE x; DELETE FROM y;')`), ['DROP','TRUNCATE','DELETE']);
    assert.deepStrictEqual(app.eval(`destructiveSqlKeywords('-- drop table t' + String.fromCharCode(10) + 'SELECT 1;')`), []);
    assert.deepStrictEqual(app.eval(`destructiveSqlKeywords('/* DELETE nothing */ SELECT 1;')`), []);
    // the generated incremental DDL itself must always be additive
    assert.deepStrictEqual(app.eval(`destructiveSqlKeywords(buildIncrementalSql({ missingTables: parseGeneratedDdlObjects(buildStagingDdl()).slice(0,1), missingColumns: [], typeMismatches: [] }))`), []);
  });

  test('designFingerprint: ignores passwords, changes with the design', () => {
    const a = app.eval(`state.vault.dvPassword = 'one'; designFingerprint()`);
    const b = app.eval(`state.vault.dvPassword = 'two'; designFingerprint()`);
    assert.strictEqual(a, b, 'password edits must not invalidate the board');
    const c = app.eval(`state.vault.name = 'renamed'; designFingerprint()`);
    assert.notStrictEqual(b, c, 'design edits must produce a new fingerprint');
  });

  test('deployBoardIsStale: false right after a probe, true once the model changes', () => {
    app.eval(`deployStatus = { rows: [], error: null, fingerprint: designFingerprint() }`);
    assert.strictEqual(app.eval(`deployBoardIsStale()`), false);
    app.eval(`state.vault.prefix = 'changed'`);
    assert.strictEqual(app.eval(`deployBoardIsStale()`), true);
    // stale board renders the warning banner and suppresses action buttons
    app.eval(`deployStatus.rows = [{ key:'staging', label:'Staging tables', state:'missing', detail:'', apply: ()=>{} }]`);
    const html = app.eval(`deployBoardHtml()`);
    assert.match(html, /design changed since this check/i);
    assert.doesNotMatch(html, /data-deploy-row/, 'no apply buttons while stale');
  });

  test('deployBusy: true while probing, applying, or any row is mid-apply', () => {
    assert.strictEqual(app.eval(`deployBusy()`), false);
    assert.strictEqual(app.eval(`deployProbing = true; var _r1 = deployBusy(); deployProbing = false; _r1`), true);
    assert.strictEqual(app.eval(`deployApplying = true; var _r2 = deployBusy(); deployApplying = false; _r2`), true);
    assert.strictEqual(app.eval(`deployStatus = { rows:[{ key:'x', state:'busy' }] }; deployBusy()`), true);
  });

  test('unknown state renders a chip with no action offered', () => {
    app.eval(`deployStatus = { rows: [{ key:'staging', label:'Staging tables', state:'unknown', detail:'could not read the target schema' }], error: null, fingerprint: designFingerprint() }`);
    const html = app.eval(`deployBoardHtml()`);
    assert.match(html, /Unknown/);
    assert.doesNotMatch(html, /data-deploy-row/, 'unknown rows must never offer Deploy');
  });

  test('Connections page warns inline on reserved-word names', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    assert.match(html, /id="f-name-warn"/);
    assert.match(html, /id="f-prefix-warn"/);
    assert.match(html, /destructiveSqlKeywords\(targetDeltaSql\)/, 'target-diff execute is confirm-gated');
  });
});


describe('final staging projection and link-satellite coverage', () => {
  beforeEach(() => { resetApp(); seedFixture(); });

  test('link satellites are enabled and junction attributes are carried', () => {
    assert.strictEqual(app.eval(`FEATURE_LINK_SATELLITES`), true);
    const summary = app.eval(`suggestModelFromKeys()`);
    assert.strictEqual(summary.linkSats, 1);
    assert.strictEqual(app.eval(`state.linkSats.length`), 1);
    assert.ok(app.eval(`state.links.map(l=>l.entity)`).some(e=>e.includes('order') && e.includes('tag')));
    assert.deepStrictEqual(app.eval(`
      (function(){
        const s = state.linkSats[0], t = findTable(s.tableId);
        return s.attrs.map(a=>findCol(t,a.colId).name);
      })()
    `), ['created_at']);
  });

  test('spreadsheet includes configured incremental columns while first-load execution remains off', () => {
    app.eval(`suggestModelFromKeys()`);
    const rows = app.eval(`buildWorkbookRows()`);
    assert.ok(rows.link_satellites.length > 0);
    rows.source_tables.forEach(r => {
      assert.strictEqual(r[6], 0, 'ind_staging_is_incremental must be 0');
    });
    assert.strictEqual(rows.source_tables.find(r=>r[1]==='customers')[7], 'updated_at');
    assert.strictEqual(rows.source_tables.find(r=>r[1]==='orders')[7], '');
  });

  test('vault DDL contains the junction link satellite', () => {
    app.eval(`suggestModelFromKeys()`);
    assert.match(app.eval(`buildDataVaultDdl()`), /lsat_sales_order_tag\b/);
  });

  test('applyFeatureGates preserves legacy incremental column and explicit activation', () => {
    app.eval(`
      suggestModelFromKeys();
      delete state.tables[0].columns[1].staged;
      state.tables[0].incremental = true; state.tables[0].incrementCol = 'updated_at';
      delete state.tables[0].incrementalReady;
      delete state.tables[0].incrementalConfiguredAt;
      var _gateResult = applyFeatureGates();
    `);
    assert.strictEqual(app.eval(`state.linkSats.length`), 1);
    assert.strictEqual(app.eval(`state.tables[0].incremental`), true);
    assert.strictEqual(app.eval(`state.tables[0].incrementCol`), 'updated_at');
    assert.strictEqual(app.eval(`state.tables[0].incrementalReady`), false);
    assert.strictEqual(app.eval(`state.tables[0].incrementalConfigPending`), true);
    assert.strictEqual(app.eval(`state.tables[0].incrementalConfiguredAt`), '');
    assert.strictEqual(app.eval(`state.tables[0].columns[1].staged`), true);
    assert.ok(app.eval(`_gateResult.normalizedColumnFlags`) >= 1);
  });

  test('applyFeatureGates migrates legacy single-column Hub and Link key fields', () => {
    app.eval(`
      startNewProject(true);
      const a=newTable('accounts'); a.columns=[Object.assign(newColumn('account_id','integer'),{pk:true,nullable:false})];
      const b=newTable('regions'); b.columns=[Object.assign(newColumn('region_id','integer'),{pk:true,nullable:false})];
      const x=newTable('account_regions'); x.columns=[newColumn('account_id','integer'),newColumn('region_id','integer')];
      state.tables.push(a,b,x);
      const ha={id:'ha',entity:'account',tableId:a.id,pkColId:a.columns[0].id,statusSat:true};
      const hb={id:'hb',entity:'region',tableId:b.id,pkColId:b.columns[0].id,statusSat:true};
      state.hubs.push(ha,hb);
      state.links.push({id:'lx',entity:'account_region',tableId:x.id,hubs:[
        {hubId:'ha',colId:x.columns[0].id},{hubId:'hb',colId:x.columns[1].id}
      ]});
      var _legacyGate=applyFeatureGates();
    `);
    assert.deepStrictEqual(app.eval(`state.hubs.map(h=>h.keyColIds)`),[[app.eval(`state.tables[0].columns[0].id`)], [app.eval(`state.tables[1].columns[0].id`)]]);
    assert.deepStrictEqual(app.eval(`state.links[0].hubs.map(h=>h.colIds)`),[[app.eval(`state.tables[2].columns[0].id`)], [app.eval(`state.tables[2].columns[1].id`)]]);
    assert.strictEqual(app.eval(`_legacyGate.normalizedHubKeys`),2);
    assert.strictEqual(app.eval(`_legacyGate.normalizedLinkKeys`),2);
  });

  test('applyFeatureGates repairs old cross-table satellite parent hashes', () => {
    app.eval(`
      startNewProject(true);
      const film=newTable('film'); film.columns=[Object.assign(newColumn('film_id','integer'),{pk:true,nullable:false})];
      const text=newTable('film_text'); text.columns=[Object.assign(newColumn('film_id','integer'),{pk:true,nullable:false}),newColumn('title','text')];
      state.tables.push(film,text);
      const h={id:'hub_film',entity:'film',description:'',tableId:film.id,pkColId:film.columns[0].id,statusSat:true}; state.hubs.push(h);
      ensureDerivation(film,'film','film_id','both');
      ensureDerivation(text,'film_text','film_id','both');
      state.hubSats.push({id:'sat_text',entity:'film',concern:'search_text',description:'',hubId:h.id,tableId:text.id,attrs:[{colId:text.columns[1].id,target:'title'}]});
      var _repairResult=applyFeatureGates();
    `);
    assert.strictEqual(app.eval(`_repairResult.repairedSatelliteDerivations`), 1);
    assert.ok(app.eval(`state.tables.find(t=>t.name==='film_text').derivations.some(d=>d.entity==='film' && d.column==='film_id')`));
  });

  test('AI may configure an incremental column, but activation remains an explicit Hub choice', () => {
    app.eval(`suggestModelFromKeys()`);
    const st = app.eval(`applyAiStaging({ incremental: [{ table:'customers', column:'updated_at' }] })`);
    assert.strictEqual(st.incremental, 1);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incremental`), false);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementCol`), 'updated_at');
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReady`), false);
    app.eval(`state.linkSats = []`);
    const md = app.eval(`applyAiModel({ linkSatellites: [{ entity:'order_tag', concern:'', table:'order_tags', link:'order_tag', attributes:[{column:'created_at',target:'created_at'}] }] })`);
    assert.strictEqual(md.linkSats, 1);
    assert.strictEqual(app.eval(`state.linkSats.length`), 1);
  });

  test('AI prompt treats the selected staging columns as mandatory coverage', () => {
    const sp = app.eval(`buildStagingPrompt().rules`);
    assert.match(sp, /"incremental"/);
    assert.match(sp, /updated_at.*modified_at.*ModifiedDate.*last_modified/i);
    assert.match(sp, /omit tables that only have creation dates/i);
    const vp = app.eval(`buildVaultPrompt().rules`);
    assert.match(vp, /SELECTED STAGING COLUMNS/);
    assert.match(vp, /Never silently omit a staged column/);
    assert.match(vp, /linkSatellites/);
    assert.match(vp, /link satellite/i);
  });

  test('gap check reports no junction gaps after deterministic suggestion', () => {
    app.eval(`suggestModelFromKeys()`);
    assert.ok(!app.eval(`unmappedAttributeColumns()`).some(u => u.table === 'order_tags'));
  });

  test('UI owns incremental-column configuration on Tables and Hub owns activation controls', () => {
    const html = readFrontendSources();
    assert.match(html, /Columns included in staging/);
    assert.match(html, /The Stage checkbox is the same setting shown on Step 3/);
    assert.match(html, /wireStagingColumnToggles\(el, t, 'tables'\)/);
    assert.match(html, /wireStagingColumnToggles\(el, t, 'staging'\)/);
    assert.match(html, /\$\{FEATURE_LINK_SATELLITES\?`<div class="field">\s*<label>Satellite type<\/label>/);
    assert.match(html, /<label>Incremental column<\/label>/);
    assert.match(html, /data-table-increment-col/);
    assert.doesNotMatch(html, /data-tf="incrementCol"/);
    assert.doesNotMatch(html, /Incremental column selection is managed on the <b>Tables<\/b> step/);
    assert.match(html, /id="incremental-loads-panel"/);
    assert.match(html, /id="btn-enable-all-incremental"/);
    assert.match(html, /data-dashboard-increment-col/);
    assert.match(html, /data-inc-toggle/);
    assert.doesNotMatch(html, /data-inc-enable/);
    assert.doesNotMatch(html, /data-inc-disable/);
    assert.match(html, /Save &amp; deploy settings/);
  });
});

describe('staged-column authority and export validation', () => {
  beforeEach(() => { resetApp(); seedFixture(); });

  test('a user-excluded staging column is omitted from SQL, AI schema, and Vault coverage', () => {
    app.eval(`
      const t = state.tables.find(x=>x.name==='customers');
      t.columns.find(c=>c.name==='email').staged = false;
      pruneDownstreamModel({ dropExcluded:true });
      suggestModelFromKeys();
    `);
    const stagingDdl = app.eval(`buildStagingDdl()`);
    const override = app.eval(`buildOverride(state.tables.find(t=>t.name==='customers'))`);
    const payload = app.eval(`schemaPayload().find(t=>t.name==='customers').columns.map(c=>c.name)`);
    const attrs = app.eval(`
      (function(){
        const s=state.hubSats.find(x=>x.tableId===state.tables.find(t=>t.name==='customers').id);
        const t=findTable(s.tableId);
        return s.attrs.map(a=>findCol(t,a.colId).name);
      })()
    `);
    assert.doesNotMatch(stagingDdl, /\bemail\b/);
    assert.doesNotMatch(override, /src\.email\s+as\s+email/i);
    assert.ok(!payload.includes('email'));
    assert.ok(!attrs.includes('email'));
    assert.ok(!app.eval(`unmappedAttributeColumns()`).some(x=>x.table==='customers' && x.column==='email'));
  });

  test('AI omissions are repaired so every eligible staged attribute is mapped', () => {
    app.eval(`suggestModelFromKeys(); state.hubSats=[]; state.linkSats=[];`);
    const result = app.eval(`applyAiModel({
      hubSatellites:[
        {entity:'customer',concern:'profile',table:'customers',hub:'customer',attributes:[{column:'name',target:'name'}]},
        {entity:'order',concern:'',table:'orders',hub:'order',attributes:[{column:'order_date',target:'order_date'}]},
        {entity:'tag',concern:'',table:'tags',hub:'tag',attributes:[{column:'label',target:'label'}]}
      ]
    })`);
    assert.ok(result.autoCovered >= 3, `expected omitted attributes to be restored, got ${JSON.stringify(result)}`);
    assert.deepStrictEqual(app.eval(`unmappedAttributeColumns()`), []);
    const customerAttrs = app.eval(`
      (function(){
        const s=state.hubSats.find(x=>x.entity==='customer'), t=findTable(s.tableId);
        return s.attrs.map(a=>findCol(t,a.colId).name).sort();
      })()
    `);
    assert.deepStrictEqual(customerAttrs, ['email','name','updated_at']);
    assert.ok(app.eval(`state.linkSats.some(s=>s.entity==='order_tag')`), 'junction attribute should be auto-covered in a link satellite');
  });

  test.skip('a satellite sourced from another table gets the exact parent-hub hash alias', () => {
    app.eval(`
      startNewProject(true);
      state.vault.name='sakila'; state.vault.prefix='sakila'; state.vault.tenantId='SAKILA';
      state.vault.srcDescription='sakila'; state.vault.srcCod='SAKILA'; state.vault.vaultDbName='dv';
      const film=newTable('film');
      film.columns=[Object.assign(newColumn('film_id','integer'),{pk:true,nullable:false})];
      const filmText=newTable('film_text');
      filmText.columns=[Object.assign(newColumn('film_id','integer'),{pk:true,nullable:false}),newColumn('title','varchar(255)'),newColumn('description','text')];
      state.tables.push(film,filmText);
      addHubProgrammatic('film','film','film_id',true);
      ensureDerivation(filmText,'film_text','film_id','both');
      var _satResult=addHubSatProgrammatic('film','search_text','film_text','film',[{column:'title',target:'title'},{column:'description',target:'description'}]);
    `);
    assert.strictEqual(app.eval(`_satResult.ok`), true);
    assert.ok(app.eval(`state.tables.find(t=>t.name==='film_text').derivations.some(d=>d.entity==='film' && d.column==='film_id' && d.kind==='hash')`));
    const sql = app.eval(`buildOverride(state.tables.find(t=>t.name==='film_text'))`);
    assert.match(sql, /as hash_film_id/);
    assert.deepStrictEqual(app.eval(`validateModel().errors`), []);
  });

  test('validation blocks export when a selected staged attribute has no Vault mapping', () => {
    app.eval(`
      suggestModelFromKeys();
      const sat = state.hubSats.find(s=>s.entity==='customer'), t=findTable(sat.tableId);
      sat.attrs = sat.attrs.filter(a=>findCol(t,a.colId).name!=='email');
    `);
    const errors = app.eval(`validateModel().errors`);
    assert.ok(errors.some(e=>/customers\.email/.test(e) && /not mapped/i.test(e)));
  });

  test('validation blocks an included table with no staged columns or no Vault object', () => {
    app.eval(`state.tables.find(t=>t.name==='customers').columns.forEach(c=>c.staged=false)`);
    let errors = app.eval(`validateModel().errors`);
    assert.ok(errors.some(e=>/customers.*no columns selected/i.test(e)));

    resetApp(); seedFixture();
    errors = app.eval(`validateModel().errors`);
    assert.ok(errors.some(e=>/included table\(s\).*not represented/i.test(e)));
  });

  test('Export page does not expose or run the removed GUI design checker', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    assert.doesNotMatch(html, /id="btn-design-check"/);
    assert.doesNotMatch(html, /runGuiDesignChecker|localDesignChecker|GUI DESIGN CHECKER/);
  });

});


describe('AI staging composite-key guards', () => {
  beforeEach(() => {
    resetApp();
    app.eval(`
      startNewProject(true);
      state.vault.name = 'sak'; state.vault.prefix = 'sak'; state.vault.tenantId = 'SAK';
      state.vault.srcCod = 'SAK'; state.vault.srcDescription = 'sakila';
      const actor = newTable('actor');
      actor.columns = [Object.assign(newColumn('actor_id','integer'), { pk:true, nullable:false })];
      const film = newTable('film');
      film.columns = [Object.assign(newColumn('film_id','integer'), { pk:true, nullable:false })];
      const filmActor = newTable('film_actor');
      filmActor.columns = [
        Object.assign(newColumn('actor_id','integer'), { pk:true, nullable:false }),
        Object.assign(newColumn('film_id','integer'), { pk:true, nullable:false }),
      ];
      state.tables.push(actor, film, filmActor);
      state.sourceMeta.foreignKeys = [
        { table:'film_actor', column:'actor_id', refTable:'actor', refColumn:'actor_id' },
        { table:'film_actor', column:'film_id', refTable:'film', refColumn:'film_id' },
      ];
    `);
  });

  test('prompt and schema payload identify relationship-table composite keys explicitly', () => {
    const prompt = app.eval(`buildStagingPrompt().rules`);
    assert.match(prompt, /tableRole is "relationship"/i);
    assert.match(prompt, /composite primary key.*one derivation.*columns/i);
    const payload = app.eval(`schemaPayload().find(t=>t.name==='film_actor')`);
    assert.strictEqual(payload.tableRole, 'relationship');
    assert.deepStrictEqual(payload.primaryKeyColumns, ['actor_id', 'film_id']);
    assert.deepStrictEqual(payload.foreignKeys, [
      { columns:['actor_id'], referencedTable:'actor', referencedEntity:'actor', referencedColumns:['actor_id'], role:'actor' },
      { columns:['film_id'], referencedTable:'film', referencedEntity:'film', referencedColumns:['film_id'], role:'film' },
    ]);
  });

  test('bad AI film_actor business keys are normalised to actor/film hashes', () => {
    const summary = app.eval(`applyAiStaging({ tableDerivations:[{
      table:'film_actor', derivations:[
        { column:'actor_id', entity:'film_actor', kind:'both' },
        { column:'film_id', entity:'film_actor', kind:'both' },
      ]
    }] })`);
    assert.strictEqual(summary.derivations, 2);
    assert.strictEqual(summary.skipped.length, 0);
    assert.strictEqual(summary.adjusted.length, 2);
    const derivations = app.eval(`state.tables.find(t=>t.name==='film_actor').derivations.map(d=>({entity:d.entity,column:d.column,kind:d.kind}))`);
    assert.deepStrictEqual(derivations, [
      { entity:'actor', column:'actor_id', kind:'hash' },
      { entity:'film', column:'film_id', kind:'hash' },
    ]);
    const columns = app.eval(`buildStagingColumns(state.tables.find(t=>t.name==='film_actor')).map(c=>c.name)`);
    assert.ok(columns.includes('hash_actor_id'));
    assert.ok(columns.includes('hash_film_id'));
    assert.ok(!columns.includes('film_actor_bk'));
  });

  test('saved bad junction derivations are repaired during project normalisation', () => {
    app.eval(`
      const t = state.tables.find(t=>t.name==='film_actor');
      t.derivations = [
        { id:'bad1', column:'actor_id', entity:'film_actor', kind:'both' },
        { id:'bad2', column:'film_id', entity:'film_actor', kind:'both' },
      ];
    `);
    const result = app.eval(`applyFeatureGates()`);
    assert.strictEqual(result.repairedJunctionDerivations, 2);
    assert.deepStrictEqual(app.eval(`state.tables.find(t=>t.name==='film_actor').derivations.map(d=>[d.entity,d.column,d.kind])`), [
      ['actor','actor_id','hash'],
      ['film','film_id','hash'],
    ]);
  });

  test('AI cannot introduce two derivations with the same business-key alias', () => {
    app.eval(`
      const customer = newTable('customer');
      customer.columns = [
        Object.assign(newColumn('customer_id','integer'), { pk:true, nullable:false }),
        newColumn('legacy_customer_id','integer'),
      ];
      state.tables.push(customer);
    `);
    const summary = app.eval(`applyAiStaging({ tableDerivations:[{
      table:'customer', derivations:[
        { column:'customer_id', entity:'customer', kind:'both' },
        { column:'legacy_customer_id', entity:'customer', kind:'bk' },
      ]
    }] })`);
    assert.ok(summary.derivations >= 1);
    assert.ok(summary.skipped.some(s=>/customer_bk/.test(s)), JSON.stringify(summary));
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customer').derivations.length`), 1);
  });
});



describe('composite business keys and safe target names', () => {
  beforeEach(() => {
    resetApp();
    app.eval(`
      startNewProject(true);
      state.vault.name='demo'; state.vault.prefix='demo'; state.vault.tenantId='DEMO';
      state.vault.srcCod='DEMO'; state.vault.srcDescription='demo'; state.vault.sourceSchema='public';
      state.vault.vaultDbName='demo_vault'; state.vault.dialect='postgresql';
    `);
  });

  test.skip('a composite entity key becomes one ordered Hub business key and hash', () => {
    app.eval(`
      const t=newTable('accounts');
      t.columns=[
        Object.assign(newColumn('country_code','varchar(2)'),{pk:true,nullable:false}),
        Object.assign(newColumn('account_number','varchar(20)'),{pk:true,nullable:false}),
        newColumn('display_name','varchar(100)')
      ];
      state.tables.push(t);
      var _summary=suggestModelFromKeys();
    `);
    assert.strictEqual(app.eval(`_summary.hubs`), 1);
    assert.deepStrictEqual(app.eval(`hubKeyCols(state.hubs[0]).map(c=>c.name)`), ['country_code','account_number']);
    assert.deepStrictEqual(app.eval(`state.tables[0].derivations.map(d=>({entity:d.entity,columns:derivationSourceColumns(d),kind:d.kind}))`), [
      { entity:'account', columns:['country_code','account_number'], kind:'both' },
    ]);
    const sql=app.eval(`buildOverride(state.tables[0])`);
    assert.match(sql, /country_code/);
    assert.match(sql, /account_number/);
    assert.match(sql, /'-1:'/); // NULL is distinct from empty string
    assert.match(sql, /as hash_account_id/);
    assert.match(sql, /as account_bk/);
    const columns=app.eval(`buildStagingColumns(state.tables[0]).map(c=>c.name)`);
    assert.strictEqual(columns.filter(x=>x==='hash_account_id').length,1);
    assert.strictEqual(columns.filter(x=>x==='account_bk').length,1);
    assert.deepStrictEqual(app.eval(`validateModel().errors`), []);
  });

  test.skip('declared composite foreign-key columns remain one Link role and one staged hash', () => {
    app.eval(`
      const parties=newTable('parties');
      parties.columns=[
        Object.assign(newColumn('country_code','varchar(2)'),{pk:true,nullable:false}),
        Object.assign(newColumn('party_number','varchar(20)'),{pk:true,nullable:false}),
        newColumn('name','text')
      ];
      const contracts=newTable('contracts');
      contracts.columns=[
        Object.assign(newColumn('contract_id','integer'),{pk:true,nullable:false}),
        newColumn('party_country_code','varchar(2)'),
        newColumn('party_number','varchar(20)'),
        newColumn('signed_at','date')
      ];
      state.tables.push(parties,contracts);
      state.sourceMeta.foreignKeys=[
        {table:'contracts',column:'party_country_code',refTable:'parties',refColumn:'country_code',constraintName:'fk_contract_party',ordinalPosition:1},
        {table:'contracts',column:'party_number',refTable:'parties',refColumn:'party_number',constraintName:'fk_contract_party',ordinalPosition:2}
      ];
      suggestModelFromKeys();
    `);
    assert.strictEqual(app.eval(`state.links.length`),1);
    const ref=app.eval(`(function(){const l=state.links[0],t=findTable(l.tableId);return l.hubs.find(h=>findHub(h.hubId).entity==='party').colIds.map(id=>findCol(t,id).name);})()`);
    assert.deepStrictEqual(ref,['party_country_code','party_number']);
    const deriv=app.eval(`state.tables.find(t=>t.name==='contracts').derivations.find(d=>d.entity==='party')`);
    assert.deepStrictEqual(deriv.columns,['party_country_code','party_number']);
    assert.strictEqual(deriv.kind,'hash');
    assert.match(app.eval(`buildOverride(state.tables.find(t=>t.name==='contracts'))`),/as hash_party_id/);
    assert.deepStrictEqual(app.eval(`validateModel().errors`),[]);
  });

  test('partially selected composite primary keys are blocked instead of modelled as a smaller key', () => {
    app.eval(`
      const t=newTable('accounts');
      const country=Object.assign(newColumn('country_code','varchar(2)'),{pk:true,nullable:false});
      const number=Object.assign(newColumn('account_number','varchar(20)'),{pk:true,nullable:false,staged:false});
      t.columns=[country,number,newColumn('name','text')];
      state.tables.push(t);
      suggestModelFromKeys();
    `);
    assert.strictEqual(app.eval(`state.hubs.length`),0);
    assert.ok(app.eval(`validateModel().errors`).some(e=>/only part of its primary key/i.test(e)));
  });

  test('partially selected composite foreign keys are blocked and not reduced to one column', () => {
    app.eval(`
      const parties=newTable('parties');
      parties.columns=[Object.assign(newColumn('country_code','varchar(2)'),{pk:true}),Object.assign(newColumn('party_number','varchar(20)'),{pk:true})];
      const contracts=newTable('contracts');
      contracts.columns=[Object.assign(newColumn('contract_id','integer'),{pk:true}),newColumn('party_country_code','varchar(2)'),Object.assign(newColumn('party_number','varchar(20)'),{staged:false})];
      state.tables.push(parties,contracts);
      state.sourceMeta.foreignKeys=[
        {table:'contracts',column:'party_country_code',refTable:'parties',refColumn:'country_code',constraintName:'fk_contract_party',ordinalPosition:1},
        {table:'contracts',column:'party_number',refTable:'parties',refColumn:'party_number',constraintName:'fk_contract_party',ordinalPosition:2}
      ];
      suggestModelFromKeys();
    `);
    assert.strictEqual(app.eval(`state.links.length`),0);
    assert.ok(app.eval(`validateModel().errors`).some(e=>/only part of foreign key "fk_contract_party"/i.test(e)));
  });

  test('composite self-references keep separate role hashes and Link columns', () => {
    app.eval(`
      const nodes=newTable('nodes');
      nodes.columns=[
        Object.assign(newColumn('tenant_code','varchar(10)'),{pk:true,nullable:false}),
        Object.assign(newColumn('node_code','varchar(20)'),{pk:true,nullable:false}),
        newColumn('parent_tenant_code','varchar(10)'),
        newColumn('parent_node_code','varchar(20)'),
        newColumn('label','text')
      ];
      state.tables.push(nodes);
      state.sourceMeta.foreignKeys=[
        {table:'nodes',column:'parent_tenant_code',refTable:'nodes',refColumn:'tenant_code',constraintName:'fk_nodes_parent',ordinalPosition:1},
        {table:'nodes',column:'parent_node_code',refTable:'nodes',refColumn:'node_code',constraintName:'fk_nodes_parent',ordinalPosition:2}
      ];
      suggestModelFromKeys();
    `);
    assert.strictEqual(app.eval(`state.links.length`),1);
    assert.deepStrictEqual(app.eval(`state.tables[0].derivations.map(d=>({entity:d.entity,role:d.role,columns:derivationSourceColumns(d),kind:d.kind}))`),[
      {entity:'node',role:'node',columns:['tenant_code','node_code'],kind:'both'},
      {entity:'node',role:'parent',columns:['parent_tenant_code','parent_node_code'],kind:'hash'},
    ]);
    const aliases=app.eval(`buildStagingColumns(state.tables[0]).map(c=>c.name)`);
    assert.ok(aliases.includes('hash_node_id'));
    assert.ok(aliases.includes('hash_parent_id'));
    const linkCols=app.eval(`linkColumns(state.links[0]).map(c=>c.name)`);
    assert.ok(linkCols.includes('hub_demo_node_id'));
    assert.ok(linkCols.includes('hub_demo_parent_id'));
    assert.strictEqual(new Set(linkCols).size,linkCols.length);
    assert.deepStrictEqual(app.eval(`validateModel().errors`),[]);
  });

  test('unsafe source identifiers receive stable PostgreSQL-safe staging aliases', () => {
    app.eval(`
      const t=newTable('Odd Table');
      t.columns=[
        Object.assign(newColumn('select','integer'),{pk:true,nullable:false}),
        newColumn('customer-name','text'),
        newColumn('customer name','text'),
        newColumn('tenant_id','text')
      ];
      state.tables.push(t);
      suggestModelFromKeys();
    `);
    assert.deepStrictEqual(app.eval(`state.tables[0].columns.map(c=>targetColumnName(c))`),[
      'select_value','customer_name','customer_name_2','tenant_id_source'
    ]);
    const override=app.eval(`buildOverride(state.tables[0])`);
    assert.match(override,/src\."select" as select_value/);
    assert.match(override,/src\."customer-name" as customer_name/);
    assert.match(override,/from public\."Odd Table" src/);
    const ddl=app.eval(`buildStagingDdl()`);
    assert.match(ddl,/staging\.stg_demo_odd_table/);
    assert.doesNotMatch(ddl,/\bcustomer-name\b/);
    assert.deepStrictEqual(app.eval(`validateModel().errors`),[]);
  });

  test('generated staging, hash and role identifiers stay within PostgreSQL limits', () => {
    app.eval(`
      state.vault.name='a_very_long_vault_name_used_to_check_combined_identifier_limits';
      state.vault.prefix='a_very_long_source_prefix_used_for_staging_names';
      const t=newTable('an_extremely_long_source_table_name_that_would_otherwise_overflow_postgresql_identifiers');
      t.columns=[Object.assign(newColumn('an_extremely_long_business_identifier_column_name','integer'),{pk:true,nullable:false})];
      state.tables.push(t);
      suggestModelFromKeys();
    `);
    const names=app.eval(`[
      stagingTableName(state.tables[0].name),
      hubName(state.hubs[0].entity),
      hubKey(state.hubs[0].entity),
      hashColumnNameForHub(state.tables[0],state.hubs[0])
    ]`);
    names.forEach(name=>assert.ok(name.length<=63,`${name} is ${name.length} characters`));
    assert.strictEqual(new Set(names).size,names.length);
  });

  test('different source tables that normalise to the same staging name are blocked', () => {
    app.eval(`
      const a=newTable('A-B'); a.columns=[Object.assign(newColumn('id','integer'),{pk:true})];
      const b=newTable('A B'); b.columns=[Object.assign(newColumn('id','integer'),{pk:true})];
      state.tables.push(a,b);
    `);
    assert.ok(app.eval(`validateModel().errors`).some(e=>/same staging table name/i.test(e)));
  });

  test('manual Hub and Link editors expose multi-column key selection', () => {
    const fs=require('node:fs'),path=require('node:path');
    const html=readFrontendSources();
    assert.match(html,/id="hub-pk" multiple/);
    assert.match(html,/id="edit-hub-pk" multiple/);
    assert.match(html,/data-lf="colIds"/);
    assert.match(html,/data-elf="colIds"/);
  });
});

describe('duplicate hash column fix (sakila film case)', () => {
  beforeEach(() => {
    resetApp();
    app.eval(`
      startNewProject(true);
      state.vault.name = 'sak'; state.vault.prefix = 'sak'; state.vault.tenantId = 'SAK';
      state.vault.srcCod = 'SAK'; state.vault.srcDescription = 'sakila';
      state.vault.sourceSchema = 'sakila'; state.vault.dialect = 'mysql';
      const language = newTable('language');
      language.columns = [Object.assign(newColumn('language_id','integer'), { pk:true, nullable:false })];
      const film = newTable('film');
      film.columns = [
        Object.assign(newColumn('film_id','integer'), { pk:true, nullable:false }),
        newColumn('title','varchar(255)'),
        newColumn('language_id','integer'),
        newColumn('original_language_id','integer'),
      ];
      state.tables.push(language, film);
      state.sourceMeta.foreignKeys = [
        { table:'film', column:'language_id', refTable:'language', refColumn:'language_id' },
        { table:'film', column:'original_language_id', refTable:'language', refColumn:'language_id' },
      ];
      // exactly the collision from the field: Suggest-from-keys maps both FK
      // columns to Hub "language"; an older AI response uses the role
      // "original_language" in the old overloaded entity field.
      ensureDerivation(film, 'film', 'film_id', 'both');
      ensureDerivation(film, 'language', 'language_id', 'hash');
      ensureDerivation(film, 'language', 'original_language_id', 'hash');
    `);
  });

  test('ensureDerivation refuses a second pure-hash derivation on the same column', () => {
    const before = app.eval(`state.tables.find(t=>t.name==='film').derivations.length`);
    app.eval(`ensureDerivation(state.tables.find(t=>t.name==='film'), 'original_language', 'original_language_id', 'hash')`);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='film').derivations.length`), before,
      'the AI path must reuse the existing hash instead of duplicating it');
  });

  test.skip('staging SQL override never emits two columns with the same alias', () => {
    // force the duplicate in state (older projects / direct edits can carry it)
    app.eval(`state.tables.find(t=>t.name==='film').derivations.push({ id:'drv_dup', entity:'original_language', column:'original_language_id', kind:'hash' })`);
    const sql = app.eval(`buildOverride(state.tables.find(t=>t.name==='film'))`);
    const dupCount = (sql.match(/as hash_original_language_id\b/g) || []).length;
    assert.strictEqual(dupCount, 1, sql);
    assert.match(sql, /as hash_language_id\b/);
    // and the aliases the override emits match the staging DDL columns
    const ddlCols = app.eval(`buildStagingColumns(state.tables.find(t=>t.name==='film')).map(c=>c.name)`);
    assert.strictEqual(new Set(ddlCols).size, ddlCols.length, 'DDL columns unique');
    assert.ok(ddlCols.includes('hash_original_language_id'));
    // validateModel repairs an exact same-source/same-output duplicate before export.
    const errors = app.eval(`validateModel().errors`);
    assert.ok(!errors.some(e => /hash_original_language_id/.test(e)), JSON.stringify(errors));
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='film').derivations.filter(d=>d.column==='original_language_id').length`), 1);
  });

  test.skip('distinct FK columns to the same entity keep distinct hash names', () => {
    const sql = app.eval(`buildOverride(state.tables.find(t=>t.name==='film'))`);
    assert.match(sql, /as hash_language_id\b/);
    assert.match(sql, /as hash_original_language_id\b/);
  });
});


describe('AI foreign-key target and role reconciliation', () => {
  beforeEach(() => {
    resetApp();
    app.eval(`
      startNewProject(true);
      state.vault.name='demo'; state.vault.prefix='demo'; state.vault.tenantId='DEMO';
      state.vault.srcCod='DEMO'; state.vault.srcDescription='demo';
      const language=newTable('language');
      language.columns=[Object.assign(newColumn('language_id','integer'),{pk:true,nullable:false})];
      const film=newTable('film');
      film.columns=[
        Object.assign(newColumn('film_id','integer'),{pk:true,nullable:false}),
        newColumn('language_id','integer'),
        newColumn('original_language_id','integer'),
        newColumn('title','text')
      ];
      state.tables.push(language,film);
      state.sourceMeta.foreignKeys=[
        {table:'film',column:'language_id',refTable:'language',refColumn:'language_id'},
        {table:'film',column:'original_language_id',refTable:'language',refColumn:'language_id'}
      ];
    `);
  });

  test('staging AI prompt separates targetEntity from role and supplies exact FK entities', () => {
    const rules=app.eval(`buildStagingPrompt().rules`);
    assert.match(rules,/targetEntity.*role.*different concepts/i);
    assert.match(rules,/copy targetEntity exactly.*referencedEntity/i);
    const film=app.eval(`schemaPayload().find(t=>t.name==='film')`);
    assert.deepStrictEqual(film.foreignKeys.map(f=>({target:f.referencedEntity,role:f.role})),[
      {target:'language',role:'language'},
      {target:'language',role:'original_language'},
    ]);
  });

  test('old AI output that uses the relationship role as entity is corrected before insertion', () => {
    const summary=app.eval(`applyAiStaging({tableDerivations:[{table:'film',derivations:[
      {column:'film_id',entity:'film',kind:'both'},
      {column:'language_id',entity:'language',kind:'hash'},
      {column:'original_language_id',entity:'original_language',kind:'hash'}
    ]}]})`);
    assert.ok(summary.adjusted.some(x=>/source relationship target "language"/.test(x)),JSON.stringify(summary));
    const rows=app.eval(`state.tables.find(t=>t.name==='film').derivations.map(d=>({entity:d.entity,role:d.role,column:d.column,kind:d.kind,output:hashColumnNameForDerivation(state.tables.find(t=>t.name==='film'),d)}))`);
    assert.deepStrictEqual(rows,[
      {entity:'film',role:'film',column:'film_id',kind:'both',output:'hash_film_id'},
      {entity:'language',role:'language',column:'language_id',kind:'hash',output:'hash_language_id'},
      {entity:'language',role:'original_language',column:'original_language_id',kind:'hash',output:'hash_original_language_id'},
    ]);
    assert.deepStrictEqual(app.eval(`duplicateDerivationTargets(state.tables.find(t=>t.name==='film'))`),[]);
  });

  test('new AI shape with an incorrect targetEntity is corrected using FK metadata', () => {
    app.eval(`applyAiStaging({tableDerivations:[{table:'film',derivations:[
      {column:'original_language_id',targetEntity:'original_language',role:'original_language',kind:'hash'}
    ]}]})`);
    const row=app.eval(`state.tables.find(t=>t.name==='film').derivations.find(d=>d.column==='original_language_id')`);
    assert.strictEqual(row.entity,'language');
    assert.strictEqual(row.role,'original_language');
  });

  test('AI then keys and keys then AI produce the same canonical derivations', () => {
    app.eval(`applyAiStaging({tableDerivations:[{table:'film',derivations:[{column:'original_language_id',entity:'original_language',kind:'hash'}]}]}); suggestStagingFromKeys();`);
    const first=app.eval(`state.tables.find(t=>t.name==='film').derivations.map(d=>[d.entity,d.role,derivationSourceColumns(d),d.kind]).sort()`);
    app.eval(`state.tables.forEach(t=>t.derivations=[]); suggestStagingFromKeys(); applyAiStaging({tableDerivations:[{table:'film',derivations:[{column:'original_language_id',entity:'original_language',kind:'hash'}]}]});`);
    const second=app.eval(`state.tables.find(t=>t.name==='film').derivations.map(d=>[d.entity,d.role,derivationSourceColumns(d),d.kind]).sort()`);
    assert.deepStrictEqual(second,first);
    assert.strictEqual(second.filter(x=>x[2][0]==='original_language_id').length,1);
  });

  test('saved duplicate role/entity rows are merged during project normalisation', () => {
    app.eval(`
      const t=state.tables.find(t=>t.name==='film');
      t.derivations=[
        {id:'old_ai',entity:'original_language',column:'original_language_id',kind:'hash'},
        {id:'fk_row',entity:'language',column:'original_language_id',kind:'hash'}
      ];
    `);
    const normalized=app.eval(`applyFeatureGates()`);
    assert.ok(normalized.repairedForeignKeyDerivations>=1,JSON.stringify(normalized));
    assert.deepStrictEqual(app.eval(`state.tables.find(t=>t.name==='film').derivations.map(d=>[d.entity,d.role,d.column,d.kind])`),[
      ['language','original_language','original_language_id','hash']
    ]);
  });

  test('self-referencing AI roles stay on the referenced Hub rather than becoming new Hubs', () => {
    app.eval(`
      const employee=newTable('employee');
      employee.columns=[Object.assign(newColumn('employee_id','integer'),{pk:true}),newColumn('manager_id','integer')];
      state.tables=[employee];
      state.sourceMeta.foreignKeys=[{table:'employee',column:'manager_id',refTable:'employee',refColumn:'employee_id'}];
      applyAiStaging({tableDerivations:[{table:'employee',derivations:[
        {column:'employee_id',targetEntity:'employee',role:'employee',kind:'both'},
        {column:'manager_id',targetEntity:'manager',role:'manager',kind:'hash'}
      ]}]});
    `);
    assert.deepStrictEqual(app.eval(`state.tables[0].derivations.map(d=>[d.entity,d.role,d.column])`),[
      ['employee','employee','employee_id'],
      ['employee','manager','manager_id'],
    ]);
    assert.deepStrictEqual(app.eval(`buildStagingColumns(state.tables[0]).map(c=>c.name).filter(n=>n.startsWith('hash_'))`),['hash_employee_id','hash_manager_id']);
  });
});

describe('connections layout & naming hygiene', () => {
  test.skip('runtime profiles share one Connections implementation while demo locks and production unlocks the supported choices', () => {
    const render=app.eval(`renderConnections.toString()`);
    assert.match(render,/const demo=isDemoRuntime\(\)/);
    assert.match(render,/demo\?'readonly aria-readonly="true"'/);
    assert.match(render,/demo\?'disabled aria-disabled="true"'/);
    assert.match(render,/type="password" id="f-srcpass"/);
    assert.match(render,/type="password" id="f-dvpass"/);
    assert.match(render,/Deployment target/);
    assert.match(render,/value="mysql"/);
    assert.match(render,/value="sqlserver"/);
    assert.match(render,/value="internal-postgres"/);
    assert.match(render,/value="postgres"/);
    assert.match(render,/FDW is not offered for this target mode/);
    assert.doesNotMatch(render,/id="f-external-tables"|id="f-external-dialect"/);
    assert.match(render,/sourceDialectOptionsHtml\(\)/);
    assert.match(app.eval(`sourceDialectOptionsHtml()`),/MySQL Demo<\/option>/);

    assert.strictEqual(app.eval(`isDemoRuntime()`),true);
    assert.strictEqual(app.eval(`state.vault.sourcePreset`),'demo');
    assert.strictEqual(app.eval(`state.vault.targetPreset`),'internal');

    const production=loadApp({runtimeMode:'production'});
    assert.strictEqual(production.eval(`isProductionRuntime()`),true);
    assert.strictEqual(production.eval(`state.vault.sourcePreset`),'');
    assert.strictEqual(production.eval(`state.vault.targetPreset`),'internal');
    const productionRender=production.eval(`renderConnections.toString()`);
    assert.match(productionRender,/\['postgresql','mysql','sqlserver'\]/);
    assert.doesNotMatch(production.eval(`sourceDialectOptionsHtml()`),/MySQL Demo|mysql_demo/);
  });
});

describe('Data Vault Hub visible run history', () => {
  test('keeps the familiar run labels but also discovers real staging/vault work from job tables', () => {
    const html = readFrontendSources();
    const metrics = html.slice(html.indexOf('async function loadDashboardMetrics'), html.indexOf('function timeAgo'));

    assert.match(metrics, /rt\.description IN \('Data Vault', 'Test Staging'\)/);
    assert.match(metrics, /EXISTS \(SELECT 1 FROM pdi_meta\.inst_run_stg_jobs/);
    assert.match(metrics, /EXISTS \(SELECT 1 FROM pdi_meta\.inst_run_dv_jobs/);
    assert.match(metrics, /THEN 'Data Vault'/);
    assert.match(metrics, /THEN 'Staging'/);
    assert.doesNotMatch(metrics, /JOIN recent_visible_runs r ON r\.id_run = j\.id_run AND r\.run_type/);
  });

  test('Hub automatically loads metrics for a known target connection and renders an empty history shell too', () => {
    const html = readFrontendSources();
    const render = html.slice(html.indexOf('function renderDashboard(el)'), html.indexOf('async function loadSchedulerStatus'));
    const loader = html.slice(html.indexOf('async function loadDashboardMetrics'), html.indexOf('function timeAgo'));
    assert.match(render, /scheduleDashboardAutoLoad\(\)/);
    assert.match(render, /dashboardStatus==='ok'/);
    assert.match(render, /renderDashboardResults\(document\.getElementById\('dash-results'\)\)/);
    assert.match(loader, /dashboardAutoLoadKey = dashboardConnectionKey\(\)/);
  });
});

describe('Data Vault Hub run watcher', () => {
  test('keeps watching without a 30-minute cutoff while retaining failure detection', () => {
    const html = readFrontendSources();
    const watcher = html.slice(html.indexOf('async function runWatchTick'), html.indexOf('async function verifyLatestLoad'));

    assert.doesNotMatch(watcher, /runWatch\.tries\s*>\s*360/);
    assert.doesNotMatch(watcher, /Stopped watching after 30 minutes/);
    assert.match(watcher, /runWatch\.tries\+\+/);
    assert.match(watcher, /engine\.exitCode!==0/);
    assert.match(watcher, /The Hop engine exited with code .*check the engine logs\./);
    assert.match(watcher, /if \(metadataFailed\)/);
    assert.match(watcher, /FAILED.*check the engine logs and run detail\./);
  });
});

describe('Data Vault Hub stop control', () => {
  test('renders one Start and one Stop control only in Hub and wires both handlers', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features', 'dashboard.js'), 'utf8');
    const render = dashboard.slice(dashboard.indexOf('function renderDashboard'), dashboard.indexOf('async function loadSchedulerStatus'));
    const html = readFrontendSources();
    const exportSection = html.slice(html.indexOf('function renderExport'), html.indexOf('function explainTargetSqlError'));

    assert.strictEqual((render.match(/id="btn-docker-runhop"/g) || []).length, 1);
    assert.strictEqual((render.match(/id="btn-docker-stophop"/g) || []).length, 1);
    assert.match(render, /class="btn danger" id="btn-docker-stophop"[^>]*>Stop data vault engine/);
    assert.match(render, /btn-docker-stophop'\)\.addEventListener\('click', dockerStopHop\)/);
    assert.doesNotMatch(exportSection, /btn-docker-(?:runhop|stophop)/);
  });

  test('uses the fixed stop endpoint after pausing monitoring and reports success as non-error', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features', 'dashboard.js'), 'utf8');
    const pause = dashboard.slice(dashboard.indexOf('function pauseRunWatchForUserStop'), dashboard.indexOf('function restoreRunWatchAfterFailedUserStop'));
    const handler = dashboard.slice(dashboard.indexOf('async function dockerStopHop'), dashboard.indexOf('/* ---- ENGINE LOGS'));

    assert.match(handler, /if \(engineActionBusy\) return/);
    assert.match(handler, /scheduler is enabled, it may start another run later/);
    assert.match(handler, /startBtn\.disabled = true;[\s\S]*stopBtn\.disabled = true/);
    assert.match(pause, /clearInterval\(runWatch\.handle\)/);
    assert.match(pause, /message:'Stopping engine at your request…'/);
    assert.ok(handler.indexOf('pauseRunWatchForUserStop()') < handler.indexOf("localFetch('/api/docker/stop-hop'"));
    assert.match(handler, /localFetch\('\/api\/docker\/stop-hop', \{ method:'POST' \}\)/);
    assert.doesNotMatch(handler, /JSON\.stringify|body:/);
    assert.match(handler, /stopRunWatch\('Engine stopped by user\.', 'ok'\)/);
    assert.match(handler, /ai-status ok mt">Engine stopped by user\./);
    assert.match(handler, /toast\('Data vault engine stopped by user\.', 'ok'\)/);
  });

  test('a failed stop restores and re-arms the previous watcher', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features', 'dashboard.js'), 'utf8');
    const restore = dashboard.slice(dashboard.indexOf('function restoreRunWatchAfterFailedUserStop'), dashboard.indexOf('async function dockerStopHop'));
    const handler = dashboard.slice(dashboard.indexOf('async function dockerStopHop'), dashboard.indexOf('/* ---- ENGINE LOGS'));
    const watcher = dashboard.slice(dashboard.indexOf('async function runWatchTick'), dashboard.indexOf('async function verifyLatestLoad'));

    assert.match(restore, /runWatch = snapshot\.previous/);
    assert.match(restore, /snapshot\.wasArmed && runWatch\) armRunWatch\(\)/);
    assert.strictEqual((handler.match(/restoreRunWatchAfterFailedUserStop\(watchSnapshot\)/g) || []).length, 2);
    assert.match(handler, /Could not stop the data vault engine — monitoring resumed\./);
    assert.match(watcher, /const watch = runWatch/);
    assert.match(watcher, /if \(runWatch !== watch \|\| engineActionBusy\) return/);
  });
});

describe('Data Vault Hub incremental loading lifecycle', () => {
  beforeEach(() => { resetApp(); seedFixture(); });

  test('schema detection helper prefers change timestamps and respects a user-cleared suggestion', () => {
    app.eval(`
      var _autoTable=newTable('accounts');
      _autoTable.columns=[
        newColumn('birth_date','date'),
        newColumn('created_at','timestamp'),
        Object.assign(newColumn('ModifiedDate','timestamp'),{nativeType:'datetime',semanticType:'TIMESTAMP'})
      ];
      state.tables.push(_autoTable);
      var _autoFirst=autoConfigureIncrementalColumn(_autoTable);
    `);
    assert.strictEqual(app.eval(`_autoFirst`), true);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='accounts').incrementCol`), 'ModifiedDate');
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='accounts').incremental`), false);
    app.eval(`
      var _autoTableCleared=state.tables.find(t=>t.name==='accounts');
      configureIncrementalColumn(_autoTableCleared,'');
      var _autoAfterClear=autoConfigureIncrementalColumn(_autoTableCleared);
    `);
    assert.strictEqual(app.eval(`_autoAfterClear`), false);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='accounts').incrementCol`), '');
  });

  test('incremental columns are restricted to timestamp/datetime fields', () => {
    app.eval(`
      var _typesTable=newTable('typed_events');
      _typesTable.columns=[
        newColumn('ModifiedDate','date'),
        newColumn('updated_at','varchar(64)'),
        Object.assign(newColumn('changed_at','timestamp'),{semanticType:'TIMESTAMP'}),
        Object.assign(newColumn('changed_offset','timestamptz'),{nativeType:'datetimeoffset',semanticType:'TIMESTAMP_TZ'})
      ];
      state.tables=[_typesTable];
      var _badDate=configureIncrementalColumn(_typesTable,'ModifiedDate');
      var _badText=configureIncrementalColumn(_typesTable,'updated_at');
    `);
    assert.deepStrictEqual(app.eval(`incrementalColumnOptions(state.tables[0]).map(c=>c.name)`), ['changed_at','changed_offset']);
    assert.strictEqual(app.eval(`_badDate`), false);
    assert.strictEqual(app.eval(`_badText`), false);
    assert.strictEqual(app.eval(`state.tables[0].incrementCol`), '');
  });

  test('Detect Source Tables applies the incremental suggestion without enabling it', async () => {
    app.eval(`
      state.vault.dialect='postgresql'; state.vault.srcDatabase='source_db'; state.vault.sourceSchema='public';
      fetchIntrospection=async function(){ return {
        ok:true, foreignKeys:[], profileSummary:{warnings:[],infos:[]}, tables:[{
          name:'events', objectType:'table', approxRows:10, columns:[
            {name:'event_id',type:'integer',nullable:false,pk:true},
            {name:'created_at',type:'timestamp',nullable:true,pk:false},
            {name:'modified_at',type:'timestamp',nullable:true,pk:false}
          ]
        }]
      }; };
    `);
    await app.evalRaw(`introspectDatabase()`);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='events').incrementCol`), 'modified_at');
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='events').incremental`), false);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='events').incrementalConfigPending`), true);
  });

  test('Detect Source Tables recognises camel-case ModifiedDate from detected schema', async () => {
    app.eval(`
      state.vault.dialect='postgresql'; state.vault.srcDatabase='source_db'; state.vault.sourceSchema='public';
      fetchIntrospection=async function(){ return {
        ok:true, foreignKeys:[], profileSummary:{warnings:[],infos:[]}, tables:[{
          name:'Customer', objectType:'table', approxRows:10, columns:[
            {name:'CustomerID',type:'integer',nullable:false,pk:true},
            {name:'AccountNumber',type:'varchar(10)',nullable:false,pk:false},
            {name:'ModifiedDate',type:'timestamp',nativeType:'datetime',semanticType:'TIMESTAMP',nullable:false,pk:false}
          ]
        }]
      }; };
    `);
    await app.evalRaw(`introspectDatabase()`);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='Customer').incrementCol`), 'ModifiedDate');
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='Customer').incremental`), false);
  });

  test('incremental auto-detection uses change/update stems in compound timestamp names', () => {
    app.eval(`
      const t=newTable('compound_names');
      t.columns=[
        Object.assign(newColumn('id','integer'),{pk:true,nullable:false}),
        newColumn('CustomerModifiedDate','timestamp'),
        newColumn('RowUpdatedAt','timestamp'),
        newColumn('EventCreatedAt','timestamp')
      ];
      state.tables=[t];
    `);
    assert.strictEqual(app.eval(`detectedIncrementalColumn(state.tables[0]).name`), 'CustomerModifiedDate');
    assert.strictEqual(app.eval(`incrementalAutoDetectNameScore('CustomerModifiedDate')`), 90);
    assert.strictEqual(app.eval(`incrementalAutoDetectNameScore('RowUpdatedAt')`), 86);
    assert.strictEqual(app.eval(`incrementalAutoDetectNameScore('EventCreatedAt')`), 0);
  });

  test('incremental auto-detection ranks last-modified/update names ahead of generic change names', () => {
    app.eval(`
      const t=newTable('ranked_names');
      t.columns=[
        newColumn('ChangedTimestamp','timestamp'),
        newColumn('UpdateTimestamp','timestamp'),
        newColumn('LastModifiedTimestamp','timestamp')
      ];
      state.tables=[t];
    `);
    assert.strictEqual(app.eval(`detectedIncrementalColumn(state.tables[0]).name`), 'LastModifiedTimestamp');
  });

  test('incremental auto-detection still requires timestamp/datetime type even when name matches', () => {
    app.eval(`
      const t=newTable('type_gate');
      t.columns=[
        newColumn('ModifiedBy','varchar(100)'),
        newColumn('UpdateCount','integer'),
        newColumn('CustomerModifiedDate','date'),
        newColumn('CreatedAt','timestamp')
      ];
      state.tables=[t];
    `);
    assert.strictEqual(app.eval(`detectedIncrementalColumn(state.tables[0])`), null);
  });

  test('universal incremental days value is written to source_systems and deploy-pending clears with workbook deployment', () => {
    assert.strictEqual(app.eval(`incrementalDaysToLoadDefault()`), 30);
    assert.strictEqual(app.eval(`configureIncrementalDaysToLoad(14)`), true);
    assert.strictEqual(app.eval(`state.vault.incrementalSettingsDeploymentPending`), true);
    assert.strictEqual(app.eval(`buildWorkbookRows().source_systems[0][5]`), 14);
    assert.match(app.eval(`buildPdiMetaSql()`), /, 14, 0\);/);
    app.eval(`markIncrementalWorkbookDeployed()`);
    assert.strictEqual(app.eval(`state.vault.incrementalSettingsDeploymentPending`), false);
  });

  test('staging history is informational and does not gate activation', async () => {
    app.eval(`
      const t = state.tables.find(x=>x.name==='customers');
      configureIncrementalColumn(t, 'updated_at');
      dashboardConn.database = 'datavault_sales';
      dashQuery = async function(){ return [{
        id_run:77, date_start:'2026-08-21T01:00:00Z',
        date_end:'2026-08-21T01:05:00Z', source_table_name:'customers'
      }]; };
    `);
    const changed = await app.evalRaw(`refreshIncrementalReadiness({ silent:true, rerender:false })`);
    assert.strictEqual(changed, 1);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReady`), true);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReadyRunId`), 77);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incremental`), false);
    assert.strictEqual(app.eval(`incrementalStatusLabel(state.tables.find(t=>t.name==='customers'))`), 'Disabled · deploy required');
    const enabled = await app.evalRaw(`enableIncrementalTable(state.tables.find(t=>t.name==='customers'))`);
    assert.strictEqual(enabled, true);
    assert.strictEqual(app.eval(`buildWorkbookRows().source_tables.find(r=>r[1]==='customers')[6]`), 1);
  });

  test('existing successful staging history qualifies a first-time incremental configuration regardless of configured-at timestamp', async () => {
    app.eval(`
      const t = state.tables.find(x=>x.name==='customers');
      configureIncrementalColumn(t, 'updated_at');
      markIncrementalWorkbookDeployed();
      // Deliberately later than the recorded database run. The old timestamp
      // comparison incorrectly rejected this common existing-vault/timezone case.
      t.incrementalConfiguredAt = '2026-08-25T00:00:00Z';
      dashboardConn.database = 'datavault_sales';
      dashQuery = async function(){ return [{
        id_run:78, run_type:'Test Staging', date_start:'2026-08-21 01:00:00',
        date_end:'2026-08-21 01:05:00', source_table_name:'customers',
        target_table_name:'stg__customers_vw', has_dv_jobs:false, has_stg_jobs:true
      }]; };
    `);
    const changed = await app.evalRaw(`refreshIncrementalReadiness({ silent:true, rerender:false })`);
    assert.strictEqual(changed, 1);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReady`), true);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReadyRunId`), 78);
  });

  test('staging target name can prove a table loaded when source name is blank', async () => {
    app.eval(`
      const t = state.tables.find(x=>x.name==='customers');
      configureIncrementalColumn(t, 'updated_at');
      markIncrementalWorkbookDeployed();
      dashboardConn.database = 'datavault_sales';
      dashQuery = async function(){ return [{
        id_run:80, run_type:'Test Staging', date_start:'2026-08-21T01:00:00Z',
        date_end:'2026-08-21T01:05:00Z', source_table_name:null,
        target_table_name:'staging.'+stagingViewName('customers'), has_dv_jobs:false, has_stg_jobs:true
      }]; };
    `);
    const changed = await app.evalRaw(`refreshIncrementalReadiness({ silent:true, rerender:false })`);
    assert.strictEqual(changed, 1);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReadyRunId`), 80);
    assert.strictEqual(app.eval(`dashboardStagingJobMatchesTable({source_table_name:null,target_table_name:'staging.'+stagingViewName('customers')}, state.tables.find(t=>t.name==='customers'))`), true);
  });

  test('legacy metadata fallback treats a successful Test Staging run as initial-load evidence', async () => {
    app.eval(`
      const t = state.tables.find(x=>x.name==='customers');
      configureIncrementalColumn(t, 'updated_at');
      markIncrementalWorkbookDeployed();
      dashboardConn.database = 'datavault_sales';
      let calls=0;
      dashQuery = async function(){
        calls++;
        if (calls===1) throw new Error('legacy metadata schema');
        return [{ id_run:81, run_type:'Test Staging', date_start:'2026-08-21T01:00:00Z', date_end:'2026-08-21T01:05:00Z', has_stg_jobs:true, has_dv_jobs:false }];
      };
    `);
    const changed = await app.evalRaw(`refreshIncrementalReadiness({ silent:true, rerender:false })`);
    assert.strictEqual(changed, 1);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReadyRunId`), 81);
  });

  test('schema-qualified staging history matches the detected source table name', async () => {
    app.eval(`
      const t = state.tables.find(x=>x.name==='customers');
      configureIncrementalColumn(t, 'updated_at');
      markIncrementalWorkbookDeployed();
      t.incrementalConfiguredAt = '2026-08-20T00:00:00Z';
      dashboardConn.database = 'datavault_sales';
      dashQuery = async function(){ return [{
        id_run:79, run_type:'Staging Load', date_start:'2026-08-21T01:00:00Z',
        date_end:'2026-08-21T01:05:00Z', source_table_name:'[Sales].[customers]', has_dv_jobs:false, has_stg_jobs:true
      }]; };
    `);
    const changed = await app.evalRaw(`refreshIncrementalReadiness({ silent:true, rerender:false })`);
    assert.strictEqual(changed, 1);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReadyRunId`), 79);
    assert.strictEqual(app.eval(`dashboardSourceTableMatches('public.customers','customers')`), true);
    assert.strictEqual(app.eval(`dashboardSourceTableMatches('"public"."customers"','customers')`), true);
  });

  test('changing the incremental column preserves the user toggle and previous staging history', () => {
    app.eval(`
      const t = state.tables.find(x=>x.name==='customers');
      t.columns.push(newColumn('modified_at','timestamp'));
      configureIncrementalColumn(t, 'updated_at');
      markIncrementalWorkbookDeployed();
      markIncrementalReady(t, { id_run:12, date_end:'2026-08-21T01:00:00Z' });
      t.incremental = true;
      configureIncrementalColumn(t, 'modified_at');
    `);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementCol`), 'modified_at');
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReady`), true);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReadyRunId`), 12);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incremental`), true);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalDeploymentPending`), true);
    assert.strictEqual(app.eval(`buildWorkbookRows().source_tables.find(r=>r[1]==='customers')[6]`), 1);
  });

  test('previous staging history remains informational after the incremental column changes', async () => {
    app.eval(`
      const t = state.tables.find(x=>x.name==='customers');
      t.columns.push(newColumn('modified_at','timestamp'));
      configureIncrementalColumn(t, 'updated_at');
      markIncrementalReady(t, { id_run:90, date_end:'2026-08-21T01:00:00Z' });
      configureIncrementalColumn(t, 'modified_at');
      dashboardConn.database = 'datavault_sales';
      dashQuery = async function(){ return [{
        id_run:90, source_table_name:'customers', target_table_name:'stg__customers_vw', has_stg_jobs:true
      }]; };
    `);
    assert.strictEqual(await app.evalRaw(`refreshIncrementalReadiness({ silent:true, rerender:false })`), 0);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='customers').incrementalReadyRunId`), 90);
  });



  test('Hub reflects the incremental column already configured on Tables and starts collapsed', () => {
    const html = app.eval(`
      const t=state.tables.find(x=>x.name==='customers');
      configureIncrementalColumn(t,'updated_at');
      markIncrementalWorkbookDeployed();
      markIncrementalReady(t,{id_run:88,date_end:'2026-08-21T01:00:00Z'});
      dashboardIncrementalOpen=false;
      dashboardIncrementalHtml();
    `);
    assert.match(html, /<details class="panel" id="incremental-loads-panel" >/);
    assert.match(html, /data-dashboard-increment-col=/);
    assert.match(html, /updated_at/);
    assert.match(html, /data-inc-toggle=/);
    assert.doesNotMatch(html, /data-inc-enable=/);
    assert.match(html, /id="btn-enable-all-incremental"/);
    assert.match(html, /id="f-incremental-days-to-load"/);
    assert.match(html, /staging_days_to_load_default/);
  });

  test('explicit Hub enable action activates a configured table without requiring staging history', async () => {
    app.eval(`
      const t=state.tables.find(x=>x.name==='customers');
      configureIncrementalColumn(t,'updated_at');
    `);
    const enabled = await app.evalRaw(`enableIncrementalTable(state.tables.find(x=>x.name==='customers'), {silent:true})`);
    assert.strictEqual(enabled, true);
    assert.strictEqual(app.eval(`state.tables.find(x=>x.name==='customers').incremental`), true);
    assert.strictEqual(app.eval(`state.tables.find(x=>x.name==='customers').incrementalDeploymentPending`), true);
    assert.strictEqual(app.eval(`buildWorkbookRows().source_tables.find(r=>r[1]==='customers')[6]`), 1);
  });

  test('Enable all activates every configured table regardless of staging history', () => {
    app.eval(`
      var _bulkCustomers=state.tables.find(x=>x.name==='customers');
      var _bulkOrders=state.tables.find(x=>x.name==='orders');
      var _bulkOrderTags=state.tables.find(x=>x.name==='order_tags');
      if (!_bulkOrders.columns.some(c=>c.name==='modified_at')) _bulkOrders.columns.push(newColumn('modified_at','timestamp'));
      configureIncrementalColumn(_bulkCustomers,'updated_at');
      configureIncrementalColumn(_bulkOrders,'modified_at');
      configureIncrementalColumn(_bulkOrderTags,'created_at');
      var _enabledAllCount=enableAllConfiguredIncrementalTables();
    `);
    assert.strictEqual(app.eval(`_enabledAllCount`), 3);
    assert.strictEqual(app.eval(`state.tables.find(x=>x.name==='customers').incremental`), true);
    assert.strictEqual(app.eval(`state.tables.find(x=>x.name==='orders').incremental`), true);
    assert.strictEqual(app.eval(`state.tables.find(x=>x.name==='order_tags').incremental`), true);
  });


  test('mapping workbook deployment, not Hop config deployment, establishes the incremental deployment boundary', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname,'..','public','js','features','deployment-actions.js'),'utf8');
    const mapping = src.slice(src.indexOf('async function deployMappingWorkbook'));
    const hopStart = src.indexOf('async function deployHopConfig');
    const hopEnd = src.indexOf('async function deployHopSourceConnection', hopStart);
    const hop = src.slice(hopStart, hopEnd);
    assert.match(mapping, /markIncrementalWorkbookDeployed\(\)/);
    assert.doesNotMatch(hop, /markIncrementalWorkbookDeployed\(\)/);
  });
});

describe('Incremental GUI compatibility across native and JDBC sources', () => {
  beforeEach(() => { resetApp(); });

  test('PostgreSQL, MySQL and JDBC semantic timestamp types are recommended consistently', () => {
    app.eval(`
      const pg=newTable('pg_events');
      pg.columns=[newColumn('changed_at','timestamptz')];
      const my=newTable('my_events');
      my.columns=[newColumn('changed_at','datetime(6)')];
      const jdbc=newTable('jdbc_events');
      jdbc.columns=[Object.assign(newColumn('changed_at','timestamptz'),{nativeType:'DATETIMEOFFSET',jdbcType:'2014',semanticType:'TIMESTAMP_TZ'})];
      state.tables=[pg,my,jdbc];
    `);
    assert.deepStrictEqual(app.eval(`state.tables.map(t=>incrementalColumnCandidates(t).map(c=>c.name))`), [['changed_at'],['changed_at'],['changed_at']]);
  });

  test('JDBC options expose timestamp/datetime columns only and reject an unfamiliar non-temporal cursor', () => {
    app.eval(`
      state.vault.srcDescription='JDBC source';
      const t=newTable('events');
      t.columns=[
        newColumn('event_id','bigint'),
        Object.assign(newColumn('ModifiedDate','timestamp'),{nativeType:'datetime2',jdbcType:'TIMESTAMP',semanticType:'TIMESTAMP'}),
        Object.assign(newColumn('change_token','text'),{nativeType:'VENDOR_CHANGE_TOKEN',jdbcType:'1111',semanticType:'UNKNOWN'}),
        newColumn('business_date','date')
      ];
      state.tables=[t];
      var _badJdbcCursor=configureIncrementalColumn(t,'change_token');
      configureIncrementalColumn(t,'ModifiedDate');
    `);
    assert.strictEqual(app.eval(`_badJdbcCursor`), false);
    assert.deepStrictEqual(app.eval(`incrementalColumnCandidates(state.tables[0]).map(c=>c.name)`), ['ModifiedDate']);
    assert.deepStrictEqual(app.eval(`incrementalColumnOptions(state.tables[0]).map(c=>c.name)`), ['ModifiedDate']);
    assert.strictEqual(app.eval(`incrementalConfigured(state.tables[0])`), true);

    let row=app.eval(`buildWorkbookRows().source_tables[0]`);
    assert.strictEqual(row[6], 0, 'initial execution must remain full-load');
    assert.strictEqual(row[7], 'ModifiedDate', 'supported JDBC timestamp/datetime column must be carried into the workbook');

    app.eval(`
      const _jdbcReadyTable=state.tables[0];
      markIncrementalWorkbookDeployed();
      markIncrementalReady(_jdbcReadyTable,{id_run:91,date_end:'2026-08-25T10:00:00Z'});
      _jdbcReadyTable.incremental=true;
    `);
    row=app.eval(`buildWorkbookRows().source_tables[0]`);
    assert.strictEqual(row[6], 1);
    assert.strictEqual(row[7], 'ModifiedDate');
  });

  test('Delete all clears the source tables, detected relationship metadata and downstream Vault objects', () => {
    app.eval(`
      startNewProject(true);
      const t=newTable('customers');
      t.columns=[Object.assign(newColumn('id','integer'),{pk:true,nullable:false}),newColumn('ModifiedDate','timestamp')];
      state.tables=[t];
      state.sourceMeta.foreignKeys=[{table:'customers',column:'id',refTable:'x',refColumn:'id'}];
      state.sourceMeta.approxRows={customers:10};
      state.hubs=[{id:'hub_1',entity:'customer',tableId:t.id,pkColId:t.columns[0].id,pkColIds:[t.columns[0].id]}];
      var _deleteAllResult=deleteAllSourceTables();
    `);
    assert.strictEqual(app.eval(`_deleteAllResult.count`), 1);
    assert.strictEqual(app.eval(`state.tables.length`), 0);
    assert.strictEqual(app.eval(`state.hubs.length`), 0);
    assert.strictEqual(app.eval(`state.sourceMeta.foreignKeys.length`), 0);
    assert.deepStrictEqual(app.eval(`state.sourceMeta.approxRows`), {});
    assert.match(readFrontendSources(), /id="btn-delete-all-tables"/);
  });

  test('an unstaged legacy incremental column is not emitted until the GUI selection is repaired', () => {
    app.eval(`
      state.vault.srcDescription='Pack source';
      const t=newTable('events');
      t.columns=[newColumn('event_id','bigint'),newColumn('changed_at','timestamp')];
      t.columns[1].staged=false;
      t.incrementCol='changed_at';
      t.incrementalReady=true;
      t.incremental=true;
      state.tables=[t];
    `);
    const row=app.eval(`buildWorkbookRows().source_tables[0]`);
    assert.strictEqual(app.eval(`incrementalConfigured(state.tables[0])`), false);
    assert.strictEqual(row[6], 0);
    assert.strictEqual(row[7], '');
  });
});

describe('Data Vault Hub run detail counters', () => {
  beforeEach(resetApp);

  test('renders Data Vault job rows using the loaded counter', () => {
    const detail = app.eval(`
      dashboardDetailStatus = 'ok';
      dashboardStgJobs = [];
      dashboardDvJobs = [{ data_vault_object:'hub_sak_customer', num_records_loaded:123, num_records_processed:0, num_errors:0, duration_in_seconds:2 }];
      const el = document.createElement('div');
      renderDashboardDetail(el);
      el.innerHTML;
    `);
    assert.match(detail, /<th>Loaded<\/th>/);
    assert.match(detail, />123<\/td>/);
    assert.doesNotMatch(detail, /<th>Processed<\/th>/);
  });

  test('queries and verifies Data Vault jobs with num_records_loaded', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    const selectRun = html.slice(html.indexOf('async function selectDashboardRun'), html.indexOf('function renderDashboardDetail'));
    const verify = html.slice(html.indexOf('async function verifyLatestLoad'), html.indexOf('function renderHealthBanner'));
    assert.match(selectRun, /SELECT data_vault_object, num_records_loaded, num_errors, duration_in_seconds/);
    assert.doesNotMatch(selectRun, /num_records_processed/);
    assert.match(verify, /COALESCE\(num_records_loaded,0\) = 0/);
    assert.doesNotMatch(verify, /COALESCE\(num_records_processed,0\) = 0/);
  });
});

describe('Export to Hub handoff', () => {
  test('keeps engine execution in the Hub and removes it from Export', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    const exportSection = html.slice(html.indexOf('function renderExport'), html.indexOf('function explainTargetSqlError'));
    assert.match(exportSection, /id="btn-open-data-vault-hub"/);
    assert.match(exportSection, /Continue in Data Vault Hub/);
    assert.doesNotMatch(exportSection, /id="btn-docker-runhop"/);
    assert.doesNotMatch(exportSection, /id="btn-engine-logs"/);

    const runButtonCount = (html.match(/id="btn-docker-runhop"/g) || []).length;
    assert.strictEqual(runButtonCount, 1, 'the engine start control should exist only in Data Vault Hub');
  });
});

describe('Data Vault Hub verification persistence', () => {
  beforeEach(resetApp);

  test('completed verification survives a dashboard rerender', () => {
    app.eval(`
      dashboardVerification = {
        status:'complete',
        headline:'Run #42 · Success',
        runSucceeded:true,
        findings:[{ kind:'warn', text:'1 staging job loaded ZERO rows.' }],
        error:'',
      };
    `);
    const before = app.eval(`dashboardVerificationHtml()`);
    app.eval(`renderDashboard(document.createElement('div'))`);
    const after = app.eval(`dashboardVerificationHtml()`);
    assert.match(before, /Run #42 · Success/);
    assert.match(before, /1 staging job loaded ZERO rows/);
    assert.strictEqual(after, before);
  });

  test('in-progress verification survives a dashboard rerender', () => {
    app.eval(`
      dashboardVerification = {
        status:'loading', headline:'', runSucceeded:false, findings:[], error:'',
      };
    `);
    app.eval(`renderDashboard(document.createElement('div'))`);
    assert.match(app.eval(`dashboardVerificationHtml()`), /Verifying the latest load/);
  });
});

describe('Studio Review workflow', () => {
  beforeEach(() => { resetApp(); app.eval(`startNewProject(true)`); });

  test('new projects are locked to the packaged source and target demos', () => {
    const v = app.eval(`state.vault`);
    assert.strictEqual(v.sourcePreset, 'demo');
    assert.strictEqual(v.targetPreset, 'internal');
    assert.strictEqual(v.dialect, 'mysql');
    assert.strictEqual(v.srcDatabase, 'sakila');
    assert.strictEqual(v.dvPort, '5433');
  });

  test('load group is fixed to 2000 for new and migrated tables', () => {
    app.eval(`
      const t = newTable('legacy_table');
      t.loadGroup = 42;
      state.tables.push(t);
      applyFeatureGates();
    `);
    assert.strictEqual(app.eval(`state.tables[0].loadGroup`), 2000);
    assert.strictEqual(app.eval(`newTable('fresh_table').loadGroup`), 2000);
  });

  test('staging confirmation is invalidated by a staging edit', () => {
    app.eval(`
      const t = newTable('customer');
      t.columns = [Object.assign(newColumn('customer_id','integer'), {pk:true,nullable:false})];
      state.tables.push(t);
      ensureKeyDerivation(t, 'customer', ['customer_id'], 'both');
    `);
    assert.strictEqual(app.eval(`stagingChangesConfirmed()`), false);
    assert.strictEqual(app.eval(`confirmStagingChanges()`), true);
    assert.strictEqual(app.eval(`stagingChangesConfirmed()`), true);
    app.eval(`state.tables[0].columns[0].staged = false`);
    assert.strictEqual(app.eval(`stagingChangesConfirmed()`), false);
  });

  test('staging cannot be confirmed until every included table emits a hash column', () => {
    app.eval(`
      const customer = newTable('customer');
      customer.columns = [Object.assign(newColumn('customer_id','integer'), {pk:true,nullable:false})];
      const address = newTable('address');
      address.columns = [Object.assign(newColumn('address_id','integer'), {pk:true,nullable:false})];
      state.tables.push(customer, address);
      ensureKeyDerivation(customer, 'customer', ['customer_id'], 'both');
      ensureKeyDerivation(address, 'address', ['address_id'], 'bk');
    `);
    assert.deepStrictEqual(app.eval(`stagingTablesMissingHashColumns().map(t=>t.name)`), ['address']);
    assert.strictEqual(app.eval(`stagingHashColumnsReady()`), false);
    assert.strictEqual(app.eval(`confirmStagingChanges()`), false);
    assert.match(app.eval(`stagingHashRequirementMessage()`), /address/);
    assert.match(app.eval(`stagingHashRequirementMessage()`), /Detect Hash Keys or AI Assist/);

    app.eval(`ensureKeyDerivation(state.tables[1], 'address', ['address_id'], 'hash')`);
    assert.strictEqual(app.eval(`stagingHashColumnsReady()`), true);
    assert.strictEqual(app.eval(`confirmStagingChanges()`), true);
  });

  test('detection actions lead each toolbar and use primary styling', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    assert.match(html, /class="btn primary" id="btn-introspect"[^>]*>Detect Source Tables</);
    assert.match(html, /class="btn primary" id="btn-suggest-keys-staging">Detect Hash Keys</);
    assert.match(html, /class="btn primary" id="btn-suggest-keys">Detect Vault Tables</);
    assert.match(html, /id="btn-coverage-staging">Integrity Check</);
    assert.match(html, /id="btn-coverage-vault">Integrity Check</);
    assert.match(html, /class="quick-tip"/);
    assert.match(html, /Schema only, no row data\. PK and NOT NULL columns are checked using aggregate blank\/null counts\./);
    assert.match(html, />Null<\/th>/);
    assert.doesNotMatch(html, />Source nullable<\/th>/);
  });
});


describe('link hash-key validation follows the real derivation (film/store regression)', () => {
  beforeEach(() => {
    resetApp();
    app.eval(`
      startNewProject(true);
      state.vault.name = 'sak'; state.vault.prefix = 'sak'; state.vault.tenantId = 'SAK';
      state.vault.srcCod = 'SAK'; state.vault.srcDescription = 'sakila';
      state.vault.sourceSchema = 'sakila'; state.vault.dialect = 'mysql';
      const language = newTable('language');
      language.columns = [Object.assign(newColumn('language_id','integer'),{pk:true,nullable:false}), newColumn('name','varchar(20)')];
      state.tables.push(language);
      const film = newTable('film');
      film.columns = [
        Object.assign(newColumn('film_id','integer'),{pk:true,nullable:false}),
        newColumn('title','varchar(255)'),
        newColumn('language_id','integer'),
        newColumn('original_language_id','integer'),
      ];
      state.tables.push(film);
      state.sourceMeta.foreignKeys = [
        { table:'film', column:'language_id',          refTable:'language', refColumn:'language_id' },
        { table:'film', column:'original_language_id', refTable:'language', refColumn:'language_id' },
      ];
      // AI Assist ran FIRST and filed the hash under its own entity name —
      // exactly the state that produced the field report
      ensureDerivation(film, 'original_language', 'original_language_id', 'hash');
      suggestModelFromKeys();
    `);
  });

  test('no "missing a hash key" errors when the column is hashed under another entity', () => {
    const errors = app.eval(`validateModel().errors`);
    assert.ok(!errors.some(e => /missing a hash key/.test(e)), JSON.stringify(errors, null, 2));
  });

  test.skip('link wiring, staging DDL and override all agree on the emitted name', () => {
    const film = `state.tables.find(t=>t.name==='film')`;
    const link = app.eval(`state.links.find(l => l.hubs.some(h => { const c = findCol(${film}, h.colId); return c && c.name==='original_language_id'; })) || null`);
    assert.ok(link, 'link over original_language_id exists');
    const wired = app.eval(`(function(){
      const t = ${film};
      const l = state.links.find(l => l.hubs.some(h => { const c = findCol(t, h.colId); return c && c.name==='original_language_id'; }));
      const h = l.hubs.find(h => { const c = findCol(t, h.colId); return c && c.name==='original_language_id'; });
      return hashColumnNameForLinkHub(t, h);
    })()`);
    const ddlCols = app.eval(`buildStagingColumns(${film}).map(c=>c.name)`);
    assert.ok(ddlCols.includes(wired), `link references "${wired}" but staging has ${JSON.stringify(ddlCols)}`);
    assert.match(app.eval(`buildOverride(${film})`), new RegExp(`as ${wired}\\b`));
    // and no duplicate columns anywhere
    assert.strictEqual(new Set(ddlCols).size, ddlCols.length);
  });

  test('repeated references to the same hub become separate role-named links', () => {
    const result = app.eval(`(function(){
      const links = state.links.filter(l => l.tableId===state.tables.find(t=>t.name==='film').id);
      return {
        entities:links.map(l=>l.entity).sort(),
        columns:links.map(l=>linkColumns(l).map(c=>c.name)),
        workbookNames:buildWorkbookRows().links.map(r=>r[0]),
        ddl:buildDataVaultDdl(),
        errors:validateModel().errors,
      };
    })()`);
    assert.deepStrictEqual(result.entities, ['film_language', 'film_original_language']);
    result.columns.forEach(cols=>assert.strictEqual(new Set(cols).size, cols.length, JSON.stringify(cols)));
    assert.match(result.ddl, /link_sak_film_language\b/);
    assert.match(result.ddl, /link_sak_film_original_language\b/);
    assert.ok(result.workbookNames.includes('link_sak_film_language'));
    assert.ok(result.workbookNames.includes('link_sak_film_original_language'));
    assert.ok(!result.errors.some(e=>/duplicate physical column/.test(e)), JSON.stringify(result.errors));
  });
});

describe('AI request compatibility', () => {
  beforeEach(resetApp);

  test('known GPT-5 models omit temperature on the first request', async () => {
    const calls = [];
    app.context.fetch = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return {
        ok:true,
        status:200,
        json:async()=>({ choices:[{ message:{ content:'{"ok":true}' } }] }),
      };
    };
    app.eval(`aiProvider='openai'; aiKey='test-key'; aiModel='gpt-5.6-sol';`);
    const parsed = await app.evalRaw(`aiChat('return json', 'hello', 0.2)`);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(calls[0], 'temperature'));
    assert.strictEqual(calls[0].reasoning_effort, 'medium');
  });

  test('GPT-5 uses one product-controlled reasoning level without a user setting', async () => {
    const calls = [];
    app.context.fetch = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok:true, status:200, json:async()=>({ choices:[{ message:{ content:'{\"ok\":true}' } }] }) };
    };
    app.eval(`aiProvider='openai'; aiKey='test-key'; aiModel='gpt-5.6-sol';`);
    await app.evalRaw(`aiChat('return json', 'hello', 0.2)`);
    await app.evalRaw(`aiChat('return json', 'hello again', 0.2)`);
    assert.strictEqual(calls[0].reasoning_effort, 'medium');
    assert.strictEqual(calls[1].reasoning_effort, 'medium');
    assert.ok(!('temperature' in calls[0]));
    assert.ok(!('temperature' in calls[1]));
    const html = app.eval(`aiSettingsHtml('test')`);
    assert.ok(!/Response speed|Balanced|More thorough|ai-speed/.test(html), html);
  });

  test('an unknown compatible model is retried once then remembered', async () => {
    const calls = [];
    app.context.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (Object.prototype.hasOwnProperty.call(body, 'temperature')){
        return {
          ok:false,
          status:400,
          text:async()=>JSON.stringify({ error:{
            message:"Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
            param:'temperature', code:'unsupported_value',
          }}),
        };
      }
      return {
        ok:true,
        status:200,
        json:async()=>({ choices:[{ message:{ content:'{"ok":true}' } }] }),
      };
    };
    app.eval(`aiProvider='custom'; aiKey=''; aiBaseUrl='http://localhost:11434/v1'; aiModel='reasoner-custom';`);
    const first = await app.evalRaw(`aiChat('return json', 'hello', 0.2)`);
    const second = await app.evalRaw(`aiChat('return json', 'hello again', 0.2)`);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls[0].temperature, 0.2);
    assert.ok(!Object.prototype.hasOwnProperty.call(calls[1], 'temperature'));
    assert.ok(!Object.prototype.hasOwnProperty.call(calls[2], 'temperature'));
  });
});

describe('schema ownership handover (permission denied for schema fix)', () => {
  beforeEach(() => { resetApp(); seedFixture(); app.eval(`suggestModelFromKeys()`); });

  test('staging & vault DDL hand the schema to the framework role before SET ROLE', () => {
    for (const [ddl, schema, role] of [
      [app.eval(`buildStagingDdl()`), 'staging', 'staging'],
      [app.eval(`buildDataVaultDdl()`), 'data_vault', 'data_vault'],
    ]){
      const create = ddl.indexOf(`CREATE SCHEMA IF NOT EXISTS ${schema};`);
      const fix = ddl.indexOf(`ALTER SCHEMA ${schema} OWNER TO ${role}`);
      const setRole = ddl.indexOf(`SET ROLE ${role};`);
      assert.ok(create >= 0 && fix > create && setRole > fix,
        `${schema}: expected CREATE SCHEMA -> ownership fix -> SET ROLE ordering`);
      assert.match(ddl, /rolname = current_user/, 'must only alter when the connecting user owns it');
    }
  });

  test('incremental DDL carries the same guard per schema', () => {
    const sql = app.eval(`buildIncrementalSql({
      missingTables: parseGeneratedDdlObjects(buildStagingDdl()).slice(0,1),
      missingColumns: [], typeMismatches: [] })`);
    assert.match(sql, /ALTER SCHEMA staging OWNER TO staging/);
    assert.ok(sql.indexOf('OWNER TO staging') < sql.indexOf('SET ROLE staging;'));
  });

  test('explainTargetSqlError maps permission errors to actions', () => {
    assert.match(app.eval(`explainTargetSqlError('permission denied for schema staging')`),
      /ALTER SCHEMA staging OWNER TO staging/);
    assert.match(app.eval(`explainTargetSqlError('must be owner of schema data_vault')`),
      /ALTER SCHEMA data_vault OWNER TO data_vault/);
    assert.match(app.eval(`explainTargetSqlError('role "staging" does not exist')`),
      /Set up metadata/i);
    assert.strictEqual(app.eval(`explainTargetSqlError('syntax error at or near')`),
      'syntax error at or near', 'unrelated errors pass through untouched');
  });
});

describe('execute-sql timeout hints', () => {


test('explainTargetSqlError: lock/statement timeouts get actionable hints', () => {
    resetApp();
    assert.match(app.eval(`explainTargetSqlError('canceling statement due to lock timeout')`),
      /pg_blocking_pids/);
    assert.match(app.eval(`explainTargetSqlError('canceling statement due to statement timeout')`),
      /120s/);
  });
});


describe('target setup error translation', () => {
  beforeEach(() => resetApp());
  test('target-login and container-networking failures get actionable hints', () => {
    assert.match(app.eval(`explainBootstrapError({ error: 'FATAL: password authentication failed for user "postgres"' })`),
      /Target username and password/);
    assert.match(app.eval(`explainBootstrapError({ error: 'connection to server at "postgres" (172.23.0.3), port 5432 failed' })`),
      /saved again/i);
    assert.match(app.eval(`explainBootstrapError({ error: 'could not translate host name "localhost"' })`),
      /host\.docker\.internal/);
    assert.strictEqual(app.eval(`explainBootstrapError({ error: 'disk full' })`), 'disk full');
  });
});


describe('board recovers after an individual deploy', () => {
  test('a lingering busy row does not block the re-probe (grey-out regression)', () => {
    resetApp();
    app.eval(`
      state.vault.dvHost = ''; // probe will stop at the connection check — synchronously
      deployProbing = false; deployApplying = false;
      deployStatus = { rows: [{ key:'staging', label:'Staging tables', state:'busy' }], error: null };
      probeDeploymentStatus();
    `);
    // with the fix, the probe RAN (and hit the no-connection guard) instead
    // of silently returning because a row was still marked busy
    assert.match(app.eval(`deployStatus.error || ''`), /target connection/i);
  });
});


describe('cross-role grants (external engine permission fix)', () => {
  beforeEach(() => { resetApp(); seedFixture(); app.eval(`suggestModelFromKeys()`); });

  test('staging and vault DDL grant peer roles and register default privileges for the creating role', () => {
    const stg = app.eval(`buildStagingDdl()`);
    assert.match(stg, /GRANT ALL ON ALL TABLES IN SCHEMA staging TO pdi_meta, data_vault;/);
    assert.match(stg, /ALTER DEFAULT PRIVILEGES FOR ROLE staging IN SCHEMA staging GRANT ALL ON TABLES TO pdi_meta, data_vault;/);
    assert.ok(stg.indexOf('GRANT ALL ON ALL TABLES') < stg.indexOf('RESET ROLE;'), 'grants run as the owner role');
    const dv = app.eval(`buildDataVaultDdl()`);
    assert.match(dv, /GRANT ALL ON ALL TABLES IN SCHEMA data_vault TO pdi_meta, staging;/);
    assert.match(dv, /ALTER DEFAULT PRIVILEGES FOR ROLE data_vault IN SCHEMA data_vault GRANT ALL ON TABLES TO pdi_meta, staging;/);
  });

  test('incremental DDL carries the same grants for the schemas it touches', () => {
    const sql = app.eval(`buildIncrementalSql({
      missingTables: parseGeneratedDdlObjects(buildStagingDdl()).slice(0,1),
      missingColumns: [], typeMismatches: [] })`);
    assert.match(sql, /GRANT ALL ON ALL TABLES IN SCHEMA staging TO pdi_meta, data_vault;/);
  });
});


describe('metadata setup chains the vault registration (no second click)', () => {
  test('internal and external setup use their own bootstrap branch before pdi_meta registration', () => {
    const fn = app.eval(`probeDeploymentStatus.toString()`);
    assert.match(fn, /pdiRow\.applyLabel = 'Set up metadata'/);
    assert.match(fn, /body:JSON\.stringify\(\{ mode:'internal', database:v\.dvDatabase, fdw:state\.externalTables\.enabled===true \}\)/);
    assert.match(fn, /metadata tables not found in this internal database/);
    assert.match(fn, /metadata tables not found on the external target/);

    const internalStart = fn.indexOf('if (internalTarget)');
    const externalStart = fn.indexOf('} else {', internalStart);
    const internalBranch = fn.slice(internalStart, externalStart);
    const externalCredentials = fn.indexOf('await deployRuntimeCredentials({ silent:true })', externalStart);
    const externalConfig = fn.indexOf('await deployHopConfig({ silent:true })', externalStart);
    const externalBootstrap = fn.indexOf("body:'{}'", externalStart);
    const registerCall = fn.indexOf("executeSqlAgainstTarget(getExportSql('pdimeta'))", externalBootstrap);
    assert.doesNotMatch(internalBranch, /deployRuntimeCredentials|deployHopConfig/,
      'internal setup must not deploy external bootstrap credentials or config');
    assert.ok(internalStart >= 0 && externalStart > internalStart);
    assert.ok(externalCredentials > externalStart && externalConfig > externalCredentials && externalBootstrap > externalConfig,
      'external setup must keep credentials, config, then bootstrap ordering');
    assert.ok(registerCall > externalBootstrap,
      'vault registration must follow either successful bootstrap inside the same apply');
  });
});


describe('MySQL Connector/J type overrides', () => {
  beforeEach(() => { resetApp(); seedFixture(); });

  test('MySQL source connection preserves tinyint and year as numeric types; Postgres variant untouched', () => {
    app.eval(`state.vault.dialect = 'mysql'`);
    const my = JSON.parse(app.eval(`buildHopSourceConnectionJson()`));
    assert.strictEqual(my.rdbms.MYSQL.attributes['EXTRA_OPTION_MYSQL.tinyInt1isBit'], 'false',
      'TINYINT(1) must reach hop as an integer, not a boolean rendered Y/N');
    assert.strictEqual(my.rdbms.MYSQL.attributes['EXTRA_OPTION_MYSQL.yearIsDateType'], 'false',
      'YEAR must reach hop as a numeric year, not a date value');
    app.eval(`state.vault.dialect = 'postgresql'`);
    const pg = JSON.parse(app.eval(`buildHopSourceConnectionJson()`));
    assert.ok(!('EXTRA_OPTION_MYSQL.tinyInt1isBit' in pg.rdbms.POSTGRESQL.attributes));
    assert.ok(!('EXTRA_OPTION_MYSQL.yearIsDateType' in pg.rdbms.POSTGRESQL.attributes));
  });
});

describe('.env runtime credential deployment', () => {
  beforeEach(() => { resetApp(); app.eval(`startNewProject(true)`); });

  test('internal targets synchronise only SOURCE_PASSWORD', () => {
    app.eval(`
      state.vault.targetPreset = 'internal';
      state.vault.srcPassword = 'source-secret';
      state.vault.dvUser = 'data-vault-user'; state.vault.dvPassword = 'target-secret';
    `);
    assert.deepStrictEqual(app.eval(`runtimeCredentialPayload()`), {
      sourcePassword: 'source-secret',
      targetPassword: '',
      targetUser: '',
      externalPostgres: false,
    });
    assert.strictEqual(app.eval(`runtimeCredentialValidationMessage()`), '');
  });

  test('native PostgreSQL synchronises source, bootstrap and runtime role passwords', () => {
    app.eval(`
      state.vault.targetPreset = '';
      state.vault.srcPassword = 'source-secret';
      state.vault.dvUser = 'postgres-admin'; state.vault.dvPassword = 'target-secret';
    `);
    assert.deepStrictEqual(app.eval(`runtimeCredentialPayload()`), {
      sourcePassword: 'source-secret',
      targetPassword: 'target-secret',
      targetUser: 'postgres-admin',
      externalPostgres: true,
    });
    assert.strictEqual(app.eval(`runtimeCredentialValidationMessage()`), '');
  });

  test('reports missing source details and native PostgreSQL target details', () => {
    app.eval(`state.vault.srcPassword = ''; state.vault.targetPreset = 'internal';`);
    assert.match(app.eval(`runtimeCredentialValidationMessage()`), /source password/i);
    app.eval(`state.vault.srcPassword = 'source-secret'; state.vault.targetPreset = ''; state.vault.dvUser = ''; state.vault.dvPassword = 'target-secret';`);
    assert.match(app.eval(`runtimeCredentialValidationMessage()`), /external PostgreSQL username/i);
    app.eval(`state.vault.dvUser = 'postgres-admin'; state.vault.dvPassword = '';`);
    assert.match(app.eval(`runtimeCredentialValidationMessage()`), /external PostgreSQL password/i);
  });

  test('generated Hop config contains env references, never literal connection passwords', () => {
    app.eval(`state.vault.srcPassword = 'source-secret'; state.vault.dvPassword = 'target-secret'; state.vault.vaultPassword = 'legacy-secret';`);
    const json = app.eval(`buildHopEnvironmentJson()`);
    assert.match(json, /\$\{SOURCE_PASSWORD\}/);
    assert.match(json, /\$\{VAULT_PASSWORD\}/);
    assert.ok(!json.includes('source-secret'));
    assert.ok(!json.includes('target-secret'));
    assert.ok(!json.includes('legacy-secret'));
  });

  test('pdi_meta target connections use the single target password', () => {
    app.eval(`state.vault.dvPassword = 'target-secret'; state.vault.vaultPassword = 'legacy-secret';`);
    const sql = app.eval(`buildPdiMetaSql()`);
    assert.match(sql, /'staging', 'target-secret'/);
    assert.match(sql, /'data_vault', 'target-secret'/);
    assert.doesNotMatch(sql, /legacy-secret/);
  });

  test('the Connections UI asks for one native PostgreSQL target password', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    assert.match(html, /Runtime secrets \(\.env\)/);
    assert.match(html, /Apply All also synchronises/);
    assert.match(html, /id="f-dvpass"/);
    assert.doesNotMatch(html, /id="f-vaultpass"/);
    assert.match(html, /Target username/);
    assert.match(html, /Target password/);
    assert.doesNotMatch(html, /Data Vault service password/);
  });

  test('end-user deployment labels avoid duplicate credential concepts', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = readFrontendSources();
    assert.doesNotMatch(html, /Bootstrap\/admin username|Bootstrap\/admin password|Engine role password|Deploy engine config &amp; runtime credentials|Deployment credentials \(\.env\)|Columns in final staging projection|<th>Artifact<\/th>|current GUI snapshot/i);
    assert.match(html, /Target username/);
    assert.match(html, /Target password/);
    assert.match(html, /Runtime secrets \(\.env\)/);
    assert.match(html, /pdiRow\.applyLabel = 'Set up metadata'/);
  });

  test('Apply All writes env first and mapping last every time', () => {
    const fn=app.eval(`applyAllPending.toString()`);
    const envCall=fn.indexOf('await deployRuntimeCredentials({silent:true})');
    const pendingLoop=fn.indexOf('for (const row of pending)');
    const mappingCall=fn.indexOf('await deployMappingWorkbook({silent:true})');
    assert.ok(envCall>=0 && pendingLoop>envCall && mappingCall>pendingLoop);
    assert.match(fn, /!\['credentials','workbook'\]\.includes\(r\.key\)/);
  });

  test('external metadata bootstrap synchronises env before deploying config and running the container', () => {
    const fn=app.eval(`probeDeploymentStatus.toString()`);
    const envCall=fn.indexOf('await deployRuntimeCredentials({ silent:true })');
    const configCall=fn.indexOf('await deployHopConfig({ silent:true })');
    const bootstrapCall=fn.indexOf("body:'{}'", configCall);
    assert.ok(envCall>=0 && configCall>envCall && bootstrapCall>configCall);
  });

  test('starting the engine refreshes the runtime config before the container is launched', () => {
    const fn = app.eval(`dockerRunHop.toString()`);
    assert.match(fn, /Applying current design/);
    assert.match(fn, /await deployMappingWorkbook\(\{ silent:true \}\)/);
    assert.match(fn, /await deployHopSourceConnection\(\{ silent:true \}\)/);
    assert.match(fn, /await deployHopConfig\(\{ silent:true \}\)/);
    assert.doesNotMatch(fn, /runGuiDesignChecker|localDesignChecker/);
    assert.match(fn, /await executeSqlAgainstTarget\(buildIncrementalSql\(delta\)\)/);
  });
});


describe('derivation reconciliation without imported FK metadata', () => {
  beforeEach(() => {
    resetApp();
    app.eval(`
      startNewProject(true);
      const language=newTable('language');
      language.columns=[Object.assign(newColumn('language_id','integer'),{pk:true,nullable:false})];
      const film=newTable('film');
      film.columns=[
        Object.assign(newColumn('film_id','integer'),{pk:true,nullable:false}),
        newColumn('language_id','integer'),
        newColumn('original_language_id','integer')
      ];
      state.tables.push(language,film);
      state.sourceMeta.foreignKeys=[];
    `);
  });

  test('a role-like AI entity resolves to a known source Hub by suffix', () => {
    app.eval(`ensureDerivation(state.tables.find(t=>t.name==='film'),'original_language','original_language_id','hash')`);
    assert.deepStrictEqual(app.eval(`state.tables.find(t=>t.name==='film').derivations.map(d=>[d.entity,d.role,d.column,hashColumnNameForDerivation(state.tables.find(t=>t.name==='film'),d)])`),[
      ['language','original_language','original_language_id','hash_original_language_id']
    ]);
  });

  test('a later Vault relationship reuses the AI derivation instead of adding a second row', () => {
    app.eval(`
      var filmForVault=state.tables.find(t=>t.name==='film');
      var languageForVault=state.tables.find(t=>t.name==='language');
      ensureDerivation(filmForVault,'original_language','original_language_id','hash');
      state.hubs.push(
        {id:'hub_film',entity:'film',tableId:filmForVault.id,pkColId:filmForVault.columns[0].id,keyColIds:[filmForVault.columns[0].id]},
        {id:'hub_language',entity:'language',tableId:languageForVault.id,pkColId:languageForVault.columns[0].id,keyColIds:[languageForVault.columns[0].id]}
      );
      state.links.push({id:'link_role',entity:'film_original_language',tableId:filmForVault.id,hubs:[
        {hubId:'hub_film',colId:filmForVault.columns[0].id,colIds:[filmForVault.columns[0].id],role:'film'},
        {hubId:'hub_language',colId:filmForVault.columns[2].id,colIds:[filmForVault.columns[2].id],role:'original_language'}
      ]});
      ensureDerivation(filmForVault,'language','original_language_id','hash','original_language');
    `);
    const rows=app.eval(`state.tables.find(t=>t.name==='film').derivations.filter(d=>d.column==='original_language_id').map(d=>[d.entity,d.role,hashColumnNameForDerivation(state.tables.find(t=>t.name==='film'),d)])`);
    assert.deepStrictEqual(rows,[['language','original_language','hash_original_language_id']]);
    assert.deepStrictEqual(app.eval(`duplicateDerivationTargets(state.tables.find(t=>t.name==='film'))`),[]);
  });

  test('validation repairs legacy same-source/same-output duplicates but keeps genuine conflicts', () => {
    app.eval(`
      var filmForRepair=state.tables.find(t=>t.name==='film');
      filmForRepair.derivations=[
        {id:'old_role',entity:'original_language',role:'original_language',column:'original_language_id',kind:'hash'},
        {id:'hub_row',entity:'language',role:'original_language',column:'original_language_id',kind:'hash'}
      ];
    `);
    app.eval(`validateModel()`);
    assert.strictEqual(app.eval(`state.tables.find(t=>t.name==='film').derivations.length`),1);
  });
});

describe('manual staging derivation add flow', () => {
  beforeEach(() => {
    resetApp();
    app.eval(`
      startNewProject(true);
      const t=newTable('orders');
      t.columns=[newColumn('customer_id','integer'),newColumn('billing_customer_id','integer')];
      state.tables.push(t);
    `);
  });

  test('adds a new derivation and reports it as added', () => {
    const result=app.eval(`addManualKeyDerivation(state.tables[0],'customer_id','customer','customer','hash')`);
    assert.strictEqual(result.ok,true);
    assert.strictEqual(result.added,true);
    assert.strictEqual(app.eval(`state.tables[0].derivations.length`),1);
    assert.strictEqual(app.eval(`hashColumnNameForDerivation(state.tables[0],state.tables[0].derivations[0])`),'hash_customer_id');
  });

  test('reuses an existing derivation and does not silently append a duplicate', () => {
    app.eval(`addManualKeyDerivation(state.tables[0],'customer_id','customer','customer','hash')`);
    const result=app.eval(`addManualKeyDerivation(state.tables[0],'customer_id','customer','customer','hash')`);
    assert.strictEqual(result.ok,true);
    assert.strictEqual(result.added,false);
    assert.strictEqual(app.eval(`state.tables[0].derivations.length`),1);
  });

  test('rejects a non-staged or missing source column with an actionable reason', () => {
    const result=app.eval(`addManualKeyDerivation(state.tables[0],'missing_id','customer','customer','hash')`);
    assert.strictEqual(result.ok,false);
    assert.match(result.reason,/staged source column/i);
  });
});
