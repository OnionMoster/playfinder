#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, normalizeItemId, toCsv } from './study-core.mjs';
import { candidateFingerprint, validateStudyData } from './study-validation.mjs';
import { scanParquet } from './parquet-lite.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A_DIR = join(ROOT, 'data');
const B_DIR = join(ROOT, 'eval');
const REAL_BASE = join(ROOT, 'study-data/staging/real-base');
const POLICY_ROOT = join(ROOT, 'study-data/staging/profile-policy-v2');
const args = process.argv.slice(2);
const outputAt = args.indexOf('--output-root');
const OUTPUT_ROOT = resolve(outputAt >= 0
  ? args[outputAt + 1]
  : join(POLICY_ROOT, 'a-v1.0-release'));
const INTEGRATION = join(OUTPUT_ROOT, 'integration-base');
const HANDOFF = join(OUTPUT_ROOT, 'cd-handoff');
const CUTOFF = 1641340800;
const CANDIDATE_HASH = '01b6bae167febed5b2012c3d8a348d0a3463d3460c9892e58b661653106246ed';
const A_RELEASE = 'v1.0';
const PACKAGE_ID = 'playfinder-cd-handoff-v2-a-v1.0-provisional';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const numericSort = (left, right) => {
  const a = BigInt(left), b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
};
const readCsv = (path, name) => parseCsv(readFileSync(path, 'utf8'), name).rows;
const required = [
  join(POLICY_ROOT, 'study_profiles.csv'),
  join(POLICY_ROOT, 'model-user-export-request.csv'),
  join(POLICY_ROOT, 'profile-coverage-report.csv'),
  join(POLICY_ROOT, 'uncovered-taste-combinations.csv'),
  join(POLICY_ROOT, 'supported-taste-combinations.csv'),
  join(POLICY_ROOT, 'third-taste-availability.csv'),
  join(POLICY_ROOT, 'policy-summary.json'),
  join(REAL_BASE, 'catalogue.json'),
  join(REAL_BASE, 'candidate_items.csv'),
  join(A_DIR, 'items.parquet'),
  join(A_DIR, 'interactions.parquet'),
  join(A_DIR, 'users.parquet'),
  join(A_DIR, 'item_popularity.parquet'),
  join(B_DIR, 'final_eval/popularity_top100.csv'),
  join(B_DIR, 'final_eval/version_info.json'),
];
for (const path of required) if (!existsSync(path)) throw new Error(`missing required local source: ${path}`);
for (const path of [INTEGRATION, HANDOFF]) {
  if (existsSync(path)) throw new Error(`output already exists; refusing to overwrite: ${path}`);
}

const profiles = readCsv(join(POLICY_ROOT, 'study_profiles.csv'), 'study_profiles.csv');
const requestRows = readCsv(
  join(POLICY_ROOT, 'model-user-export-request.csv'),
  'model-user-export-request.csv',
);
if (profiles.length !== 46 || requestRows.length !== 46) {
  throw new Error(`expected 46 V2 profiles/request rows, found ${profiles.length}/${requestRows.length}`);
}
const profileIds = new Set(profiles.map((row) => row.profile_id));
const modelUserIds = new Set(profiles.map((row) => row.model_user_id));
if (profileIds.size !== profiles.length || modelUserIds.size !== profiles.length) {
  throw new Error('V2 profiles must have unique profile_id and model_user_id values');
}
for (let index = 0; index < profiles.length; index++) {
  const profile = profiles[index], request = requestRows[index];
  for (const field of ['profile_id', 'model_user_id', 'taste_1', 'taste_2', 'taste_3']) {
    if (profile[field] !== request[field]) {
      throw new Error(`request/profile mismatch at row ${index + 1}, field ${field}`);
    }
  }
}

const candidateRows = readCsv(join(REAL_BASE, 'candidate_items.csv'), 'candidate_items.csv');
const candidateIds = new Set(candidateRows.map((row) => normalizeItemId(row.item_id)));
if (candidateIds.has(null) || candidateIds.size !== 20435) {
  throw new Error(`candidate set is invalid or unexpected: ${candidateIds.size}`);
}
const actualCandidateHash = candidateFingerprint(candidateIds);
if (actualCandidateHash !== CANDIDATE_HASH) {
  throw new Error(`candidate hash mismatch: expected ${CANDIDATE_HASH}, got ${actualCandidateHash}`);
}

console.log('profile-policy-v2-handoff: scanning selected users’ training-period interactions');
const seenByUser = new Map(profiles.map((profile) => [profile.model_user_id, new Set()]));
scanParquet(
  join(A_DIR, 'interactions.parquet'),
  ['user_id', 'item_id', 'timestamp'],
  (columns, { groupIndex, rowCount }) => {
    for (let index = 0; index < rowCount; index++) {
      const userId = String(columns.user_id[index]);
      if (!seenByUser.has(userId) || Number(columns.timestamp[index]) > CUTOFF) continue;
      const itemId = normalizeItemId(columns.item_id[index]);
      if (!itemId) throw new Error(`invalid seen item_id for model user ${userId}`);
      seenByUser.get(userId).add(itemId);
    }
    if ((groupIndex + 1) % 30 === 0) {
      console.log(`profile-policy-v2-handoff: scanned ${groupIndex + 1} interaction row groups`);
    }
  },
);
const seenRows = profiles.flatMap((profile) =>
  [...seenByUser.get(profile.model_user_id)].sort(numericSort).map((item_id) => ({
    profile_id: profile.profile_id,
    model_user_id: profile.model_user_id,
    item_id,
  })));
if (profiles.some((profile) => seenByUser.get(profile.model_user_id).size === 0)) {
  throw new Error('every requested V2 model user must have at least one training-period seen item');
}

const profileByUser = new Map(profiles.map((profile) => [profile.model_user_id, profile]));
const popularityRows = [];
const popularityAudit = new Map(profiles.map((profile) => [profile.profile_id, {
  rows: 0,
  ranks: new Set(),
  items: new Set(),
  unknownCandidate: 0,
  seenLeakage: 0,
  nonFiniteScore: 0,
}]));
console.log('profile-policy-v2-handoff: extracting B Popularity for the frozen V2 users');
{
  const stream = createReadStream(join(B_DIR, 'final_eval/popularity_top100.csv'), { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  for await (const line of lines) {
    if (!headers) {
      headers = line.split(',');
      continue;
    }
    if (!line) continue;
    const values = line.split(',');
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    const profile = profileByUser.get(row.user_id);
    if (!profile) continue;
    const itemId = normalizeItemId(row.item_id);
    const rank = Number(row.rank);
    const audit = popularityAudit.get(profile.profile_id);
    audit.rows++;
    if (audit.ranks.has(rank)) throw new Error(`duplicate Popularity rank for ${profile.profile_id}: ${rank}`);
    if (audit.items.has(itemId)) throw new Error(`duplicate Popularity item for ${profile.profile_id}: ${itemId}`);
    audit.ranks.add(rank);
    audit.items.add(itemId);
    if (!candidateIds.has(itemId)) audit.unknownCandidate++;
    if (seenByUser.get(row.user_id).has(itemId)) audit.seenLeakage++;
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
  if (
    audit.rows !== 100 ||
    audit.ranks.size !== 100 ||
    [...audit.ranks].some((rank) => !Number.isInteger(rank) || rank < 1 || rank > 100) ||
    audit.items.size !== 100 ||
    audit.unknownCandidate ||
    audit.seenLeakage ||
    audit.nonFiniteScore
  ) {
    throw new Error(`B Popularity failed for ${profile.profile_id}/${profile.model_user_id}: ${JSON.stringify({
      rows: audit.rows,
      ranks: audit.ranks.size,
      items: audit.items.size,
      unknownCandidate: audit.unknownCandidate,
      seenLeakage: audit.seenLeakage,
      nonFiniteScore: audit.nonFiniteScore,
    })}`);
  }
}
popularityRows.sort((left, right) =>
  left.profile_id.localeCompare(right.profile_id) || Number(left.rank) - Number(right.rank));

const catalogue = JSON.parse(readFileSync(join(REAL_BASE, 'catalogue.json'), 'utf8'));
const catalogueById = new Map(catalogue.map((game) => [String(game.item_id), game]));
const popularityUniqueIds = new Set(popularityRows.map((row) => row.item_id));
const recommendedMissing = {
  title: [...popularityUniqueIds].filter((id) => !catalogueById.get(id)?.title?.trim()).length,
  price: [...popularityUniqueIds].filter((id) => {
    const price = catalogueById.get(id)?.price;
    return typeof price !== 'number' || !Number.isFinite(price) || price < 0;
  }).length,
  platform: [...popularityUniqueIds].filter((id) =>
    !Array.isArray(catalogueById.get(id)?.platforms) || !catalogueById.get(id).platforms.length).length,
};
if (Object.values(recommendedMissing).some((count) => count > 0)) {
  throw new Error(`V2 Popularity has unusable recommended metadata: ${JSON.stringify(recommendedMissing)}`);
}

const sourceHashes = {
  a_items_sha256: sha256(readFileSync(join(A_DIR, 'items.parquet'))),
  a_interactions_sha256: sha256(readFileSync(join(A_DIR, 'interactions.parquet'))),
  a_users_sha256: sha256(readFileSync(join(A_DIR, 'users.parquet'))),
  a_item_popularity_sha256: sha256(readFileSync(join(A_DIR, 'item_popularity.parquet'))),
  b_popularity_sha256: sha256(readFileSync(join(B_DIR, 'final_eval/popularity_top100.csv'))),
  b_version_info_sha256: sha256(readFileSync(join(B_DIR, 'final_eval/version_info.json'))),
};
const bVersion = JSON.parse(readFileSync(join(B_DIR, 'final_eval/version_info.json'), 'utf8'));
const disabledRows = readCsv(
  join(POLICY_ROOT, 'third-taste-availability.csv'),
  'third-taste-availability.csv',
).filter((row) => row.enabled === 'false');
const uncoveredRows = readCsv(
  join(POLICY_ROOT, 'uncovered-taste-combinations.csv'),
  'uncovered-taste-combinations.csv',
);
if (disabledRows.length !== 6 || uncoveredRows.length !== 2) {
  throw new Error(`unexpected V2 policy gaps: disabled=${disabledRows.length}, uncovered=${uncoveredRows.length}`);
}

mkdirSync(INTEGRATION, { recursive: true });
copyFileSync(join(REAL_BASE, 'catalogue.json'), join(INTEGRATION, 'catalogue.json'));
copyFileSync(join(REAL_BASE, 'candidate_items.csv'), join(INTEGRATION, 'candidate_items.csv'));
for (const filename of [
  'study_profiles.csv',
  'model-user-export-request.csv',
  'profile-coverage-report.csv',
  'uncovered-taste-combinations.csv',
  'supported-taste-combinations.csv',
  'third-taste-availability.csv',
]) {
  copyFileSync(join(POLICY_ROOT, filename), join(INTEGRATION, filename));
}
writeFileSync(
  join(INTEGRATION, 'profile_seen_items.csv'),
  toCsv(['profile_id', 'model_user_id', 'item_id'], seenRows),
);
writeFileSync(
  join(INTEGRATION, 'popularity_top100.csv'),
  toCsv(['profile_id', 'model_user_id', 'item_id', 'rank', 'score'], popularityRows),
);

const qualityReport = {
  status: 'provisional_v2_export_freeze',
  formal_ready: false,
  profile_policy: 'top-5-enumerated-v2',
  profile_count: profiles.length,
  model_user_count: modelUserIds.size,
  coverage: {
    covered_combinations: 558,
    total_combinations: 560,
    threshold: 0.5,
    minimum_best_jaccard_all_combinations: 0.2,
    uncovered_combinations: uncoveredRows.map((row) => [row.taste_1, row.taste_2, row.taste_3]),
    disabled_third_taste_rows: disabledRows.length,
    all_single_and_double_prefixes_have_completion: true,
  },
  split: {
    cutoff_timestamp: CUTOFF,
    train_rule: 'timestamp <= cutoff',
    seen_exclusion: 'all training-period interactions for the same model user, regardless of label',
  },
  candidate: {
    count: candidateIds.size,
    sha256: actualCandidateHash,
  },
  seen: {
    rows: seenRows.length,
    profiles_with_seen_items: [...seenByUser.values()].filter((items) => items.size > 0).length,
    duplicate_profile_item_rows: seenRows.length -
      new Set(seenRows.map((row) => `${row.profile_id}|${row.item_id}`)).size,
  },
  popularity: {
    rows: popularityRows.length,
    profiles_with_exact_top100: [...popularityAudit.values()].filter((audit) =>
      audit.rows === 100 && audit.ranks.size === 100 && audit.items.size === 100).length,
    unique_items: popularityUniqueIds.size,
    unknown_candidate_items: [...popularityAudit.values()]
      .reduce((sum, audit) => sum + audit.unknownCandidate, 0),
    seen_leakage_rows: [...popularityAudit.values()]
      .reduce((sum, audit) => sum + audit.seenLeakage, 0),
    non_finite_scores: [...popularityAudit.values()]
      .reduce((sum, audit) => sum + audit.nonFiniteScore, 0),
    recommended_missing_metadata_unique_items: recommendedMissing,
  },
  source_release_created_at_utc: bVersion.created_at_utc,
  a_release: {
    version: A_RELEASE,
    status: 'confirmed_frozen',
    authoritative_files: [
      'items.parquet',
      'interactions.parquet',
      'users.parquet',
      'item_popularity.parquet',
    ],
    item_id_namespace: 'steam_appid_direct',
    user_group_definition: 'value_tertile',
    interactions_semantics: 'reviewed/seen, not ownership',
    genres_missingness: 'confirmed final source state; no metadata may be invented',
    source_commit: null,
    source_commit_note: 'A confirmed v1.0 but did not supply a source commit.',
  },
  source_hashes: sourceHashes,
  remaining_blockers: [
    'B final evaluation release/policy confirmation',
    'C bpr_top100.csv for the exact frozen request',
    'D hybrid_top100.csv for the exact frozen request',
    'approved study rule restricting the selectable domain to the 558 supported combinations',
    'formal manifest and complete formal validation',
  ],
};
writeFileSync(
  join(INTEGRATION, 'integration-quality-report.json'),
  JSON.stringify(qualityReport, null, 2) + '\n',
);

const manifestFiles = [
  'catalogue.json',
  'candidate_items.csv',
  'study_profiles.csv',
  'profile_seen_items.csv',
  'popularity_top100.csv',
  'model-user-export-request.csv',
  'profile-coverage-report.csv',
  'uncovered-taste-combinations.csv',
  'supported-taste-combinations.csv',
  'third-taste-availability.csv',
  'integration-quality-report.json',
];
const provisionalManifest = {
  schema_version: 'playfinder-study-v1',
  mode: 'provisional-v2-export-freeze',
  notice: 'PROVISIONAL / NOT FORMAL / A V1.0 CONFIRMED / B CONFIRMATION AND C-D RANKINGS REQUIRED',
  id_namespace: 'steam_appid',
  candidate_hash: actualCandidateHash,
  data_snapshot: {
    status: 'a_v1.0_confirmed_b_unconfirmed',
    a_release: A_RELEASE,
    a_status: 'confirmed_frozen',
    a_authoritative_files: [
      'items.parquet',
      'interactions.parquet',
      'users.parquet',
      'item_popularity.parquet',
    ],
    a_source_commit: null,
    ...sourceHashes,
  },
  split: qualityReport.split,
  profile_policy: {
    id: 'top-5-enumerated-v2',
    status: 'provisional_export_freeze',
    profiles: profiles.length,
    covered_combinations: 558,
    total_combinations: 560,
    disabled_third_taste_rows: disabledRows.length,
    frontend_changed: false,
  },
  conditions: {
    A: { model: 'popularity', status: 'available', candidate_hash: actualCandidateHash },
    B: { model: 'bpr', status: 'blocked_missing_c_export', candidate_hash: actualCandidateHash },
    C: { model: 'hybrid', status: 'blocked_missing_d_export', candidate_hash: actualCandidateHash },
  },
  files: Object.fromEntries(manifestFiles.map((filename) => [
    filename,
    sha256(readFileSync(join(INTEGRATION, filename))),
  ])),
};
writeFileSync(
  join(INTEGRATION, 'provisional-manifest.json'),
  JSON.stringify(provisionalManifest, null, 2) + '\n',
);

const partial = validateStudyData(INTEGRATION, { mode: 'partial' });
const unexpectedPartialErrors = partial.errors.filter((issue) => issue.rule !== 'profile-coverage');
const coverageErrors = partial.errors.filter((issue) => issue.rule === 'profile-coverage');
if (
  !partial.validationComplete ||
  unexpectedPartialErrors.length ||
  coverageErrors.length !== 2 ||
  partial.summary?.rankingQuality?.A?.recommendedMissingPlatformItems !== 0
) {
  throw new Error(`unexpected V2 partial-validation result: ${JSON.stringify({
    validationComplete: partial.validationComplete,
    unexpectedPartialErrors,
    coverageErrors: coverageErrors.length,
    summary: partial.summary,
  })}`);
}
mkdirSync(join(INTEGRATION, 'partial-validation'), { recursive: true });
writeFileSync(join(INTEGRATION, 'partial-validation/validation-report.json'), JSON.stringify({
  ok: partial.ok,
  formal_ready: partial.formalReady,
  validation_complete: partial.validationComplete,
  scope: partial.scope,
  stopped_after: partial.stoppedAfter,
  executed_sections: partial.executedSections,
  not_executed_sections: partial.notExecutedSections,
  note: partial.note,
  summary: partial.summary,
  errors: partial.errors,
  warnings: partial.warnings,
}, null, 2) + '\n');
writeFileSync(join(INTEGRATION, 'partial-validation/profile-coverage-report.csv'), partial.coverageCsv);
writeFileSync(join(INTEGRATION, 'partial-validation/filter-availability-report.csv'), partial.filterCsv);

const freeze = {
  policy_id: 'top-5-enumerated-v2',
  status: 'provisional_export_freeze',
  freeze_recorded_on: '2026-07-29',
  formal: false,
  frontend_changed: false,
  profile_count: profiles.length,
  unique_model_user_count: modelUserIds.size,
  jaccard_threshold: 0.5,
  covered_combinations: 558,
  total_combinations: 560,
  unsupported_combinations: uncoveredRows.map((row) => ({
    tastes: [row.taste_1, row.taste_2, row.taste_3],
    best_jaccard: Number(row.best_jaccard),
  })),
  disabled_third_taste_mapping: disabledRows.map((row) => ({
    prefix: [row.prefix_taste_1, row.prefix_taste_2],
    disabled_third_taste: row.third_taste,
  })),
  all_single_tastes_have_legal_completion: true,
  all_double_taste_prefixes_have_legal_third: true,
  candidate_count: candidateIds.size,
  candidate_sha256: actualCandidateHash,
  split_cutoff: CUTOFF,
  seen_exclusion: qualityReport.split.seen_exclusion,
  a_release: A_RELEASE,
  a_source_confirmed_frozen: true,
  a_authoritative_files: qualityReport.a_release.authoritative_files,
  a_item_id_namespace: 'steam_appid_direct',
  a_user_group_definition: 'value_tertile',
  a_interactions_semantics: 'reviewed/seen, not ownership',
  a_genres_missingness: 'final source state; no imputation',
  a_source_commit: null,
  b_source_confirmed_final: false,
  source_versions_confirmed_final: false,
};

mkdirSync(HANDOFF, { recursive: true });
for (const filename of [
  'model-user-export-request.csv',
  'candidate_items.csv',
  'profile_seen_items.csv',
  'study_profiles.csv',
]) {
  copyFileSync(join(INTEGRATION, filename), join(HANDOFF, filename));
}
writeFileSync(join(HANDOFF, 'profile-policy-freeze.json'), JSON.stringify(freeze, null, 2) + '\n');
writeFileSync(
  join(HANDOFF, 'ranking-output-schema.csv'),
  'profile_id,model_user_id,item_id,rank,score\n',
);

const aConfirmation = `# A v1.0 data-freeze record

## Confirmed by member A

- Release: **v1.0 frozen**.
- Authoritative files: \`items.parquet\`, \`interactions.parquet\`, \`users.parquet\`, and \`item_popularity.parquet\`.
- \`item_id\` is the Steam appid directly; no ID mapping is required.
- The authoritative user-group definition is \`value_tertile\`, not the earlier products/reviews wording.
- Interactions represent reviewed/seen activity only. They do **not** prove ownership.
- Missing genres in \`items.parquet\` are part of the final source state.

## Local frozen-file hashes

| File | SHA-256 |
|---|---|
| \`items.parquet\` | \`${sourceHashes.a_items_sha256}\` |
| \`interactions.parquet\` | \`${sourceHashes.a_interactions_sha256}\` |
| \`users.parquet\` | \`${sourceHashes.a_users_sha256}\` |
| \`item_popularity.parquet\` | \`${sourceHashes.a_item_popularity_sha256}\` |

A did not supply a source commit. This handoff pins A v1.0 by the four exact hashes above.

## E conversion implications

- The catalogue is derived from \`items.parquet\`.
- Seen exclusion means training-period reviewed/interacted games, not owned games.
- Missing genres are preserved. No genre is inferred or invented.
- Genre hard filtering may use only explicit source genres. Tags may support taste/profile evidence but do not become fabricated genres.
- C/D must not use user group or taste metadata to alter their model rankings.
`;
writeFileSync(join(HANDOFF, 'A-DATA-FREEZE.md'), aConfirmation);

const returnChecklist = `# C/D return checklist

Before returning a model export, check every item below.

## File identity

- C filename: \`bpr_top100.csv\`.
- D filename: \`hybrid_top100.csv\`.
- Exact header: \`profile_id,model_user_id,item_id,rank,score\`.
- Exactly 4,600 data rows plus one header row.

## User and rank integrity

- Exactly the 46 request profiles and model users.
- No missing, replacement, or additional user.
- Exactly 100 rows for each profile.
- Unique, contiguous ranks 1–100 for each profile.
- 100 unique item IDs for each profile.
- Finite score on the model's native scale.

## Candidate and exclusion integrity

- Every item is a positive-integer Steam appid.
- Every item appears in \`candidate_items.csv\`.
- No returned profile/item pair appears in \`profile_seen_items.csv\`.
- No fixture, Popularity, catalogue fallback, or padding item was appended.
- No test-period interaction, relevance, or evaluation outcome informed the export.

If any requested model user is unsupported, stop and report the exact \`profile_id\` and \`model_user_id\`; do not substitute another user.
`;
writeFileSync(join(HANDOFF, 'C-D-RETURN-CHECKLIST.md'), returnChecklist);

const handoffManifest = {
  schema_version: 'playfinder-cd-handoff-v1',
  package_id: PACKAGE_ID,
  status: 'provisional_export_freeze',
  formal: false,
  created_on: '2026-07-29',
  requested_outputs: {
    member_c: 'bpr_top100.csv',
    member_d: 'hybrid_top100.csv',
    schema: ['profile_id', 'model_user_id', 'item_id', 'rank', 'score'],
    rows_per_profile: 100,
  },
  request: {
    profile_count: profiles.length,
    unique_model_user_count: modelUserIds.size,
    data_rows_per_return_file: profiles.length * 100,
  },
  candidate: {
    count: candidateIds.size,
    sha256: actualCandidateHash,
    id_namespace: 'steam_appid',
  },
  split: {
    cutoff_timestamp: CUTOFF,
    train_rule: 'timestamp <= cutoff',
    test_rule: 'timestamp > cutoff',
    seen_exclusion: qualityReport.split.seen_exclusion,
    interactions_semantics: 'reviewed/seen, not ownership',
  },
  a_data_freeze: {
    version: A_RELEASE,
    status: 'confirmed_frozen',
    source_commit: null,
    authoritative_files: {
      'items.parquet': sourceHashes.a_items_sha256,
      'interactions.parquet': sourceHashes.a_interactions_sha256,
      'users.parquet': sourceHashes.a_users_sha256,
      'item_popularity.parquet': sourceHashes.a_item_popularity_sha256,
    },
    item_id_namespace: 'steam_appid_direct',
    user_group_definition: 'value_tertile',
    genres_missingness: 'confirmed final; no imputation',
  },
  b_data_freeze: {
    status: 'awaiting_final_confirmation',
    popularity_sha256: sourceHashes.b_popularity_sha256,
    version_info_sha256: sourceHashes.b_version_info_sha256,
  },
  profile_policy: {
    id: 'top-5-enumerated-v2',
    covered_combinations: 558,
    total_combinations: 560,
    jaccard_threshold: 0.5,
    disabled_third_taste_rows: disabledRows.length,
  },
};
writeFileSync(
  join(HANDOFF, 'handoff-manifest.json'),
  JSON.stringify(handoffManifest, null, 2) + '\n',
);

const readme = `# PlayFinder C/D model export handoff

## Status and exact request

Package ID: \`${PACKAGE_ID}\`.

This handoff is a **provisional export freeze, not a formal data release**. A's four-file **v1.0 frozen release is confirmed and hash-pinned**. B's final-evaluation release is still awaiting confirmation. Use only the 46 rows in \`model-user-export-request.csv\`. The old 41-user fixed-top-3 request is superseded and must not be used.

- Member C returns BPR as \`bpr_top100.csv\`.
- Member D returns Hybrid as \`hybrid_top100.csv\`.
- Do not replace an unsupported model user. Stop and report the exact \`model_user_id\` instead.
- Do not change \`profile_id\`, user mapping, or taste signature.
- Do not use test interactions, test relevance, or evaluation outcomes to select users or rankings.

## A v1.0 data freeze

- Authoritative files: \`items.parquet\`, \`interactions.parquet\`, \`users.parquet\`, and \`item_popularity.parquet\`.
- \`item_id\` equals the Steam appid directly.
- Authoritative user grouping: \`value_tertile\`.
- Interactions mean reviewed/seen, **not ownership**.
- Missing genres are confirmed final source state; no metadata may be invented.
- Source commit was not supplied; the exact four SHA-256 values are recorded in \`A-DATA-FREEZE.md\` and \`handoff-manifest.json\`.

## Shared candidate and split

- ID namespace: positive-integer Steam appid serialized as a string.
- Candidate rows: **${candidateIds.size.toLocaleString()}**.
- Candidate SHA-256: \`${actualCandidateHash}\`.
- Training split: \`timestamp <= ${CUTOFF}\`.
- Test split: \`timestamp > ${CUTOFF}\`.
- Candidate policy: unique training-period \`label=1\` items intersected with A's catalogue.
- Seen exclusion: every training-period interaction for the requested model user, regardless of label.

\`candidate_items.csv\` and \`profile_seen_items.csv\` are the exact validation inputs. A returned item must be in the candidate file and must not appear in that profile's seen rows.

## Required output

Return exactly:

\`\`\`csv
profile_id,model_user_id,item_id,rank,score
\`\`\`

For every requested profile:

1. Return exactly 100 rows after candidate and seen exclusion.
2. Use contiguous unique ranks 1–100.
3. Use 100 unique Steam appids.
4. Keep scores finite and on the model's native scale; do not normalize scores across models.
5. Preserve the request's \`profile_id ↔ model_user_id\` mapping.
6. Do not append fallback, fixture, Popularity, or catalogue items to reach 100.

\`ranking-output-schema.csv\` is header-only and contains no fabricated ranking.

## Policy freeze

The current V2 profile set covers 558/560 taste triples at Jaccard ≥ 0.5. The two unsupported triples and six deterministic third-choice disables are recorded in \`profile-policy-freeze.json\`. This policy record is for identity/provenance only; C/D must not use tastes to modify their model ranking.

## Files

- \`model-user-export-request.csv\`: the exact 46 profiles/users to score.
- \`candidate_items.csv\`: the exact shared candidate.
- \`profile_seen_items.csv\`: the exact training-period exclusion rows for those users.
- \`study_profiles.csv\`: profile/user/taste identity and training evidence for audit.
- \`profile-policy-freeze.json\`: provisional policy decision and disabled-choice mapping.
- \`ranking-output-schema.csv\`: required output header only.
- \`A-DATA-FREEZE.md\`: A v1.0 authority, semantics, and four source hashes.
- \`C-D-RETURN-CHECKLIST.md\`: pre-return validation checklist.
- \`handoff-manifest.json\`: machine-readable provenance and requested outputs.
- \`SHA256SUMS\`: integrity hashes for this handoff.

## Confirmation still pending

A v1.0 is confirmed frozen. B has not yet confirmed that the local final-evaluation release, shared candidate/split policy, seen exclusion, and Popularity export are final. Returned rankings therefore remain provisional until B's confirmation, the supported-combination study rule is approved, and E completes formal validation.
`;
writeFileSync(join(HANDOFF, 'README.md'), readme);

const handoffFiles = [
  'A-DATA-FREEZE.md',
  'C-D-RETURN-CHECKLIST.md',
  'README.md',
  'candidate_items.csv',
  'handoff-manifest.json',
  'model-user-export-request.csv',
  'profile-policy-freeze.json',
  'profile_seen_items.csv',
  'ranking-output-schema.csv',
  'study_profiles.csv',
];
writeFileSync(
  join(HANDOFF, 'SHA256SUMS'),
  handoffFiles.map((filename) =>
    `${sha256(readFileSync(join(HANDOFF, filename)))}  ${filename}`).join('\n') + '\n',
);

console.log(`profile-policy-v2-handoff: integration base=${INTEGRATION}`);
console.log(`profile-policy-v2-handoff: C/D handoff=${HANDOFF}`);
console.log(`profile-policy-v2-handoff: profiles=${profiles.length} seenRows=${seenRows.length} popularityRows=${popularityRows.length}`);
console.log(`profile-policy-v2-handoff: partial errors=${partial.errors.length} (expected coverage-only=${coverageErrors.length}) warnings=${partial.warnings.length}`);
