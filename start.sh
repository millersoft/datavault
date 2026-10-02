#!/usr/bin/env bash
set -Eeuo pipefail

# Container engine can be supplied directly in the environment or configured
# in .env. An explicitly supplied environment variable takes precedence.
if [ -z "${CONTAINER_ENGINE:-}" ] && [ -f .env ]; then
  CONTAINER_ENGINE="$(
    sed -n 's/^[[:space:]]*CONTAINER_ENGINE[[:space:]]*=[[:space:]]*//p' .env |
      tail -n 1 |
      tr -d '\r' |
      sed 's/^["'\'']\(.*\)["'\'']$/\1/'
  )"
fi

CONTAINER_ENGINE="${CONTAINER_ENGINE:-docker}"

LICENSE_FILE="${LICENSE_FILE:-LICENSE}"
LICENSE_STATE_DIR="${LICENSE_STATE_DIR:-.license-state}"
LICENSE_MARKER="${LICENSE_STATE_DIR}/license.accepted"

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

set_compose_command() {
  case "${CONTAINER_ENGINE:-docker}" in
    docker)
      if docker compose version >/dev/null 2>&1; then
        COMPOSE_IMPL="docker-compose-v2"
      elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE_IMPL="docker-compose-v1"
      else
        echo "ERROR: Docker Compose is not available." >&2
        exit 1
      fi
      ;;

    podman)
      if ! command -v podman >/dev/null 2>&1; then
        echo "ERROR: Podman is not available." >&2
        exit 1
      fi

      if ! podman info >/dev/null 2>&1; then
        echo "ERROR: Podman Machine is not running." >&2
        echo "Run: podman machine start" >&2
        exit 1
      fi

      COMPOSE_IMPL="podman"
      ;;

    *)
      echo "ERROR: Unknown container engine: ${CONTAINER_ENGINE}" >&2
      echo "Supported engines: docker, podman" >&2
      exit 1
      ;;
  esac
}

compose() {
  case "$COMPOSE_IMPL" in
    docker-compose-v2)
      docker compose "$@"
      ;;
    docker-compose-v1)
      docker-compose "$@"
      ;;
    podman)
      podman compose "$@"
      ;;
  esac
}

# Studio writes this local, ignored Compose override when users set container
# resources in the Hub.  Keep the tracked Compose definition untouched.
append_resource_override() {
  if [ -f "docker-compose.resources.yaml" ]; then
    export COMPOSE_FILE="${COMPOSE_FILE:+${COMPOSE_FILE}:}docker-compose.resources.yaml"
  fi
}

check_license_file_exists() {
  if [ ! -f "$LICENSE_FILE" ]; then
    echo "ERROR: License file not found at ${LICENSE_FILE}" >&2
    echo "Create a LICENSE file next to docker-compose.yaml, then run ./start.sh --build again." >&2
    exit 1
  fi
}

license_hash() {
  check_license_file_exists

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$LICENSE_FILE" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$LICENSE_FILE" | awk '{print $1}'
  else
    echo "ERROR: Neither sha256sum nor shasum is available on this machine." >&2
    exit 1
  fi
}

license_marker_is_valid() {
  if [ ! -f "$LICENSE_MARKER" ]; then
    return 1
  fi

  local current_hash
  current_hash="$(license_hash)"

  grep -qx "license_sha256=${current_hash}" "$LICENSE_MARKER"
}

write_license_marker() {
  mkdir -p "$LICENSE_STATE_DIR"

  {
    echo "license_sha256=$(license_hash)"
    echo "accepted_at_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "accepted_method=host start.sh launcher"
  } > "$LICENSE_MARKER"
}

show_license_menu() {
  cat <<MSG

============================================================
LICENSE AGREEMENT
============================================================

You must accept the license agreement before the ETL process can start.

Options:
  Y - Accept license and start ETL
  N - Decline license and stop
  V - View full license text

MSG
}

ensure_license_accepted() {
  check_license_file_exists

  if license_marker_is_valid; then
    echo "License already accepted. Starting Docker Compose..."
    return 0
  fi

  if is_truthy "${ACCEPT_LICENSE:-false}"; then
    write_license_marker
    echo "License accepted via ACCEPT_LICENSE=true. Starting Docker Compose..."
    return 0
  fi

  while true; do
    show_license_menu
    printf "Please choose Y, N, or V: "
    IFS= read -r choice

    case "$choice" in
      [yY]|[yY][eE][sS])
        write_license_marker
        echo ""
        echo "License accepted. Starting Docker Compose..."
        echo ""
        return 0
        ;;
      [nN]|[nN][oO])
        echo ""
        echo "License declined. Docker Compose will not be started."
        echo ""
        exit 1
        ;;
      [vV])
        echo ""
        echo "==================== FULL LICENSE TEXT ===================="
        cat "$LICENSE_FILE"
        echo ""
        echo "==========================================================="
        echo ""
        ;;
      *)
        echo ""
        echo "Invalid option. Please enter Y, N, or V."
        echo ""
        ;;
    esac
  done
}

set_compose_command

# Direct launcher commands such as `stop hop` and `ps` must resolve the same
# effective Compose project as Studio-managed starts.
export COMPOSE_FILE="docker-compose.yaml"
append_resource_override

export COMPOSE_MENU="${COMPOSE_MENU:-false}"

if [ "$#" -eq 0 ]; then
  subcommand="up"
elif [[ "${1:-}" == -* ]]; then
  subcommand="up"
else
  subcommand="$1"
  shift
fi

case "$subcommand" in
  bootstrap-external-postgres)
    ensure_license_accepted

    export COMPOSE_FILE="docker-compose.yaml:docker-compose.studio.yaml"
    append_resource_override
    export DEMO_MODE=false
    export WAIT_FOR_MYSQL=false

    compose --profile external-postgres-bootstrap build metadata-bootstrap
    compose --profile external-postgres-bootstrap run --rm metadata-bootstrap
    exit 0
    ;;

  up)
    ensure_license_accepted

    demo_mode=false
    external_postgres=false
    fdw_mode=false
    build_requested=false
    studio_build=false
    compose_build_forwarded=false

    # Use the Studio override by default so a fresh internal PostgreSQL volume
    # cannot create design-specific tables before the GUI deployment workflow
    # runs. An internal PostgreSQL --build opts into the packaged 03-ddls.sql
    # instead.
    export COMPOSE_FILE="docker-compose.yaml"

    original_arg_count=$#

    while [ "$original_arg_count" -gt 0 ]; do
      arg="$1"
      shift
      original_arg_count=$((original_arg_count - 1))

      case "$arg" in
        --demo)
          demo_mode=true
          ;;
        --external-postgres)
          external_postgres=true
          ;;
        --fdw)
          fdw_mode=true
          ;;
        --build)
          build_requested=true
          if [ "$compose_build_forwarded" = false ]; then
            set -- "$@" --build
            compose_build_forwarded=true
          fi
          ;;
        --studio-build)
          studio_build=true
          build_requested=true
          if [ "$compose_build_forwarded" = false ]; then
            set -- "$@" --build
            compose_build_forwarded=true
          fi
          ;;
        *)
          set -- "$@" "$arg"
          ;;
      esac
    done

    if [ "$demo_mode" = true ] && [ "$external_postgres" = true ]; then
      echo "ERROR: --demo and --external-postgres cannot be used together." >&2
      echo "The bundled Sakila demo is only supported with the internal Docker PostgreSQL service." >&2
      exit 1
    fi

    if [ "$fdw_mode" = true ] && [ "$external_postgres" = true ]; then
      echo "ERROR: --fdw and --external-postgres cannot be used together." >&2
      echo "FDW mode requires the packaged PostgreSQL service." >&2
      exit 1
    fi

    if [ "$studio_build" = true ] && [ "$external_postgres" = true ]; then
      echo "ERROR: --studio-build is only valid for Studio-managed internal PostgreSQL." >&2
      echo "Use --build with --external-postgres to keep the external bootstrap semantics." >&2
      exit 1
    fi

    if [ "$build_requested" = true ] && [ "$studio_build" = false ] && [ "$external_postgres" = false ] && [ "$fdw_mode" = false ]; then
      echo "Build requested. Packaged 03-ddls.sql is enabled and will run only when PostgreSQL initializes a new data volume."
    else
      # Studio-managed and FDW starts must keep the Studio override so a build
      # never re-enables design-specific init SQL on a fresh PostgreSQL volume.
      export COMPOSE_FILE="${COMPOSE_FILE}:docker-compose.studio.yaml"
    fi

    if [ "$fdw_mode" = true ]; then
      export COMPOSE_FILE="${COMPOSE_FILE}:docker-compose.fdw.yaml"
      echo "FDW mode enabled for packaged PostgreSQL."
    fi
    append_resource_override

    if [ "$external_postgres" = true ]; then
      echo "Starting in EXTERNAL POSTGRES mode."
      echo "Internal Docker PostgreSQL will not be started."
      echo "Bundled Sakila MySQL source will not be started."

      export DEMO_MODE=false
      export WAIT_FOR_MYSQL=false

      if [ "$build_requested" = true ]; then
        echo "Build requested. Running external PostgreSQL bootstrap/setup only."
        echo "Hop ETL will not be started in this step."

        compose --profile external-postgres-bootstrap build metadata-bootstrap
        compose --profile external-postgres-bootstrap run --rm metadata-bootstrap

        echo "Building Hop image for later ETL launch."
        compose build hop

        echo "External PostgreSQL setup complete."
        echo "Create staging/Data Vault tables using the GUI, then launch ETL with:"
        echo ""
        echo "  ./start.sh --external-postgres"
        echo ""

        exit 0
      else
        echo "No --build flag provided. Skipping external PostgreSQL bootstrap."
        echo "Starting Hop ETL against external PostgreSQL."

        compose up "$@"
        exit $?
      fi
    fi

    if [ "$demo_mode" = true ]; then
      echo "Starting in DEMO mode. Bundled Sakila MySQL source will be started."

      export DEMO_MODE=true
      export WAIT_FOR_MYSQL=true

      compose --profile internal-postgres --profile demo up "$@"
      exit $?
    fi

    echo "Starting in normal INTERNAL POSTGRES mode. Bundled Sakila MySQL source will not be started."

    export DEMO_MODE=false
    export WAIT_FOR_MYSQL=false

    compose --profile internal-postgres up "$@"
    exit $?
    ;;

  down)
    compose --profile internal-postgres --profile demo --profile external-postgres-bootstrap down "$@"
    exit $?
    ;;

  *)
    compose "$subcommand" "$@"
    exit $?
    ;;
esac
