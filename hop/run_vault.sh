#!/bin/bash
set -e
set -o pipefail

LICENSE_FILE="${LICENSE_FILE:-/app/LICENSE}"
LICENSE_STATE_DIR="${LICENSE_STATE_DIR:-/var/lib/datavault-hop}"
LICENSE_MARKER="${LICENSE_STATE_DIR}/license.accepted"
ACCEPT_LICENSE="${ACCEPT_LICENSE:-false}"
DEMO_MODE="${DEMO_MODE:-false}"
WAIT_FOR_MYSQL="${WAIT_FOR_MYSQL:-false}"
DATABASE_READY_TIMEOUT_SECONDS="${DATABASE_READY_TIMEOUT_SECONDS:-300}"
DATABASE_READY_RETRY_INTERVAL_SECONDS="${DATABASE_READY_RETRY_INTERVAL_SECONDS:-2}"
DATABASE_READY_CONNECT_TIMEOUT_SECONDS="${DATABASE_READY_CONNECT_TIMEOUT_SECONDS:-5}"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

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

validate_positive_integer() {
  local name="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    fail "$name must be a positive integer; got '$value'."
  fi
}

wait_for_tcp_service() {
  local host="$1"
  local port="$2"
  local service_name="$3"
  local started_at now elapsed remaining sleep_seconds

  started_at="$(date +%s)"

  until nc -z -w "$DATABASE_READY_CONNECT_TIMEOUT_SECONDS" "$host" "$port"; do
    now="$(date +%s)"
    elapsed=$((now - started_at))

    if (( elapsed >= DATABASE_READY_TIMEOUT_SECONDS )); then
      fail "Timed out after ${DATABASE_READY_TIMEOUT_SECONDS}s waiting for ${service_name} at ${host}:${port}. Check the host and port, or increase DATABASE_READY_TIMEOUT_SECONDS."
    fi

    remaining=$((DATABASE_READY_TIMEOUT_SECONDS - elapsed))
    sleep_seconds="$DATABASE_READY_RETRY_INTERVAL_SECONDS"
    if (( sleep_seconds > remaining )); then
      sleep_seconds="$remaining"
    fi

    echo "Waiting for ${service_name} at ${host}:${port} (${elapsed}s elapsed; timeout ${DATABASE_READY_TIMEOUT_SECONDS}s)..."
    sleep "$sleep_seconds"
  done
}

validate_positive_integer "DATABASE_READY_TIMEOUT_SECONDS" "$DATABASE_READY_TIMEOUT_SECONDS"
validate_positive_integer "DATABASE_READY_RETRY_INTERVAL_SECONDS" "$DATABASE_READY_RETRY_INTERVAL_SECONDS"
validate_positive_integer "DATABASE_READY_CONNECT_TIMEOUT_SECONDS" "$DATABASE_READY_CONNECT_TIMEOUT_SECONDS"

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
  local env_file="${ENV_TEMPLATE_FILE:-/app/postgres-environment.json}"
  local value

  if [ ! -f "$env_file" ]; then
    printf '%s' ""
    return 0
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
    ' "$env_file"
  )"

  resolve_config_value "$value"
}

load_jdbc_drivers() {
  local driver_dir="/opt/hop/lib/jdbc-extra"
  local target_dir="/opt/hop/lib/jdbc"

  echo "=== Loading user-supplied JDBC drivers ==="

  mkdir -p "$target_dir"

  if [ ! -d "$driver_dir" ]; then
    echo "No JDBC driver directory mounted at $driver_dir. Continuing..."
    return 0
  fi

  echo "Contents of $driver_dir:"
  ls -la "$driver_dir" || true

  local found_driver="false"

  for jar_file in "$driver_dir"/*.jar "$driver_dir"/*.JAR; do
    if [ ! -f "$jar_file" ]; then
      continue
    fi

    found_driver="true"
    echo "Copying JDBC driver: $jar_file"
    cp "$jar_file" "$target_dir/"
  done

  if [ "$found_driver" != "true" ]; then
    cat <<MSG
No JDBC driver JARs found in:

  jdbc-drivers/

Expected to find one or more .jar files inside:

  $driver_dir

MSG
    return 0
  fi

  echo "JDBC drivers copied to $target_dir"

  echo "JARs now available to Hop:"
  ls -la "$target_dir"/*.jar "$target_dir"/*.JAR 2>/dev/null || true
}

check_license_file_exists() {
  if [ ! -f "$LICENSE_FILE" ]; then
    fail "License file not found at ${LICENSE_FILE}"
  fi
}

license_hash() {
  check_license_file_exists

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$LICENSE_FILE" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$LICENSE_FILE" | awk '{print $1}'
  else
    fail "Neither sha256sum nor shasum is available in the container."
  fi
}

license_marker_is_valid() {
  check_license_file_exists

  if [ ! -f "$LICENSE_MARKER" ]; then
    return 1
  fi

  current_hash="$(license_hash)"

  grep -qx "license_sha256=${current_hash}" "$LICENSE_MARKER"
}

write_license_marker_from_env() {
  check_license_file_exists
  mkdir -p "$LICENSE_STATE_DIR"

  {
    echo "license_sha256=$(license_hash)"
    echo "accepted_at_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "accepted_method=ACCEPT_LICENSE environment variable"
  } > "$LICENSE_MARKER"
}

ensure_license_accepted() {
  check_license_file_exists

  if license_marker_is_valid; then
    log "License already accepted. Continuing..."
    return 0
  fi

  if is_truthy "$ACCEPT_LICENSE"; then
    write_license_marker_from_env
    log "License accepted via ACCEPT_LICENSE=true. Continuing..."
    return 0
  fi

  cat >&2 <<MSG

============================================================
LICENSE ACCEPTANCE REQUIRED
============================================================

The ETL process has not started.

Start the stack using the project launcher:

  ./start.sh --build

The launcher asks for Y/N/V before Docker Compose starts and writes a
license marker here:

  .license-state/license.accepted

For automation only, you may bypass the prompt with:

  ACCEPT_LICENSE=true docker compose up --build

No valid license acceptance marker was found inside the container at:

  ${LICENSE_MARKER}

MSG

  exit 2
}

ensure_license_accepted

load_jdbc_drivers

TARGET_DB_HOST="$(get_hop_env_value "data_vault_host_name")"
TARGET_DB_PORT="$(get_hop_env_value "data_vault_port_number")"

TARGET_DB_HOST="${TARGET_DB_HOST:-${DB_HOST:-postgres}}"
TARGET_DB_PORT="${TARGET_DB_PORT:-${DB_PORT:-5432}}"

echo "=== Waiting for target database ==="
wait_for_tcp_service "$TARGET_DB_HOST" "$TARGET_DB_PORT" "target database"
echo "Target database is ready!"

if is_truthy "$WAIT_FOR_MYSQL"; then
  echo "=== Waiting for bundled MySQL demo source ==="
  wait_for_tcp_service "$MYSQL_HOST" "$MYSQL_PORT" "MySQL demo source"
  echo "MySQL demo source is ready!"
else
  echo "Skipping bundled MySQL wait because demo mode is disabled."
fi

echo "=== Setting up Hop Project & Environment ==="

mkdir -p /tmp/hop-config
chmod -R 777 /tmp/hop-config 2>/dev/null || true

PROJECT_CONFIG_FILE="/app/project-config.json"
ENV_TEMPLATE_FILE="/app/postgres-environment.json"
ENV_RUNTIME_DIR="$(mktemp -d /tmp/datavault-hop-env.XXXXXX)"
ENV_RESOLVED_FILE="${ENV_RUNTIME_DIR}/postgres-environment.json"
chmod 700 "$ENV_RUNTIME_DIR"
trap 'rm -rf "$ENV_RUNTIME_DIR"' EXIT

# Project
if [ -f "$PROJECT_CONFIG_FILE" ]; then
  echo "Project config already exists at $PROJECT_CONFIG_FILE. Skipping Hop project creation."
else
  echo "Project config not found. Creating Hop project config at $PROJECT_CONFIG_FILE."

  $HOP_HOME/hop-conf.sh \
    --project-create \
    --project dv-latest \
    --project-home "$PROJECT_HOME" \
    --project-config-file "$PROJECT_CONFIG_FILE"
fi

# Environment
# Hop does not recursively expand arbitrary OS environment variables stored as
# environment JSON values, so render a protected runtime config before hop-run.
echo "Resolving Hop environment secrets into $ENV_RESOLVED_FILE."
/app/render-hop-environment.sh "$ENV_TEMPLATE_FILE" "$ENV_RESOLVED_FILE"

echo "Creating Hop environment from resolved config."

$HOP_HOME/hop-conf.sh \
  --environment-create \
  --environment "$ENV_NAME" \
  --environment-project dv-latest \
  --environment-purpose Development \
  --environment-config-files "$ENV_RESOLVED_FILE"

echo "=== Running Hop ETL ==="

mkdir -p "$LOG_DIR"

RUN_TS="$(date -u '+%Y%m%dT%H%M%SZ')"
STAGING_LOG_FILE="${LOG_DIR}/hop-staging-${RUN_TS}.log"
VAULT_LOG_FILE="${LOG_DIR}/hop-data-vault-${RUN_TS}.log"

echo "Staging log file: $STAGING_LOG_FILE"
echo "Data Vault log file: $VAULT_LOG_FILE"

set +e

$HOP_HOME/hop-run.sh \
  -j dv-latest \
  -e "$ENV_NAME" \
  -f "${PROJECT_HOME}/staging_generic/job_complete_batch_staging.hwf" \
  -p "$PARAMS_STAGE" \
  -r "$RUN_CONFIG" 2>&1 | tee "$STAGING_LOG_FILE"

STAGING_STATUS=${PIPESTATUS[0]}

if [ "$STAGING_STATUS" -ne 0 ]; then
  echo "ERROR: Staging Hop job failed with exit code $STAGING_STATUS"
  exit "$STAGING_STATUS"
fi

$HOP_HOME/hop-run.sh \
  -j dv-latest \
  -e "$ENV_NAME" \
  -f "${PROJECT_HOME}/data_vault/job_data_vault_all_incl_md.hwf" \
  -p "$PARAMS_VAULT" \
  -r "$RUN_CONFIG" 2>&1 | tee "$VAULT_LOG_FILE"

VAULT_STATUS=${PIPESTATUS[0]}

if [ "$VAULT_STATUS" -ne 0 ]; then
  echo "ERROR: Data Vault Hop job failed with exit code $VAULT_STATUS"
  exit "$VAULT_STATUS"
fi

set -e

echo "=== ETL complete ==="
