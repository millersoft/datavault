# Millersoft Data Vault Studio

Millersoft Data Vault Studio helps you turn a PostgreSQL or MySQL source database into a Data Vault design.

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
- Docker and Docker Compose;
- network access to the source and target databases.

AI Assist is optional. **Detect Hash Keys** and **Detect Vault Tables** work without an API key.

The locked demo connections read their credentials from the project-root
`.env` file:

- `SOURCE_PASSWORD` — packaged MySQL source password;
- `DB_USER` — packaged PostgreSQL target username;
- `VAULT_PASSWORD` — packaged PostgreSQL target and service-role password.

Studio treats `.env` as read-only. Change these values outside Studio and
restart any affected containers.

---

## Start the Studio

Open a terminal in the `data_vault_studio` folder and run:

```bash
npm install
npm start
```

Then open:

```text
http://127.0.0.1:8420/
```

---

# Recommended workflow

Work through the five numbered tabs from left to right:

1. **Connections** — connect the packaged MySQL and PostgreSQL demo databases.
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

Use this tab to describe the source system and connect to both packaged demo databases.

## Naming

The packaged demo supplies the Vault and source-system naming values. They remain visible for reference but are read-only in this evaluation workflow. These values are used in generated table names, connection names, and metadata.

Keep the following values stable once a design has been deployed:

- **Vault short name** — for example, `sales`;
- **Staging prefix** — usually the same short name;
- **Tenant ID** — the value used to identify records from this source;
- **Source system code**;
- **Source system description**.

Changing these values outside the evaluation workflow can make a new export look like a different source system.

## Source connection

The source selector remains visible but is disabled and locked to the packaged
MySQL Sakila demo. Its fixed host, port, database, username, and readable demo
password are shown for reference. The password comes from `SOURCE_PASSWORD` in
the project-root `.env`.

Select **Connect**. The Studio starts the demo container if necessary, waits for it to become available, and verifies the connection.

## Target connection

The target selector remains visible but is disabled and locked to the packaged
PostgreSQL demo. Its fixed connection values and readable demo password are
shown for reference. The username comes from `DB_USER` and the password comes
from `VAULT_PASSWORD` in the project-root `.env`.

The same target password is used when preparing the target database and for the Data Vault service users created by the project.

Select **Connect** before moving on. Starting and testing the packaged service are handled by the same action.

When Studio starts a fresh packaged PostgreSQL target, it uses
`docker-compose.studio.yaml` to mask the bundled `db-init/03-ddls.sql` with a
harmless placeholder. This prevents old/demo staging and Data Vault tables
from being created before the current Studio design is applied. The metadata
bootstrap still runs normally.

This applies only to PostgreSQL started through Studio. A manual
`./start.sh` launch continues to use the real `03-ddls.sql`. PostgreSQL
entrypoint scripts run only when the data volume is fresh and empty; Studio
does not remove tables that already exist in an initialized volume.

---

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

- **Staging SQL override** — the query used to read and prepare the source table;
- **Staging DDL** — the PostgreSQL table definition that will receive the data.

Generated Staging and Data Vault DDL also creates an idempotent PostgreSQL
index for every generated hash column. This includes Hub and Link keys,
relationship hashes, Satellite parent keys, and hashdiff columns.

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
blank/whitespace-only value, that staging column is generated as nullable so the
engine can land the row after blank-to-`NULL` normalisation. Derived hashes,
business-key helpers, and `tenant_id` remain nullable. Nullability is decided in
the initial `CREATE TABLE`; no `ALTER TABLE ... DROP NOT NULL` migration or
repair statements are emitted.

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

---

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

Select **Apply all updates** to apply the outstanding items in order.

For a first deployment, this normally includes:

- target schemas and tables;
- metadata setup;
- the metadata spreadsheet;
- the source connection file;
- engine settings.

The project-root `.env` is read-only to Studio. Configure database usernames
and passwords there outside the app, then restart any affected containers.

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
tables, columns, and hash indexes. Type differences are reported for review
rather than changed automatically.

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

The run dashboard intentionally includes only **Data Vault** and **Test Staging** run records. **Test Staging** is presented as **Staging** because that run owns the usable staging job counts. The separate **Staging** and **Test Staging Files** run types are excluded from dashboard totals, charts, and recent-run rows.

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

---
