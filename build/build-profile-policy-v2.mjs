#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASTES, combinations, jaccard, normalizeItemId, toCsv,
} from './study-core.mjs';
import { scanParquet } from './parquet-lite.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A_DIR = join(ROOT, 'data');
const B_DIR = join(ROOT, 'eval');
const args = process.argv.slice(2);
const outputAt = args.indexOf('--output');
const OUT = resolve(outputAt >= 0
  ? args[outputAt + 1]
  : join(ROOT, 'study-data/staging/profile-policy-v2'));
const CUTOFF = 1641340800;
const THRESHOLD = 0.5;
const TASTE_INDEX = new Map(TASTES.map((taste, index) => [taste, index]));
const tasteCombos = combinations(TASTES, 3);

const required = [
  join(A_DIR, 'items.parquet'),
  join(A_DIR, 'interactions.parquet'),
  join(B_DIR, 'results/evaluation_users.csv'),
  join(B_DIR, 'final_eval/version_info.json'),
];
for (const path of required) if (!existsSync(path)) throw new Error(`missing required local source: ${path}`);
if (existsSync(OUT)) throw new Error(`output already exists; refusing to overwrite: ${OUT}`);

const numericCompare = (left, right) => {
  const a = BigInt(left), b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
};
const signatureCompare = (left, right) => {
  for (let index = 0; index < 3; index++) {
    const delta = TASTE_INDEX.get(left[index]) - TASTE_INDEX.get(right[index]);
    if (delta) return delta;
  }
  return 0;
};
const canonicalSignature = (tastes) => [...tastes]
  .sort((left, right) => TASTE_INDEX.get(left) - TASTE_INDEX.get(right));
const signatureKey = (tastes) => canonicalSignature(tastes).join('|');
const ensureSet = (map, key) => {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
};
const coverageFor = (tastes) => tasteCombos
  .map((combo, index) => jaccard(tastes, combo) >= THRESHOLD ? index : -1)
  .filter((index) => index >= 0);

console.log('profile-policy-v2: loading A taste metadata');
const tokensByItem = new Map();
scanParquet(
  join(A_DIR, 'items.parquet'),
  ['item_id', 'genres', 'tags'],
  (columns, { rowCount }) => {
    for (let index = 0; index < rowCount; index++) {
      const itemId = normalizeItemId(columns.item_id[index]);
      if (!itemId) throw new Error(`invalid A item_id ${columns.item_id[index]}`);
      const tokens = new Set([
        ...(Array.isArray(columns.genres[index]) ? columns.genres[index] : []),
        ...(Array.isArray(columns.tags[index]) ? columns.tags[index] : []),
      ].map(String));
      tokensByItem.set(itemId, tokens);
    }
  },
);

const evaluationUsers = new Set();
{
  const parsed = readFileSync(join(B_DIR, 'results/evaluation_users.csv'), 'utf8').trim().split(/\r?\n/);
  const headers = parsed.shift().split(',');
  const userAt = headers.indexOf('user_id');
  if (userAt < 0) throw new Error('B evaluation_users.csv is missing user_id');
  for (const line of parsed) evaluationUsers.add(line.split(',')[userAt]);
}
if (evaluationUsers.size !== 9000) throw new Error(`expected 9000 B evaluation users, found ${evaluationUsers.size}`);

const seenByUser = new Map();
const positiveTrainByUser = new Map();
const positiveTestUsers = new Set();
let trainRows = 0, testRows = 0;
console.log('profile-policy-v2: scanning A interactions with B split');
scanParquet(
  join(A_DIR, 'interactions.parquet'),
  ['user_id', 'item_id', 'label', 'timestamp'],
  (columns, { groupIndex, rowCount }) => {
    for (let index = 0; index < rowCount; index++) {
      const userId = String(columns.user_id[index]);
      const itemId = String(columns.item_id[index]);
      const label = Number(columns.label[index]);
      const timestamp = Number(columns.timestamp[index]);
      if (timestamp <= CUTOFF) {
        trainRows++;
        if (evaluationUsers.has(userId)) {
          ensureSet(seenByUser, userId).add(itemId);
          if (label === 1) ensureSet(positiveTrainByUser, userId).add(itemId);
        }
      } else {
        testRows++;
        if (label === 1 && evaluationUsers.has(userId)) positiveTestUsers.add(userId);
      }
    }
    if ((groupIndex + 1) % 30 === 0) {
      console.log(`profile-policy-v2: scanned ${groupIndex + 1} interaction row groups`);
    }
  },
);
if (trainRows !== 17838174 || testRows !== 4448786) {
  throw new Error(`split row-count mismatch: train=${trainRows}, test=${testRows}`);
}
const seenUsers = [...evaluationUsers]
  .filter((userId) => positiveTestUsers.has(userId) && (seenByUser.get(userId)?.size || 0) > 0)
  .sort(numericCompare);
if (seenUsers.length !== 5119) throw new Error(`expected 5119 seen users, found ${seenUsers.length}`);

const users = [];
for (const userId of seenUsers) {
  const positiveItems = positiveTrainByUser.get(userId) || new Set();
  const scores = new Map(TASTES.map((taste) => [taste, 0]));
  for (const itemId of positiveItems) {
    const tokens = tokensByItem.get(itemId);
    if (!tokens) continue;
    for (const taste of TASTES) if (tokens.has(taste)) scores.set(taste, scores.get(taste) + 1);
  }
  const rankedTastes = TASTES.filter((taste) => scores.get(taste) > 0)
    .sort((left, right) => scores.get(right) - scores.get(left) ||
      TASTE_INDEX.get(left) - TASTE_INDEX.get(right));
  users.push({
    userId,
    scores,
    rankedTastes,
    trainPositiveCount: positiveItems.size,
  });
}
const eligibleUsers = users.filter((user) => user.rankedTastes.length >= 3);
if (eligibleUsers.length !== 4671) {
  throw new Error(`expected 4671 users with at least three supported tastes, found ${eligibleUsers.length}`);
}

const makeCandidate = (user, tastes) => {
  const canonical = canonicalSignature(tastes);
  const tasteScores = canonical.map((taste) => user.scores.get(taste));
  if (tasteScores.some((score) => !Number.isInteger(score) || score < 1)) {
    throw new Error(`unsupported signature generated for user ${user.userId}: ${canonical.join('|')}`);
  }
  return {
    userId: user.userId,
    tastes: canonical,
    tasteScores,
    minTasteScore: Math.min(...tasteScores),
    scoreSum: tasteScores.reduce((sum, score) => sum + score, 0),
    trainPositiveCount: user.trainPositiveCount,
    coverage: coverageFor(canonical),
  };
};

const baselineCandidates = eligibleUsers.map((user) =>
  makeCandidate(user, user.rankedTastes.slice(0, 3)));
const v2Candidates = [];
for (const user of eligibleUsers) {
  const topFive = user.rankedTastes.slice(0, 5);
  for (const tastes of combinations(topFive, 3)) v2Candidates.push(makeCandidate(user, tastes));
}

const greedySelect = (candidates, compareTie) => {
  const selected = [];
  const covered = new Set();
  const selectedUsers = new Set();
  while (covered.size < tasteCombos.length) {
    let best = null, bestGain = 0;
    for (const candidate of candidates) {
      if (selectedUsers.has(candidate.userId)) continue;
      let gain = 0;
      for (const index of candidate.coverage) if (!covered.has(index)) gain++;
      if (!best || gain > bestGain || (gain === bestGain && compareTie(candidate, best) < 0)) {
        best = candidate;
        bestGain = gain;
      }
    }
    if (!best || bestGain === 0) break;
    selected.push(best);
    selectedUsers.add(best.userId);
    for (const index of best.coverage) covered.add(index);
  }
  return { selected, covered };
};

const baselineTie = (left, right) =>
  right.trainPositiveCount - left.trainPositiveCount ||
  numericCompare(left.userId, right.userId);
const v2Tie = (left, right) =>
  right.minTasteScore - left.minTasteScore ||
  right.scoreSum - left.scoreSum ||
  right.trainPositiveCount - left.trainPositiveCount ||
  numericCompare(left.userId, right.userId) ||
  signatureCompare(left.tastes, right.tastes);

const baseline = greedySelect(baselineCandidates, baselineTie);
const v2 = greedySelect(v2Candidates, v2Tie);
const candidatePoolCoverage = (candidates) => new Set(candidates.flatMap((candidate) => candidate.coverage));

const buildProfiles = (selected) => selected.map((candidate, index) => ({
  profile_id: `profile-${String(index + 1).padStart(3, '0')}`,
  model_user_id: candidate.userId,
  taste_1: candidate.tastes[0],
  taste_2: candidate.tastes[1],
  taste_3: candidate.tastes[2],
  train_positive_count: candidate.trainPositiveCount,
  taste_1_score: candidate.tasteScores[0],
  taste_2_score: candidate.tasteScores[1],
  taste_3_score: candidate.tasteScores[2],
  signature_min_taste_score: candidate.minTasteScore,
  signature_score_sum: candidate.scoreSum,
}));
const baselineProfiles = buildProfiles(baseline.selected);
const v2Profiles = buildProfiles(v2.selected);

const coverageReport = (profiles) => {
  let minimumJaccard = 1;
  const rows = tasteCombos.map((combo) => {
    const scored = profiles.map((profile) => ({
      profile,
      similarity: jaccard(combo, [profile.taste_1, profile.taste_2, profile.taste_3]),
    })).sort((left, right) => right.similarity - left.similarity ||
      left.profile.profile_id.localeCompare(right.profile.profile_id));
    const best = scored[0];
    const bestJaccard = best?.similarity ?? 0;
    const tieCount = scored.filter((entry) => entry.similarity === bestJaccard).length;
    minimumJaccard = Math.min(minimumJaccard, bestJaccard);
    return {
      taste_1: combo[0],
      taste_2: combo[1],
      taste_3: combo[2],
      best_profile_id: best?.profile.profile_id || '',
      best_jaccard: bestJaccard.toFixed(6),
      best_profile_tie_count: tieCount,
      tied: tieCount > 1,
      covered_at_0_5: bestJaccard >= THRESHOLD,
    };
  });
  return { rows, minimumJaccard };
};
const baselineCoverage = coverageReport(baselineProfiles);
const v2Coverage = coverageReport(v2Profiles);
const baselinePoolCoverage = candidatePoolCoverage(baselineCandidates);
const v2PoolCoverage = candidatePoolCoverage(v2Candidates);

const policyRows = [
  {
    policy: 'fixed-top-3-baseline',
    seen_users: seenUsers.length,
    eligible_users: eligibleUsers.length,
    signature_candidates: baselineCandidates.length,
    selected_profiles: baselineProfiles.length,
    covered_combinations: baseline.covered.size,
    achievable_combinations_in_policy_pool: baselinePoolCoverage.size,
    total_combinations: tasteCombos.length,
    coverage_rate: (baseline.covered.size / tasteCombos.length).toFixed(8),
    minimum_jaccard: baselineCoverage.minimumJaccard.toFixed(6),
    weakest_selected_taste_score: Math.min(...baseline.selected.map((entry) => entry.minTasteScore)),
    all_selected_tastes_have_training_evidence: baseline.selected.every((entry) =>
      entry.tasteScores.every((score) => score >= 1)),
  },
  {
    policy: 'top-5-enumerated-v2',
    seen_users: seenUsers.length,
    eligible_users: eligibleUsers.length,
    signature_candidates: v2Candidates.length,
    selected_profiles: v2Profiles.length,
    covered_combinations: v2.covered.size,
    achievable_combinations_in_policy_pool: v2PoolCoverage.size,
    total_combinations: tasteCombos.length,
    coverage_rate: (v2.covered.size / tasteCombos.length).toFixed(8),
    minimum_jaccard: v2Coverage.minimumJaccard.toFixed(6),
    weakest_selected_taste_score: Math.min(...v2.selected.map((entry) => entry.minTasteScore)),
    all_selected_tastes_have_training_evidence: v2.selected.every((entry) =>
      entry.tasteScores.every((score) => score >= 1)),
  },
];

const v2CandidatesByCombo = tasteCombos.map(() => []);
for (const candidate of v2Candidates) {
  for (const index of candidate.coverage) v2CandidatesByCombo[index].push(candidate);
}
const supportedRows = tasteCombos.map((combo, index) => {
  const candidates = v2CandidatesByCombo[index];
  candidates.sort((left, right) =>
    v2Tie(left, right) ||
    signatureCompare(left.tastes, right.tastes));
  const best = candidates[0];
  const distinctUsers = new Set(candidates.map((candidate) => candidate.userId));
  const selectedCoverage = v2Coverage.rows[index];
  return {
    taste_1: combo[0],
    taste_2: combo[1],
    taste_3: combo[2],
    supported_by_top5_candidate_pool: candidates.length > 0,
    covered_by_selected_profiles: selectedCoverage.covered_at_0_5,
    best_selected_jaccard: selectedCoverage.best_jaccard,
    supporting_signature_count: candidates.length,
    supporting_user_count: distinctUsers.size,
    best_support_model_user_id: best?.userId || '',
    best_support_signature: best ? signatureKey(best.tastes) : '',
    best_support_min_taste_score: best?.minTasteScore ?? '',
    best_support_score_sum: best?.scoreSum ?? '',
  };
});

const supportByComboKey = new Map(supportedRows.map((row) => [
  signatureKey([row.taste_1, row.taste_2, row.taste_3]),
  row,
]));
const thirdTasteRows = [];
for (const prefix of combinations(TASTES, 2)) {
  for (const thirdTaste of TASTES) {
    if (prefix.includes(thirdTaste)) continue;
    const row = supportByComboKey.get(signatureKey([...prefix, thirdTaste]));
    thirdTasteRows.push({
      prefix_taste_1: prefix[0],
      prefix_taste_2: prefix[1],
      third_taste: thirdTaste,
      enabled: row?.covered_by_selected_profiles === true,
      supporting_user_count: row?.supporting_user_count ?? 0,
      disabled_reason: row?.covered_by_selected_profiles === true
        ? ''
        : 'no selected real profile reaches Jaccard >= 0.5 under top-5 policy',
    });
  }
}
const prefixSummaryRows = [
  ...TASTES.map((taste) => {
    const rows = supportedRows.filter((row) =>
      [row.taste_1, row.taste_2, row.taste_3].includes(taste));
    return {
      prefix_size: 1,
      prefix_taste_1: taste,
      prefix_taste_2: '',
      available_third_taste_count: rows.filter((row) => row.covered_by_selected_profiles).length,
      has_legal_completion: rows.some((row) => row.covered_by_selected_profiles),
    };
  }),
  ...combinations(TASTES, 2).map((prefix) => {
    const rows = thirdTasteRows.filter((row) =>
      row.prefix_taste_1 === prefix[0] && row.prefix_taste_2 === prefix[1]);
    return {
      prefix_size: 2,
      prefix_taste_1: prefix[0],
      prefix_taste_2: prefix[1],
      available_third_taste_count: rows.filter((row) => row.enabled).length,
      has_legal_completion: rows.some((row) => row.enabled),
    };
  }),
];

const minV2Support = Math.min(...v2.selected.map((entry) => entry.minTasteScore));
const uncovered = v2Coverage.rows.filter((row) => !row.covered_at_0_5);
const singlePrefixesComplete = prefixSummaryRows
  .filter((row) => row.prefix_size === 1)
  .every((row) => row.has_legal_completion);
const doublePrefixesComplete = prefixSummaryRows
  .filter((row) => row.prefix_size === 2)
  .every((row) => row.has_legal_completion);
const bVersion = JSON.parse(readFileSync(join(B_DIR, 'final_eval/version_info.json'), 'utf8'));
const recommendation = v2.covered.size === tasteCombos.length
  ? 'Recommend top-5-enumerated V2 as the formal profile policy, while keeping this output provisional until A/B versions are confirmed.'
  : 'Do not freeze a formal profile policy yet. Keep Jaccard at 0.5 and use the emitted deterministic third-taste availability mapping.';
const requestGuidance = v2.covered.size === tasteCombos.length
  ? 'The V2 `model-user-export-request.csv` is the policy-correct request, but remains provisional until A/B version confirmation.'
  : 'The V2 `model-user-export-request.csv` is the only current policy candidate, but must not be sent to C/D until E freezes the disabled-combination rule.';
const uncoveredLines = uncovered.length
  ? uncovered.map((row) =>
    `- ${row.taste_1} + ${row.taste_2} + ${row.taste_3} (best Jaccard ${row.best_jaccard})`).join('\n')
  : '- None.';
const disabledThirdLines = thirdTasteRows.filter((row) => !row.enabled)
  .map((row) =>
    `- After ${row.prefix_taste_1} + ${row.prefix_taste_2}, disable ${row.third_taste}.`).join('\n');
const report = `# PlayFinder profile policy V2 report

## Status

This output is **provisional, not formal**. It uses only distinct training-period positive games at B's cutoff \`${CUTOFF}\`. Test-period interactions, test relevance, and model outcomes are not used.

${recommendation}

${requestGuidance}

## Corrected baseline interpretation

The fixed top-3 baseline covers **${baseline.covered.size}/${tasteCombos.length}** combinations. Its ${baselinePoolCoverage.size}/${tasteCombos.length} achievable count is a limit only after each user has been compressed to one fixed top-3 signature. It is not an unconditional limit of the real training data.

## Policy comparison

| Policy | Candidate signatures | Selected profiles | Coverage | Minimum Jaccard | Weakest selected taste score |
|---|---:|---:|---:|---:|---:|
| Fixed top-3 baseline | ${baselineCandidates.length.toLocaleString()} | ${baselineProfiles.length} | ${baseline.covered.size}/${tasteCombos.length} | ${baselineCoverage.minimumJaccard.toFixed(6)} | ${policyRows[0].weakest_selected_taste_score} |
| Top-5 enumerated V2 | ${v2Candidates.length.toLocaleString()} | ${v2Profiles.length} | ${v2.covered.size}/${tasteCombos.length} | ${v2Coverage.minimumJaccard.toFixed(6)} | ${minV2Support} |

Every selected V2 taste has support from at least one distinct training-positive game. The weakest selected taste score is **${minV2Support}**.

## Coverage and frontend executability

- Uncovered combinations: **${uncovered.length}**.
- Every single-taste prefix has at least one legal completion: **${singlePrefixesComplete}**.
- Every two-taste prefix has at least one legal third taste: **${doublePrefixesComplete}**.
- \`supported-taste-combinations.csv\` is the canonical 560-row support table.
- \`third-taste-availability.csv\` is the deterministic frontend mapping. Rows with \`enabled=false\` identify third tastes that must be disabled if this policy is frozen.

### Unsupported triples

${uncoveredLines}

### Deterministic disabled-third mapping

${disabledThirdLines || '- No third-taste choices need to be disabled.'}

## Greedy selection rule

At each step, the implementation maximizes uncovered-combination gain. Gain ties prefer: higher minimum selected taste score; higher selected score sum; more distinct training-positive games; lower numeric user_id; then the lexicographically smaller signature under the frontend taste order. One model_user_id can be selected at most once.

## Remaining blockers

- A must confirm the local catalogue/interactions snapshot version.
- B must confirm the local split, seen-user cohort, candidate policy, and Popularity release.
- BPR and Hybrid rankings for the V2 request remain absent and were not generated in this run.
- A formal manifest can only be assembled after version confirmation and all ranking files are present and validated.
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'policy-comparison.csv'), toCsv(
  [
    'policy', 'seen_users', 'eligible_users', 'signature_candidates', 'selected_profiles',
    'covered_combinations', 'achievable_combinations_in_policy_pool', 'total_combinations',
    'coverage_rate', 'minimum_jaccard', 'weakest_selected_taste_score',
    'all_selected_tastes_have_training_evidence',
  ],
  policyRows,
));
writeFileSync(join(OUT, 'study_profiles.csv'), toCsv(
  [
    'profile_id', 'model_user_id', 'taste_1', 'taste_2', 'taste_3',
    'train_positive_count', 'taste_1_score', 'taste_2_score', 'taste_3_score',
    'signature_min_taste_score', 'signature_score_sum',
  ],
  v2Profiles,
));
writeFileSync(join(OUT, 'profile-coverage-report.csv'), toCsv(
  [
    'taste_1', 'taste_2', 'taste_3', 'best_profile_id', 'best_jaccard',
    'best_profile_tie_count', 'tied', 'covered_at_0_5',
  ],
  v2Coverage.rows,
));
writeFileSync(join(OUT, 'uncovered-taste-combinations.csv'), toCsv(
  ['taste_1', 'taste_2', 'taste_3', 'best_profile_id', 'best_jaccard'],
  uncovered,
));
writeFileSync(join(OUT, 'supported-taste-combinations.csv'), toCsv(
  [
    'taste_1', 'taste_2', 'taste_3', 'supported_by_top5_candidate_pool',
    'covered_by_selected_profiles', 'best_selected_jaccard', 'supporting_signature_count',
    'supporting_user_count', 'best_support_model_user_id', 'best_support_signature',
    'best_support_min_taste_score', 'best_support_score_sum',
  ],
  supportedRows,
));
writeFileSync(join(OUT, 'third-taste-availability.csv'), toCsv(
  [
    'prefix_taste_1', 'prefix_taste_2', 'third_taste', 'enabled',
    'supporting_user_count', 'disabled_reason',
  ],
  thirdTasteRows,
));
writeFileSync(join(OUT, 'taste-prefix-support-summary.csv'), toCsv(
  [
    'prefix_size', 'prefix_taste_1', 'prefix_taste_2',
    'available_third_taste_count', 'has_legal_completion',
  ],
  prefixSummaryRows,
));
writeFileSync(join(OUT, 'model-user-export-request.csv'), toCsv(
  ['profile_id', 'model_user_id', 'taste_1', 'taste_2', 'taste_3'],
  v2Profiles,
));
writeFileSync(join(OUT, 'profile-policy-report.md'), report);
writeFileSync(join(OUT, 'policy-summary.json'), JSON.stringify({
  status: 'provisional',
  source_release_created_at_utc: bVersion.created_at_utc,
  split_cutoff: CUTOFF,
  baseline: policyRows[0],
  v2: policyRows[1],
  prefix_support: {
    all_single_tastes_have_legal_completion: singlePrefixesComplete,
    all_double_tastes_have_legal_third: doublePrefixesComplete,
    disabled_third_taste_rows: thirdTasteRows.filter((row) => !row.enabled).length,
  },
  recommended_policy: v2.covered.size === tasteCombos.length
    ? 'top-5-enumerated-v2'
    : null,
  blockers: [
    ...(v2.covered.size < tasteCombos.length
      ? ['E decision to freeze the two unsupported taste combinations and deterministic disabled-third mapping']
      : []),
    'A final snapshot/version confirmation',
    'B final evaluation release/policy confirmation',
    'bpr_top100.csv for the V2 request',
    'hybrid_top100.csv for the V2 request',
    'formal manifest and full formal validation',
  ],
}, null, 2) + '\n');

console.log(`profile-policy-v2: wrote ${OUT}`);
console.log(`profile-policy-v2: baseline=${baseline.covered.size}/560 profiles=${baselineProfiles.length}`);
console.log(`profile-policy-v2: v2=${v2.covered.size}/560 profiles=${v2Profiles.length} minJaccard=${v2Coverage.minimumJaccard.toFixed(6)}`);
console.log(`profile-policy-v2: weakest selected taste score=${minV2Support}`);
