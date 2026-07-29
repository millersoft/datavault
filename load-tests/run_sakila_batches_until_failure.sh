#!/usr/bin/env bash
set -uo pipefail

# Usage:
#   ./run_sakila_batches_until_failure.sh auto
#   ./run_sakila_batches_until_failure.sh manual
#   ./run_sakila_batches_until_failure.sh -a
#   ./run_sakila_batches_until_failure.sh -m
#
# Environment overrides:
#   CONTAINER=dv-mysql
#   MYSQL_USER=sakila
#   MYSQL_PASSWORD=sourcesecret
#   MYSQL_DB=sakila
#   SQL_FILE=sakila_load_test_batched_explicit_ids.sql
#   SLEEP_SECONDS=0
#   SUCCESS_SNAPSHOT=0   # set to 1 if you want an extra summary from the runner

CONTAINER="${CONTAINER:-dv-mysql}"
MYSQL_USER="${MYSQL_USER:-sakila}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-sourcesecret}"
MYSQL_DB="${MYSQL_DB:-sakila}"
SQL_FILE="${SQL_FILE:-sakila_load_test_batched_explicit_ids.sql}"
SLEEP_SECONDS="${SLEEP_SECONDS:-0}"
SUCCESS_SNAPSHOT="${SUCCESS_SNAPSHOT:-0}"
MODE="${1:-${MODE:-auto}}"

usage() {
  cat <<USAGE
Usage:
  $0 auto
  $0 manual
  $0 -a
  $0 -m

Modes:
  auto      Keep running 10,000-row batches until MySQL fails. This is the default.
  manual    Run one 10,000-row batch, then wait for Enter before continuing.

Environment overrides:
  CONTAINER=dv-mysql
  MYSQL_USER=sakila
  MYSQL_PASSWORD=sourcesecret
  MYSQL_DB=sakila
  SQL_FILE=sakila_load_test_batched_explicit_ids.sql
  SLEEP_SECONDS=0
  SUCCESS_SNAPSHOT=0

Examples:
  $0 auto
  $0 manual
  SQL_FILE=sakila_load_test_batched_explicit_ids.sql $0 manual
USAGE
}

case "$MODE" in
  auto|--auto|-a)
    MODE="auto"
    ;;
  manual|--manual|-m)
    MODE="manual"
    ;;
  help|--help|-h)
    usage
    exit 0
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    echo >&2
    usage >&2
    exit 2
    ;;
esac

if [ ! -f "$SQL_FILE" ]; then
  echo "Cannot find SQL file: $SQL_FILE" >&2
  echo "Run this script from the folder containing $SQL_FILE, or pass SQL_FILE=/path/to/file.sql." >&2
  exit 2
fi

run_sql_file() {
  docker exec -i -e MYSQL_PWD="$MYSQL_PASSWORD" "$CONTAINER" \
    mysql --show-warnings -u "$MYSQL_USER" "$MYSQL_DB" < "$SQL_FILE"
}

run_sql() {
  local sql="$1"
  docker exec -i -e MYSQL_PWD="$MYSQL_PASSWORD" "$CONTAINER" \
    mysql --show-warnings -u "$MYSQL_USER" "$MYSQL_DB" -e "$sql"
}

print_success_snapshot() {
  if [ "$SUCCESS_SNAPSHOT" != "1" ]; then
    return 0
  fi

  run_sql "
    SELECT
      (SELECT COUNT(*) FROM actor)      AS actor_total,
      (SELECT MAX(actor_id) FROM actor) AS actor_max_id,
      (SELECT COUNT(*) FROM customer)      AS customer_total,
      (SELECT MAX(customer_id) FROM customer) AS customer_max_id,
      (SELECT COUNT(*) FROM film)      AS film_total,
      (SELECT MAX(film_id) FROM film) AS film_max_id,
      (SELECT COUNT(*) FROM film_actor) AS film_actor_total,
      (SELECT COUNT(*) FROM inventory) AS inventory_total,
      (SELECT MAX(inventory_id) FROM inventory) AS inventory_max_id;
  "
}

wait_for_manual_continue() {
  local next_batch="$1"
  local answer=""

  if [ "$MODE" != "manual" ]; then
    return 0
  fi

  if [ ! -r /dev/tty ]; then
    echo "Manual mode needs an interactive terminal so it can wait for Enter." >&2
    exit 2
  fi

  while true; do
    printf "\nPress Enter to run batch %s, or type q then Enter to stop: " "$next_batch" > /dev/tty
    if ! IFS= read -r answer < /dev/tty; then
      echo >&2
      echo "No input received; stopping." >&2
      exit 0
    fi

    case "$answer" in
      "")
        return 0
        ;;
      q|Q|quit|QUIT|exit|EXIT)
        echo "Stopping by user request."
        exit 0
        ;;
      *)
        echo "Please press Enter to continue, or type q then Enter to stop." > /dev/tty
        ;;
    esac
  done
}

batch=0

echo "=== Sakila load batch runner started in $MODE mode ==="
echo "=== SQL file: $SQL_FILE ==="

while true; do
  batch=$((batch + 1))
  echo
  echo "=== Running Sakila load batch $batch at $(date '+%Y-%m-%d %H:%M:%S') ==="

  if run_sql_file; then
    echo "=== Batch $batch completed successfully ==="
    print_success_snapshot
  else
    rc=$?
    echo
    echo "=== Batch $batch failed with exit code $rc ==="
    echo "=== ID/capacity snapshot at failure ==="
    run_sql "
      SELECT
        c.table_name,
        c.column_name,
        c.column_type,
        t.auto_increment
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
      WHERE c.table_schema = 'sakila'
        AND c.extra LIKE '%auto_increment%'
      ORDER BY c.table_name;

      SELECT
        (SELECT COUNT(*) FROM actor)      AS actor_total,
        (SELECT MAX(actor_id) FROM actor) AS actor_max_id,
        (SELECT COUNT(*) FROM customer)      AS customer_total,
        (SELECT MAX(customer_id) FROM customer) AS customer_max_id,
        (SELECT COUNT(*) FROM film)      AS film_total,
        (SELECT MAX(film_id) FROM film) AS film_max_id,
        (SELECT COUNT(*) FROM film_actor) AS film_actor_total,
        (SELECT COUNT(*) FROM inventory) AS inventory_total,
        (SELECT MAX(inventory_id) FROM inventory) AS inventory_max_id;
    " || true
    exit "$rc"
  fi

  if [ "$SLEEP_SECONDS" != "0" ]; then
    sleep "$SLEEP_SECONDS"
  fi

  wait_for_manual_continue "$((batch + 1))"
done
