#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStudyData } from './study-validation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const input = resolve(arg('--input', join(ROOT, 'study-data/incoming/final')));
const mode = arg('--mode', 'formal');
const output = resolve(arg('--output', join(ROOT, 'study-data/generated/playfinder-study-payload.json')));
const result = validateStudyData(input, { mode });
if (!result.ok) {
  console.error(`build-study-payload: validation failed with ${result.errors.length} errors`);
  process.exit(1);
}
const { manifest, catalogue, profiles, seenByProfile, rankings } = result.data;
const sourcePolicy = manifest.profile_policy;
const disabledThirdTasteMapping = sourcePolicy?.disabled_third_taste_mapping ??
  sourcePolicy?.disabledThirdTasteMapping ?? [];
const payload = {
  schemaVersion: 'playfinder-study-v1',
  mode,
  notice: mode === 'fixture' ? 'FIXTURE / NOT FOR FORMAL STUDY' : 'FORMAL STUDY DATA',
  idNamespace: 'steam_appid',
  provenance: {
    dataSnapshot: manifest.conditions.A.data_snapshot,
    splitId: manifest.conditions.A.split_id,
    candidateHash: manifest.conditions.A.candidate_hash,
  },
  conditions: { A: 'popularity', B: 'bpr', C: 'hybrid' },
  tastePolicy: sourcePolicy ? {
    id: sourcePolicy.id ?? sourcePolicy.policy_id,
    status: sourcePolicy.status,
    formal: mode === 'formal' && sourcePolicy.status === 'formal_supported_domain',
    supportedCombinationCount: Number(sourcePolicy.covered_combinations ?? sourcePolicy.supported_combination_count),
    totalCombinationCount: Number(sourcePolicy.total_combinations ?? sourcePolicy.total_combination_count),
    jaccardThreshold: Number(sourcePolicy.jaccard_threshold),
    disabledThirdTasteMapping: disabledThirdTasteMapping.map((row) => ({
      prefix: row.prefix,
      disabledThirdTaste: row.disabled_third_taste ?? row.disabledThirdTaste,
    })),
  } : null,
  catalogue: catalogue.map((game) => ({ ...game, id: String(game.item_id ?? game.id), item_id: undefined })),
  profiles: profiles.map((profile) => ({
    profileId: profile.profile_id,
    modelUserId: profile.model_user_id,
    tastes: profile.tastes,
    trainPositiveCount: Number(profile.train_positive_count),
    seenItemIds: seenByProfile.get(profile.profile_id) || [],
    rankings: Object.fromEntries(Object.entries(rankings).map(([condition, rows]) => [
      condition,
      rows.filter((row) => row.profile_id === profile.profile_id)
        .sort((a, b) => Number(a.rank) - Number(b.rank))
        .map((row) => ({ itemId: String(row.item_id), rank: Number(row.rank) })),
    ])),
  })),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(payload) + '\n');
console.log(`build-study-payload: wrote ${output} (${payload.profiles.length} profiles)`);
