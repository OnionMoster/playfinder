import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStudyData } from '../build/study-validation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'study-data/fixtures');
const clone = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-negative-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
};
const hasRule = (result, rule) => result.errors.some((error) => error.rule === rule);

test('valid fixture passes and emits 560 coverage rows', () => {
  const result = validateStudyData(FIXTURE, { mode: 'fixture' });
  assert.equal(result.ok, true);
  assert.equal(result.summary.tasteCombinations, 560);
  assert.equal(result.coverageCsv.trim().split('\n').length, 561);
});

test('missing file fails', () => {
  const dir = clone();
  try {
    unlinkSync(join(dir, 'bpr_top100.csv'));
    const result = validateStudyData(dir, { mode: 'fixture' });
    assert.ok(hasRule(result, 'required-file'));
    assert.equal(result.validationComplete, false);
    assert.equal(result.stoppedAfter, 'required-file-presence');
    assert.ok(result.notExecutedSections.includes('ranking-integrity-and-recommended-metadata'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('partial mode validates available base and Popularity without BPR/Hybrid', () => {
  const dir = clone();
  try {
    unlinkSync(join(dir, 'bpr_top100.csv'));
    unlinkSync(join(dir, 'hybrid_top100.csv'));
    const result = validateStudyData(dir, { mode: 'partial' });
    assert.equal(result.ok, true);
    assert.equal(result.validationComplete, true);
    assert.equal(result.formalReady, false);
    assert.deepEqual(result.summary.checkedConditions, ['A']);
    assert.deepEqual(result.summary.skippedConditions, ['B', 'C']);
    assert.ok(!hasRule(result, 'required-file'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing non-recommended catalogue metadata is warning-only', () => {
  const dir = clone();
  try {
    const path = join(dir, 'catalogue.json');
    const catalogue = JSON.parse(readFileSync(path, 'utf8'));
    catalogue.push({
      item_id: '999999999',
      title: null,
      price: null,
      platforms: [],
      genres: [],
      tags: [],
    });
    writeFileSync(path, JSON.stringify(catalogue, null, 2) + '\n');
    const result = validateStudyData(dir, { mode: 'fixture' });
    assert.ok(result.warnings.some((warning) => warning.rule === 'catalogue-title-missing'));
    assert.ok(result.warnings.some((warning) => warning.rule === 'catalogue-price-missing'));
    assert.ok(result.warnings.some((warning) => warning.rule === 'catalogue-platform-missing'));
    assert.ok(!result.errors.some((error) =>
      error.item_id === '999999999' && error.rule.startsWith('recommended-')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recommended platform warning identifies condition, profile_id, and item_id', () => {
  const dir = clone();
  try {
    const ranking = readFileSync(join(dir, 'popularity_top100.csv'), 'utf8').split('\n')[1].split(',');
    const [profileId, , itemId] = ranking;
    const path = join(dir, 'catalogue.json');
    const catalogue = JSON.parse(readFileSync(path, 'utf8'));
    catalogue.find((game) => String(game.item_id) === itemId).platforms = [];
    writeFileSync(path, JSON.stringify(catalogue, null, 2) + '\n');
    const result = validateStudyData(dir, { mode: 'fixture' });
    const issue = result.warnings.find((warning) =>
      warning.rule === 'recommended-platform-metadata' &&
      warning.condition === 'A' &&
      warning.profile_id === profileId &&
      warning.item_id === itemId);
    assert.ok(issue);
    assert.equal(result.errors.some((error) =>
      error.rule === 'recommended-platform-metadata' && error.item_id === itemId), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('duplicate rank fails', () => {
  const dir = clone();
  try {
    const path = join(dir, 'popularity_top100.csv');
    const text = readFileSync(path, 'utf8').replace(/,2,9900000\.00000000/, ',1,9900000.00000000');
    writeFileSync(path, text);
    assert.ok(hasRule(validateStudyData(dir, { mode: 'fixture' }), 'duplicate-rank'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown recommendation fails candidate and catalogue membership', () => {
  const dir = clone();
  try {
    const path = join(dir, 'bpr_top100.csv');
    const text = readFileSync(path, 'utf8').replace(/,10\d\d,1,/, ',999999999,1,');
    writeFileSync(path, text);
    const result = validateStudyData(dir, { mode: 'fixture' });
    assert.ok(hasRule(result, 'candidate-membership'));
    assert.ok(hasRule(result, 'catalogue-membership'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('seen leakage fails', () => {
  const dir = clone();
  try {
    const seen = readFileSync(join(dir, 'profile_seen_items.csv'), 'utf8').split('\n')[1].split(',');
    const path = join(dir, 'hybrid_top100.csv');
    const lines = readFileSync(path, 'utf8').split('\n');
    const cols = lines[1].split(',');
    cols[2] = seen[2];
    lines[1] = cols.join(',');
    writeFileSync(path, lines.join('\n'));
    assert.ok(hasRule(validateStudyData(dir, { mode: 'fixture' }), 'seen-leakage'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('condition candidate mismatch fails', () => {
  const dir = clone();
  try {
    const path = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.conditions.B.candidate_hash = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
    assert.ok(hasRule(validateStudyData(dir, { mode: 'fixture' }), 'condition-provenance'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Top-99 fails', () => {
  const dir = clone();
  try {
    const path = join(dir, 'popularity_top100.csv');
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    lines.splice(100, 1);
    writeFileSync(path, lines.join('\n') + '\n');
    assert.ok(hasRule(validateStudyData(dir, { mode: 'fixture' }), 'top-100'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
