# Building a Database Pack manually

Database Packs add JDBC database types to Data Vault Studio without adding a new hard-coded source dialect. A Pack is a JSON manifest stored in `data_vault_studio/database-packs/`; the vendor JDBC driver is stored separately in project-root `jdbc-drivers/`.

The current manifest schema is **`schemaVersion: 1`**. The current Studio Database Pack feature contract is **v0.2.2**. Do not add a `featureVersion` field to a hand-authored Pack; Studio adds runtime defaults in memory.

For a complete reference manifest, see [`examples/full-database-pack.example.json`](examples/full-database-pack.example.json). The example intentionally includes optional/advanced sections; most source Packs should start with the smaller manifest below.

## 1. Start with a minimal Pack

Create `data_vault_studio/database-packs/<id>.json`:

```json
{
  "schemaVersion": 1,
  "id": "exampledb",
  "label": "Example Database",
  "version": "1.0.0",
  "jdbc": {
    "driverClass": "com.vendor.jdbc.ExampleDriver",
    "urlTemplate": "jdbc:example://{host}:{port}/{database}",
    "defaultPort": 1234,
    "jarPattern": "example-jdbc-*.jar",
    "testSql": "SELECT 1"
  },
  "namespace": {
    "usesSchema": true
  },
  "hop": {
    "forceGeneric": true
  }
}
```

Place the matching JDBC JAR in:

```text
<project-root>/jdbc-drivers/
```

Then either restart/reload Studio so it reads the top-level Pack file, or use **Source database → + Add database type… → Import existing Database Pack**. Import requires the referenced driver JAR to be present first.

## 2. Required manifest fields

| Field | Requirement |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `id` | Lowercase letters/numbers plus `.`, `_` or `-`; maximum 64 characters. The canonical filename is `<id>.json`. |
| `label` | Human-readable database name shown in Studio. |
| `version` | Semantic version such as `1.0.0` or `1.1.0-beta.1`. |
| `jdbc.driverClass` | Fully qualified JDBC driver class. |
| `jdbc.urlTemplate` | JDBC URL containing `{field}` tokens. |
| `jdbc.jarfile` or `jdbc.jarPattern` | Exact JAR filename or a `*`/`?` wildcard pattern. Use one. |

`jdbc.defaultPort`, `jdbc.testSql`, and `jdbc.driverDownloadUrl` are optional but recommended where they make sense. `testSql` defaults to `SELECT 1`.

Use a plain JAR filename/pattern, for example `vendor-jdbc-*.jar`. Do not put credentials in the manifest or JDBC URL template.

## 3. JDBC URL tokens and automatic connection fields

Tokens in `jdbc.urlTemplate` become connection inputs. For a normal URL:

```json
"urlTemplate": "jdbc:example://{host}:{port}/{database}"
```

Studio recognises these standard names automatically:

```text
host  port  database  schema  catalog  user  password
```

If `connectionFields` is omitted, Studio derives the URL fields and also supplies standard username/password inputs. Schema is also made available by default unless `namespace.usesSchema` is explicitly `false`.

This means most Packs do **not** need to spell out the normal Host / Port / Database / Schema / Username / Password form.

### Custom URL fields

A URL can contain custom tokens:

```json
"urlTemplate": "jdbc:example://{host}:{port}/{database}?sslMode={sslMode}"
```

For a simple custom token, Studio can infer a text input. Define `connectionFields` when you need a select list, checkbox, custom label/help, a non-standard default, or an explicit mapping.

When `connectionFields` is present it is the explicit form definition, so include every URL token and every credential/namespace field you want the user to enter.

Supported field types are:

```text
text  password  number  select  checkbox
```

A `select` field must define a non-empty `options` array.

`mapsTo` may be one of:

```text
host  port  database  schema  catalog  user  password
```

Custom URL-only fields normally omit `mapsTo`.

## 4. Namespace behaviour

Use `namespace` to describe how the source organises objects:

```json
"namespace": {
  "usesCatalog": false,
  "usesSchema": true,
  "schemaLabel": "Schema",
  "defaultSchema": ""
}
```

Important options:

- `usesSchema: true` — expose a schema. This is the normal default.
- `usesSchema: false` — database has no schema namespace and Studio should not manufacture one.
- `usesCatalog: true` — expose a catalog/database namespace where the JDBC model needs it.
- `defaultSchema` / `defaultCatalog` — optional defaults.
- `schemaLabel` / `catalogLabel` — optional UI labels.

JDBC metadata is used to discover available schemas/catalogs after a connection is made.

## 5. Source datatype overrides

JDBC metadata is mapped to Studio semantic types automatically. Only add `source.nativeTypeOverrides` when a driver reports a vendor-native type that needs help:

```json
"source": {
  "nativeTypeOverrides": {
    "VENDOR_UUID": "UUID",
    "VENDOR_JSON": "JSON",
    "VENDOR_DATETIME": "TIMESTAMP"
  }
}
```

Allowed semantic types are:

```text
BOOLEAN
SMALL_INTEGER
INTEGER
BIG_INTEGER
DECIMAL
FLOAT
STRING
LARGE_TEXT
DATE
TIME
TIMESTAMP
TIMESTAMP_TZ
BINARY
BINARY_LARGE
UUID
JSON
XML
ARRAY
COMPLEX
UNKNOWN
```

`source.enabled` is optional; source use is enabled by default. Source-side hashing is **not** part of the Database Pack contract. Studio lands source columns and the PostgreSQL staging view owns Data Vault BK/hash/tenant derivation.

## 6. Apache Hop connection choice

Make the Hop strategy explicit for a new manual Pack.

### Generic JDBC

Use this when the database has no suitable packaged Hop database plugin:

```json
"hop": {
  "forceGeneric": true
}
```

Optional vendor JDBC properties can be supplied with `hop.attributes`.

### Native Hop plugin

If the packaged Hop runtime contains a suitable plugin, use its plugin ID:

```json
"hop": {
  "pluginId": "ORACLE"
}
```

The packaged catalogue is documented in `hop/HOP_DATABASE_TYPES.md` and stored in `hop/database-types.json`.

If `hop` is omitted, Studio attempts to match the Pack id/label to the Hop catalogue and otherwise falls back to Generic JDBC. For a manually maintained Pack, declaring the intended strategy is clearer and more deterministic.

## 7. Target support is discovered, not pre-declared

A Pack does not need a large hard-coded target type map to be usable as a physical target. Studio discovers JDBC target types and identifier quoting from the connected database during **Test connection & map types**.

Use `target` only for genuine vendor exceptions, for example:

```json
"target": {
  "identifierQuote": "\"",
  "types": {
    "UUID": "VARCHAR(36)",
    "JSON": "TEXT"
  }
}
```

`target.types` overrides discovered semantic mappings; it is not intended to duplicate the entire vendor type system. Advanced Packs can also provide target DDL templates such as schema/table creation where JDBC metadata alone is insufficient.

Older `target.enabled` and FDW `enabled/read/insert/update/delete/certified` properties are still accepted for compatibility, but they are **not** the current target allowlist and should not be copied into a new Pack just to make target support work.

## 8. FDW and provisioning are advanced options

Most source-only Packs do not need `fdw` or `provisioning`.

Use them only when the database is also being integrated with Studio's external-target/JDBC-FDW deployment workflow and vendor-specific setup is required. Examples include:

- resolving remote tables through the connection's default schema;
- creating a dedicated FDW service login/user;
- creating a database/schema;
- checking table status with vendor-specific SQL.

The complete example shows the currently supported shape. Treat all SQL templates as vendor-specific deployment code: test them against the exact database/version you intend to support.

## 9. Identifier quoting

For source discovery/extraction, JDBC metadata provides the database's identifier quote where possible. For target DDL, `target.identifierQuote` can override discovery when the driver is wrong or incomplete.

Do not add quoting rules unless the database/driver actually needs an exception.

## 10. Install and test a manually built Pack

Recommended deployment-readiness sequence:

1. Put the JDBC JAR in `<project-root>/jdbc-drivers/`.
2. Save the Pack as `data_vault_studio/database-packs/<id>.json`, or import it through **+ Add database type…**.
3. Open **Connections** and select the Pack as the source database.
4. Enter source credentials and test the connection.
5. Verify schema/catalog discovery.
6. Run **Detect Source Tables** and check table/column types, PKs and FKs.
7. Check any vendor-specific native types. Add `source.nativeTypeOverrides` only if required.
8. Verify the generated Hop source connection uses the intended native plugin or Generic JDBC strategy.
9. If the Pack is intended as a physical target, run **Test connection & map types** and review the discovered target mapping before deployment.
10. Increment the Pack `version` whenever the distributed manifest changes.

## 11. Updating a Pack

The top-level `data_vault_studio/database-packs/` folder is the installed Pack registry. The canonical name is `<id>.json`; if duplicate files contain the same `id`, the canonical file wins.

Keep the `id` stable when releasing an updated definition and increase `version`, for example:

```text
1.0.0 → 1.0.1   documentation/default correction
1.0.0 → 1.1.0   compatible Pack capability/configuration addition
1.0.0 → 2.0.0   intentionally incompatible Pack contract change
```

Do not store passwords, access tokens or other environment credentials in a Pack.

## 12. Troubleshooting

**Pack is listed as invalid**  
Check JSON syntax, `schemaVersion`, `id`, semantic version format, JDBC class/URL and JAR configuration.

**JDBC URL references an unknown field**  
Every `{token}` in `jdbc.urlTemplate` must have a derived or explicit connection field. If you supplied `connectionFields`, make sure the token is included there.

**Driver is missing**  
Confirm `jdbc.jarfile` or `jdbc.jarPattern` matches a JAR in `<project-root>/jdbc-drivers/`.

**Tables connect but types look wrong**  
Inspect the JDBC native/JDBC type returned during discovery and add the smallest necessary `source.nativeTypeOverrides` entry.

**Hop connection is using the wrong database type**  
Set `hop.pluginId` explicitly for a native Hop plugin or `hop.forceGeneric: true` for Generic JDBC.

**Schema does not appear**  
Check `namespace.usesSchema` and the driver's JDBC metadata support. For databases without schemas, explicitly set `usesSchema: false`.

## Release checklist for a Pack

- Valid JSON and `schemaVersion: 1`.
- Stable lowercase Pack `id` and semantic `version`.
- JDBC driver class and URL tested.
- JAR filename/pattern matches the shipped deployment instructions.
- Connection fields are minimal and contain no secrets.
- Schema/catalog behaviour verified.
- Source table/column metadata verified against a real database.
- Native type overrides added only where JDBC metadata is insufficient.
- Hop strategy explicitly verified.
- Target/FDW/provisioning sections included only when actually tested and required.
