#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv } from './study-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'study-data/staging/real-base');
const POLICY_V2 = join(ROOT, 'study-data/staging/profile-policy-v2');
const quality = JSON.parse(readFileSync(join(BASE, 'data-quality-report.json'), 'utf8'));
const policy = JSON.parse(readFileSync(join(POLICY_V2, 'policy-summary.json'), 'utf8'));
const generatedAt = new Date(quality.source_release_created_at_utc).toISOString();

const metadataRows = Object.entries(quality.metadata.fields).map(([field, values]) => ({
  field,
  label: field.replaceAll('_', ' '),
  missing_count: values.missing_count,
  candidate_count: quality.candidate.count,
  missing_rate: values.missing_rate,
  missing_percent: values.missing_percent,
}));
const policyComparisonRows = [
  {
    policy: 'Fixed top-3 baseline',
    covered_combinations: policy.baseline.covered_combinations,
    uncovered_combinations: policy.baseline.total_combinations - policy.baseline.covered_combinations,
    selected_profiles: policy.baseline.selected_profiles,
    policy_pool_maximum: policy.baseline.achievable_combinations_in_policy_pool,
    minimum_jaccard: Number(policy.baseline.minimum_jaccard),
    weakest_selected_taste_score: policy.baseline.weakest_selected_taste_score,
  },
  {
    policy: 'Top-5-derived V2',
    covered_combinations: policy.v2.covered_combinations,
    uncovered_combinations: policy.v2.total_combinations - policy.v2.covered_combinations,
    selected_profiles: policy.v2.selected_profiles,
    policy_pool_maximum: policy.v2.achievable_combinations_in_policy_pool,
    minimum_jaccard: Number(policy.v2.minimum_jaccard),
    weakest_selected_taste_score: policy.v2.weakest_selected_taste_score,
  },
];
const gapRows = [
  {
    priority: 1,
    owner: 'E / study team',
    gap: 'Top-5-derived V2 reaches 558/560; two exact taste triples remain unsupported',
    required_resolution: 'Freeze the two disabled combinations and deterministic third-taste mapping before model export',
  },
  {
    priority: 2,
    owner: 'C',
    gap: 'bpr_top100.csv is absent',
    required_resolution: 'After E freezes V2, export Top-100 for the exact 46 requested model_user_id values',
  },
  {
    priority: 3,
    owner: 'D',
    gap: 'hybrid_top100.csv is absent',
    required_resolution: 'After E freezes V2, export Top-100 for the exact 46 requested model_user_id values',
  },
  {
    priority: 4,
    owner: 'A',
    gap: 'A snapshot is locally hashed but not confirmed final',
    required_resolution: 'Confirm items/interactions snapshot hashes and metadata policy',
  },
  {
    priority: 5,
    owner: 'B',
    gap: 'B final_eval release and shared policy are locally reproduced but not confirmed final',
    required_resolution: 'Confirm release, cutoff, candidate and seen-exclusion policy',
  },
  {
    priority: 6,
    owner: 'E',
    gap: 'Formal validation stops after required-file presence when files are absent',
    required_resolution: 'Use partial validation for existing base files; do not infer that later formal rules passed',
  },
  {
    priority: 7,
    owner: 'E',
    gap: 'formal-manifest.json is absent',
    required_resolution: 'Assemble final hashes only after policy freeze, A/B confirmation, and C/D delivery',
  },
];

const sourceQuality = {
  id: 'source-quality',
  label: 'Generated real-base quality metrics',
  path: 'data-quality-report.json',
  query: {
    engine: 'DuckDB',
    language: 'sql',
    executed_at: generatedAt,
    description: 'Reads the deterministic staged quality report as one nested audit record.',
    sql: "SELECT * FROM read_json_auto('data-quality-report.json', format='auto');",
    tables_used: ['data-quality-report.json'],
    filters: [
      'B training split: timestamp <= 1641340800',
      'B seen-user cohort only; true new users excluded',
      'Profiles use training-positive interactions only',
    ],
    metric_definitions: [
      'Coverage = three-taste combinations whose best selected-profile Jaccard is at least 0.5.',
      'Popularity completeness = selected profiles with exactly 100 unique valid ranks / 41 selected profiles.',
    ],
  },
};
const sourceMetadata = {
  id: 'source-metadata',
  label: 'Candidate metadata completeness',
  path: 'metadata-quality.csv',
  query: {
    engine: 'DuckDB',
    language: 'sql',
    executed_at: generatedAt,
    description: 'Loads candidate metadata missing counts and formats field labels for the comparison chart.',
    sql: `SELECT field, replace(field, '_', ' ') AS label,
  CAST(missing_count AS INTEGER) AS missing_count,
  CAST(candidate_count AS INTEGER) AS candidate_count,
  CAST(missing_rate AS DOUBLE) AS missing_rate,
  CAST(missing_percent AS DOUBLE) AS missing_percent
FROM read_csv_auto('metadata-quality.csv', header=true)
ORDER BY missing_percent DESC;`,
    tables_used: ['metadata-quality.csv'],
    filters: ['Shared candidate only', 'No imputation'],
    metric_definitions: ['Missing percent = missing_count / candidate_count × 100.'],
  },
};
const sourceCoverage = {
  id: 'source-coverage',
  label: 'Profile-policy comparison',
  path: 'profile-policy-v2-comparison.csv',
  query: {
    engine: 'DuckDB',
    language: 'sql',
    executed_at: generatedAt,
    description: 'Loads the deterministic fixed-top-3 and top-5-derived V2 policy comparison.',
    sql: `SELECT policy,
  CAST(covered_combinations AS INTEGER) AS covered_combinations,
  CAST(uncovered_combinations AS INTEGER) AS uncovered_combinations,
  CAST(selected_profiles AS INTEGER) AS selected_profiles,
  CAST(policy_pool_maximum AS INTEGER) AS policy_pool_maximum,
  CAST(minimum_jaccard AS DOUBLE) AS minimum_jaccard,
  CAST(weakest_selected_taste_score AS INTEGER) AS weakest_selected_taste_score
FROM read_csv_auto('profile-policy-v2-comparison.csv', header=true);`,
    tables_used: ['profile-policy-v2-comparison.csv'],
    filters: [
      'Eligible users are B seen users with at least three allowed training-derived tastes',
      'No test interactions, relevance, or model performance used',
      'V2 signatures enumerate triples only from each user’s five highest-scoring supported tastes',
    ],
    metric_definitions: [
      'Best Jaccard = maximum set Jaccard between one requested taste triple and any selected profile taste triple.',
      'Policy-pool maximum = combinations with any eligible signature at Jaccard at least 0.5 under that policy.',
    ],
  },
};
const sourceGaps = {
  id: 'source-gaps',
  label: 'Formal-study gap register',
  path: 'formal-gaps.csv',
  query: {
    engine: 'DuckDB',
    language: 'sql',
    executed_at: generatedAt,
    description: 'Loads the staged formal-readiness gaps in required resolution order.',
    sql: "SELECT * FROM read_csv_auto('formal-gaps.csv', header=true) ORDER BY priority ASC;",
    tables_used: ['formal-gaps.csv'],
  },
};

const artifact = {
  surface: 'report',
  manifest: {
    version: 1,
    surface: 'report',
    title: 'PlayFinder Real-Data Base Package Quality Report',
    description: 'Provisional A/B integration evidence, quality findings, and formal-study blockers.',
    generatedAt,
    sources: [sourceQuality, sourceMetadata, sourceCoverage, sourceGaps],
    charts: [
      {
        id: 'candidate-metadata-missing',
        title: 'Shared candidate metadata missing rates',
        subtitle: 'Genres are absent for 55.0% of candidates; only 1.35% lack both genres and tags.',
        type: 'horizontalBar',
        intent: 'comparison',
        question: 'Which candidate metadata fields have the largest missing share?',
        rationale: 'Sorted horizontal bars compare seven categorical missing rates with readable field labels.',
        dataset: 'candidate_metadata',
        sourceId: 'source-metadata',
        encodings: {
          x: { field: 'label', type: 'nominal', label: 'Metadata field' },
          y: { field: 'missing_percent', type: 'quantitative', format: 'number', label: 'Missing', unit: '%' },
          tooltip: [
            { field: 'missing_count', type: 'quantitative', label: 'Missing rows' },
            { field: 'candidate_count', type: 'quantitative', label: 'Candidate rows' },
          ],
        },
        xAxisTitle: 'Metadata field',
        yAxisTitle: 'Missing candidate rows (%)',
        valueFormat: 'number',
        unit: '%',
        layout: 'full',
        palette: { kind: 'sequential', name: 'orange' },
        settings: { orientation: 'horizontal', sort: 'descending', showValues: true },
        surface: { surface: 'card', viewMode: 'both' },
      },
      {
        id: 'profile-combination-coverage',
        title: 'Taste-combination coverage by profile policy',
        subtitle: 'Top-5-derived signatures raise coverage from 519 to 558 of 560, leaving two unsupported triples.',
        type: 'bar',
        intent: 'comparison',
        question: 'How much coverage does the top-5-derived policy add over the fixed-top-3 baseline?',
        rationale: 'Two zero-based bars directly compare covered combinations under the two policies.',
        dataset: 'policy_comparison',
        sourceId: 'source-coverage',
        encodings: {
          x: { field: 'policy', type: 'nominal', label: 'Profile policy' },
          y: { field: 'covered_combinations', type: 'quantitative', format: 'number', label: 'Covered combinations' },
          tooltip: [
            { field: 'uncovered_combinations', type: 'quantitative', label: 'Uncovered combinations' },
            { field: 'selected_profiles', type: 'quantitative', label: 'Selected profiles' },
            { field: 'policy_pool_maximum', type: 'quantitative', label: 'Policy-pool maximum' },
            { field: 'minimum_jaccard', type: 'quantitative', format: 'number', label: 'Minimum best Jaccard' },
          ],
        },
        xAxisTitle: 'Profile policy',
        yAxisTitle: 'Covered taste combinations',
        valueFormat: 'number',
        layout: 'full',
        palette: { kind: 'sequential', name: 'blue' },
        settings: { orientation: 'vertical', sort: 'custom', showValues: true },
        surface: { surface: 'card', viewMode: 'both' },
      },
    ],
    tables: [
      {
        id: 'formal-gaps',
        title: 'Readiness decisions and missing inputs',
        subtitle: 'Policy decisions are separated from absent formal files and version confirmations.',
        dataset: 'formal_gaps',
        sourceId: 'source-gaps',
        defaultSort: { field: 'priority', direction: 'asc' },
        density: 'spacious',
        layout: 'full',
        columns: [
          { field: 'priority', label: 'Priority', format: 'number' },
          { field: 'owner', label: 'Owner', type: 'text' },
          { field: 'gap', label: 'Gap', type: 'text' },
          { field: 'required_resolution', label: 'Required resolution', type: 'text' },
        ],
      },
    ],
    blocks: [
      {
        id: 'title',
        type: 'markdown',
        body: '# PlayFinder Real-Data Base Package Quality Report',
        layout: 'full',
      },
      {
        id: 'executive-summary',
        type: 'markdown',
        body: `## Executive Summary

This staging package is **provisional, not formal**. It reproduces a shared candidate of **${quality.candidate.count.toLocaleString()}** Steam appids (SHA-256 \`${quality.candidate.sha256}\`) and uses **${quality.split.seen_users_only.toLocaleString()}** B seen users. The fixed-top-3 baseline covers **${policy.baseline.covered_combinations}/560** combinations with ${policy.baseline.selected_profiles} profiles; that ceiling applies only after compressing every user to one fixed top-3 signature.

The top-5-derived V2 evaluates ${policy.v2.signature_candidates.toLocaleString()} evidence-backed user/signature candidates and reaches **${policy.v2.covered_combinations}/560** with **${policy.v2.selected_profiles}** unique users. Two exact triples remain unsupported, so E must freeze the disabled-combination rule before the V2 model-user request is sent to C/D. A/B final-version confirmations, both C/D rankings, and the formal manifest are also still missing.`,
        layout: 'full',
      },
      {
        id: 'metadata-section',
        type: 'markdown',
        sourceId: 'source-metadata',
        body: `## Candidate Metadata Quality

No missing metadata was imputed. Title and price are complete in the shared candidate, while genres are missing for 55.0281%. Tags reduce the effective taste gap: only 276 candidates (1.3506%) lack both genres and tags. Seventeen candidate rows and 792 full-catalogue rows have no platform metadata; these are data-quality warnings, not automatic formal errors. A recommendation becomes unusable only when a ranked item lacks a required display field.`,
        layout: 'full',
      },
      {
        id: 'metadata-chart',
        type: 'chart',
        chartId: 'candidate-metadata-missing',
        layout: 'full',
      },
      {
        id: 'coverage-section',
        type: 'markdown',
        sourceId: 'source-coverage',
        body: `## Profile Policy Comparison

Of ${quality.split.seen_users_only.toLocaleString()} seen users, ${quality.profiles.eligible_users_with_three_tastes.toLocaleString()} have at least three supported tastes. Fixed top-3 selects ${policy.baseline.selected_profiles} profiles and covers ${policy.baseline.covered_combinations}/560. Top-5-derived V2 selects ${policy.v2.selected_profiles} profiles and covers ${policy.v2.covered_combinations}/560. Both have an all-combination minimum best Jaccard of ${Number(policy.v2.minimum_jaccard).toFixed(1)}; the weakest taste in every selected V2 signature is still supported by at least ${policy.v2.weakest_selected_taste_score} distinct training-positive game.`,
        layout: 'full',
      },
      {
        id: 'coverage-chart',
        type: 'chart',
        chartId: 'profile-combination-coverage',
        layout: 'full',
      },
      {
        id: 'integrity-section',
        type: 'markdown',
        sourceId: 'source-quality',
        body: `## Popularity and Filter Integrity

B supplies exactly 100 rows for all ${quality.profiles.selected_profiles} fixed-top-3 baseline profiles (${quality.popularity.rows_exported.toLocaleString()} rows). Duplicate ranks/items, unknown candidates, non-finite scores, and seen leakage are zero. Its 127 unique ranked items have **zero** missing titles, prices, or platforms, so catalogue-wide platform gaps do not block current Popularity. The executable A-only filter matrix has no Any Price single-platform error and five finite-budget warnings, all for profile-037 on Linux at $5–$9.`,
        layout: 'full',
      },
      {
        id: 'validation-scope',
        type: 'markdown',
        body: `## Validation Scope

Formal mode still requires the manifest plus Popularity, BPR, and Hybrid rankings. If required files are absent, it intentionally stops after file-presence checks and marks every later section **not executed**. That result must not be reported as if catalogue, profiles, coverage, seen exclusion, metadata, or rankings passed. The read-only partial mode checks the currently available base files and existing Popularity without relaxing formal requirements.`,
        layout: 'full',
      },
      {
        id: 'gaps-section',
        type: 'markdown',
        body: `## Remaining Decisions and Inputs

The fixed-top-3 41-user request is superseded and must not be sent. The 46-user V2 request is the only current candidate, but it also remains on hold until E freezes the two unsupported triples and disabled-third mapping. After that decision, C/D must use that exact request, the shared candidate hash, the same split, and all-training-interaction seen exclusion. Fixture rankings must not be substituted.`,
        layout: 'full',
      },
      {
        id: 'gaps-table',
        type: 'table',
        tableId: 'formal-gaps',
        layout: 'full',
      },
      {
        id: 'method-section',
        type: 'markdown',
        body: `## Method and Reproducibility

Profiles use only distinct training-positive games. Taste scores count games whose A genres or tags contain one of the 16 allowed tastes. V2 enumerates three-taste signatures from each user’s five highest-scoring supported tastes. Greedy coverage ties prefer higher minimum signature score, higher signature-score sum, more training positives, lower numeric user_id, then smaller frontend taste order. Each user is selected at most once. Seen exclusion includes every training-period interaction regardless of label. Reproducibility tests rerun the generator in an isolated directory and compare output hashes.`,
        layout: 'full',
      },
      {
        id: 'limitations',
        type: 'markdown',
        body: `## Limitations

The two V2-uncovered triples are **Roguelike + Cozy + Open World** and **Cozy + Survival + Turn-Based**. This is a ceiling of the stated top-5-derived signature pool at Jaccard ≥ 0.5, not an unconditional ceiling of all possible real-data policies. The threshold was not lowered, the taste vocabulary was not changed, and no user or taste evidence was synthesized.`,
        layout: 'full',
      },
      {
        id: 'next-step',
        type: 'markdown',
        body: `## Next Decision

Freeze whether the interface will disable exactly those unsupported third-taste choices. Every single taste and every two-taste prefix still has at least one legal completion. If the rule is approved, the V2 request becomes the export input for C/D; otherwise the study team must select another evidence-preserving policy before model exports begin.`,
        layout: 'full',
      },
    ],
  },
  snapshot: {
    version: 1,
    generatedAt,
    status: 'blocked',
    datasets: {
      candidate_metadata: metadataRows,
      policy_comparison: policyComparisonRows,
      formal_gaps: gapRows,
    },
    accessIssues: [
      {
        id: 'missing-bpr',
        scope: 'condition B',
        message: 'C has not supplied bpr_top100.csv for the requested model users.',
      },
      {
        id: 'missing-hybrid',
        scope: 'condition C',
        message: 'D has not supplied hybrid_top100.csv for the requested model users.',
      },
      {
        id: 'missing-formal-manifest',
        scope: 'formal package',
        message: 'formal-manifest.json cannot be finalized until policy, source versions, and all rankings are frozen.',
      },
    ],
  },
  sources: [sourceQuality, sourceMetadata, sourceCoverage, sourceGaps],
};

writeFileSync(
  join(BASE, 'formal-gaps.csv'),
  toCsv(['priority', 'owner', 'gap', 'required_resolution'], gapRows),
);
writeFileSync(
  join(BASE, 'profile-policy-v2-comparison.csv'),
  toCsv(
    [
      'policy',
      'covered_combinations',
      'uncovered_combinations',
      'selected_profiles',
      'policy_pool_maximum',
      'minimum_jaccard',
      'weakest_selected_taste_score',
    ],
    policyComparisonRows,
  ),
);
writeFileSync(join(BASE, 'report-artifact.json'), JSON.stringify(artifact, null, 2) + '\n');
writeFileSync(join(BASE, 'chart-map.md'), `# Quality report chart map

| Report section | Analytical question | Family/type | Fields | Supported takeaway | Palette |
|---|---|---|---|---|---|
| Candidate Metadata Quality | Which fields have the largest missing share? | Comparison / horizontal bar | label, missing_percent | Genres have the largest missing rate; both genres+tags missing is much smaller | single-root orange |
| Profile Policy Comparison | How much coverage does top-5-derived V2 add? | Comparison / bar | policy, covered_combinations | Coverage rises from 519 to 558, with two combinations unsupported | single-root blue |
`);
console.log(`real-base-report: wrote ${join(BASE, 'report-artifact.json')}`);
