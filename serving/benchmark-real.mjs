#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../build/study-core.mjs';
import { serveRanking } from './index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const input = resolve(arg('--input', join(ROOT, 'study-data/staging/three-model-provisional')));
const output = resolve(arg('--output', join(ROOT, 'serving/results/benchmark-real-provisional.json')));
const passes = Number(arg('--passes', '5'));
if (!Number.isInteger(passes) || passes < 1) throw new Error('--passes must be a positive integer');

const csv = (name) => parseCsv(readFileSync(join(input, name), 'utf8'), name).rows;
const manifestPath = join(input, 'manifest.json');
const isFormal = existsSync(manifestPath) &&
  JSON.parse(readFileSync(manifestPath, 'utf8')).mode === 'formal';
const catalogue = JSON.parse(readFileSync(join(input, 'catalogue.json'), 'utf8'));
const profiles = csv('study_profiles.csv');
const catalogueById = new Map(catalogue.map((game) => [
  String(game.item_id),
  { ...game, id: String(game.item_id) },
]));
const seenByProfile = new Map();
for (const row of csv('profile_seen_items.csv')) {
  if (!seenByProfile.has(row.profile_id)) seenByProfile.set(row.profile_id, []);
  seenByProfile.get(row.profile_id).push(String(row.item_id));
}
const rankingFiles = {
  A: 'popularity_top100.csv',
  B: 'bpr_top100.csv',
  C: 'hybrid_top100.csv',
};
const rankings = {};
for (const [condition, filename] of Object.entries(rankingFiles)) {
  const byProfile = new Map();
  for (const row of csv(filename)) {
    if (!byProfile.has(row.profile_id)) byProfile.set(row.profile_id, []);
    byProfile.get(row.profile_id).push({ item_id: String(row.item_id), rank: Number(row.rank) });
  }
  for (const rows of byProfile.values()) rows.sort((left, right) => left.rank - right.rank);
  rankings[condition] = byProfile;
}

const samples = [];
const availableCounts = [];
const platformCycle = ['Windows', 'macOS', 'Linux'];
const budgetCycle = [Infinity, 20, 40, 60, Infinity];
const runRequest = (profile, condition, pass) => {
  const start = performance.now();
  const result = serveRanking({
    ranking: rankings[condition].get(profile.profile_id),
    catalogueById,
    seen: seenByProfile.get(profile.profile_id) || [],
    filters: {
      maxPrice: budgetCycle[pass % budgetCycle.length],
      platforms: [platformCycle[pass % platformCycle.length]],
    },
  });
  const durationMs = performance.now() - start;
  return { durationMs, available: result.length };
};

// Warm the runtime without recording the first execution.
for (const condition of Object.keys(rankingFiles)) runRequest(profiles[0], condition, 0);
for (let pass = 0; pass < passes; pass++) {
  for (const profile of profiles) {
    for (const condition of Object.keys(rankingFiles)) {
      const result = runRequest(profile, condition, pass);
      samples.push({ condition, duration_ms: result.durationMs });
      availableCounts.push(result.available);
    }
  }
}

const summarize = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    runs: sorted.length,
    mean_ms: total / sorted.length,
    p50_ms: percentile(0.50),
    p95_ms: percentile(0.95),
    p99_ms: percentile(0.99),
    max_ms: sorted.at(-1),
  };
};

const report = {
  schema_version: 'playfinder-serving-benchmark-v1',
  status: isFormal ? 'formal-real-three-model-data' : 'provisional-real-three-model-data',
  input: relative(ROOT, input),
  measured_at: new Date().toISOString(),
  definition: 'Warm in-memory request from profile/condition lookup through seen exclusion, hard filters, and deterministic MMR; excludes process startup and file loading.',
  profiles: profiles.length,
  conditions: rankingFiles,
  passes,
  overall: summarize(samples.map((sample) => sample.duration_ms)),
  by_condition: Object.fromEntries(Object.keys(rankingFiles).map((condition) => [
    condition,
    summarize(samples.filter((sample) => sample.condition === condition).map((sample) => sample.duration_ms)),
  ])),
  post_filter_result_count: {
    minimum: Math.min(...availableCounts),
    maximum: Math.max(...availableCounts),
    mean: availableCounts.reduce((sum, value) => sum + value, 0) / availableCounts.length,
  },
  limitations: [
    'This is a local single-process service-layer benchmark, not browser network latency.',
    isFormal
      ? 'The input is the formally validated three-model study package.'
      : 'The input is a real three-model provisional package; formal study rules are not yet frozen.',
  ],
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`benchmark-real: ${report.overall.runs} runs, p95 ${report.overall.p95_ms.toFixed(3)} ms`);
