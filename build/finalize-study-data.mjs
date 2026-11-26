#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync,
  readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './study-core.mjs';
import { formatValidationIssues, validateStudyData } from './study-validation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const source = resolve(value(
  '--input',
  join(ROOT, 'study-data/staging/three-model-provisional'),
));
const output = resolve(value('--output', join(ROOT, 'study-data/incoming/final')));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const readCsv = (name) => parseCsv(readFileSync(join(source, name), 'utf8'), name).rows;

const coreFiles = [
  'catalogue.json',
  'candidate_items.csv',
  'study_profiles.csv',
  'profile_seen_items.csv',
  'popularity_top100.csv',
  'bpr_top100.csv',
  'hybrid_top100.csv',
];
const policyFiles = [
  'profile-coverage-report.csv',
  'uncovered-taste-combinations.csv',
  'supported-taste-combinations.csv',
  'third-taste-availability.csv',
];
for (const filename of [...coreFiles, ...policyFiles, 'provisional-manifest.json']) {
  if (!existsSync(join(source, filename))) {
    throw new Error(`missing frozen integration source: ${join(source, filename)}`);
  }
}

const existingFormalFiles = ['manifest.json', ...coreFiles, ...policyFiles]
  .filter((filename) => existsSync(join(output, filename)));
if (existingFormalFiles.length) {
  throw new Error(
    `refusing to overwrite an existing formal package: ${existingFormalFiles.join(', ')}`,
  );
}

const sourceManifest = JSON.parse(
  readFileSync(join(source, 'provisional-manifest.json'), 'utf8'),
);
const uncoveredRows = readCsv('uncovered-taste-combinations.csv');
const disabledRows = readCsv('third-taste-availability.csv')
  .filter((row) => row.enabled === 'false');
if (uncoveredRows.length !== 2 || disabledRows.length !== 6) {
  throw new Error(
    `frozen supported-domain evidence is unexpected: uncovered=${uncoveredRows.length}, disabled=${disabledRows.length}`,
  );
}

const staging = mkdtempSync(join(tmpdir(), 'playfinder-formal-data-'));
try {
  for (const filename of [...coreFiles, ...policyFiles]) {
    copyFileSync(join(source, filename), join(staging, filename));
  }

  const dataSnapshot = 'A-v1.0+B-final_eval-2026-07-27+C-D-2026-07-29';
  const splitId = 'timestamp-cutoff-1641340800';
  const candidateHash = sourceManifest.candidate_hash;
  const manifestFiles = Object.fromEntries(
    [...coreFiles, ...policyFiles].map((filename) => [
      filename,
      sha256(readFileSync(join(staging, filename))),
    ]),
  );
  const manifest = {
    schema_version: 'playfinder-study-v1',
    mode: 'formal',
    notice: 'FORMAL STUDY DATA / PARTICIPANT RESULTS NOT YET COLLECTED',
    id_namespace: 'steam_appid',
    candidate_hash: candidateHash,
    data_snapshot: {
      status: 'frozen_for_formal_study',
      assembled_on: '2026-07-29',
      a_release: 'v1.0',
      b_release: 'final_eval created 2026-07-27T09:05:16.442657+00:00',
      c_return: 'bpr_top100.csv and reproducibility evidence received 2026-07-29',
      d_return: 'hybrid_top100.csv received 2026-07-29',
      a_source_commit: null,
    },
    split: {
      id: splitId,
      cutoff_timestamp: 1641340800,
      train_rule: 'timestamp <= cutoff',
      test_rule: 'timestamp > cutoff',
      candidate_policy: 'unique training-period label=1 items intersected with A catalogue',
      seen_exclusion: 'all training-period reviewed interactions for the same model user, regardless of label',
      seen_users: 5119,
      true_new_users: 229,
      interactions_semantics: 'reviewed/seen, not ownership',
    },
    profile_policy: {
      id: 'top-5-enumerated-v2',
      status: 'formal_supported_domain',
      covered_combinations: 558,
      supported_combination_count: 558,
      total_combinations: 560,
      total_combination_count: 560,
      jaccard_threshold: 0.5,
      profile_count: 46,
      unsupported_combinations: uncoveredRows.map((row) => ({
        tastes: [row.taste_1, row.taste_2, row.taste_3],
        best_jaccard: Number(row.best_jaccard),
      })),
      disabled_third_taste_mapping: disabledRows.map((row) => ({
        prefix: [row.prefix_taste_1, row.prefix_taste_2],
        disabled_third_taste: row.third_taste,
      })),
      short_lists_allowed: true,
      no_fallback_or_condition_relaxation: true,
    },
    platform_policy: {
      id: 'common-strict-compatible-v1',
      status: 'formal',
      applies_to_conditions: ['A', 'B', 'C'],
      match_rule: 'any selected platform must be explicitly present in source platforms',
      missing_platform: 'unknown; excluded whenever a platform filter is active; warning only',
      fewer_than_six_after_filter: 'display the honest short list; warning only',
      metadata_imputation: 'forbidden',
      fallback_or_filter_relaxation: 'forbidden',
    },
    source_provenance: {
      a: {
        status: 'v1.0_confirmed_frozen',
        authoritative_files: {
          'items.parquet': sourceManifest.data_snapshot.a_items_sha256,
          'interactions.parquet': sourceManifest.data_snapshot.a_interactions_sha256,
          'users.parquet': sourceManifest.data_snapshot.a_users_sha256,
          'item_popularity.parquet': sourceManifest.data_snapshot.a_item_popularity_sha256,
        },
        item_id_namespace: 'steam_appid_direct',
        user_group_definition: 'value_tertile',
        missing_genres: 'confirmed final source state; no imputation',
      },
      b: {
        status: 'frozen_unchanged_local_final_eval',
        version_info_sha256: sourceManifest.data_snapshot.b_version_info_sha256,
        popularity_source_sha256: sourceManifest.data_snapshot.b_popularity_source_sha256,
      },
      c: {
        status: 'ranking_received_contract_valid_provenance_evidence_complete_checkpoint_external',
        bpr_top100_sha256: sourceManifest.files['bpr_top100.csv'],
        reproducibility_archive:
          'study-data/provenance/c-bpr-2026-07-29/C_reproducibility_public_bundle.zip',
        reproducibility_archive_sha256:
          'edec033f264de30e1ceae4f8907aea5378779096b38b3f82ff06a6051d7cfe53',
        received_archive_sha256:
          '59939307817aa4c77b72ab497ee84fb059af6ea0b6a1faee09259f4a69deadf4',
        exporter_sha256:
          '2d646e9b30b7ed3aa0366c382dd424d075cf4901f2922ace6805d530a17c505b',
        code_checksums_sha256:
          '4809d6ae10d3e5a17fb09e4a03ff0f54da650330fb8584a8a49f7f3303dbde9f',
        checkpoint_manifest_sha256:
          'a9d02966a8458de1e42be2315f6960490a7e3fc0b30ad243cd18ac82fe7007ad',
        checkpoint_checksums_sha256:
          'e1327946586cc24a9447295af11246d8042523c5047093595fc2708d06c0135b',
        export_log_sha256:
          'ca10a844352fe45ce9f8be6c7f8dd76773e919fcfcd6165f71ddd373a74d7b50',
        runtime_sha256:
          'df5a3aea7bd102cbd7db8a919068420c92c315ae342fb57072b5664ca0a32a97',
        requirements_sha256:
          '0c5eb51a6684de78b39e817dee7bdf31bd54f8e2832d6fd01e78fd33480b63d0',
        source_version: 'complete source file SHA-256 manifest; no Git commit available',
        model_trial: 'bpr_f96_lr0.02_r0.005_i75',
        seed: 42,
        runtime: {
          python: '3.12.13',
          implicit: '0.7.3',
          execution_device: 'CPU',
          num_threads: 1,
        },
        checkpoint_bundled: false,
        limitation:
          'large checkpoint binaries are externally retained; archive contains their filenames, sizes, and SHA-256 values',
      },
      d: {
        status: 'ranking_received_contract_valid_provenance_partial',
        hybrid_top100_sha256: sourceManifest.files['hybrid_top100.csv'],
        exporter_sha256: '55f3e7d56add9d4d5d96e801f74d55700500e98b30175c3db91ef005458ace95',
        hybrid_source_sha256: '6912df0584613b6210acfbc88b51d11f28db9b8e9a8b1e492af46935176f3595',
        export_log_sha256: 'b565e8cc3bd5a144fcaf74e7a0be68415c676efc89940a887d2851deb816156b',
        seed: 9727,
        missing: [
          'source commit or checkpoint hash tied to run',
          'complete environment/runtime versions',
        ],
      },
    },
    conditions: {
      A: {
        model: 'popularity',
        data_snapshot: dataSnapshot,
        split_id: splitId,
        candidate_hash: candidateHash,
      },
      B: {
        model: 'bpr',
        data_snapshot: dataSnapshot,
        split_id: splitId,
        candidate_hash: candidateHash,
      },
      C: {
        model: 'hybrid',
        data_snapshot: dataSnapshot,
        split_id: splitId,
        candidate_hash: candidateHash,
      },
    },
    files: manifestFiles,
  };
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const validation = validateStudyData(staging, { mode: 'formal' });
  if (!validation.ok || !validation.formalReady || !validation.validationComplete) {
    throw new Error(
      `assembled formal package did not validate:\n${formatValidationIssues(validation)}`,
    );
  }

  mkdirSync(output, { recursive: true });
  cpSync(staging, output, { recursive: true });
  const delivered = readdirSync(output).filter((name) => name !== '.gitkeep').sort();
  console.log(`finalize-study-data: PASS; wrote ${delivered.length} files to ${output}`);
  console.log(
    `finalize-study-data: profiles=${validation.summary.profileCount} ` +
    `supported=${validation.summary.supportedTasteCombinations}/` +
    `${validation.summary.tasteCombinations} warnings=${validation.warnings.length}`,
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
