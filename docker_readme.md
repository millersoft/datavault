[← Back to the main README](README.md)

# Data Vault Hop Docker Setup – Quick Start & Configuration Guide

## Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [JDBC Drivers](#jdbc-drivers)
4. [Startup Modes](#startup-modes)
5. [First-Time Startup – Linux / macOS](#linux-macos-startup)
6. [First-Time Startup – Windows](#windows-startup)
7. [License Acceptance](#license-acceptance)
8. [License Management](#license-management)
9. [Automated / CI Environments](#ci-environments)
10. [External PostgreSQL Bootstrap Behaviour](#external-postgres-bootstrap)
11. [Adding a New Source System](#new-source-system)
12. [Typical Changes for a New Source](#new-source-changes)
13. [Project Structure](#project-structure)
14. [Useful Tips](#useful-tips)

<a id="overview"></a>

## 1. Overview

This project provides an Apache Hop Data Vault ETL environment running in Docker.

The solution includes:

* **PostgreSQL** – Data Vault and metadata repository
* **Apache Hop** – ETL orchestration and Data Vault processing
* **Optional MySQL Sakila demo source** – started only when demo mode is enabled
* **License Management** – one-time acceptance workflow before ETL execution
* **User-supplied JDBC driver support** – external database drivers are mounted at runtime

---

<a id="prerequisites"></a>

## 2. Prerequisites

Before running the project, ensure the following are installed:

* Docker Desktop for Windows / macOS
* Docker Engine + Docker Compose for Linux
* Required JDBC driver JAR files for your source database

Verify Docker is available:

```bash
docker --version
docker compose version
```

---

<a id="jdbc-drivers"></a>

## 3. JDBC Drivers

JDBC driver JAR files are **not bundled** with this repository.

Place any required JDBC driver JAR files in:

```text
./jdbc-drivers/
```

Example:

```text
./jdbc-drivers/mysql-connector-j-8.4.0.jar
./jdbc-drivers/mariadb-java-client-x.x.x.jar
```

At container startup, any `.jar` or `.JAR` files in `jdbc-drivers/` are mounted into the Hop container and copied into Hop’s JDBC library directory.

---

<a id="startup-modes"></a>

## 4. Startup Modes

There are two main startup modes:

| Command                                  | Behaviour                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./start.sh --build`                     | Starts PostgreSQL and Hop only. Builds the Postgres metadata DB. Does **not** start the bundled MySQL Sakila demo source.                                                                 |
| `./start.sh`                             | Starts PostgreSQL and Hop only. Runs the ETL. Does **not** start the bundled MySQL Sakila demo source.                                                                                    |
|                                          |                                                                                                                                                                                           |
| `./start.sh --build --demo`              | Starts PostgreSQL, Builds MySQL Sakila demo source and starts Hop. Runs the bundled demo flow.                                                                                            |
| `./start.sh --demo`                      | Starts PostgreSQL, MySQL Sakila demo source and Hop. Runs the bundled demo flow.                                                                                                          |
|                                          |                                                                                                                                                                                           |
| `./start.sh --build --external-postgres` | Uses an external PostgreSQL database. Runs the external PostgreSQL bootstrap if required, then starts Hop. Does not start the internal PostgreSQL container or bundled MySQL demo source. |
| `./start.sh --external-postgres`         | Uses an external PostgreSQL database. Skips bootstrap and starts Hop only. Does not start the internal PostgreSQL container or bundled MySQL demo source.                                 |


On Windows, use the PowerShell launcher:

| Command                                   | Behaviour                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `.\start.ps1 --build`                     | Starts PostgreSQL and Hop only. Builds the Postgres metadata DB. Does **not** start the bundled MySQL Sakila demo source.                                                                 |
| `.\start.ps1`                             | Starts PostgreSQL and Hop only. Runs the ETL. Does **not** start the bundled MySQL Sakila demo source.                                                                                    |
|                                           |                                                                                                                                                                                           |
| `.\start.ps1 --build --demo`              | Starts PostgreSQL, Builds MySQL Sakila demo source and starts Hop. Runs the bundled demo flow.                                                                                            |
| `.\start.ps1 --demo`                      | Starts PostgreSQL, MySQL Sakila demo source and Hop. Runs the bundled demo flow.                                                                                                          |
|                                           |                                                                                                                                                                                           |
| `.\start.ps1 --build --external-postgres` | Uses an external PostgreSQL database. Runs the external PostgreSQL bootstrap if required, then starts Hop. Does not start the internal PostgreSQL container or bundled MySQL demo source. |
| `.\start.ps1 --external-postgres`         | Uses an external PostgreSQL database. Skips bootstrap and starts Hop only. Does not start the internal PostgreSQL container or bundled MySQL demo source.                                 |


Note: `--demo` and `--external-postgres` cannot be used together. The bundled Sakila demo is intended to run against the internal Docker PostgreSQL service only.

---

<a id="linux-macos-startup"></a>

## 5. First-Time Startup – Linux / macOS


### Demo Mode

Use this to run the bundled Sakila example, and only for the initial setup:

```bash
./start.sh --build --demo
```

This starts:

```text
PostgreSQL
MySQL Sakila demo source
Apache Hop
```

After initial setup, use:

```bash
./start.sh --demo
```

The bundled MySQL service is controlled by the Docker Compose `demo` profile.


### Normal Mode

Use this when running against your own configured source system, and only for the initial setup:

```bash
./start.sh --build
```

This starts:

```text
PostgreSQL
Apache Hop
```

After initial setup, use:

```bash
./start.sh
```

It does **not** start the bundled MySQL Sakila demo container.


### External PostgreSQL Mode

Use this when running against an external PostgreSQL database instead of the bundled Docker PostgreSQL container.

Before starting, update:

`.env`
`hop/postgres-environment.json`

The external PostgreSQL host, port, database, and runtime users should be configured in `hop/postgres-environment.json`.

The bootstrap/admin PostgreSQL credentials should be configured in `.env`.

Example .env values:

`POSTGRES_BOOTSTRAP_USER=postgres`
`POSTGRES_BOOTSTRAP_PASSWORD=your_external_admin_password`
`POSTGRES_BOOTSTRAP_DATABASE=postgres`

`CREATE_EXTERNAL_DATABASE=true`

`BOOTSTRAP_NAME=datavault-core`
`BOOTSTRAP_VERSION=1`
`FORCE_EXTERNAL_BOOTSTRAP=false`

Run first-time external PostgreSQL setup:

`./start.sh --build --external-postgres`

This will:

Skip the internal Docker PostgreSQL container
Skip the bundled MySQL Sakila demo source
Connect to the external PostgreSQL database
Run the PostgreSQL bootstrap/restore if required
Start Apache Hop

After initial setup, use:

`./start.sh --external-postgres`

This starts Hop without re-running the external PostgreSQL bootstrap.

---

<a id="windows-startup"></a>

## 6. First-Time Startup – Windows

Open a PowerShell terminal and navigate to the DVE code root directory.

Relax script permissions if required:

```powershell
Unblock-File .\start.ps1
```

If there are still permissions issues, run from the root directory:

```powershell
Get-ChildItem -Recurse | Unblock-File
```

If PowerShell still blocks the script, check the execution policy:

```powershell
Get-ExecutionPolicy -List
```

You should see `RemoteSigned` for `CurrentUser`.

If not, run:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### Demo Mode

```powershell
.\start.ps1 --build --demo
```

If needed, you can also run with execution policy bypass:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1 --build --demo
```

After initial setup, use:

```powershell
.\start.ps1 --demo
```

### Normal Mode

```powershell
.\start.ps1 --build
```

After initial setup, use:

```powershell
.\start.ps1
```

### External PostgreSQL Mode

Use this when running against an external PostgreSQL database instead of the bundled Docker PostgreSQL container.

Before starting, update:

`.env`
`hop/postgres-environment.json`

Run first-time external PostgreSQL setup:

`.\start.ps1 --build --external-postgres`

After initial setup, use:

`.\start.ps1 --external-postgres`

This starts Hop without rerunning the external PostgreSQL bootstrap.

---

<a id="license-acceptance"></a>

## 7. License Acceptance

On first execution you will be prompted to review and accept the license agreement.

Example:

```text
============================================================
LICENSE AGREEMENT
============================================================

Options:
  Y - Accept license and start ETL
  N - Decline license and stop
  V - View full license text

Please choose Y, N, or V:
```

After accepting the license:

* Docker images will be built if required
* Containers will be started
* Metadata will be initialized
* Apache Hop will run the ETL process

License acceptance is remembered between runs using:

```text
.license-state/license.accepted
```

---

### Making Changes to `.env`

If you change `.env`, recreate the containers so the new values are injected. Rebuilding alone is not enough if Docker reuses existing containers.

Linux / macOS:

```bash
./start.sh --force-recreate
```

Demo mode:

```bash
./start.sh --force-recreate --demo
```

Windows:

```powershell
.\start.ps1 --force-recreate
```

Demo mode:

```powershell
.\start.ps1 --force-recreate --demo
```

---

### Making Changes to `hop/postgres-environment.json`

If you change `hop/postgres-environment.json`, recreate the Hop container so the updated connection values are mounted and used.

Linux / macOS:

`./start.sh --force-recreate`

External PostgreSQL mode:

`./start.sh --force-recreate --external-postgres`

Demo mode:

`./start.sh --force-recreate --demo`

Windows:

`.\start.ps1 --force-recreate`

External PostgreSQL mode:

`.\start.ps1 --force-recreate --external-postgres`

Demo mode:

`.\start.ps1 --force-recreate --demo`

---

### Stop Running Containers

If running in the foreground:

```text
CTRL + C
```

Or:

Linux / macOS:

```bash
./start.sh down
```

Windows:

```powershell
.\start.ps1 down
```

---

### View Logs

Linux / macOS:

```bash
./start.sh logs -f hop
```

Windows:

```powershell
.\start.ps1 logs -f hop
```

---

### Check Container Status

Linux / macOS:

```bash
./start.sh ps
```

Windows:

```powershell
.\start.ps1 ps
```

---

### Full Clean Restart

⚠️ This removes Docker containers and database volumes.

Linux / macOS:

```bash
./start.sh down -v
./start.sh --build
```

Demo mode:

```bash
./start.sh down -v
./start.sh --build --demo
```

Windows:

```powershell
.\start.ps1 down -v
.\start.ps1 --build
```

Demo mode:

```powershell
.\start.ps1 down -v
.\start.ps1 --build --demo
```

The launcher includes the Docker Compose `demo` profile during `down`, so demo-related resources such as the MySQL container and `mysql_data` volume are also removed.

---

### External PostgreSQL Clean Restart

External PostgreSQL databases are not removed by Docker volume cleanup.

Linux / macOS:

`./start.sh down -v`
`./start.sh --build --external-postgres`

Windows:

`.\start.ps1 down -v`
`.\start.ps1 --build --external-postgres`

The down -v command removes Docker containers and Docker-managed volumes, but it does not drop or reset the external PostgreSQL database.

If the external database needs to be fully reset, drop and recreate the external database manually, then run the external bootstrap again.

---

<a id="license-management"></a>

## 8. License Management

### Reset License Acceptance – Linux / macOS

```bash
rm -f .license-state/license.accepted
```

Then run:

```bash
./start.sh --build
```

or demo mode:

```bash
./start.sh --build --demo
```

### Reset License Acceptance – Windows

```powershell
.\start.ps1 --reset-license
```

Then run:

```powershell
.\start.ps1 --build
```

or demo mode:

```powershell
.\start.ps1 --build --demo
```

### Force License Prompt – Windows

```powershell
.\start.ps1 --force-license-prompt --build
```

### Check License Status – Windows

```powershell
.\start.ps1 --license-status
```

---

<a id="ci-environments"></a>

## 9. Automated / CI Environments

For non-interactive execution on Linux / macOS:

```bash
ACCEPT_LICENSE=true ./start.sh --build
```

Demo mode:

```bash
ACCEPT_LICENSE=true ./start.sh --build --demo
```

For non-interactive execution on Windows:

```powershell
$env:ACCEPT_LICENSE="true"; .\start.ps1 --build
```

Demo mode:

```powershell
$env:ACCEPT_LICENSE="true"; .\start.ps1 --build --demo
```

This automatically records acceptance and starts the environment.

---

<a id="external-postgres-bootstrap"></a>

## 10. External PostgreSQL Bootstrap Behaviour

External PostgreSQL mode uses a bootstrap marker so the database restore behaves similarly to Docker’s PostgreSQL init directory.

On the first successful run, the bootstrap process writes a marker to:

`bootstrap_admin.bootstrap_state`

On later runs, if the marker already exists, the restore/bootstrap is skipped.

This means:

`./start.sh --build --external-postgres`

will bootstrap the external database only if the marker does not already exist.

To force the external bootstrap to run again, set this in .env:

`FORCE_EXTERNAL_BOOTSTRAP=true`

Then run:

`./start.sh --build --external-postgres`

After forcing bootstrap, set it back to:

`FORCE_EXTERNAL_BOOTSTRAP=false`

Leaving `FORCE_EXTERNAL_BOOTSTRAP=true` is not recommended because it will try to rerun the database restore each time.

If the first external bootstrap fails part way through, the marker will not be written. In that case, the external database may be partially populated. For test databases, the cleanest recovery is usually to drop and recreate the external database, then rerun:

`./start.sh --build --external-postgres`


<a id="new-source-system"></a>

## 11. Adding a New Source System

When adding a new source system, update the required connection and mapping configuration before running the ETL.

### A. `.env`

Add or update credentials.

Example:

```env
VAULT_PASSWORD=your_vault_password
SOURCE_PASSWORD=your_source_password
```

These values can be referenced from Hop environment configuration using `${VARIABLE_NAME}` syntax.

---

### B. `hop/postgres-environment.json`

This file contains the runtime connection variables used by Apache Hop.

Example source connection section:

```json
{
  "name": "postgres",
  "purpose": "Development",
  "variables": [
    {
      "name": "source_host_name",
      "value": "your-source-host"
    },
    {
      "name": "source_port_number",
      "value": "3306"
    },
    {
      "name": "source_database_name",
      "value": "your_source_database"
    },
    {
      "name": "source_user_name",
      "value": "your_source_user"
    },
    {
      "name": "source_password",
      "value": "${SOURCE_PASSWORD}"
    }
  ]
}
```

> Use `${VARIABLE_NAME}` syntax to reference values from `.env`.

---

### C. JDBC Driver

Place the required JDBC driver JAR file in:

```text
./jdbc-drivers/
```

Example:

```text
./jdbc-drivers/mysql-connector-j-8.4.0.jar
```

The startup script will load any `.jar` or `.JAR` files found in this directory.

---

### D. Data Vault Mappings

Update the mapping files in:

```text
./mappings/
```

These define the source-to-Data Vault structures used by the ETL.

---

### E. Database Structures

The required staging tables, hubs, links, satellites, and metadata structures must exist before the main ETL can run successfully.

For the bundled demo, these are already included.

For a new source system, generate or create the required structures before running the ETL.

---

<a id="new-source-changes"></a>

## 12. Typical Changes for a New Source

| Item                           | Location                        | Action                                                    |
| ------------------------------ | ------------------------------- | --------------------------------------------------------- |
| Passwords                      | `.env`                          | Add or update credentials                                 |
| Source connection details      | `hop/postgres-environment.json` | Update host, database, port, user                         |
| Destination connection details | `hop/postgres-environment.json` | Update PostgreSQL/Data Vault connection details if needed |
| JDBC drivers                   | `jdbc-drivers/`                 | Add required driver JAR files                             |
| Data Vault mappings            | `mappings/`                     | Update source definitions                                 |
| Staging tables                 | PostgreSQL / DDL scripts        | Create or update staging structures                       |
| Hubs, links, satellites        | PostgreSQL / DDL scripts        | Create or update Data Vault structures                    |

### External PostgreSQL Target

If you want to use an external PostgreSQL database for the metadata, staging, and Data Vault schemas, update the PostgreSQL-side variables in:

`hop/postgres-environment.json`

For external PostgreSQL mode, the following variables should normally point to the external PostgreSQL host:

`pdi_meta_host_name`
`data_vault_host_name`
`stg_host_name`
`staging_host_name`

The database, port, users, passwords, and schema names should also be checked.

Example:
```json
{
  "name": "data_vault_host_name",
  "value": "your-external-postgres-host"
}
{
  "name": "data_vault_port_number",
  "value": "5432"
}
{
  "name": "data_vault_database_name",
  "value": "datavault"
}
{
  "name": "data_vault_user_name",
  "value": "data_vault"
}
{
  "name": "data_vault_password",
  "value": "${VAULT_PASSWORD}"
}
```
The external bootstrap connects using the admin/bootstrap credentials from `.env` ($VAULT_PASSWORD), but Apache Hop runs using the runtime users defined in `hop/postgres-environment.json`.

---

<a id="project-structure"></a>

## 13. Project Structure

```text
.
├── docker-compose.yaml
├── start.sh
├── start.ps1
├── LICENSE
├── .env
├── data_vault/
├── staging_generic/
├── mappings/
├── metadata/
├── logs/
├── jdbc-drivers/
├── mysql-init/
└── hop/
```

---

<a id="useful-tips"></a>

## 14. Useful Tips

### Logs

Application logs are written to:

```text
./logs
```

and are mapped into the container as:

```text
/app/logs
```

---

### Vault Mapping Definitions

Data Vault object definitions are maintained in:

```text
./mappings/
```

---

### PostgreSQL Access

From the host:

```bash
docker exec -it dv-postgres psql -U data_vault -d datavault
```

The PostgreSQL service is exposed on the host as:

```text
localhost:5433
```

Container-internal PostgreSQL connection details:

```text
Host: postgres
Port: 5432
Database: datavault
User: dvuser
```

---

### MySQL Access – Demo Mode Only

The MySQL container is only started when demo mode is enabled.

Start demo mode:

```bash
./start.sh --build --demo
```

Access MySQL:

```bash
docker exec -it dv-mysql mysql -u sakila -p
```

The MySQL service is exposed on the host as:

```text
localhost:3306
```

Container-internal MySQL connection details:

```text
Host: mysql
Port: 3306
Database: sakila
User: sakila
```

---
