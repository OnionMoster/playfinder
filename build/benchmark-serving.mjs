#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { serveRanking } from './study-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const at = args.indexOf('--payload');
const payloadPath = resolve(at >= 0 ? args[at + 1] : join(ROOT, 'study-data/generated/playfinder-study-payload.json'));
const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
const catalogueById = new Map(payload.catalogue.map((game) => [String(game.id), game]));
const samples = [];
const benchmarkProfiles = payload.profiles.slice(0, 5);
for (let pass = 0; pass < 5; pass++) for (const profile of benchmarkProfiles) for (const condition of ['A', 'B', 'C']) {
  const start = performance.now();
  serveRanking({
    ranking: profile.rankings[condition].map((row) => ({ item_id: row.itemId, rank: row.rank })),
    catalogueById,
    seen: profile.seenItemIds,
    filters: { maxPrice: pass % 2 ? 40 : Infinity, platforms: [pass % 3 === 0 ? 'Linux' : 'Windows'] },
  });
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
const report = {
  payload: relative(ROOT, payloadPath), runs: samples.length,
  sampled_profiles: benchmarkProfiles.length,
  mean_ms: samples.reduce((a, b) => a + b, 0) / samples.length,
  p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99),
  measured_at: new Date().toISOString(),
};
const output = join(ROOT, 'study-data/reports/serving-benchmark.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`benchmark-serving: ${report.runs} runs, p95 ${report.p95_ms.toFixed(3)} ms`);
