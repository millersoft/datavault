'use strict';

// DDL from the deployment pages should finish in seconds, so the default stays
// short. Studio Plus rebuilds persisted Business Models with CREATE TABLE AS
// SELECT, which can legitimately run for minutes on a large Vault, so a caller
// may ask for longer. The request is clamped so the browser can never disable
// the safety net entirely.
const DEFAULT_STATEMENT_TIMEOUT_SECONDS = 120;
const MIN_STATEMENT_TIMEOUT_SECONDS = 10;
const MAX_STATEMENT_TIMEOUT_SECONDS = 3600;

function statementTimeoutSeconds(requested){
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_STATEMENT_TIMEOUT_SECONDS;
  return Math.min(MAX_STATEMENT_TIMEOUT_SECONDS, Math.max(MIN_STATEMENT_TIMEOUT_SECONDS, Math.round(value)));
}

module.exports = {
  DEFAULT_STATEMENT_TIMEOUT_SECONDS,
  MIN_STATEMENT_TIMEOUT_SECONDS,
  MAX_STATEMENT_TIMEOUT_SECONDS,
  statementTimeoutSeconds,
};
