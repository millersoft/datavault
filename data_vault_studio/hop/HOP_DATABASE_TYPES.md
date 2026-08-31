# Hop database types available to Studio

Catalogue version: 2.0.0

Apache Hop database-plugin reference inventory; pass the packaged Hop plugins/databases directory to filter the exact product build

Studio uses this catalogue when generating `metadata/rdbms/source.json`. A dedicated Hop database type is preferred when it matches; `GENERIC` remains the fallback for JDBC databases without a dedicated type.

The `connectionDefaults` stored in the JSON are Studio-certified generation defaults for the remaining built-in source types, not a claim that every Hop advanced option is universal. SQL Server is deliberately not a Studio built-in source in v0.2.0; its proof Pack selects `MSSQL` and supplies its connection exceptions declaratively. Database Pack `hop.attributes` values override catalogue defaults when a vendor-specific exception is required.

| Plugin ID | Hop name | Module | Studio built-in | Studio connection defaults |
|---|---|---|---|---|
| ACCESS | MS Access | access | — | Hop defaults |
| AS400 | AS/400 | as400 | — | Hop defaults |
| CACHE | InterSystems Cache | cache | — | Hop defaults |
| CLICKHOUSE | ClickHouse | clickhouse | — | Hop defaults |
| COCKROACHDB | CockroachDB | cockroachdb | — | Hop defaults |
| CRATEDB | CrateDB | cratedb | — | Hop defaults |
| DB2 | IBM Db2 | db2 | — | Hop defaults |
| DERBY | Apache Derby | derby | — | Hop defaults |
| DORIS | Apache Doris | doris | — | Hop defaults |
| DUCKDB | DuckDB | duckdb | — | Hop defaults |
| EXASOL4 | Exasol | exasol4 | — | Hop defaults |
| FIREBIRD | Firebird | firebird | — | Hop defaults |
| GENERIC | Generic database | generic | — | Hop defaults |
| GOOGLEBIGQUERY | Google BigQuery | googlebigquery | — | Hop defaults |
| GREENPLUM | Greenplum | greenplum | — | Hop defaults |
| H2 | H2 | h2 | — | Hop defaults |
| HIVE2 | Apache Hive | hive | — | Hop defaults |
| HYPERSONIC | Hypersonic | hypersonic | — | Hop defaults |
| IMPALA | Apache Impala | impala | — | Hop defaults |
| INFOBRIGHT | Infobright | infobright | — | Hop defaults |
| INFORMIX | Informix | informix | — | Hop defaults |
| INGRES | Ingres | ingres | — | Hop defaults |
| INTERBASE | InterBase | interbase | — | Hop defaults |
| IRIS | InterSystems IRIS | iris | — | Hop defaults |
| KINGBASEES | KingbaseES | kingbasees | — | Hop defaults |
| MARIADB | MariaDB | mariadb | — | Hop defaults |
| MONETDB | MonetDB | monetdb | — | Hop defaults |
| MSSQL | MS SQL Server | mssql | — | Hop defaults |
| MSSQLNATIVE | MS SQL Server (Native) | mssqlnative | — | Hop defaults |
| MYSQL | MySQL | mysql | mysql | yes |
| NETEZZA | Netezza | netezza | — | Hop defaults |
| ORACLE | Oracle | oracle | — | Hop defaults |
| ORACLERDB | Oracle RDB | oraclerdb | — | Hop defaults |
| POSTGRESQL | PostgreSQL | postgresql | postgresql | yes |
| REDSHIFT | Amazon Redshift | redshift | — | Hop defaults |
| SAPDB | SAP DB | sapdb | — | Hop defaults |
| SINGLESTORE | SingleStore | singlestore | — | Hop defaults |
| SNOWFLAKE | Snowflake | snowflake | — | Hop defaults |
| SQLBASE | SQLBase | sqlbase | — | Hop defaults |
| SQLITE | SQLite | sqlite | — | Hop defaults |
| SYBASE | Sybase | sybase | — | Hop defaults |
| SYBASEIQ | Sybase IQ | sybaseiq | — | Hop defaults |
| TERADATA | Teradata | teradata | — | Hop defaults |
| UNIVERSE | UniVerse | universe | — | Hop defaults |
| VECTORWISE | VectorWise | vectorwise | — | Hop defaults |
| VERTICA | Vertica | vertica | — | Hop defaults |

## Generic fallback

- Plugin ID: GENERIC
- Name: Generic database
- Used only when Studio cannot resolve a dedicated Hop database type or a pack explicitly forces Generic.
