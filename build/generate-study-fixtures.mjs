#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASTES, toCsv } from './study-core.mjs';
import { candidateFingerprint } from './study-validation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'study-data/fixtures');
mkdirSync(OUT, { recursive: true });

const profiles = [];
for (let i = 0; i < TASTES.length; i++) {
  for (let j = i + 1; j < TASTES.length; j++) {
    let third = (j + 1) % TASTES.length;
    while (third === i || third === j) third = (third + 1) % TASTES.length;
    profiles.push({
      profile_id: `fixture-profile-${String(profiles.length + 1).padStart(3, '0')}`,
      model_user_id: `fixture-user-${String(profiles.length + 1).padStart(3, '0')}`,
      taste_1: TASTES[i], taste_2: TASTES[j], taste_3: TASTES[third],
      train_positive_count: 12 + profiles.length % 29,
    });
  }
}

const catalogue = Array.from({ length: 120 }, (_, index) => {
  const item = index + 1001;
  return {
    item_id: String(item),
    title: `Fixture Game ${String(index + 1).padStart(3, '0')}`,
    description: 'Obviously fictional fixture metadata for pipeline development only.',
    price: index % 13 === 0 ? 0 : (index % 61) + 0.99,
    platforms: ['Windows', 'macOS', 'Linux'],
    genres: [TASTES[index % 10], TASTES[(index + 5) % 10]],
    tags: [TASTES[8 + (index % 8)], `Fixture Token ${index % 12}`],
    explanation: 'Fixture recommendation — not model output.',
  };
});
const candidateRows = catalogue.map((game) => ({ item_id: game.item_id }));
const candidateIds = new Set(candidateRows.map((row) => row.item_id));

const files = new Map();
files.set('catalogue.json', JSON.stringify(catalogue, null, 2) + '\n');
files.set('candidate_items.csv', toCsv(['item_id'], candidateRows));
files.set('study_profiles.csv', toCsv(
  ['profile_id', 'model_user_id', 'taste_1', 'taste_2', 'taste_3', 'train_positive_count'],
  profiles,
));
files.set('profile_seen_items.csv', toCsv(
  ['profile_id', 'model_user_id', 'item_id'],
  profiles.map((profile, index) => ({
    profile_id: profile.profile_id,
    model_user_id: profile.model_user_id,
    item_id: String(1001 + ((index + 119) % 120)),
  })),
));

const modelFiles = [
  ['popularity_top100.csv', 0, 100000],
  ['bpr_top100.csv', 17, 0.4],
  ['hybrid_top100.csv', 43, 0.01],
];
for (const [filename, modelOffset, scoreScale] of modelFiles) {
  const rows = [];
  for (let p = 0; p < profiles.length; p++) {
    const seen = String(1001 + ((p + 119) % 120));
    const order = Array.from({ length: 120 }, (_, i) => String(1001 + ((i + modelOffset + p) % 120)))
      .filter((id) => id !== seen).slice(0, 100);
    order.forEach((item_id, index) => rows.push({
      profile_id: profiles[p].profile_id,
      model_user_id: profiles[p].model_user_id,
      item_id,
      rank: index + 1,
      score: (scoreScale * (100 - index) + p / 100000).toFixed(8),
    }));
  }
  files.set(filename, toCsv(['profile_id', 'model_user_id', 'item_id', 'rank', 'score'], rows));
}

const digest = (text) => createHash('sha256').update(text).digest('hex');
for (const [filename, text] of files) writeFileSync(join(OUT, filename), text);
const hashes = Object.fromEntries([...files].map(([filename, text]) => [filename, digest(text)]));
const common = {
  data_snapshot: 'fixture-snapshot-v1',
  split_id: 'fixture-split-v1',
  candidate_hash: candidateFingerprint(candidateIds),
};
const manifest = {
  schema_version: 'playfinder-study-v1',
  mode: 'fixture',
  notice: 'FIXTURE / NOT FOR FORMAL STUDY',
  id_namespace: 'steam_appid',
  candidate_hash: common.candidate_hash,
  conditions: {
    A: { model: 'popularity', ...common },
    B: { model: 'bpr', ...common },
    C: { model: 'hybrid', ...common },
  },
  files: hashes,
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`generate-study-fixtures: wrote ${profiles.length} profiles and ${catalogue.length} fictional games to ${OUT}`);
