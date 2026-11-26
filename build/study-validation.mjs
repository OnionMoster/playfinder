import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONDITIONS, REQUIRED_FILES, RANKING_FILE, TASTES, applyHardFilters, combinations,
  matchProfile, normalizeItemId, parseCsv, toCsv,
} from './study-core.mjs';

export const PARTIAL_REQUIRED_FILES = [
  'catalogue.json',
  'candidate_items.csv',
  'study_profiles.csv',
  'profile_seen_items.csv',
  'popularity_top100.csv',
];
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const candidateFingerprint = (ids) => sha256(
  [...ids].sort((left, right) => {
    const a = BigInt(left), b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }).join('\n') + '\n',
);

const ALL_SECTIONS = [
  'required-file-presence',
  'parsing-and-schema',
  'manifest-and-provenance',
  'catalogue-quality',
  'candidate-integrity',
  'profile-integrity-and-coverage',
  'seen-item-integrity',
  'ranking-integrity-and-recommended-metadata',
  'filter-availability',
];
const requiredColumns = {
  'candidate_items.csv': ['item_id'],
  'study_profiles.csv': ['profile_id', 'model_user_id', 'taste_1', 'taste_2', 'taste_3', 'train_positive_count'],
  'profile_seen_items.csv': ['profile_id', 'model_user_id', 'item_id'],
  ranking: ['profile_id', 'model_user_id', 'item_id', 'rank', 'score'],
};
const missingText = (value) => typeof value !== 'string' || !value.trim();
const tasteOrder = new Map(TASTES.map((taste, index) => [taste, index]));
const canonicalTastes = (values) => [...values].sort(
  (left, right) => tasteOrder.get(left) - tasteOrder.get(right),
);
const tasteKey = (values) => canonicalTastes(values).join('|');

function loadAvailableStudyInput(inputDir, mode) {
  const json = (name) => JSON.parse(readFileSync(join(inputDir, name), 'utf8'));
  const csv = (name) => parseCsv(readFileSync(join(inputDir, name), 'utf8'), name);
  const manifestFile = existsSync(join(inputDir, 'manifest.json'))
    ? 'manifest.json'
    : mode === 'partial' && existsSync(join(inputDir, 'provisional-manifest.json'))
      ? 'provisional-manifest.json'
      : null;
  const manifest = manifestFile ? json(manifestFile) : null;
  const catalogue = json('catalogue.json');
  const candidateCsv = csv('candidate_items.csv');
  const profileCsv = csv('study_profiles.csv');
  const profiles = profileCsv.rows.map((row) => ({
    ...row,
    tastes: [row.taste_1, row.taste_2, row.taste_3],
  }));
  const seenCsv = csv('profile_seen_items.csv');
  const seenByProfile = new Map();
  for (const row of seenCsv.rows) {
    if (!seenByProfile.has(row.profile_id)) seenByProfile.set(row.profile_id, []);
    seenByProfile.get(row.profile_id).push(String(row.item_id));
  }
  const rankings = {};
  for (const [condition, filename] of Object.entries(RANKING_FILE)) {
    if (existsSync(join(inputDir, filename))) rankings[condition] = csv(filename).rows;
  }
  return {
    manifest,
    manifestFile,
    catalogue,
    candidateCsv,
    profileCsv,
    profiles,
    seenCsv,
    seenByProfile,
    rankings,
  };
}

export function validateStudyData(inputDir, { mode = 'formal' } = {}) {
  if (!['formal', 'fixture', 'partial'].includes(mode)) {
    throw new Error(`validation mode must be formal, fixture, or partial; found ${mode}`);
  }
  const errors = [], warnings = [];
  const error = (rule, message, context = {}) => errors.push({ level: 'error', rule, message, ...context });
  const warning = (rule, message, context = {}) => warnings.push({ level: 'warning', rule, message, ...context });
  const requiredFiles = mode === 'partial' ? PARTIAL_REQUIRED_FILES : REQUIRED_FILES;

  for (const filename of requiredFiles) {
    if (!existsSync(join(inputDir, filename))) {
      error('required-file', `missing required file ${filename}`, { file: filename });
    }
  }
  if (errors.length) {
    return {
      ok: false,
      mode,
      scope: mode === 'partial' ? 'partial-existing-files' : 'complete-formal-package',
      formalReady: false,
      validationComplete: false,
      stoppedAfter: 'required-file-presence',
      executedSections: ['required-file-presence'],
      notExecutedSections: ALL_SECTIONS.slice(1),
      inputDir,
      errors,
      warnings,
      summary: null,
      note: mode === 'partial'
        ? 'Partial validation stopped because one or more base files were absent.'
        : 'Only required-file presence was checked. No later formal rules were executed.',
    };
  }

  let data;
  try {
    data = loadAvailableStudyInput(inputDir, mode);
  } catch (cause) {
    error('parse', cause.message);
    return {
      ok: false,
      mode,
      scope: mode === 'partial' ? 'partial-existing-files' : 'complete-formal-package',
      formalReady: false,
      validationComplete: false,
      stoppedAfter: 'parsing-and-schema',
      executedSections: ['required-file-presence', 'parsing-and-schema'],
      notExecutedSections: ALL_SECTIONS.slice(2),
      inputDir,
      errors,
      warnings,
      summary: null,
      note: 'Parsing failed. Later validation rules were not executed.',
    };
  }
  const {
    manifest, manifestFile, catalogue, candidateCsv, profileCsv, profiles,
    seenCsv, seenByProfile, rankings,
  } = data;

  const checkColumns = (file, actual, expected) => {
    for (const column of expected) {
      if (!actual.includes(column)) error('required-column', `missing column ${column}`, { file });
    }
  };
  checkColumns('study_profiles.csv', profileCsv.headers, requiredColumns['study_profiles.csv']);
  checkColumns('profile_seen_items.csv', seenCsv.headers, requiredColumns['profile_seen_items.csv']);
  checkColumns('candidate_items.csv', candidateCsv.headers, requiredColumns['candidate_items.csv']);
  for (const condition of Object.keys(rankings)) {
    const filename = RANKING_FILE[condition];
    const headers = parseCsv(readFileSync(join(inputDir, filename), 'utf8'), filename).headers;
    checkColumns(filename, headers, requiredColumns.ranking);
  }

  if (manifest) {
    if (manifest.schema_version !== 'playfinder-study-v1') {
      error('manifest-schema', `schema_version must be playfinder-study-v1, found ${manifest.schema_version}`, { file: manifestFile });
    }
    if (manifest.id_namespace !== 'steam_appid') {
      error('id-namespace', `id_namespace must be steam_appid, found ${manifest.id_namespace}`, { file: manifestFile });
    }
    if (mode !== 'partial') {
      if (manifest.mode !== mode) {
        error('manifest-mode', `manifest mode must be ${mode}, found ${manifest.mode}`, { file: manifestFile });
      }
      if (mode === 'formal' && manifest.mode !== 'formal') {
        error('manifest-formal', 'formal validation requires a formal manifest', { file: manifestFile });
      }
      if (mode === 'fixture' && !manifest.notice?.includes('FIXTURE / NOT FOR FORMAL STUDY')) {
        error('fixture-label', 'fixture manifest must display FIXTURE / NOT FOR FORMAL STUDY', { file: manifestFile });
      }
    } else {
      warning(
        'partial-validation-scope',
        `using ${manifestFile}; formal manifest and cross-condition provenance are not required or claimed`,
        { file: manifestFile },
      );
    }

    for (const [filename, expected] of Object.entries(manifest.files || {})) {
      const path = join(inputDir, filename);
      if (!existsSync(path)) {
        if (mode === 'partial') {
          warning('partial-manifest-file-unavailable', 'manifest-referenced file is not present in partial scope', { file: filename });
        } else {
          error('manifest-file', 'manifest references a missing file', { file: filename });
        }
      } else {
        const actual = sha256(readFileSync(path));
        if (actual !== expected) {
          error('sha256', `SHA-256 mismatch: expected ${expected}, got ${actual}`, { file: filename });
        }
      }
    }
    if (mode !== 'partial') {
      for (const filename of REQUIRED_FILES.slice(1)) {
        if (!(filename in (manifest.files || {}))) {
          error('manifest-hash', 'file has no SHA-256 entry in manifest', { file: filename });
        }
      }
      const metadata = Object.entries(manifest.conditions || {});
      for (const [condition, model] of Object.entries(CONDITIONS)) {
        const entry = manifest.conditions?.[condition];
        if (!entry) {
          error('condition-manifest', `missing condition ${condition}`, { file: manifestFile, condition });
        } else if (entry.model !== model) {
          error('condition-map', `condition ${condition} must map to ${model}`, { file: manifestFile, condition });
        }
      }
      for (const field of ['data_snapshot', 'split_id', 'candidate_hash']) {
        const values = new Set(metadata.map(([, value]) => value?.[field]));
        if (values.size !== 1 || values.has(undefined)) {
          error('condition-provenance', `all conditions must declare the same ${field}`, { file: manifestFile });
        }
      }
    }
  } else if (mode === 'partial') {
    warning('partial-manifest-missing', 'no manifest was supplied; manifest hashes and provenance were not checked');
  } else {
    error('required-file', 'missing required file manifest.json', { file: 'manifest.json' });
  }

  const candidateIds = new Set();
  for (const row of candidateCsv.rows) {
    const id = normalizeItemId(row.item_id);
    if (!id) {
      error('positive-steam-appid', 'candidate item_id must be a positive integer Steam appid', {
        file: 'candidate_items.csv',
        item_id: row.item_id,
      });
    } else if (candidateIds.has(id)) {
      error('duplicate-candidate', 'duplicate candidate item_id', {
        file: 'candidate_items.csv',
        item_id: id,
      });
    } else {
      candidateIds.add(id);
    }
  }
  const actualCandidateHash = candidateFingerprint(candidateIds);
  if (manifest?.candidate_hash && manifest.candidate_hash !== actualCandidateHash) {
    error(
      'candidate-hash',
      `candidate hash mismatch: expected ${manifest.candidate_hash}, got ${actualCandidateHash}`,
      { file: manifestFile },
    );
  }
  if (mode !== 'partial') {
    for (const [condition, entry] of Object.entries(manifest?.conditions || {})) {
      if (entry.candidate_hash !== actualCandidateHash) {
        error('candidate-mismatch', 'condition candidate hash does not match candidate_items.csv', {
          file: manifestFile,
          condition,
        });
      }
    }
  }

  const catalogueById = new Map();
  const catalogueQuality = {
    rows: Array.isArray(catalogue) ? catalogue.length : 0,
    missingTitle: 0,
    missingPrice: 0,
    missingPlatform: 0,
  };
  if (!Array.isArray(catalogue)) {
    error('catalogue-schema', 'catalogue.json must contain an array', { file: 'catalogue.json' });
  } else {
    for (const game of catalogue) {
      const rawId = game.item_id ?? game.id;
      const id = normalizeItemId(rawId);
      if (!id) {
        error('positive-steam-appid', 'catalogue item_id must be a positive integer Steam appid', {
          file: 'catalogue.json',
          item_id: rawId,
        });
        continue;
      }
      if (catalogueById.has(id)) {
        error('duplicate-catalogue-item', 'duplicate catalogue item_id', {
          file: 'catalogue.json',
          item_id: id,
        });
      }
      if (missingText(game.title)) catalogueQuality.missingTitle++;
      if (game.price == null) catalogueQuality.missingPrice++;
      else if (typeof game.price !== 'number' || !Number.isFinite(game.price) || game.price < 0) {
        error('price-metadata', 'price must be null or a finite non-negative number', {
          file: 'catalogue.json',
          item_id: id,
        });
      }
      if (!Array.isArray(game.platforms)) {
        error('platform-metadata-type', 'platforms must be an array', {
          file: 'catalogue.json',
          item_id: id,
        });
      } else if (!game.platforms.length) {
        catalogueQuality.missingPlatform++;
      }
      if (!Array.isArray(game.genres) || !Array.isArray(game.tags)) {
        error('filter-metadata', 'genres and tags must be arrays', {
          file: 'catalogue.json',
          item_id: id,
        });
      }
      catalogueById.set(id, { ...game, id, item_id: id });
    }
  }
  for (const [field, count] of [
    ['title', catalogueQuality.missingTitle],
    ['price', catalogueQuality.missingPrice],
    ['platform', catalogueQuality.missingPlatform],
  ]) {
    if (count) {
      const suffix = field === 'platform'
        ? 'missing platform remains unknown and is excluded by an active platform filter'
        : `only recommended items with missing ${field} are formal blockers`;
      warning(
        `catalogue-${field}-missing`,
        `${count} catalogue items have missing ${field} metadata; ${suffix}`,
        { file: 'catalogue.json', affected_items: count, catalogue_items: catalogueQuality.rows },
      );
    }
  }

  const candidateQuality = {
    rows: candidateIds.size,
    missingCatalogue: 0,
    missingTitle: 0,
    missingPrice: 0,
    missingPlatform: 0,
  };
  for (const id of candidateIds) {
    const game = catalogueById.get(id);
    if (!game) {
      candidateQuality.missingCatalogue++;
      error('candidate-catalogue-membership', 'candidate item is not in catalogue', {
        file: 'candidate_items.csv',
        item_id: id,
      });
      continue;
    }
    if (missingText(game.title)) candidateQuality.missingTitle++;
    if (typeof game.price !== 'number' || !Number.isFinite(game.price)) candidateQuality.missingPrice++;
    if (!Array.isArray(game.platforms) || !game.platforms.length) candidateQuality.missingPlatform++;
  }
  for (const [field, count] of [
    ['title', candidateQuality.missingTitle],
    ['price', candidateQuality.missingPrice],
    ['platform', candidateQuality.missingPlatform],
  ]) {
    if (count) {
      warning(
        `candidate-${field}-missing`,
        `${count} candidate items have missing ${field} metadata`,
        { file: 'candidate_items.csv', affected_items: count, candidate_items: candidateIds.size },
      );
    }
  }

  const profileIds = new Set(), userIds = new Set();
  const validTaste = new Set(TASTES);
  for (const profile of profiles) {
    if (!profile.profile_id) {
      error('profile-id', 'profile_id is required', { file: 'study_profiles.csv' });
    } else if (profileIds.has(profile.profile_id)) {
      error('duplicate-profile', 'duplicate profile_id', {
        file: 'study_profiles.csv',
        profile_id: profile.profile_id,
      });
    }
    profileIds.add(profile.profile_id);
    if (!profile.model_user_id) {
      error('model-user-id', 'model_user_id is required', {
        file: 'study_profiles.csv',
        profile_id: profile.profile_id,
      });
    } else if (userIds.has(profile.model_user_id)) {
      error('duplicate-model-user', 'duplicate model_user_id', {
        file: 'study_profiles.csv',
        profile_id: profile.profile_id,
      });
    }
    userIds.add(profile.model_user_id);
    if (new Set(profile.tastes).size !== 3 || profile.tastes.some((taste) => !validTaste.has(taste))) {
      error('profile-tastes', 'profile must contain three distinct allowed tastes', {
        file: 'study_profiles.csv',
        profile_id: profile.profile_id,
      });
    }
    if (!Number.isInteger(Number(profile.train_positive_count)) || Number(profile.train_positive_count) < 1) {
      error('train-positive-count', 'train_positive_count must be a positive integer', {
        file: 'study_profiles.csv',
        profile_id: profile.profile_id,
      });
    }
    const scoreColumns = ['taste_1_score', 'taste_2_score', 'taste_3_score'];
    if (scoreColumns.some((column) => profileCsv.headers.includes(column))) {
      for (const column of scoreColumns) {
        if (!Number.isInteger(Number(profile[column])) || Number(profile[column]) < 1) {
          error('profile-taste-evidence', `${column} must be a positive integer when taste evidence is supplied`, {
            file: 'study_profiles.csv',
            profile_id: profile.profile_id,
          });
        }
      }
    }
  }

  const seenUsers = new Map();
  const seenPairs = new Set();
  for (const row of seenCsv.rows) {
    const id = normalizeItemId(row.item_id);
    if (!id) {
      error('positive-steam-appid', 'seen item_id must be a positive integer Steam appid', {
        file: 'profile_seen_items.csv',
        profile_id: row.profile_id,
        item_id: row.item_id,
      });
    }
    if (!profileIds.has(row.profile_id)) {
      error('seen-profile', 'seen row references unknown profile', {
        file: 'profile_seen_items.csv',
        profile_id: row.profile_id,
        item_id: row.item_id,
      });
    }
    if (seenUsers.has(row.profile_id) && seenUsers.get(row.profile_id) !== row.model_user_id) {
      error('seen-user', 'profile has inconsistent model_user_id', {
        file: 'profile_seen_items.csv',
        profile_id: row.profile_id,
        item_id: row.item_id,
      });
    }
    seenUsers.set(row.profile_id, row.model_user_id);
    const key = `${row.profile_id}|${id}`;
    if (seenPairs.has(key)) {
      error('duplicate-seen-item', 'duplicate profile seen item', {
        file: 'profile_seen_items.csv',
        profile_id: row.profile_id,
        item_id: id,
      });
    }
    seenPairs.add(key);
    if (id && !catalogueById.has(id)) {
      error('seen-catalogue-membership', 'seen item is not in catalogue', {
        file: 'profile_seen_items.csv',
        profile_id: row.profile_id,
        item_id: id,
      });
    }
  }
  for (const profile of profiles) {
    if (seenUsers.get(profile.profile_id) !== profile.model_user_id) {
      error('common-seen-cohort', 'profile is not represented by the same model user in seen items', {
        file: 'profile_seen_items.csv',
        profile_id: profile.profile_id,
      });
    }
  }

  const allTasteCombinations = combinations(TASTES, 3);
  let supportedTasteKeys = new Set(allTasteCombinations.map(tasteKey));
  let coverageThreshold = 0.5;
  if (mode === 'formal') {
    const policy = manifest?.profile_policy;
    if (!policy || policy.status !== 'formal_supported_domain') {
      error(
        'profile-policy-status',
        'formal validation requires profile_policy.status=formal_supported_domain',
        { file: manifestFile },
      );
    } else {
      coverageThreshold = Number(policy.jaccard_threshold);
      if (!Number.isFinite(coverageThreshold) || coverageThreshold !== 0.5) {
        error(
          'profile-policy-threshold',
          `formal supported-domain Jaccard threshold must be 0.5, found ${policy.jaccard_threshold}`,
          { file: manifestFile },
        );
        coverageThreshold = 0.5;
      }
      const unsupportedRows = Array.isArray(policy.unsupported_combinations)
        ? policy.unsupported_combinations
        : [];
      const unsupportedKeys = new Set();
      for (const entry of unsupportedRows) {
        const tastes = Array.isArray(entry) ? entry : entry?.tastes;
        if (
          !Array.isArray(tastes) ||
          tastes.length !== 3 ||
          new Set(tastes).size !== 3 ||
          tastes.some((taste) => !validTaste.has(taste))
        ) {
          error(
            'profile-policy-domain',
            'every unsupported combination must contain three distinct allowed tastes',
            { file: manifestFile },
          );
          continue;
        }
        const key = tasteKey(tastes);
        if (unsupportedKeys.has(key)) {
          error('profile-policy-domain', 'duplicate unsupported combination', {
            file: manifestFile,
            tastes: key,
          });
        }
        unsupportedKeys.add(key);
      }
      supportedTasteKeys = new Set(
        allTasteCombinations.map(tasteKey).filter((key) => !unsupportedKeys.has(key)),
      );
      const declaredSupported = Number(
        policy.supported_combination_count ?? policy.covered_combinations,
      );
      const declaredTotal = Number(policy.total_combination_count ?? policy.total_combinations);
      if (declaredTotal !== allTasteCombinations.length) {
        error(
          'profile-policy-domain',
          `total combination count must be ${allTasteCombinations.length}, found ${declaredTotal}`,
          { file: manifestFile },
        );
      }
      if (declaredSupported !== supportedTasteKeys.size) {
        error(
          'profile-policy-domain',
          `supported combination count must be ${supportedTasteKeys.size}, found ${declaredSupported}`,
          { file: manifestFile },
        );
      }

      const expectedDisabled = new Set();
      for (const key of unsupportedKeys) {
        const tastes = key.split('|');
        for (let omitted = 0; omitted < tastes.length; omitted++) {
          const third = tastes[omitted];
          const prefix = tastes.filter((_, index) => index !== omitted);
          expectedDisabled.add(`${tasteKey(prefix)}=>${third}`);
        }
      }
      const actualDisabled = new Set();
      const mapping = Array.isArray(policy.disabled_third_taste_mapping)
        ? policy.disabled_third_taste_mapping
        : [];
      for (const row of mapping) {
        const prefix = row?.prefix;
        const third = row?.disabled_third_taste ?? row?.disabledThirdTaste;
        if (
          !Array.isArray(prefix) ||
          prefix.length !== 2 ||
          new Set(prefix).size !== 2 ||
          prefix.some((taste) => !validTaste.has(taste)) ||
          !validTaste.has(third) ||
          prefix.includes(third)
        ) {
          error(
            'profile-policy-disabled-mapping',
            'disabled-third mapping must contain two distinct prefix tastes and one distinct allowed third taste',
            { file: manifestFile },
          );
          continue;
        }
        const key = `${tasteKey(prefix)}=>${third}`;
        if (actualDisabled.has(key)) {
          error('profile-policy-disabled-mapping', 'duplicate disabled-third mapping', {
            file: manifestFile,
            tastes: key,
          });
        }
        actualDisabled.add(key);
      }
      for (const key of expectedDisabled) {
        if (!actualDisabled.has(key)) {
          error('profile-policy-disabled-mapping', 'missing required disabled-third mapping', {
            file: manifestFile,
            tastes: key,
          });
        }
      }
      for (const key of actualDisabled) {
        if (!expectedDisabled.has(key)) {
          error('profile-policy-disabled-mapping', 'disabled-third mapping is outside the unsupported domain', {
            file: manifestFile,
            tastes: key,
          });
        }
      }

      for (const prefix of combinations(TASTES, 2)) {
        const hasCompletion = TASTES.some((third) =>
          !prefix.includes(third) && supportedTasteKeys.has(tasteKey([...prefix, third])));
        if (!hasCompletion) {
          error(
            'profile-policy-prefix-completion',
            'two-taste prefix has no legal third-taste completion',
            { file: manifestFile, tastes: prefix.join('|') },
          );
        }
      }
    }
  }

  const coverageRows = [];
  for (const combo of allTasteCombinations) {
    const best = matchProfile(combo, profiles);
    const inSupportedDomain = supportedTasteKeys.has(tasteKey(combo));
    coverageRows.push({
      taste_1: combo[0],
      taste_2: combo[1],
      taste_3: combo[2],
      in_supported_domain: inSupportedDomain,
      best_profile_id: best.profile.profile_id,
      best_jaccard: best.similarity.toFixed(6),
      tied: best.tied,
    });
    if (inSupportedDomain && best.similarity < coverageThreshold) {
      error('profile-coverage', `best Jaccard ${best.similarity.toFixed(6)} is below ${coverageThreshold}`, {
        file: 'study_profiles.csv',
        profile_id: best.profile.profile_id,
        tastes: combo.join('|'),
      });
    }
  }

  const rankingQuality = {};
  for (const [condition, rows] of Object.entries(rankings)) {
    const file = RANKING_FILE[condition];
    const grouped = new Map();
    const recommendedMissing = { title: new Set(), price: new Set(), platform: new Set() };
    for (const row of rows) {
      const id = normalizeItemId(row.item_id);
      const profileId = row.profile_id;
      const context = { file, condition, profile_id: profileId, item_id: id || row.item_id };
      if (!grouped.has(profileId)) grouped.set(profileId, []);
      grouped.get(profileId).push({ ...row, item_id: id });
      if (!profileIds.has(profileId)) error('ranking-profile', 'ranking references unknown profile', context);
      const profile = profiles.find((value) => value.profile_id === profileId);
      if (profile && row.model_user_id !== profile.model_user_id) {
        error('ranking-model-user', 'ranking model_user_id does not match profile', context);
      }
      if (!id) error('positive-steam-appid', 'ranking item_id must be a positive integer Steam appid', context);
      if (!Number.isFinite(Number(row.score))) error('finite-score', 'score must be a finite number', context);
      if (id && !candidateIds.has(id)) {
        error('candidate-membership', 'recommended item is not in the common candidate set', context);
      }
      if (id && !catalogueById.has(id)) {
        error('catalogue-membership', 'recommended item is not in catalogue', context);
      }
      if (id && catalogueById.has(id)) {
        const game = catalogueById.get(id);
        if (missingText(game.title)) {
          recommendedMissing.title.add(id);
          error('recommended-title-metadata', 'recommended item requires title metadata', context);
        }
        if (typeof game.price !== 'number' || !Number.isFinite(game.price) || game.price < 0) {
          recommendedMissing.price.add(id);
          error('recommended-price-metadata', 'recommended item requires finite non-negative price metadata', context);
        }
        if (!Array.isArray(game.platforms) || !game.platforms.length) {
          recommendedMissing.platform.add(id);
          warning(
            'recommended-platform-metadata',
            'recommended item has unknown platform compatibility and will be excluded when a platform filter is active',
            context,
          );
        }
      }
      if (id && (seenByProfile.get(profileId) || []).includes(id)) {
        error('seen-leakage', 'recommended item appears in profile seen items', context);
      }
    }
    for (const profile of profiles) {
      const list = grouped.get(profile.profile_id) || [];
      const context = { file, condition, profile_id: profile.profile_id };
      if (list.length !== 100) {
        error('top-100', `expected exactly 100 rows, found ${list.length}`, context);
      }
      const ranks = new Set(), items = new Set();
      for (const row of list) {
        const rank = Number(row.rank);
        const rowContext = { ...context, item_id: row.item_id };
        if (!Number.isInteger(rank) || rank < 1 || rank > 100) {
          error('rank-range', 'rank must be an integer from 1 to 100', rowContext);
        }
        if (ranks.has(rank)) error('duplicate-rank', 'duplicate rank', rowContext);
        if (items.has(row.item_id)) error('duplicate-ranked-item', 'duplicate item in profile-condition ranking', rowContext);
        ranks.add(rank);
        items.add(row.item_id);
      }
      for (let rank = 1; rank <= 100; rank++) {
        if (!ranks.has(rank)) {
          error('rank-completeness', `missing rank ${rank}`, context);
        }
      }
    }
    rankingQuality[condition] = {
      rows: rows.length,
      uniqueRecommendedItems: new Set(rows.map((row) => normalizeItemId(row.item_id)).filter(Boolean)).size,
      recommendedMissingTitleItems: recommendedMissing.title.size,
      recommendedMissingPriceItems: recommendedMissing.price.size,
      recommendedMissingPlatformItems: recommendedMissing.platform.size,
    };
  }

  const budgets = [...Array.from({ length: 56 }, (_, index) => index + 5), 'any'];
  const platformCombos = [
    ['Windows'],
    ['macOS'],
    ['Linux'],
    ['Windows', 'macOS'],
    ['Windows', 'Linux'],
    ['macOS', 'Linux'],
    ['Windows', 'macOS', 'Linux'],
  ];
  const filterRows = [];
  let finiteBudgetShortStates = 0;
  for (const profile of profiles) {
    for (const [condition, rows] of Object.entries(rankings)) {
      const ranking = rows.filter((row) => row.profile_id === profile.profile_id);
      for (const budget of budgets) {
        for (const platforms of platformCombos) {
          const excluded = new Set(seenByProfile.get(profile.profile_id) || []);
          const available = applyHardFilters(
            ranking
              .map((row) => catalogueById.get(String(row.item_id)))
              .filter((game) => game && !excluded.has(game.id)),
            { maxPrice: budget === 'any' ? Infinity : budget, platforms },
          ).length;
          filterRows.push({
            profile_id: profile.profile_id,
            condition,
            budget,
            platforms: platforms.join('|'),
            available,
          });
          const context = {
            condition,
            profile_id: profile.profile_id,
            budget,
            platforms: platforms.join('|'),
          };
          if (budget !== 'any' && available < 6) {
            finiteBudgetShortStates++;
          }
          if (budget === 'any' && platforms.length === 1 && available < 6) {
            warning(
              'single-platform-availability',
              `only ${available} games available at Any Price; the formal policy permits an honest short list`,
              context,
            );
          }
        }
      }
    }
  }
  if (finiteBudgetShortStates) {
    warning(
      'filter-availability-summary',
      `${finiteBudgetShortStates} finite-budget/platform states contain fewer than six games; the formal policy permits an honest short list`,
      { affected_filter_states: finiteBudgetShortStates },
    );
  }

  const checkedConditions = Object.keys(rankings);
  const skippedConditions = Object.keys(RANKING_FILE).filter((condition) => !(condition in rankings));
  const partialNotExecuted = mode === 'partial'
    ? [
      'formal manifest mode and complete eight-file checksum contract',
      ...skippedConditions.map((condition) =>
        `${condition}/${RANKING_FILE[condition]} ranking and filter checks`),
      'cross-condition formal readiness',
    ]
    : [];
  return {
    ok: errors.length === 0,
    mode,
    scope: mode === 'partial' ? 'partial-existing-files' : 'complete-formal-package',
    formalReady: mode === 'formal' && errors.length === 0,
    validationComplete: true,
    stoppedAfter: null,
    executedSections: ALL_SECTIONS,
    notExecutedSections: partialNotExecuted,
    inputDir,
    manifest,
    data,
    errors,
    warnings,
    coverageCsv: toCsv(
      ['taste_1', 'taste_2', 'taste_3', 'in_supported_domain', 'best_profile_id', 'best_jaccard', 'tied'],
      coverageRows,
    ),
    filterCsv: toCsv(
      ['profile_id', 'condition', 'budget', 'platforms', 'available'],
      filterRows,
    ),
    summary: {
      profileCount: profiles.length,
      catalogueCount: catalogueById.size,
      candidateCount: candidateIds.size,
      tasteCombinations: coverageRows.length,
      supportedTasteCombinations: supportedTasteKeys.size,
      coverageThreshold,
      checkedConditions,
      skippedConditions,
      catalogueQuality,
      candidateQuality,
      rankingQuality,
    },
    note: mode === 'partial'
      ? 'Partial validation completed for available base files and rankings. It is not a formal pass.'
      : 'All validation sections were executed.',
  };
}

export function formatValidationIssues(result) {
  return [...result.errors, ...result.warnings].map((issue) => {
    const context = [
      'file', 'profile_id', 'condition', 'item_id', 'budget', 'platforms',
      'affected_items', 'candidate_items', 'catalogue_items',
    ]
      .filter((key) => issue[key] != null)
      .map((key) => `${key}=${issue[key]}`)
      .join(' ');
    return `${issue.level.toUpperCase()} [${issue.rule}]${context ? ` ${context}` : ''}: ${issue.message}`;
  }).join('\n');
}
