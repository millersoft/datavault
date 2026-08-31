#!/usr/bin/env bash
set -Eeuo pipefail

ENV_TEMPLATE_FILE="${ENV_TEMPLATE_FILE:-/app/postgres-environment.json}"
INIT_DIR="${INIT_DIR:-/docker-entrypoint-initdb.d}"

POSTGRES_BOOTSTRAP_USER="${POSTGRES_BOOTSTRAP_USER:-}"
POSTGRES_BOOTSTRAP_PASSWORD="${POSTGRES_BOOTSTRAP_PASSWORD:-}"
POSTGRES_BOOTSTRAP_DATABASE="${POSTGRES_BOOTSTRAP_DATABASE:-postgres}"

CREATE_EXTERNAL_DATABASE="${CREATE_EXTERNAL_DATABASE:-false}"

BOOTSTRAP_NAME="${BOOTSTRAP_NAME:-datavault-core}"
BOOTSTRAP_VERSION="${BOOTSTRAP_VERSION:-1}"
FORCE_EXTERNAL_BOOTSTRAP="${FORCE_EXTERNAL_BOOTSTRAP:-false}"

is_truthy() {
  case "${1:-}" in
    true|TRUE|True|1|yes|YES|Yes|y|Y)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

resolve_config_value() {
  local value="${1:-}"

  case "$value" in
    '${'*'}')
      local var_name
      var_name="${value#\$\{}"
      var_name="${var_name%\}}"

      printf '%s' "${!var_name:-}"
      ;;
    *)
      printf '%s' "$value"
      ;;
  esac
}

get_hop_env_value() {
  local key="$1"
  local value

  if [ ! -f "$ENV_TEMPLATE_FILE" ]; then
    fail "Hop environment file not found at $ENV_TEMPLATE_FILE"
  fi

  value="$(
    awk -v key="$key" '
      BEGIN { RS="\\{" }
      $0 ~ "\"name\"[[:space:]]*:[[:space:]]*\"" key "\"" {
        if (match($0, /"value"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
          s = substr($0, RSTART, RLENGTH)
          sub(/^"value"[[:space:]]*:[[:space:]]*"/, "", s)
          sub(/"$/, "", s)
          print s
          exit
        }
      }
    ' "$ENV_TEMPLATE_FILE"
  )"

  resolve_config_value "$value"
}

bootstrap_marker_exists() {
  psql \
    -h "$TARGET_HOST" \
    -p "$TARGET_PORT" \
    -U "$POSTGRES_BOOTSTRAP_USER" \
    -d "$TARGET_DATABASE" \
    -tAc "
      SELECT 1
      FROM bootstrap_admin.bootstrap_state
      WHERE bootstrap_name = '${BOOTSTRAP_NAME}'
      LIMIT 1;
    " 2>/dev/null | grep -qx "1"
}

write_bootstrap_marker() {
  psql \
    -h "$TARGET_HOST" \
    -p "$TARGET_PORT" \
    -U "$POSTGRES_BOOTSTRAP_USER" \
    -d "$TARGET_DATABASE" \
    -v ON_ERROR_STOP=1 <<SQL
CREATE SCHEMA IF NOT EXISTS bootstrap_admin;

CREATE TABLE IF NOT EXISTS bootstrap_admin.bootstrap_state (
    bootstrap_name text PRIMARY KEY,
    bootstrap_version text NOT NULL,
    bootstrap_completed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bootstrap_admin.bootstrap_state (
    bootstrap_name,
    bootstrap_version,
    bootstrap_completed_at
)
VALUES (
    '${BOOTSTRAP_NAME}',
    '${BOOTSTRAP_VERSION}',
    now()
)
ON CONFLICT (bootstrap_name)
DO UPDATE SET
    bootstrap_version = excluded.bootstrap_version,
    bootstrap_completed_at = excluded.bootstrap_completed_at;
SQL
}

TARGET_HOST="$(get_hop_env_value "data_vault_host_name")"
TARGET_PORT="$(get_hop_env_value "data_vault_port_number")"
TARGET_DATABASE="$(get_hop_env_value "data_vault_database_name")"

if [ -z "$TARGET_HOST" ]; then
  fail "data_vault_host_name is empty in $ENV_TEMPLATE_FILE"
fi

if [ -z "$TARGET_PORT" ]; then
  fail "data_vault_port_number is empty in $ENV_TEMPLATE_FILE"
fi

if [ -z "$TARGET_DATABASE" ]; then
  fail "data_vault_database_name is empty in $ENV_TEMPLATE_FILE"
fi

if [[ ! "$TARGET_DATABASE" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  fail "Database name must be a plain identifier (letters, numbers, underscores, not starting with a number)."
fi

if [ -z "$POSTGRES_BOOTSTRAP_USER" ]; then
  fail "POSTGRES_BOOTSTRAP_USER is not set. Set this to the external Postgres admin/master user."
fi

if [ -z "$POSTGRES_BOOTSTRAP_PASSWORD" ]; then
  fail "POSTGRES_BOOTSTRAP_PASSWORD is not set. Set this to the external Postgres admin/master password."
fi

if [ -z "${VAULT_PASSWORD:-}" ]; then
  fail "VAULT_PASSWORD is not set. This is required so the dump can create pdi_meta/staging/data_vault users."
fi

export PGPASSWORD="$POSTGRES_BOOTSTRAP_PASSWORD"

# Compatibility for scripts/dumps originally written for the official postgres image.
export POSTGRES_USER="$POSTGRES_BOOTSTRAP_USER"
export POSTGRES_PASSWORD="$POSTGRES_BOOTSTRAP_PASSWORD"
export POSTGRES_DB="$TARGET_DATABASE"

echo "============================================================"
echo "External PostgreSQL bootstrap"
echo "============================================================"
echo "Target host:             $TARGET_HOST"
echo "Target port:             $TARGET_PORT"
echo "Target database:         $TARGET_DATABASE"
echo "Bootstrap user:          $POSTGRES_BOOTSTRAP_USER"
echo "Bootstrap database:      $POSTGRES_BOOTSTRAP_DATABASE"
echo "Init directory:          $INIT_DIR"
echo "Create external DB:      $CREATE_EXTERNAL_DATABASE"
echo "Bootstrap marker:        $BOOTSTRAP_NAME"
echo "Bootstrap version:       $BOOTSTRAP_VERSION"
echo "Force bootstrap:         $FORCE_EXTERNAL_BOOTSTRAP"
echo "============================================================"

echo "Waiting for PostgreSQL at ${TARGET_HOST}:${TARGET_PORT}..."

until pg_isready -h "$TARGET_HOST" -p "$TARGET_PORT" -U "$POSTGRES_BOOTSTRAP_USER" >/dev/null 2>&1; do
  echo "Waiting for PostgreSQL..."
  sleep 2
done

echo "PostgreSQL is reachable."

if is_truthy "$CREATE_EXTERNAL_DATABASE"; then
  echo "CREATE_EXTERNAL_DATABASE=true. Creating database if it does not already exist."

  psql \
    -h "$TARGET_HOST" \
    -p "$TARGET_PORT" \
    -U "$POSTGRES_BOOTSTRAP_USER" \
    -d "$POSTGRES_BOOTSTRAP_DATABASE" \
    -v ON_ERROR_STOP=1 \
    -v target_database="$TARGET_DATABASE" <<'SQL'
SELECT format('CREATE DATABASE %I', :'target_database')
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = :'target_database'
)\gexec
SQL
else
  echo "CREATE_EXTERNAL_DATABASE=false. Assuming target database already exists or will be created by the dump."
fi

echo "Checking bootstrap connection..."

psql \
  -h "$TARGET_HOST" \
  -p "$TARGET_PORT" \
  -U "$POSTGRES_BOOTSTRAP_USER" \
  -d "$POSTGRES_BOOTSTRAP_DATABASE" \
  -v ON_ERROR_STOP=1 \
  -c "select current_database(), current_user;"

if bootstrap_marker_exists && ! is_truthy "$FORCE_EXTERNAL_BOOTSTRAP"; then
  echo "============================================================"
  echo "External PostgreSQL bootstrap marker already exists."
  echo "Bootstrap name: $BOOTSTRAP_NAME"
  echo "Skipping database restore/bootstrap."
  echo "============================================================"
  exit 0
fi

if [ ! -d "$INIT_DIR" ]; then
  fail "Init directory not found: $INIT_DIR"
fi

core_files=(
  "$INIT_DIR/01-vault-password.sh"
  "$INIT_DIR/02-dump.sql"
)

for core_file in "${core_files[@]}"; do
  if [ ! -f "$core_file" ]; then
    fail "Required core bootstrap file not found or not a regular file: $core_file"
  fi
done

shopt -s nullglob dotglob
init_entries=("$INIT_DIR"/*)

for entry in "${init_entries[@]}"; do
  base_file="$(basename "$entry")"

  case "$base_file" in
    01-vault-password.sh|02-dump.sql)
      ;;
    *)
      echo "Skipping non-core file during external PostgreSQL bootstrap: $base_file"
      ;;
  esac
done

echo "Running shell bootstrap file: ${core_files[0]}"
bash "${core_files[0]}"

echo "Running SQL bootstrap file: ${core_files[1]}"
psql \
  -h "$TARGET_HOST" \
  -p "$TARGET_PORT" \
  -U "$POSTGRES_BOOTSTRAP_USER" \
  -d "$POSTGRES_BOOTSTRAP_DATABASE" \
  -v ON_ERROR_STOP=1 \
  -v target_database="$TARGET_DATABASE" \
  -f "${core_files[1]}"

echo "Writing external PostgreSQL bootstrap marker..."
write_bootstrap_marker
echo "External PostgreSQL bootstrap marker written."

echo "============================================================"
echo "External PostgreSQL bootstrap complete."
echo "============================================================"
