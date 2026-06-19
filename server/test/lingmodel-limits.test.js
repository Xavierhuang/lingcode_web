// Tests for the runtime tier-limit override pipeline.
// loadLingModelLimits should read DB → env → hard-coded default in that
// priority, and lingModelLimitValue should reject negative / non-integer
// inputs (falling through to env / default instead of NaN-poisoning).

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { loadLingModelLimits, lingModelLimitValue } = require('../inference-anthropic.js');

// Saved env state — restored after the suite so we don't pollute siblings.
const SAVED_ENV = {};
const KEYS = [
  'LINGMODEL_FREE_DAILY_PROMPT_LIMIT',
  'LINGMODEL_FREE_BURST_PER_MIN',
  'LINGMODEL_PRO_DAILY_PROMPT_LIMIT',
  'LINGMODEL_PRO_5H_PROMPT_LIMIT',
  'LINGMODEL_MAX_PRO_DAILY_PROMPT_LIMIT',
];

before(() => {
  for (const k of KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});
after(() => {
  for (const k of KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

function makeDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
  return db;
}

describe('lingModelLimitValue', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  test('returns DB value when set', () => {
    db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run('LINGMODEL_FREE_DAILY_PROMPT_LIMIT', '200', Date.now());
    assert.equal(lingModelLimitValue(db, 'LINGMODEL_FREE_DAILY_PROMPT_LIMIT', 25), 200);
  });

  test('falls through to env when DB empty', () => {
    process.env.LINGMODEL_FREE_DAILY_PROMPT_LIMIT = '75';
    assert.equal(lingModelLimitValue(db, 'LINGMODEL_FREE_DAILY_PROMPT_LIMIT', 25), 75);
    delete process.env.LINGMODEL_FREE_DAILY_PROMPT_LIMIT;
  });

  test('falls through to default when neither DB nor env set', () => {
    assert.equal(lingModelLimitValue(db, 'LINGMODEL_FREE_DAILY_PROMPT_LIMIT', 25), 25);
  });

  test('DB beats env', () => {
    db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run('LINGMODEL_FREE_DAILY_PROMPT_LIMIT', '500', Date.now());
    process.env.LINGMODEL_FREE_DAILY_PROMPT_LIMIT = '999';
    assert.equal(lingModelLimitValue(db, 'LINGMODEL_FREE_DAILY_PROMPT_LIMIT', 25), 500);
    delete process.env.LINGMODEL_FREE_DAILY_PROMPT_LIMIT;
  });

  test('rejects non-integer DB rows → falls through to env/default', () => {
    db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run('LINGMODEL_FREE_DAILY_PROMPT_LIMIT', 'not-a-number', Date.now());
    assert.equal(lingModelLimitValue(db, 'LINGMODEL_FREE_DAILY_PROMPT_LIMIT', 42), 42);
  });

  test('rejects negative DB rows → falls through', () => {
    db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run('LINGMODEL_FREE_DAILY_PROMPT_LIMIT', '-5', Date.now());
    assert.equal(lingModelLimitValue(db, 'LINGMODEL_FREE_DAILY_PROMPT_LIMIT', 42), 42);
  });

  test('zero is a valid value (operator "no cap" escape hatch)', () => {
    db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run('LINGMODEL_PRO_DAILY_PROMPT_LIMIT', '0', Date.now());
    assert.equal(lingModelLimitValue(db, 'LINGMODEL_PRO_DAILY_PROMPT_LIMIT', 500), 0);
  });

  test('survives db=null (covers the never-instantiated case)', () => {
    assert.equal(lingModelLimitValue(null, 'LINGMODEL_FREE_DAILY_PROMPT_LIMIT', 25), 25);
  });

  test('survives missing app_config table (first-boot case)', () => {
    const bareDb = new Database(':memory:'); // no migrations run
    assert.equal(lingModelLimitValue(bareDb, 'LINGMODEL_FREE_DAILY_PROMPT_LIMIT', 25), 25);
  });
});

describe('loadLingModelLimits — full snapshot', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  test('returns all 13 limits with correct defaults when nothing is set', () => {
    const limits = loadLingModelLimits(db);
    // Spot-check the documented defaults — protects against accidental edits
    // to the parseDefaults inside loadLingModelLimits.
    assert.equal(limits.freeDailyPromptLimit, 25);
    assert.equal(limits.freeBurstPerMin, 10);
    assert.equal(limits.proDailyPromptLimit, 500);
    assert.equal(limits.pro5hPromptLimit, 30);
    assert.equal(limits.proDailyOutputTokens, 600000);
    assert.equal(limits.proMonthlyOutputTokens, 8000000);
    assert.equal(limits.maxProDailyPromptLimit, 0);
    assert.equal(limits.maxProDailyOutputTokens, 0); // Max Pro is uncapped on tokens
    assert.equal(limits.maxProMonthlyOutputTokens, 0);
  });

  test('DB overrides are reflected per key', () => {
    const now = Date.now();
    const ins = db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)');
    ins.run('LINGMODEL_FREE_DAILY_PROMPT_LIMIT', '100', now);
    ins.run('LINGMODEL_PRO_DAILY_PROMPT_LIMIT', '1500', now);
    ins.run('LINGMODEL_PRO_5H_PROMPT_LIMIT', '75', now);
    const limits = loadLingModelLimits(db);
    assert.equal(limits.freeDailyPromptLimit, 100);
    assert.equal(limits.proDailyPromptLimit, 1500);
    assert.equal(limits.pro5hPromptLimit, 75);
    // Unset keys still get defaults
    assert.equal(limits.freeBurstPerMin, 10);
  });

  test('env wins when DB is empty', () => {
    process.env.LINGMODEL_PRO_5H_PROMPT_LIMIT = '7';
    const limits = loadLingModelLimits(db);
    assert.equal(limits.pro5hPromptLimit, 7);
    delete process.env.LINGMODEL_PRO_5H_PROMPT_LIMIT;
  });

  test('clearing the DB row (DELETE) restores env/default', () => {
    const now = Date.now();
    db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run('LINGMODEL_FREE_DAILY_PROMPT_LIMIT', '100', now);
    assert.equal(loadLingModelLimits(db).freeDailyPromptLimit, 100);
    db.prepare('DELETE FROM app_config WHERE key = ?').run('LINGMODEL_FREE_DAILY_PROMPT_LIMIT');
    assert.equal(loadLingModelLimits(db).freeDailyPromptLimit, 25);
  });
});
