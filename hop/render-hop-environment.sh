#!/bin/bash
set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <template.json> <output.json>" >&2
  exit 2
fi

TEMPLATE_FILE="$1"
OUTPUT_FILE="$2"

if [ ! -f "$TEMPLATE_FILE" ]; then
  echo "ERROR: Hop environment template not found: $TEMPLATE_FILE" >&2
  exit 1
fi

if [ -z "${VAULT_PASSWORD:-}" ]; then
  echo "ERROR: VAULT_PASSWORD is not set." >&2
  exit 1
fi

if [ -z "${SOURCE_PASSWORD:-}" ]; then
  echo "ERROR: SOURCE_PASSWORD is not set." >&2
  exit 1
fi

umask 077
TMP_FILE="$(mktemp "${OUTPUT_FILE}.tmp.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT

VAULT_PASSWORD="$VAULT_PASSWORD" SOURCE_PASSWORD="$SOURCE_PASSWORD" awk '
BEGIN {
  backslash = sprintf("%c", 92)
  vault_token = "${VAULT_PASSWORD}"
  source_token = "${SOURCE_PASSWORD}"

  # Environment variables cannot contain NUL. Map every other JSON control
  # character so it can be emitted as a portable Unicode escape.
  for (code = 1; code < 32; code++) {
    control_code[sprintf("%c", code)] = code
  }

  vault_value = json_escape(ENVIRON["VAULT_PASSWORD"])
  source_value = json_escape(ENVIRON["SOURCE_PASSWORD"])
}

function json_escape(value,    escaped, i, char) {
  escaped = ""

  for (i = 1; i <= length(value); i++) {
    char = substr(value, i, 1)

    if (char == backslash) {
      escaped = escaped backslash backslash
    } else if (char == "\"") {
      escaped = escaped backslash "\""
    } else if (char in control_code) {
      escaped = escaped backslash sprintf("u%04x", control_code[char])
    } else {
      escaped = escaped char
    }
  }

  return escaped
}

# Replace tokens found in the original template in one pass. Inserted password
# text is never scanned again, so placeholder-like text inside a password is
# preserved literally.
function render(line,    output, vault_at, source_at, token_at, token, value) {
  output = ""

  while (1) {
    vault_at = index(line, vault_token)
    source_at = index(line, source_token)

    if (vault_at == 0 && source_at == 0) {
      return output line
    }

    if (vault_at > 0 && (source_at == 0 || vault_at < source_at)) {
      token_at = vault_at
      token = vault_token
      value = vault_value
      vault_replacements++
    } else {
      token_at = source_at
      token = source_token
      value = source_value
      source_replacements++
    }

    output = output substr(line, 1, token_at - 1) value
    line = substr(line, token_at + length(token))
  }
}

{
  print render($0)
}

END {
  if (vault_replacements == 0 || source_replacements == 0) {
    print "ERROR: Hop environment template is missing one or more password placeholders." > "/dev/stderr"
    exit 1
  }
}
' "$TEMPLATE_FILE" > "$TMP_FILE"

chmod 600 "$TMP_FILE"
mv -f "$TMP_FILE" "$OUTPUT_FILE"
trap - EXIT
