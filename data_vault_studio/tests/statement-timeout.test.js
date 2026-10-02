'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_STATEMENT_TIMEOUT_SECONDS,
  MIN_STATEMENT_TIMEOUT_SECONDS,
  MAX_STATEMENT_TIMEOUT_SECONDS,
  statementTimeoutSeconds,
} = require('../server/statement-timeout');

describe('statement timeout requested by the browser', () => {
  test('defaults to the routine DDL limit when nothing valid is requested', () => {
    for (const value of [undefined, null, '', 'abc', 0, -5, NaN]) {
      assert.strictEqual(statementTimeoutSeconds(value), DEFAULT_STATEMENT_TIMEOUT_SECONDS);
    }
  });

  test('accepts a longer limit for table builds', () => {
    assert.strictEqual(statementTimeoutSeconds(1800), 1800);
    assert.strictEqual(statementTimeoutSeconds('900'), 900);
  });

  test('is clamped so it can never be disabled or made unbounded', () => {
    assert.strictEqual(statementTimeoutSeconds(1), MIN_STATEMENT_TIMEOUT_SECONDS);
    assert.strictEqual(statementTimeoutSeconds(999999), MAX_STATEMENT_TIMEOUT_SECONDS);
  });

  test('always yields a plain integer safe to interpolate into SET LOCAL statement_timeout', () => {
    for (const value of [12.7, '45', '1e3', '30; DROP TABLE x']) {
      assert.match(`${statementTimeoutSeconds(value)}`, /^\d+$/);
    }
  });
});
