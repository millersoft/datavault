# Millersoft Data Vault Studio

Millersoft Data Vault Studio helps you turn PostgreSQL, MySQL, or a JDBC database supplied through a Database Pack into a Data Vault design.

You can use it to:

- connect to a source database and a PostgreSQL target;
- choose which tables and columns to include;
- prepare the staging layer;
- design Hubs, Links, Satellites, and Link Satellites;
- generate the staging and Data Vault SQL;
- create the metadata spreadsheet used by the loading engine;
- check the design before deployment;
- deploy the files, then move to the Data Vault Hub to start and monitor the data-loading engine.

The Studio can also be used without starting the engine. You can build and review a complete design, download the SQL and spreadsheet, and hand them over for deployment later.

---

## General Data Vault Studio Architecture

![Millersoft Data Vault Studio Architecture](../docs/img/data-vault-studio-architecture-github.png)


---

## Before you start

For the Studio itself, you need:

- Node.js 18 or newer;
- npm;
- a modern web browser.

For deployment and data loading, you also need:

- the main Millersoft Data Vault project;
- Docker or Podman with Compose support;
- network access to the source and target databases.

Studio GUI container operations run through the project-root `start.sh` or
`start.ps1` launcher and respect root `.env` configuration via
`CONTAINER_ENGINE=podman|docker` (an explicit host environment value still takes
precedence).

AI Assist is optional. **Detect Hash Keys** and **Detect Vault Tables** work without an API key.

Demo mode reads its locked container credentials from the project-root
`.env` file:

- `SOURCE_PASSWORD` — packaged MySQL/Sakila password;
- `DB_USER` — packaged PostgreSQL target username;
- `VAULT_PASSWORD` — packaged PostgreSQL target and service-role password.

Studio masks passwords. **Apply All** synchronises `SOURCE_PASSWORD` from the
source connection. When the selected deployment target is native PostgreSQL,
it also synchronises the existing `POSTGRES_BOOTSTRAP_USER`,
`POSTGRES_BOOTSTRAP_PASSWORD`, and `VAULT_PASSWORD` values from the target
connection. Internal `DB_*` settings remain administrator-controlled and are
never changed by Studio. Restart or recreate affected containers after changing
runtime credentials.

---

## Start the Studio

Open a terminal in the `data_vault_studio` folder and install dependencies:

```bash
npm install
```

Start the same Studio application in either runtime profile:

```bash
# Normal startup — production mode is the default
npm start

# Explicit production mode (equivalent to npm start)
npm start -- --mode=production

# Locked demonstration environment
npm start -- --mode=demo
```

Convenience aliases are also available:

```bash
npm run start:demo
npm run start:production
```

The runtime flag affects only Studio defaults, field locking, and the supported
connection choices. It does not change `start.sh`, Compose files, deployment
SQL, or model-generation logic.

Then open:

```text
http://127.0.0.1:8420/
```

---

## Development structure

The Studio deliberately uses plain HTML, CSS, classic browser scripts, and
CommonJS on the server. There is no frontend framework or build step.

- `public/index.html` is the small browser shell and records script order.
- `public/css/studio.css` owns application styling.
- `public/js/core`, `domain`, `generators`, `features`, `database-packs`, and
  `ui` separate shared state, modelling, generated outputs, screens, Pack
  support, and visual helpers.
- Source extraction, physical staging-table DDL, and PostgreSQL staging-view
  DDL have separate generator files. Keep that boundary when changing staging.
- `server.js` starts the listener only. `server/app.js` assembles middleware,
  configuration, database services, and feature routers.
- `server/routes` owns API families; `server/database` owns connection dispatch;
  `server/database-packs` owns Pack manifests/repository/JDBC behavior.
- `tests/helpers/load-app.js` executes the local scripts in their exact HTML
  order, so frontend tests do not depend on one monolithic source file.

When adding a browser feature, place its behavior in the narrowest existing
feature/domain/generator file and add its `<script>` after its dependencies in
`public/index.html`. When adding an endpoint, put it in the matching router and
pass shared dependencies from `server/app.js`; do not add business handlers to
the startup or assembly files.

Run the complete current-contract suite with:

```bash
npm test
```

The active Database Pack contract is v0.2.2: SQL Server is a Pack, source SQL
extracts source columns, physical staging tables remain source-shaped, and the
engine-facing `_vw` relation adds hashes, business keys, and tenant metadata.

---

# Recommended workflow

Work through the five numbered tabs from left to right:

1. **Connections** — configure the source and choose MySQL, Internal PostgreSQL, PostgreSQL, or an installed Database Pack as the deployment target.
2. **Tables** — choose the source tables and columns you want to use.
3. **Staging** — define the columns and keys that will be produced in staging.
4. **Vault model** — review and edit the Hubs, Links, and Satellites.
5. **Export & Deploy** — validate, download, and deploy. When deployment is current, continue to **Data Vault Hub** to start and monitor the engine.

You can go back to an earlier tab at any time. Step navigation always opens the
destination at the top of the page, including the Back and Next buttons at the
bottom of long Tables and Staging pages. Changes made to selected tables or
staging columns may affect the Vault model, so run the Integrity Checks again
after making changes. Vault and Export remain unavailable until every included
table has a generated staging hash column.

---

# Step 1 — Connections

The active runtime profile is shown at the top of the page. Demo and production
use the same connection, modelling, deployment, and reporting code.

## Demo mode

Demo mode is the existing self-contained evaluation environment:

- Source is locked to the packaged MySQL Sakila database.
- The Data Vault engine is locked to the internal PostgreSQL container.
- The user may keep native PostgreSQL storage or enable JDBC FDW storage.
- When FDW is enabled, the physical target is locked to MySQL database/schema
  `datavault` with the Sakila account.
- Source, PostgreSQL, physical-target, and FDW fields are visible for clarity
  but the demo-controlled values cannot be edited.

Passwords are always rendered as password inputs rather than readable text.

## Production source

Production mode removes the demo-source option. Choose PostgreSQL, MySQL, or
SQL Server and enter the external source host, port, database/schema, username,
and password. SQL Server is always external and is never started or packaged by
Studio. The source credential is independent of any physical FDW target
credential.

MySQL and SQL Server sources show a JDBC-driver check and fetch action because
the Hop engine requires the corresponding jar in `jdbc-drivers/`. SQL Server
source introspection also requires the Node `mssql` package installed by
`npm install`. The SQL Server path currently uses SQL authentication and
encrypted connections with trusted server certificates; Windows integrated
authentication is not configured by this release.

## Deployment target

Production shows four target choices:

- **MySQL** — the packaged PostgreSQL service remains the Hop engine and metadata
  store; core Hub, Link, Satellite, and Link Satellite tables are stored in the
  selected MySQL database through the existing JDBC gateway workflow.
- **SQL Server** — the same packaged PostgreSQL gateway is used, with core Vault
  tables stored in the selected external SQL Server database.
- **Internal PostgreSQL** — all staging, metadata, support, and core Vault tables
  are native objects in the packaged PostgreSQL container.
- **PostgreSQL** — all objects are deployed natively to the selected external
  PostgreSQL database. The external metadata bootstrap is run before the
  vault-specific `pdi_meta` records are generated by the GUI.

MySQL and SQL Server still use the existing ordered physical-target and gateway
deployment logic; the target list intentionally hides that implementation
detail. SQL Server remains external and no SQL Server container is created.

Studio-managed `start.sh up` layers `docker-compose.studio.yaml` over the base
Compose file by default. That override mounts `docker/studio-skip-ddls.sql`
over `03-ddls.sql`, so a fresh internal PostgreSQL volume cannot create
generated staging or Data Vault tables before **Export & Deploy** runs. Use
`--build` to opt into the packaged DDL instead. MySQL and SQL Server add
`docker-compose.fdw.yaml` as a third layer for the FDW image and JDBC drivers;
the DDL mask remains owned by the Studio override.

For native PostgreSQL, enter the host, port, database, username, and password.
Apply All writes those credentials to the existing external-bootstrap variables
before running the established metadata-bootstrap flow. The bootstrap script
itself is unchanged; after it completes, the GUI generates and applies the
vault-specific `pdi_meta` rows.

## Studio Plus default

Studio Plus follows the actual data location and uses the credentials supplied
on Connections:

- internal PostgreSQL with native storage → internal PostgreSQL target;
- internal PostgreSQL with FDW → physical storage target, including an
  external MySQL or SQL Server target;
- external PostgreSQL → external PostgreSQL target.

Deployment remains exclusively on **Export & Deploy**.

### Business-ready Studio Plus reports

Studio Plus now defaults to a richer business-report workflow. The saved-output
model is unchanged: the generated HTML is the reusable client report, while the
Excel workbook contains the live report datasets plus an **Instructions** sheet
with the SQL used to populate them. Refreshing a report does not redesign it;
rerun/refresh the workbook SQL and load the refreshed workbook into the same
HTML file.

When **Business-ready report** is enabled, generation is split into distinct
steps:

1. a BI-consultant planning pass turns the Vault schema, row counts, data types,
   and authoritative hash-key join map into decision-focused business questions
   and analytical techniques;
2. an analytics-engineering pass generates the reporting `SELECT` datasets;
3. Studio validates every generated query against the selected physical target;
4. when **Result-aware design review** is enabled, Studio runs capped samples of
   the validated datasets and sends no more than 30 rows per dataset (with long
   cell values truncated and an overall prompt-size cap) to the configured AI
   provider;
5. a report-design pass produces reusable section rendering code. Sample values
   are context only: generated rendering must calculate every displayed metric,
   filter, chart, and data-dependent narrative from the workbook rows at runtime.

The planning prompt includes an analytics cookbook covering executive KPI and
variance analysis, lifecycle/funnel analysis, cohorts, RFV/RFM and other scoring,
Pareto/concentration, contribution, rankings, velocity/ageing, trends, exceptions,
performance bands, relationship analysis, and Data Vault historical-change
patterns. The model may choose only techniques supported by the actual schema.

Generated client reports include Apache ECharts plus HTML/CSS/SVG support. The AI
can therefore use conventional charts where appropriate and bespoke visuals such
as cohort matrices, journeys, scorecards, timelines, and relationship diagrams.
The report shell also supplies responsive KPI, insight, filter, chart, table, and
section-navigation styling. If ECharts is unavailable, generated sections are
instructed to remain useful with an HTML/SVG/table fallback.

**Privacy note:** schema planning does not send row values. Enabling
**Result-aware design review** intentionally sends the capped report-result sample
to whichever AI provider is configured in Studio Plus. This is disclosed next to
the option in the UI and can be disabled; the downloaded HTML never makes an AI
request during normal client refreshes.

# Step 2 — Tables

Use this tab to choose the source data that will be available to the rest of the design.

## Import the source structure

After connecting the source, select **Detect Source Tables** to import its tables,
columns, primary keys, and source nullability. As part of the same action, the
Studio checks source PK and `NOT NULL` columns for SQL nulls and blank or
whitespace-only values. It performs one aggregate scan per relevant table and
returns counts only; source values are not copied into the Studio or sent to AI
Assist.

You can also paste or import a source definition manually. Manually entered
schemas follow their declared nullability until you use the table-level
**Profile table** action.

## Include or exclude tables

Only included tables are used in Staging and the Vault model. Live detection
lists database views in a separate **Views** section and leaves them unselected
by default; include a view only when it is intentionally acting as a source.

Use the table controls to:

- include or exclude a table;
- review primary and foreign keys;
- review approximate row counts;
- profile a table when needed.

## Select columns for staging

Each source column has a **Stage** checkbox.

- Checked: the column is available in staging and to the Vault modeller.
- Unchecked: the column is deliberately left out of staging and the Vault design.

This is the main control for excluding sensitive, unused, or unwanted columns.

## Staging names

The Studio keeps the original source name for reading the source database and creates a PostgreSQL-safe staging name for the target.

For example:

```text
Source name:  customer-name
Staging name: customer_name
```

Review any warnings about duplicated or invalid staging names before continuing.

# Step 3 — Staging

Staging is the prepared version of the source data used by the Data Vault load.

The columns selected here are the source of truth for the Vault model.

Each included source table is shown as a collapsible card. Use the card checkbox or **Deselect Tables** to remove tables from Staging without returning to Step 2.

The load group is fixed to the default value `2000` in this workflow.

## Column selection

The **Stage** checkboxes are the same settings shown on the Tables tab. A column unticked here is also removed from the Vault design.

## Key derivations

Key derivations create the business-key and hash columns used by Hubs and Links.

The list shows:

- the source column or columns;
- the target Hub;
- the relationship role;
- the generated output name;
- whether the output is a hash, business key, or both.

For example:

```text
language_id → Hub: language → Role: language
            → hash_language_id
```

Use **Add** to create a derivation manually. The output name is generated and checked for collisions.

## Detect Hash Keys

On the Staging tab, **Detect Hash Keys** adds staging key derivations only. It does not build or change the Vault model.

It uses declared primary keys first, foreign keys for relationships, and column-name conventions only when declared relationships are unavailable. Composite keys remain together in source-column order. The detection is deterministic and does not require AI.

## AI Assist

AI Assist can suggest staging key choices and relationship roles. The Studio checks the result against the imported database relationships before applying it.

AI suggestions are not accepted blindly. Known foreign keys and the Studio's validation rules take priority.

## SQL and DDL previews

Each table shows:

- **Staging SQL override** — explicit selected source columns only. Source databases do not calculate Data Vault hashes in v0.2.0.
- **Staging DDL** — the physical PostgreSQL landing table plus the engine-facing `_vw` view. The table mirrors selected source columns; the view adds business keys, canonical SHA-256 hashes, and `tenant_id`.

Data Vault tables still receive idempotent indexes for their generated hash-key
columns. Ordinary staging views are not indexed; PostgreSQL computes their
derived key columns when the engine reads the view.

Review these previews when you change columns or key derivations.

### Wizard navigation scroll

The designer scrolls inside the `<main>` application container. Moving between
wizard steps resets that container, plus the document fallback, to the top after
rendering. The missing-hash warning shown on the first Staging visit is not the
cause of the old retained position; after the fix it is simply visible near the
top of the newly opened page.

### Empty values and nullability

**Detect Source Tables** automatically profiles every source PK and `NOT NULL` column,
counting SQL nulls and blank/whitespace-only values separately. This matters
because the engine can normalise blank source fields to SQL `NULL`, even when
the source metadata declares the column `NOT NULL`. The **Profile table**
button runs a manual check for every column and also calculates distinct values
for business-key assessment.

The initial staging DDL matches the source definition by default:

- primary-key columns are generated as `NOT NULL`;
- source columns marked non-nullable are generated as `NOT NULL`;
- source columns marked nullable remain nullable;
- an unprofiled column follows those source settings (for example, a manually
  pasted schema or an automatic table profile that could not be completed).

A saved live profile is the exception. If profiling finds a SQL null or a
blank/whitespace-only value, that physical staging column is generated as nullable
so the engine can land the row after blank-to-`NULL` normalisation. Hashes,
business-key helpers, and `tenant_id` are computed by the `_vw` relation rather
than stored in the physical table. Nullability is decided in the initial
`CREATE TABLE`; no `ALTER TABLE ... DROP NOT NULL` migration or repair statements
are emitted.

Automatic source-detection profiles are stored only for staging-DDL decisions
and are not shown on the Tables page. Selecting **Profile table** replaces them
with full row, distinct, null and blank counts and then shows the results beside
each column. Renaming a source column clears its saved profile because the
result no longer applies to that identifier.

## Integrity Check

Use the Staging **Integrity Check** to find included tables that still emit no
hash column. A business-key-only derivation does not satisfy this check.

## Confirm changes

Every included table must emit at least one hash column before you can
continue. Run **Detect Hash Keys** or use **AI Assist** to create them, or
deselect a table that should not be staged.

After reviewing the selected columns, detected keys, and SQL previews, select
**Confirm Changes**. The confirmation and **Next: vault model** buttons remain
disabled until the hash requirement is satisfied. Any later Staging edit
invalidates the confirmation, so the current state must be confirmed again
before continuing to the Vault model.

---

# Step 4 — Vault model

Use this tab to review and edit the Data Vault design.

At the top of the page, enter the Vault name and description used in the metadata spreadsheet.

The tab contains four views.

## Hubs

Hubs represent the main business entities and their stable business keys.

Examples include:

- Customer;
- Product;
- Employee;
- Contract.

A Hub can use a single key or an ordered composite key.

Review:

- the source table;
- the Hub name;
- the business-key columns;
- the generated Hub key and business-key output.

## Links

Links represent relationships between Hubs.

Examples include:

- Customer placed Order;
- Employee manages Employee;
- Product belongs to Category.

The Studio keeps relationship roles separate, so two references to the same Hub can still be distinguished, such as:

```text
billing_address
shipping_address
```

Relationship tables containing additional data can also create a Link Satellite.

## Satellites

Satellites store descriptive and changing attributes.

There are two types:

- **Hub Satellites** — describe a business entity;
- **Link Satellites** — describe a relationship.

For example, an order-product relationship might place `quantity`, `unit_price`, and `discount` in a Link Satellite.

Every selected descriptive staging column should appear in a Satellite unless it was explicitly excluded earlier.

## Diagram

The diagram provides a visual view of the Hubs, Links, and Satellites.

You can change the layout, fit the model to the screen, inspect an object, and download the diagram as an SVG file.

## Detect Vault Tables

On the Vault model tab, **Detect Vault Tables** builds a deterministic model from the imported keys. It can create Hubs, Links, Hub Satellites, and Link Satellites.

This is a good starting point when the source has reliable primary and foreign keys.

## AI Assist

AI Assist can propose grouping and naming for the Vault model. The Studio then completes missing selected attributes and applies its own relationship and validation rules.

Always review the result before deployment.

## Integrity Check

The Vault **Integrity Check** finds:

- included tables not represented in the model;
- selected staging columns not assigned to a Satellite.

## External core tables with jdbc_fdw

JDBC FDW is available only when the Data Vault engine target is the internal
PostgreSQL container. Enable it on **Connections**. Configure the physical
target and the container-side foreign-server route in the two sections that
appear there; the Vault-model tab contains modelling controls only.

The storage boundary is deliberately narrow:

- `hub_*`, `link_*`, `sat_*`, and `lsat_*` become PostgreSQL foreign tables;
- the corresponding physical tables live in the selected external target;
- every `*_err` table, staging object, metadata object, and verification view
  remains native PostgreSQL.

Hop continues to use the internal PostgreSQL connection. Export performs the
single ordered deployment: verify/create the PostgreSQL database, verify/create
the physical target, create physical core tables, create local support objects,
configure the FDW extension/server/role mappings, create foreign-table bindings
last, and smoke-test reads as both `data_vault` and `pdi_meta`.

The JDBC URL is the route visible from inside the PostgreSQL container. It may
use a Docker service hostname while the Studio-visible physical target uses a
host address such as `localhost` or `host.docker.internal`.

# Step 5 — Export & Deploy

Use this tab to check the complete design and prepare it for use.

## Validation

The validation panel lists design issues that must be resolved before export.

Typical issues include:

- duplicate output names;
- missing Hub or Link keys;
- selected staging columns not assigned to a Satellite;
- invalid table or column names;
- included tables or columns that are not represented in the Vault model.

## Deployment status

Select **Check status** to see which parts of the current design have already been applied.

Select **Apply all updates** to apply the outstanding items in order. Every run
first synchronises the allowlisted runtime secrets in `.env` and always
regenerates the metadata spreadsheet at the end, even when its existing file
cannot be content-diffed.

For a first deployment, this normally includes:

- target schemas and tables;
- metadata setup;
- the metadata spreadsheet;
- the source connection file;
- engine settings.

The project-root `.env` remains protected from generic file deployment. Studio
can update only the allowlisted runtime secrets described above; comments,
unrelated settings, internal `DB_*` values, and variable references are
preserved.

## Download files

You can download the generated files without deploying them:

- metadata spreadsheet;
- Staging DDL;
- Data Vault DDL;
- metadata SQL;
- source connection file;
- engine settings.

This is useful when another team manages the database or deployment process.

## Update an existing Vault

Use **Diff against target** after changing an already-deployed design.

The Studio compares the new DDL with the target and generates SQL for missing
staging tables/views, Vault tables, columns, and Vault hash indexes. Type
differences are reported for review rather than changed automatically.

It can also identify obsolete Link Satellite Hub columns created by older
Studio DDL. Those removals are listed explicitly and require confirmation
before execution.

## Continue to the Data Vault Hub

Before starting the engine:

1. resolve all validation errors;
2. apply the current updates until every deployment item shows **Deployed ✓**;
3. confirm that the source and target connections work.

The Export & Deploy page does not start the engine. Select **Open Data Vault Hub** after deployment is current.

---

# Data Vault Hub

Use **Data Vault Hub** to start the engine and review the operational status of the Vault. The Hub saves the current spreadsheet, source connection, and engine settings before starting a run; it never rewrites `.env`.

The run dashboard recognises operational load history from the records actually written to `pdi_meta.inst_run_stg_jobs` and `pdi_meta.inst_run_dv_jobs`, while retaining the familiar **Data Vault** / **Staging** labels. This makes the Hub tolerant of older or differently labelled `ref_runtypes` rows. If an older metadata schema does not expose the per-job tables, Studio falls back to the legacy **Data Vault** / **Test Staging** run-type filter. When the Hub opens with a known Data Vault connection it automatically loads existing history and metrics; the manual **Load metrics** action remains available to refresh them.

Use **View engine logs** to follow the run and diagnose connection or loading errors.

Depending on the available metadata, it can show:

- recent runs and their status;
- rows loaded;
- tables with zero rows;
- loading errors;
- error tables containing rejected records.

Use **Verify latest load** in **Post-run verification** to run checks against
the most recent load. Verification progress and completed results remain
visible when the Hub refreshes or re-renders; they are not cleared by the
normal dashboard polling cycle.

## Incremental loads — first feature version

Incremental staging configuration is available per included source table. The
incremental column is metadata; whether it is used is an explicit operational
choice in **Data Vault Hub**:

1. **Detect Source Tables** attempts to suggest a staged timestamp/datetime
   Incremental column using update/change name stems such as `modified*`,
   `updated*`, `last_modified*`, and `change*`.
2. The Incremental column can be reviewed or changed on **Tables**. The first
   feature version only allows staged timestamp/datetime-style columns for
   built-in PostgreSQL/MySQL sources and JDBC Database Packs; plain DATE/TIME,
   numeric and string cursors are not enabled yet.
3. **Data Vault Hub** reflects that selection and also lets the user adjust the
   Incremental column directly. A per-table toggle controls whether the next
   deployed workbook writes `ind_staging_is_incremental = 1` or `0`.
4. Studio does not require or infer an "initial full load" before allowing the
   user to enable incremental loading. The Hub toggle is the user's explicit choice.
5. **Enable all** switches on every table with a supported Incremental column.
   Tables with no Incremental column are left unchanged.
6. The global **Incremental days to load** value is written to
   `source_systems.staging_days_to_load_default` and is deployed with the same
   workbook settings.

The **Staging** step deliberately contains no incremental-loading controls; Tables owns column selection and Hub owns operation. The Hub's **Incremental Loads** section is collapsed by default. Changes to the
column, toggle, or global days value are marked for workbook deployment. Users
can therefore change a column, turn the table on or off, adjust the days value,
and use **Save & deploy settings** once to write the complete spreadsheet.

The workbook contract is the same for every source connector:

- `increment_date_column` contains the selected staged timestamp/datetime column;
- `ind_staging_is_incremental` directly reflects the Hub toggle;
- `staging_days_to_load_default` is the universal source-system days value.

JDBC Database Packs do not require separate incremental UI code.

---

### Runtime profiles and FDW credentials

`npm start` defaults to production mode. Use `npm start -- --mode=demo` only
for the locked demonstration environment. `npm start -- --mode=production`
remains supported when an explicit production flag is preferred. The
server injects the selected profile into the same browser application and
exposes it through `/api/runtime-profile`.

In demo mode, the physical MySQL target deliberately reuses the locked Sakila
account. In production mode, the physical target uses the username/password the
user enters for that target; it never silently reuses the source credential.
That physical-target account creates or maintains the core tables and is stored
in the specific `data_vault` and `pdi_meta` FDW user mappings.

The account must be able to create or open the output database and create,
alter, index, read, and write the core tables. For customer-managed targets, an
administrator must grant those privileges before deployment.

The packaged MySQL demo grants the existing Sakila account privileges on the
future `datavault.*` namespace from
`mysql-init/99-fdw-demo-target-grant.sql`. The file does not create the
database, and `start.sh` does not contain a MySQL administrator login.


## v6.4 runtime-role correction

FDW live checks now run under PostgreSQL role `data_vault`, matching Hop. The Studio deployment login is tested with `SET LOCAL ROLE data_vault` during preflight and deployment; no user mapping is created for the administrative login.


## v6.5 pdi_meta FDW mapping correction

The Data Vault engine's metadata procedures read the core Vault tables while connected
as PostgreSQL role `pdi_meta`. External mode now creates a second specific JDBC FDW user
mapping for `pdi_meta`, using the same physical-target username/password as `data_vault`,
and grants both roles `USAGE` on the foreign server. Preflight verifies that the Studio
deployment login can assume both service roles. Deployment and status checks open one
foreign table as each role, so a missing `pdi_meta` mapping is detected before the engine
runs. No `PUBLIC` user mapping is created.

## v6.6 deployment UI

Deployment is performed only from **Export & Deploy**. The packaged demo locks the selected physical target fields and masks demo passwords. Later releases moved the FDW server configuration from the Vault page to the end of Connections and corrected Studio Plus to follow the physical target.

## v6.7 Studio Plus physical-target default

Studio Plus defaults from the physical Target entered on Connections. External mode connects directly to the selected target database with its configured target username/password; the packaged demo therefore uses MySQL `datavault` as `sakila`. Normal mode uses the PostgreSQL Target connection.

## v6.8 compact deployment status

Export shows three compact deployment stages: **Physical target**, **PostgreSQL gateway**, and **Engine and project**. Each stage has one status pill and one summary. Current stages remain collapsed; stages requiring attention open automatically. Expanding a stage exposes the same detailed checks and individual deployment actions as before. Deployment ordering and behaviour are unchanged.


## v7.0 runtime profiles and Connections-owned FDW setup

One Studio build now supports `demo` and `production` npm-start modes. Demo keeps
the existing packaged services and locked values. Production removes the
MySQL-demo source option, supports user-defined PostgreSQL and MySQL sources,
and offers either internal PostgreSQL (native or FDW) or external PostgreSQL
(native only). The FDW server fields now live at the end of Connections. A
separate physical-target driver check appears when the source and non-PostgreSQL
FDW target use different database types.


## v7.1 external SQL Server support

Production mode now supports SQL Server in two external positions: as a source
database and as the physical core-table target behind the internal PostgreSQL
JDBC FDW gateway. SQL Server is never offered as a packaged service or direct
Data Vault engine target.

The Studio adds SQL Server connection tests, schemas, PK/FK/table introspection,
profiling, Hop `MSSQLNATIVE` metadata, Unicode-safe SHA-256 override generation,
remote core-table DDL/status/deployment, JDBC-driver checks, and Studio Plus
reporting. SQL Server target deployment uses the Target credentials from
Connections. The selected target schema must match the SQL login user's default
schema.

Run `npm install` after applying this release so the companion server can load
the new `mssql` dependency. A live SQL Server plus jdbc_fdw route was not
available in the packaging environment; certify the intended SQL Server
version, authentication policy, JDBC driver, and network route before a
production rollout.


## v7.1.1 target and environment hotfix

The Connections target selector is simplified to MySQL, SQL Server, Internal
PostgreSQL, and PostgreSQL. The existing MySQL and SQL Server JDBC gateway route
is retained. Apply All now synchronises `SOURCE_PASSWORD`, synchronises native
PostgreSQL bootstrap credentials, and always redeploys the mapping workbook.
The existing external PostgreSQL bootstrap script is unchanged. The GUI continues
to invoke that prerequisite flow and then applies the vault-specific `pdi_meta`
records itself. Studio-managed internal PostgreSQL starts apply the no-op
`03-ddls.sql` override by default; `--build` opts into the packaged DDL.
FDW starts add the FDW packaging override on top.

## Database Packs v0.2.2 (preview)

v0.2.2 simplifies custom database-type authoring without changing the v0.2 staging-table + `_vw` architecture. **+ Add database type...** now opens a guided wizard instead of immediately opening a JSON file picker. Users can either create a new minimal JDBC database type or import an existing Database Pack.

The Create path now starts with the packaged Apache Hop database-type catalogue, with **Other / Generic JDBC...** as the final fallback. Native choices no longer ask the user to name the Pack: Studio owns the display name, generated Pack ID and initial version. Generic JDBC alone asks for a database display name. The remaining inputs are JDBC driver class, JDBC URL template, default port, JDBC JAR filename, and optional default schema. Studio infers the normal Host/Port/Database/Schema/Username/Password connection fields. No live host, credentials, metadata inspection or connection test is requested while defining the database type; those happen later in the normal Connections workflow.

The JDBC JAR must already exist in project-root `jdbc-drivers/` before the wizard will create or import a database type. This remains the single shared driver location for Studio, Hop and JDBC-FDW packaging. Wizard-generated manifests remain minimal on disk; inferred connection fields are expanded only in memory. Newly created Packs explicitly record the selected native Hop `pluginId`, or `hop.forceGeneric: true`, making `metadata/rdbms/source.json` generation deterministic while keeping the legacy matcher for imported/older Packs.

The wizard modal is wider and its JDBC fields are proportioned to expected content length (driver/JAR fields wider than port/schema). Browser autofill remains available for repeat testing, while Studio overrides Chromium's yellow autofill styling so populated inputs retain the application theme.

The SQL Server reference Pack has been reduced accordingly: no explicit standard connection-field list, no target/FDW false boilerplate, no source-side hashing and no explicit Hop plugin ID/name. SQL Server remains a Pack-installed source and the existing built-in SQL Server physical-target path is unchanged.

## Database Packs v0.2.1 (preview)

v0.2.1 is a focused staging-view validation fix on top of the v0.2.0 architecture.
Hash/BK/tenant derivation remains on the PostgreSQL `_vw`; the physical staging
table remains selected source columns only. The Staging readiness/integrity check
now reads hash-producing derivation metadata instead of treating the physical
landing table as the place where hash columns must exist. Hash fields exposed by
`buildStagingViewColumns()` also retain `hashed: true` for compatibility with
existing Studio model/DDL helpers.

The Database Pack manifest schema remains version `1`. The SQL Server proof Pack
remains `1.0.0` / feature contract `0.2.0`; no Pack manifest change is required.

## Database Packs v0.2.0 (preview)

Database Packs keep source-database differences declarative. The Studio-owned
`data_vault_studio/database-packs/` directory is the registry: valid top-level
`*.json` manifests are installed database types, while `examples/` and `schema/`
are resources. Vendor JDBC JARs stay in project-root `jdbc-drivers/` so Studio,
Hop and the PostgreSQL JDBC-FDW runtime can share them.

Normal users install a source type from **Source database → + Add database
type…**. `schemaVersion` remains `1`; the old `source.hashSha256` property is
still accepted for v0.1.x manifest compatibility but is ignored by v0.2.0.

### One hashing implementation

Source SQL now extracts explicit source columns only. Data Vault preparation is
centralised in PostgreSQL:

```text
source database
    ↓ explicit selected columns
staging.stg_<prefix>_<table>
    ↓
staging.stg_<prefix>_<table>_vw
    + business keys
    + SHA-256 hash keys
    + tenant_id
    ↓
existing Hub / Link / Satellite processing
```

The physical staging table mirrors the selected source columns. The mapping
workbook's existing single `staging_table_name` points to the `_vw` relation.
PostgreSQL converts the canonical key text to UTF-8 and applies built-in
`sha256(bytea)`, so every source database produces hashes under the same rule.
This removes MySQL `SHA2`, SQL Server `HASHBYTES`, Oracle `STANDARD_HASH`, and
other vendor hash syntax from the source-adapter contract.

Existing v0.1.x physical staging tables may retain old derived columns after an
overlay. The new view ignores those harmless legacy columns. Recreating staging
from the v0.2 DDL produces the clean source-column-only physical layout. Old
custom `staging_sql_override` values that still return generated hash/BK/tenant
aliases are blocked until reset or edited, because those `_vw` columns are now
read-only derivations.

### SQL Server proves the add-a-database workflow

SQL Server remains a supported physical target, but it is deliberately no longer
a built-in **source** selector entry. The release ships
`database-packs/sqlserver.json`. Add or import the database type and place a
Microsoft JDBC JAR matching `mssql-jdbc-*.jar` into `jdbc-drivers/`. The Pack
uses JDBC metadata for target capabilities and the native Hop `MSSQLNATIVE`
connection plugin.
A v0.1.x saved project with the old built-in SQL Server source is migrated to the
installed SQL Server Pack automatically, preserving its host, port, database,
schema, username and password.

This is intentionally the reference test for future database additions: adding a
new source should not require another core Studio source dialect branch.

### Engine compatibility: DELETE, not TRUNCATE

The `_vw` is a simple writable PostgreSQL view for its base columns. The existing
engine can therefore insert source fields through it and later read the derived
fields from the same relation. Staging cleanup must use `DELETE FROM
<staging_table_name>` rather than `TRUNCATE`, because PostgreSQL cannot truncate
a view.

The Hop `staging_generic` workflow files are outside this Studio tree and were
not present in the supplied release inputs, so this Studio preview does **not**
claim that engine-side statement has been patched. Apply the companion engine
change before end-to-end v0.2 testing; see `ENGINE_CHANGE_REQUIRED.md` in the
release package. No other engine metadata contract changes are required.

### Hop, namespace and Docker behaviour

Studio still generates `metadata/rdbms/source.json` and
`hop/postgres-environment.json`; it does not call the running Hop container. A
Pack can select a native Hop plugin or fall back to Generic JDBC. SQL Server's
proof Pack selects `MSSQL` declaratively; PostgreSQL and MySQL remain the only
built-in source mappings in the Hop catalogue.

Pack source SQL never inherits PostgreSQL `public` when the Pack has no schema.
For Docker runtime networking, `localhost`, `127.x.x.x`, and `::1` source hosts
are written as `host.docker.internal` for Hop while Studio keeps the original
JDBC address.

### Dynamic Database Pack targets

Every installed Database Pack can now be selected as a physical Data Vault target. Selecting a non-PostgreSQL target keeps packaged PostgreSQL as the engine/metadata gateway and stores the physical Hub/Link/Satellite tables in the selected database through `jdbc_fdw`.

For Pack targets, **Test connection & map types** runs JDBC metadata discovery and resolves the server's native types into Studio's semantic target model (`BOOLEAN`, integer families, `DECIMAL`, `STRING`, `TIMESTAMP`, `BINARY`, and so on). The resolved profile records database/driver identity, identifier quoting and native type templates with the saved project. Deployment refuses silent profile drift until the user retests and accepts the refreshed mapping.

Pack `target.types`, identifier quoting and DDL templates remain optional exception overrides; legacy target/FDW enablement/certification fields remain readable but no longer act as a target allowlist. Before changing anything, deployment checks that all semantic types required by the current Vault model resolve safely. It then creates only missing physical tables, configures the PostgreSQL JDBC FDW gateway, and verifies the resulting foreign-table route. JDBC metadata cannot safely derive universal schema-creation syntax, so a custom Pack uses an existing/default schema unless it provides `target.createSchemaSql`. Current `jdbc_fdw` user mappings also require target connection fields mapped to username and password.


### Incremental loading controls

When **Detect Source Tables** refreshes source metadata, Studio tries to select an incremental column automatically using change/update name stems rather than a fixed list of exact column names. Timestamp/datetime columns containing terms such as `modified*`, `update*`, `updated*`, `last_modified*`, `last_update*`, `change*`, and `changed*` are ranked as candidates, including compound conventions such as `CustomerModifiedDate` and `RowUpdatedAt`. The name match is accepted only when the detected source type is timestamp/datetime-style. Creation-only timestamps such as `created_at` are not selected automatically. The suggestion is visible and editable on **Tables**. Detection never enables incremental execution; activation remains an explicit Data Vault Hub choice and is not gated by staging history.

The **Delete all** action on **Tables** clears all detected/manual source tables, detected FK/row-count metadata, and downstream Vault objects sourced from those tables (with Undo available). It is intended to make a clean **Delete all → Detect Source Tables** refresh cycle quick during source-schema setup.

The collapsed **Incremental Loads** section in Data Vault Hub also owns the universal **Incremental days to load** value. It is persisted as `vault.stagingDaysToLoadDefault` and written to `source_systems.staging_days_to_load_default` in the generated metadata spreadsheet (default `30`). Changing it marks incremental settings as requiring deployment; **Save & deploy settings** regenerates the workbook and clears that pending state together with table-level incremental changes.
