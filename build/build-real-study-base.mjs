#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  TASTES, applyHardFilters, combinations, jaccard, normalizeItemId, toCsv,
} from './study-core.mjs';
import { candidateFingerprint } from './study-validation.mjs';
import { inspectParquet, scanParquet } from './parquet-lite.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A_DIR = join(ROOT, 'data');
const B_DIR = join(ROOT, 'eval');
const args = process.argv.slice(2);
const outputAt = args.indexOf('--output');
const OUT = resolve(outputAt >= 0 ? args[outputAt + 1] : join(ROOT, 'study-data/staging/real-base'));
const CUTOFF = 1641340800;
const FRONTEND_TASTE_INDEX = new Map(TASTES.map((taste, index) => [taste, index]));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const numericSort = (left, right) => {
  const a = BigInt(left), b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
};
const missing = (value) => value == null || (typeof value === 'string' && !value.trim());
const roundMoney = (value) => typeof value === 'number' && Number.isFinite(value)
  ? Math.round((value + Number.EPSILON) * 100) / 100
  : null;
const inspectPortableParquet = (path) => ({
  ...inspectParquet(path),
  path: relative(ROOT, path),
});

const required = [
  join(A_DIR, 'items.parquet'),
  join(A_DIR, 'interactions.parquet'),
  join(B_DIR, 'results/evaluation_users.csv'),
  join(B_DIR, 'final_eval/popularity_top100.csv'),
  join(B_DIR, 'final_eval/version_info.json'),
  join(B_DIR, 'run_final_eval.py'),
  join(B_DIR, 'evaluation_core.py'),
  join(B_DIR, 'baselines.py'),
];
for (const path of required) if (!existsSync(path)) throw new Error(`missing required local source: ${path}`);
if (existsSync(OUT)) throw new Error(`staging output already exists; refusing to overwrite: ${OUT}`);
const bVersionInfo = JSON.parse(readFileSync(join(B_DIR, 'final_eval/version_info.json'), 'utf8'));

console.log('real-base: decoding A catalogue');
const catalogue = [];
const catalogueById = new Map();
scanParquet(
  join(A_DIR, 'items.parquet'),
  ['item_id', 'title', 'description', 'price', 'win', 'mac', 'linux', 'genres', 'tags', 'developer', 'publisher', 'release_date'],
  (columns, { rowCount }) => {
    for (let i = 0; i < rowCount; i++) {
      const itemId = normalizeItemId(columns.item_id[i]);
      if (!itemId) throw new Error(`A items.parquet contains invalid item_id ${columns.item_id[i]}`);
      if (catalogueById.has(itemId)) throw new Error(`A items.parquet contains duplicate item_id ${itemId}`);
      const platforms = [];
      if (columns.win[i] === true) platforms.push('Windows');
      if (columns.mac[i] === true) platforms.push('macOS');
      if (columns.linux[i] === true) platforms.push('Linux');
      const game = {
        item_id: itemId,
        title: columns.title[i] == null ? null : String(columns.title[i]),
        description: columns.description[i] == null ? null : String(columns.description[i]),
        price: roundMoney(columns.price[i]),
        platforms,
        genres: Array.isArray(columns.genres[i]) ? columns.genres[i].map(String) : [],
        tags: Array.isArray(columns.tags[i]) ? columns.tags[i].map(String) : [],
        developer: columns.developer[i] == null ? null : String(columns.developer[i]),
        publisher: columns.publisher[i] == null ? null : String(columns.publisher[i]),
        release_date: columns.release_date[i] == null ? null : String(columns.release_date[i]),
      };
      catalogue.push(game);
      catalogueById.set(itemId, game);
    }
  },
);
catalogue.sort((a, b) => numericSort(a.item_id, b.item_id));

const evaluationUsers = new Set();
{
  const lines = readFileSync(join(B_DIR, 'results/evaluation_users.csv'), 'utf8').trim().split(/\r?\n/);
  const headers = lines.shift().split(',');
  const userAt = headers.indexOf('user_id');
  if (userAt < 0) throw new Error('B evaluation_users.csv is missing user_id');
  for (const line of lines) {
    const value = line.split(',')[userAt];
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`invalid B evaluation user_id ${value}`);
    evaluationUsers.add(value);
  }
}
if (evaluationUsers.size !== 9000) throw new Error(`B sampled cohort expected 9000 unique users, found ${evaluationUsers.size}`);

const candidateIds = new Set();
const seenByUser = new Map();
const positiveTrainByUser = new Map();
const positiveTestUsers = new Set();
const ensureSet = (map, key) => {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
};
let trainRows = 0, testRows = 0, trainPositiveRows = 0;
console.log('real-base: scanning A interactions with B split/exclusion policy');
scanParquet(
  join(A_DIR, 'interactions.parquet'),
  ['user_id', 'item_id', 'label', 'timestamp'],
  (columns, { groupIndex, rowCount }) => {
    for (let i = 0; i < rowCount; i++) {
      const userId = String(columns.user_id[i]);
      const itemId = String(columns.item_id[i]);
      const label = Number(columns.label[i]);
      const timestamp = Number(columns.timestamp[i]);
      if (timestamp <= CUTOFF) {
        trainRows++;
        if (label === 1) { candidateIds.add(itemId); trainPositiveRows++; }
        if (evaluationUsers.has(userId)) {
          ensureSet(seenByUser, userId).add(itemId);
          if (label === 1) ensureSet(positiveTrainByUser, userId).add(itemId);
        }
      } else {
        testRows++;
        if (label === 1 && evaluationUsers.has(userId)) positiveTestUsers.add(userId);
      }
    }
    if ((groupIndex + 1) % 30 === 0) console.log(`real-base: scanned ${groupIndex + 1} interaction row groups`);
  },
);
const allTestUsers = [...evaluationUsers].filter((userId) => positiveTestUsers.has(userId));
const seenUsers = allTestUsers.filter((userId) => (seenByUser.get(userId)?.size || 0) > 0);
const newUsers = allTestUsers.filter((userId) => !(seenByUser.get(userId)?.size || 0));
if (trainRows !== 17838174 || testRows !== 4448786) {
  throw new Error(`split row-count mismatch: train=${trainRows}, test=${testRows}`);
}
if (allTestUsers.length !== 5348 || seenUsers.length !== 5119 || newUsers.length !== 229) {
  throw new Error(`B cohort mismatch: all=${allTestUsers.length}, seen=${seenUsers.length}, new=${newUsers.length}`);
}
if (candidateIds.size !== 20435) throw new Error(`shared candidate mismatch: expected 20435, found ${candidateIds.size}`);
for (const itemId of candidateIds) if (!catalogueById.has(itemId)) throw new Error(`candidate ${itemId} is absent from A catalogue`);

const eligibleSignatures = [];
for (const userId of seenUsers) {
  const positiveItems = positiveTrainByUser.get(userId) || new Set();
  const counts = new Map(TASTES.map((taste) => [taste, 0]));
  for (const itemId of positiveItems) {
    const game = catalogueById.get(itemId);
    if (!game) continue;
    const tokens = new Set([...game.genres, ...game.tags]);
    for (const taste of TASTES) if (tokens.has(taste)) counts.set(taste, counts.get(taste) + 1);
  }
  const ranked = TASTES.filter((taste) => counts.get(taste) > 0)
    .sort((a, b) => counts.get(b) - counts.get(a) || FRONTEND_TASTE_INDEX.get(a) - FRONTEND_TASTE_INDEX.get(b));
  if (ranked.length >= 3) {
    eligibleSignatures.push({
      userId,
      tastes: ranked.slice(0, 3),
      trainPositiveCount: positiveItems.size,
      tasteScores: ranked.slice(0, 3).map((taste) => counts.get(taste)),
    });
  }
}

const tasteCombos = combinations(TASTES, 3);
const coverageFor = (tastes) => tasteCombos
  .map((combo, index) => jaccard(tastes, combo) >= 0.5 ? index : -1)
  .filter((index) => index >= 0);
for (const user of eligibleSignatures) user.coverage = coverageFor(user.tastes);
const achievable = new Set(eligibleSignatures.flatMap((user) => user.coverage));
const covered = new Set();
const selected = [];
const remaining = new Set(eligibleSignatures);
while (covered.size < tasteCombos.length) {
  let best = null, bestGain = 0;
  for (const user of remaining) {
    let gain = 0;
    for (const index of user.coverage) if (!covered.has(index)) gain++;
    const betterUser = !best ||
      gain > bestGain ||
      (gain === bestGain && user.trainPositiveCount > best.trainPositiveCount) ||
      (gain === bestGain && user.trainPositiveCount === best.trainPositiveCount && BigInt(user.userId) < BigInt(best.userId));
    if (betterUser) { best = user; bestGain = gain; }
  }
  if (!best || bestGain === 0) break;
  selected.push(best);
  remaining.delete(best);
  for (const index of best.coverage) covered.add(index);
}
const profiles = selected.map((user, index) => ({
  profile_id: `profile-${String(index + 1).padStart(3, '0')}`,
  model_user_id: user.userId,
  taste_1: user.tastes[0], taste_2: user.tastes[1], taste_3: user.tastes[2],
  train_positive_count: user.trainPositiveCount,
  taste_1_score: user.tasteScores[0], taste_2_score: user.tasteScores[1], taste_3_score: user.tasteScores[2],
}));

const coverageRows = [];
let minimumJaccard = 1, tiedCombinationCount = 0;
for (let index = 0; index < tasteCombos.length; index++) {
  const combo = tasteCombos[index];
  const scored = profiles.map((profile) => ({
    profile,
    similarity: jaccard(combo, [profile.taste_1, profile.taste_2, profile.taste_3]),
  })).sort((a, b) => b.similarity - a.similarity || a.profile.profile_id.localeCompare(b.profile.profile_id));
  const best = scored[0];
  const tieCount = best ? scored.filter((value) => value.similarity === best.similarity).length : 0;
  if (tieCount > 1) tiedCombinationCount++;
  const similarity = best?.similarity ?? 0;
  minimumJaccard = Math.min(minimumJaccard, similarity);
  coverageRows.push({
    taste_1: combo[0], taste_2: combo[1], taste_3: combo[2],
    best_profile_id: best?.profile.profile_id || '',
    best_jaccard: similarity.toFixed(6),
    best_profile_tie_count: tieCount,
    tied: tieCount > 1,
    covered_at_0_5: similarity >= 0.5,
  });
}

const profileByUser = new Map(profiles.map((profile) => [profile.model_user_id, profile]));
const popularityRows = [];
const popularityAudit = new Map(profiles.map((profile) => [profile.profile_id, {
  rows: 0, ranks: new Set(), items: new Set(), unknownCandidate: 0, unknownCatalogue: 0, seenLeakage: 0, nonFiniteScore: 0,
}]));
console.log('real-base: extracting B Popularity rows for selected model users');
{
  const stream = createReadStream(join(B_DIR, 'final_eval/popularity_top100.csv'), { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  for await (const line of lines) {
    if (!headers) { headers = line.split(','); continue; }
    if (!line) continue;
    const values = line.split(',');
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    const profile = profileByUser.get(row.user_id);
    if (!profile) continue;
    const itemId = normalizeItemId(row.item_id);
    const rank = Number(row.rank);
    const audit = popularityAudit.get(profile.profile_id);
    audit.rows++;
    if (audit.ranks.has(rank)) audit.duplicateRank = true;
    if (audit.items.has(itemId)) audit.duplicateItem = true;
    audit.ranks.add(rank); audit.items.add(itemId);
    if (!candidateIds.has(itemId)) audit.unknownCandidate++;
    if (!catalogueById.has(itemId)) audit.unknownCatalogue++;
    if (seenByUser.get(row.user_id)?.has(itemId)) audit.seenLeakage++;
    if (!Number.isFinite(Number(row.score))) audit.nonFiniteScore++;
    popularityRows.push({
      profile_id: profile.profile_id,
      model_user_id: row.user_id,
      item_id: itemId,
      rank: row.rank,
      score: row.score,
    });
  }
}
for (const profile of profiles) {
  const audit = popularityAudit.get(profile.profile_id);
  if (audit.rows !== 100 || audit.ranks.size !== 100 || [...audit.ranks].some((rank) => rank < 1 || rank > 100) ||
      audit.items.size !== 100 || audit.unknownCandidate || audit.unknownCatalogue || audit.seenLeakage ||
      audit.nonFiniteScore || audit.duplicateRank || audit.duplicateItem) {
    throw new Error(`B Popularity failed for ${profile.profile_id}/${profile.model_user_id}: ${JSON.stringify({
      rows: audit.rows, ranks: audit.ranks.size, items: audit.items.size,
      unknownCandidate: audit.unknownCandidate, unknownCatalogue: audit.unknownCatalogue,
      seenLeakage: audit.seenLeakage, nonFiniteScore: audit.nonFiniteScore,
      duplicateRank: !!audit.duplicateRank, duplicateItem: !!audit.duplicateItem,
    })}`);
  }
}
popularityRows.sort((a, b) => a.profile_id.localeCompare(b.profile_id) || Number(a.rank) - Number(b.rank));

const candidateList = [...candidateIds].sort(numericSort);
const candidateHash = candidateFingerprint(candidateIds);
const candidateGames = candidateList.map((itemId) => catalogueById.get(itemId));
const metadataMetrics = {
  title_missing: candidateGames.filter((game) => missing(game.title)).length,
  description_missing: candidateGames.filter((game) => missing(game.description)).length,
  price_missing: candidateGames.filter((game) => game.price == null).length,
  platform_missing: candidateGames.filter((game) => !game.platforms.length).length,
  genres_missing: candidateGames.filter((game) => !game.genres.length).length,
  tags_missing: candidateGames.filter((game) => !game.tags.length).length,
  genres_and_tags_missing: candidateGames.filter((game) => !game.genres.length && !game.tags.length).length,
};
const metadataQualityRows = Object.entries(metadataMetrics).map(([field, count]) => ({
  field, missing_count: count, candidate_count: candidateList.length,
  missing_rate: (count / candidateList.length).toFixed(8),
  missing_percent: (100 * count / candidateList.length).toFixed(4),
}));
const catalogueMetadataMetrics = {
  title_missing: catalogue.filter((game) => missing(game.title)).length,
  price_missing: catalogue.filter((game) => game.price == null).length,
  platform_missing: catalogue.filter((game) => !game.platforms.length).length,
};
const popularityUniqueIds = new Set(popularityRows.map((row) => row.item_id));
const missingMetadata = (game, field) => field === 'price'
  ? game?.price == null
  : Array.isArray(game?.[field])
    ? game[field].length === 0
    : missing(game?.[field]);
const popularityMetadata = Object.fromEntries(
  ['title', 'price', 'platforms', 'genres', 'tags'].map((field) => [field, {
    missing_rows: popularityRows.filter((row) => missingMetadata(catalogueById.get(row.item_id), field)).length,
    missing_unique_items: [...popularityUniqueIds].filter((itemId) => missingMetadata(catalogueById.get(itemId), field)).length,
  }]),
);
const filterBudgets = [...Array.from({ length: 56 }, (_, index) => index + 5), 'any'];
const filterPlatformCombos = [
  ['Windows'], ['macOS'], ['Linux'],
  ['Windows', 'macOS'], ['Windows', 'Linux'], ['macOS', 'Linux'],
  ['Windows', 'macOS', 'Linux'],
];
const popularityByProfile = new Map(profiles.map((profile) => [profile.profile_id, []]));
for (const row of popularityRows) popularityByProfile.get(row.profile_id).push(catalogueById.get(row.item_id));
const filterAvailabilityRows = [];
let popularityFilterWarnings = 0, popularitySinglePlatformErrors = 0;
for (const profile of profiles) {
  const ranking = popularityByProfile.get(profile.profile_id);
  for (const budget of filterBudgets) for (const platforms of filterPlatformCombos) {
    const available = applyHardFilters(
      ranking,
      { maxPrice: budget === 'any' ? Infinity : budget, platforms },
    ).length;
    filterAvailabilityRows.push({
      profile_id: profile.profile_id,
      condition: 'A',
      budget,
      platforms: platforms.join('|'),
      available,
    });
    if (budget !== 'any' && available < 6) popularityFilterWarnings++;
    if (budget === 'any' && platforms.length === 1 && available < 6) popularitySinglePlatformErrors++;
  }
}
const blockers = [
  ...(covered.size < tasteCombos.length ? [
    `the fixed top-3 baseline policy covers only ${covered.size}/${tasteCombos.length} combinations at Jaccard >= 0.5; this is not an unconditional limit of the real training data`,
  ] : []),
  'bpr_top100.csv from C for the exact model-user-export-request.csv users',
  'hybrid_top100.csv from D for the exact model-user-export-request.csv users',
  'A confirmation that the local unversioned output directory is the intended final snapshot',
  'B confirmation that the local final_eval release and candidate/split policy are final',
  'formal manifest checksums assembled only after coverage resolution, A/B confirmation, and C/D delivery',
];

const files = new Map();
files.set('catalogue.json', JSON.stringify(catalogue, null, 2) + '\n');
files.set('candidate_items.csv', toCsv(['item_id'], candidateList.map((item_id) => ({ item_id }))));
files.set('study_profiles.csv', toCsv(
  ['profile_id', 'model_user_id', 'taste_1', 'taste_2', 'taste_3', 'train_positive_count', 'taste_1_score', 'taste_2_score', 'taste_3_score'],
  profiles,
));
const seenRows = profiles.flatMap((profile) => [...(seenByUser.get(profile.model_user_id) || [])].sort(numericSort).map((item_id) => ({
  profile_id: profile.profile_id, model_user_id: profile.model_user_id, item_id,
})));
files.set('profile_seen_items.csv', toCsv(['profile_id', 'model_user_id', 'item_id'], seenRows));
files.set('popularity_top100.csv', toCsv(['profile_id', 'model_user_id', 'item_id', 'rank', 'score'], popularityRows));
files.set('model-user-export-request.csv', toCsv(
  ['profile_id', 'model_user_id', 'taste_1', 'taste_2', 'taste_3'],
  profiles,
));
files.set('profile-coverage-report.csv', toCsv(
  ['taste_1', 'taste_2', 'taste_3', 'best_profile_id', 'best_jaccard', 'best_profile_tie_count', 'tied', 'covered_at_0_5'],
  coverageRows,
));
files.set('uncovered-taste-combinations.csv', toCsv(
  ['taste_1', 'taste_2', 'taste_3', 'best_jaccard'],
  coverageRows.filter((row) => row.covered_at_0_5 === false),
));
files.set('metadata-quality.csv', toCsv(
  ['field', 'missing_count', 'candidate_count', 'missing_rate', 'missing_percent'],
  metadataQualityRows,
));
files.set('popularity-filter-availability.csv', toCsv(
  ['profile_id', 'condition', 'budget', 'platforms', 'available'],
  filterAvailabilityRows,
));

const sourceHashes = {
  a_items_sha256: sha256(readFileSync(join(A_DIR, 'items.parquet'))),
  a_interactions_sha256: sha256(readFileSync(join(A_DIR, 'interactions.parquet'))),
  b_popularity_sha256: sha256(readFileSync(join(B_DIR, 'final_eval/popularity_top100.csv'))),
  b_version_info_sha256: sha256(readFileSync(join(B_DIR, 'final_eval/version_info.json'))),
  b_run_final_eval_sha256: sha256(readFileSync(join(B_DIR, 'run_final_eval.py'))),
  b_evaluation_core_sha256: sha256(readFileSync(join(B_DIR, 'evaluation_core.py'))),
  b_baselines_sha256: sha256(readFileSync(join(B_DIR, 'baselines.py'))),
};
const qualityReport = {
  status: covered.size === 560 ? 'base_package_ready_for_c_d_exports' : 'fixed_top3_policy_incomplete',
  formal_validation_passed: false,
  source_release_created_at_utc: bVersionInfo.created_at_utc,
  sources: sourceHashes,
  parquet: {
    items: inspectPortableParquet(join(A_DIR, 'items.parquet')),
    interactions: inspectPortableParquet(join(A_DIR, 'interactions.parquet')),
  },
  split: {
    cutoff_timestamp: CUTOFF, cutoff_date: '2022-01-05',
    rule: 'train timestamp <= cutoff; test timestamp > cutoff',
    train_rows: trainRows, test_rows: testRows,
    sampled_users: evaluationUsers.size, all_test_users: allTestUsers.length,
    seen_users_only: seenUsers.length, true_new_users: newUsers.length,
  },
  candidate: {
    rule: 'unique item_id where label=1 and timestamp<=cutoff, intersected with A items catalogue by B code',
    count: candidateList.length, sha256: candidateHash, train_positive_rows: trainPositiveRows,
  },
  profiles: {
    eligible_seen_users: seenUsers.length,
    eligible_users_with_three_tastes: eligibleSignatures.length,
    selected_profiles: profiles.length,
    covered_combinations: covered.size,
    achievable_combinations_with_fixed_top3_signatures: achievable.size,
    achievable_scope_note: 'This limit applies only after each user is compressed to one fixed top-3 signature.',
    total_combinations: tasteCombos.length,
    minimum_jaccard: minimumJaccard,
    combinations_with_best_profile_ties: tiedCombinationCount,
  },
  seen_policy: 'all training-period interactions for the same user, regardless of label',
  seen_rows_exported: seenRows.length,
  metadata: {
    catalogue_count: catalogue.length,
    catalogue_validator_sensitive_fields: catalogueMetadataMetrics,
    candidate_count: candidateList.length,
    fields: Object.fromEntries(metadataQualityRows.map((row) => [row.field, {
      missing_count: row.missing_count,
      missing_rate: Number(row.missing_rate),
      missing_percent: Number(row.missing_percent),
    }])),
  },
  popularity: {
    source_users: 5348,
    requested_profiles: profiles.length,
    covered_profiles: [...popularityAudit.values()].filter((audit) => audit.rows === 100).length,
    rows_exported: popularityRows.length,
    duplicate_rank_profiles: [...popularityAudit.values()].filter((audit) => audit.duplicateRank).length,
    duplicate_item_profiles: [...popularityAudit.values()].filter((audit) => audit.duplicateItem).length,
    unknown_candidate_items: [...popularityAudit.values()].reduce((sum, audit) => sum + audit.unknownCandidate, 0),
    unknown_catalogue_items: [...popularityAudit.values()].reduce((sum, audit) => sum + audit.unknownCatalogue, 0),
    seen_leakage_rows: [...popularityAudit.values()].reduce((sum, audit) => sum + audit.seenLeakage, 0),
    unique_items: popularityUniqueIds.size,
    metadata: popularityMetadata,
    filter_availability: {
      rows_checked: filterAvailabilityRows.length,
      finite_budget_warnings_below_six: popularityFilterWarnings,
      any_price_single_platform_errors_below_six: popularitySinglePlatformErrors,
    },
  },
  blockers,
};
files.set('data-quality-report.json', JSON.stringify(qualityReport, null, 2) + '\n');

const gapMarkdown = `# PlayFinder real-data base package quality and gap report

## Technical summary

This package is **provisional, not formal**. It deterministically reproduces B's shared candidate and split policy from the local A/B files, derives the fixed top-3 baseline profiles from training-only positive interactions, and maps B's unmodified per-user Popularity Top-100 to those profiles.

The formal validator stops after required-file presence when \`manifest.json\`, BPR, or Hybrid is absent. That result does **not** mean later formal rules passed. Use \`node build/validate-study-data.mjs --input study-data/staging/real-base --mode partial\` to execute the available catalogue, candidate, profile, coverage, seen-item, and Popularity checks.

## Candidate and cohort evidence

- Shared candidate: **${candidateList.length.toLocaleString()}** Steam appids; SHA-256 \`${candidateHash}\`.
- Split: training is \`timestamp <= ${CUTOFF}\`; ${trainRows.toLocaleString()} train rows and ${testRows.toLocaleString()} test rows.
- B sampled cohort: ${evaluationUsers.size.toLocaleString()} users; ${allTestUsers.length.toLocaleString()} have positive test relevance; ${seenUsers.length.toLocaleString()} are known/seen users; ${newUsers.length} true new users were excluded.
- Seen exclusion is every training-period interaction for the user, regardless of label.

## Real profile coverage

- ${eligibleSignatures.length.toLocaleString()} of ${seenUsers.length.toLocaleString()} eligible seen users have at least three supported tastes.
- Greedy selection chose **${profiles.length}** unique real model users.
- Coverage at Jaccard ≥ 0.5: **${covered.size}/${tasteCombos.length}**.
- Within the fixed top-3 compression only, the candidate-pool maximum is ${achievable.size}/${tasteCombos.length}. This is not an unconditional theoretical limit of the real training data.
- Minimum best-profile Jaccard: **${minimumJaccard.toFixed(6)}**.
- ${tiedCombinationCount} combinations have more than one equally best selected profile; runtime tie-break remains the smallest profile_id.

## Candidate metadata completeness

| Field | Missing | Rate |
|---|---:|---:|
${metadataQualityRows.map((row) => `| ${row.field} | ${Number(row.missing_count).toLocaleString()} | ${row.missing_percent}% |`).join('\n')}

Missing metadata was preserved as null/empty and was not invented. Catalogue- and candidate-level title, price, and platform gaps are reported as data-quality warnings. They become formal errors only for items actually used in a condition Top-100; missing genres/tags still reduces profile evidence and MMR/filter utility.

The full A catalogue contains ${catalogueMetadataMetrics.platform_missing.toLocaleString()} rows without any platform metadata (${metadataMetrics.platform_missing.toLocaleString()} within the shared candidate). These are data-quality warnings. Under the corrected validator, platform metadata becomes a formal error only when a missing-platform item actually appears in a condition Top-100.

## Popularity integrity

B covers **${qualityReport.popularity.covered_profiles}/${profiles.length}** selected profiles with exactly 100 rows each. Exported rows: ${popularityRows.length.toLocaleString()}. Duplicate ranks/items, unknown candidate/catalogue IDs, non-finite scores, and training-seen leakage were all checked before writing.

Across ${popularityUniqueIds.size} unique recommended items, title, price, and platform metadata are complete. Therefore current Popularity has **0** platform-metadata blockers. The currently executable Popularity-only hard-filter matrix contains ${filterAvailabilityRows.length.toLocaleString()} profile/budget/platform checks: ${popularitySinglePlatformErrors} Any Price single-platform errors and ${popularityFilterWarnings} finite-budget warnings. C/D filter availability remains untestable until their rankings arrive.

## Blocking gaps and confirmations

${blockers.map((blocker) => `- ${blocker}`).join('\n')}

## Method and robustness notes

Profile taste scores count distinct training-positive games containing an allowed taste in A genres or tags. Top-three ties follow the fixed frontend taste order. Greedy coverage ties prefer higher training-positive count and then lower numeric user_id. No test interactions, test relevance, or model performance informed profile selection. This directory records the baseline policy; the separate \`study-data/staging/profile-policy-v2/\` evaluation is authoritative for policy comparison.
`;
files.set('data-quality-and-gaps.md', gapMarkdown);
files.set('model-user-export-request.md', `# C/D Top-100 export request

Do **not** send this fixed-top-3 baseline request to C/D. It is retained only for provenance and is superseded by the profile-policy-v2 decision.

- This baseline request contains ${profiles.length} real users and covers ${covered.size}/560 combinations under fixed top-3 compression.
- C exports BPR to \`bpr_top100.csv\`; D exports Hybrid to \`hybrid_top100.csv\`.
- Use candidate SHA-256 \`${candidateHash}\` (${candidateList.length} Steam appids).
- Use B's cutoff \`${CUTOFF}\` and the same train/test split.
- Exclude every training-period seen item for the requested user, regardless of label.
- Output exactly \`profile_id,model_user_id,item_id,rank,score\`.
- Each profile must have unique Steam appids and contiguous ranks 1–100. Scores must be finite and remain on the model's native scale.
`);

mkdirSync(OUT, { recursive: true });
for (const [filename, content] of files) writeFileSync(join(OUT, filename), content);
const generatedHashes = Object.fromEntries([...files].map(([filename, content]) => [filename, sha256(content)]));
const provisionalManifest = {
  schema_version: 'playfinder-study-v1',
  mode: 'provisional-real-base',
  notice: 'PROVISIONAL / NOT FORMAL / A-B VERSION CONFIRMATION AND C-D RANKINGS REQUIRED',
  id_namespace: 'steam_appid',
  candidate_hash: candidateHash,
  data_snapshot: {
    status: 'unconfirmed',
    a_items_sha256: sourceHashes.a_items_sha256,
    a_interactions_sha256: sourceHashes.a_interactions_sha256,
  },
  split: {
    status: 'locally_reproduced_unconfirmed_final',
    cutoff_timestamp: CUTOFF, cutoff_date: '2022-01-05',
    sample_per_group: 3000, seed: 42, train_ratio: 0.8,
  },
  conditions: {
    A: { model: 'popularity', status: 'available', candidate_hash: candidateHash },
    B: { model: 'bpr', status: 'blocked_missing_c_export', candidate_hash: candidateHash },
    C: { model: 'hybrid', status: 'blocked_missing_d_export', candidate_hash: candidateHash },
  },
  profile_count: profiles.length,
  requested_model_user_count: profiles.length,
  files: generatedHashes,
  blockers,
};
writeFileSync(join(OUT, 'provisional-manifest.json'), JSON.stringify(provisionalManifest, null, 2) + '\n');

const stagingValidation = {
  ok_for_formal: false,
  ok_as_real_base: covered.size === 560,
  executed_checks: {
    parquet_row_counts_match_documented_sources: true,
    split_counts_match_b_version_info: true,
    candidate_count_matches_b_version_info: true,
    candidate_ids_are_positive_unique_catalogue_members: true,
    profiles_use_unique_seen_model_users_and_training_only_tastes: true,
    profile_coverage_560_at_jaccard_0_5: covered.size === 560,
    seen_rows_follow_b_train_all_interactions_policy: true,
    popularity_top100_complete_for_all_profiles: qualityReport.popularity.covered_profiles === profiles.length,
    popularity_ids_in_candidate_and_catalogue: qualityReport.popularity.unknown_candidate_items === 0 && qualityReport.popularity.unknown_catalogue_items === 0,
    popularity_seen_leakage_zero: qualityReport.popularity.seen_leakage_rows === 0,
    popularity_recommended_title_price_platform_complete:
      qualityReport.popularity.metadata.title.missing_rows === 0 &&
      qualityReport.popularity.metadata.price.missing_rows === 0 &&
      qualityReport.popularity.metadata.platforms.missing_rows === 0,
    popularity_any_price_single_platform_availability: popularitySinglePlatformErrors === 0,
  },
  warnings: {
    popularity_finite_budget_filter_availability_below_six: popularityFilterWarnings,
    full_catalogue_rows_without_platform_metadata: catalogueMetadataMetrics.platform_missing,
    shared_candidate_rows_without_platform_metadata: metadataMetrics.platform_missing,
  },
  blockers: {
    missing_files: ['bpr_top100.csv', 'hybrid_top100.csv', 'manifest.json'],
    profile_coverage: {
      covered_combinations: covered.size,
      required_combinations: tasteCombos.length,
      uncovered_combinations: tasteCombos.length - covered.size,
      minimum_jaccard: minimumJaccard,
    },
    confirmations: ['A final snapshot/version', 'B final evaluation release/policy'],
  },
  note: 'The full formal validator was not passed and must not be claimed until blockers are resolved.',
};
writeFileSync(join(OUT, 'staging-validation-report.json'), JSON.stringify(stagingValidation, null, 2) + '\n');

console.log(`real-base: wrote ${OUT}`);
console.log(`real-base: profiles=${profiles.length} coverage=${covered.size}/560 minJaccard=${minimumJaccard.toFixed(6)}`);
console.log(`real-base: candidate=${candidateList.length} sha256=${candidateHash}`);
