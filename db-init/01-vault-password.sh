#!/bin/bash
set -e

DUMP_FILE="/docker-entrypoint-initdb.d/02-dump.sql"

echo "=== Resolving VAULT_PASSWORD in 02-dump.sql ==="

if [ -z "${VAULT_PASSWORD:-}" ]; then
  echo "ERROR: VAULT_PASSWORD is not set."
  exit 1
fi

sed -i "s|VAULT_PASSWORD|${VAULT_PASSWORD}|g" "$DUMP_FILE"

if [ "${EXTERNAL_POSTGRES_BOOTSTRAP:-false}" != "true" ]; then

  TARGET_DATABASE="${INTERNAL_DATA_VAULT_DATABASE:-datavault}"
  if [[ ! "$TARGET_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "ERROR: INTERNAL_DATA_VAULT_DATABASE must be a plain SQL identifier."
    exit 1
  fi

  echo "=== Internal PostgreSQL init detected. Selecting target database: ${TARGET_DATABASE} ==="
  sed -i "s/^\\\\set target_database datavault$/\\\\set target_database ${TARGET_DATABASE}/" "$DUMP_FILE"
  if ! grep -Fxq "\\set target_database ${TARGET_DATABASE}" "$DUMP_FILE"; then
    echo "ERROR: Failed to set the internal target database in 02-dump.sql."
    exit 1
  fi

  echo "=== Skipping external bootstrap role grants. ==="
  echo "=== 02-dump.sql ready ==="
  exit 0
fi

BOOTSTRAP_ROLE="${POSTGRES_BOOTSTRAP_USER:-}"

if [ -z "$BOOTSTRAP_ROLE" ]; then
  echo "ERROR: POSTGRES_BOOTSTRAP_USER is required when EXTERNAL_POSTGRES_BOOTSTRAP=true."
  exit 1
fi

echo "=== Adding external bootstrap role grants to 02-dump.sql ==="

if grep -q "External bootstrap role grants added by 01-vault-password.sh" "$DUMP_FILE"; then
  echo "External bootstrap grants already present. Skipping."
else
  tmp_file="${DUMP_FILE}.tmp"

  awk -v bootstrap_role="$BOOTSTRAP_ROLE" '
    function quote_ident(value) {
      gsub(/"/, "\"\"", value)
      return "\"" value "\""
    }

    {
      print

      if ($0 ~ /^DO[[:space:]]+\$\$/) {
        in_first_do_block = 1
      }

      if (!inserted && in_first_do_block && $0 ~ /^\$\$;[[:space:]]*$/) {
        print ""
        print "-- External bootstrap role grants added by 01-vault-password.sh"
        print "GRANT pdi_meta TO " quote_ident(bootstrap_role) ";"
        print "GRANT staging TO " quote_ident(bootstrap_role) ";"
        print "GRANT data_vault TO " quote_ident(bootstrap_role) ";"
        print ""
        inserted = 1
        in_first_do_block = 0
      }
    }

    END {
      if (!inserted) {
        print "ERROR: Failed to inject external bootstrap role grants." > "/dev/stderr"
        exit 1
      }
    }
  ' "$DUMP_FILE" > "$tmp_file"

  mv "$tmp_file" "$DUMP_FILE"
fi

echo "=== Verifying injected role grants ==="
grep -n "External bootstrap role grants added\|GRANT pdi_meta TO\|GRANT staging TO\|GRANT data_vault TO" "$DUMP_FILE"

echo "=== 02-dump.sql ready ==="
