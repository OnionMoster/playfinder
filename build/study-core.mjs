import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TASTES = [
  'Action', 'RPG', 'Strategy', 'Adventure', 'Indie', 'Roguelike',
  'Simulation', 'Puzzle', 'Cozy', 'Horror', 'Multiplayer', 'Story Rich',
  'Open World', 'Survival', 'Turn-Based', 'Exploration',
];
export const CONDITIONS = { A: 'popularity', B: 'bpr', C: 'hybrid' };
export const REQUIRED_FILES = [
  'manifest.json', 'catalogue.json', 'candidate_items.csv', 'study_profiles.csv',
  'profile_seen_items.csv', 'popularity_top100.csv', 'bpr_top100.csv',
  'hybrid_top100.csv',
];
export const RANKING_FILE = {
  A: 'popularity_top100.csv',
  B: 'bpr_top100.csv',
  C: 'hybrid_top100.csv',
};

export function parseCsv(text, file = 'CSV') {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') {
      row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new Error(`${file}: unterminated quoted field`);
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows.shift().map((v) => v.trim());
  return {
    headers,
    rows: rows.map((values, index) => ({
      ...Object.fromEntries(headers.map((header, col) => [header, values[col] ?? ''])),
      __line: index + 2,
    })),
  };
}

export function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n') + '\n';
}

export function normalizeItemId(value) {
  const text = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(text) ? String(BigInt(text)) : null;
}

export function normalizeToken(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

export function jaccard(left, right) {
  const a = new Set(left), b = new Set(right);
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

export function matchProfile(tastes, profiles) {
  const selected = [...new Set(tastes)];
  if (selected.length !== 3) throw new Error('profile matching requires exactly three distinct tastes');
  const scored = profiles.map((profile) => ({
    profile,
    similarity: jaccard(selected, profile.tastes),
  })).sort((a, b) => b.similarity - a.similarity ||
    a.profile.profile_id.localeCompare(b.profile.profile_id));
  if (!scored.length) throw new Error('no study profiles are available');
  const best = scored[0];
  return {
    profile: best.profile,
    similarity: best.similarity,
    tied: scored.filter((entry) => entry.similarity === best.similarity).length > 1,
  };
}

export function assignProfileOnce(preferences, profiles) {
  if (preferences.assignedProfileId) return { ...preferences };
  return { ...preferences, assignedProfileId: matchProfile(preferences.taste, profiles).profile.profile_id };
}

export function sequenceFor(participantNumber) {
  const sequences = ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA'];
  return sequences[(Number(participantNumber) - 1) % sequences.length];
}

export function recordImpression(impressions, key) {
  if (impressions[key]) return { impressions, added: false };
  return { impressions: { ...impressions, [key]: true }, added: true };
}

export function combinations(values, count = 3) {
  const out = [];
  const visit = (start, chosen) => {
    if (chosen.length === count) { out.push(chosen.slice()); return; }
    for (let i = start; i <= values.length - (count - chosen.length); i++) {
      chosen.push(values[i]); visit(i + 1, chosen); chosen.pop();
    }
  };
  visit(0, []);
  return out;
}

export function diversityTokens(game) {
  return [...new Set([...(game.genres || []), ...(game.tags || [])].map(normalizeToken).filter(Boolean))];
}

export function applyHardFilters(items, filters = {}) {
  const genres = filters.genres || [];
  const tags = filters.tags || [];
  const platforms = filters.platforms || [];
  const maxPrice = filters.maxPrice;
  return items.filter((game) => {
    if (genres.length && !genres.some((value) => (game.genres || []).includes(value))) return false;
    if (tags.length && !tags.some((value) => (game.tags || []).includes(value))) return false;
    if (platforms.length && !platforms.some((value) => (game.platforms || []).includes(value))) return false;
    if (maxPrice != null && maxPrice !== Infinity && maxPrice !== 'any') {
      if (typeof game.price !== 'number' || !Number.isFinite(game.price) || game.price > Number(maxPrice)) return false;
    }
    return true;
  });
}

// Facet display scope. Counts are taken from an already-served result pool (the
// caller computes that pool with this dimension's own filter ignored, mirroring
// the frontend's poolExcept). Values are read only from the explicit dimension
// arrays, so tags can never surface as genres. Zero-count values are dropped
// unless currently selected; a selected value always stays visible so it can be
// removed even when it no longer matches any game.
export function facetCounts(pool, dimension) {
  const counts = {};
  for (const game of pool) {
    for (const value of game[dimension] || []) counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

export function facetEntries({ pool, dimension, selected = [] }) {
  const counts = facetCounts(pool, dimension);
  const names = Object.keys(counts).filter((name) => counts[name] > 0);
  for (const name of selected) if (!names.includes(name)) names.push(name);
  return names
    .map((name) => ({ name, count: counts[name] || 0, selected: selected.includes(name) }))
    .sort((a, b) => ((b.selected ? 1 : 0) - (a.selected ? 1 : 0)) ||
      (b.count - a.count) || a.name.localeCompare(b.name));
}

// Collapsed view: selected entries are always visible; the remaining slots up to
// `limit` go to the highest-count available entries (entries arrive pre-sorted
// selected-first from facetEntries, so index < limit does exactly that).
export function visibleFacetEntries(entries, limit) {
  return entries.filter((entry, index) => entry.selected || index < limit);
}

export function mmrRerank(items) {
  const remaining = items.map((game) => ({
    ...game,
    rank: Number(game.rank),
    relevance: 1 - (Number(game.rank) - 1) / 99,
    _tokens: diversityTokens(game),
  }));
  const selected = [];
  while (remaining.length) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      let maxSimilarity = 0;
      for (const prior of selected) {
        maxSimilarity = Math.max(maxSimilarity, jaccard(candidate._tokens, prior._tokens));
      }
      const value = 0.8 * candidate.relevance - 0.2 * maxSimilarity;
      const best = remaining[bestIndex];
      const tied = Math.abs(value - bestValue) < 1e-12;
      const lowerAppId = BigInt(candidate.id) < BigInt(best.id);
      if (value > bestValue + 1e-12 ||
          (tied && (candidate.rank < best.rank ||
            (candidate.rank === best.rank && lowerAppId)))) {
        bestValue = value; bestIndex = i;
      }
    }
    const [picked] = remaining.splice(bestIndex, 1);
    selected.push({ ...picked, mmr: bestValue });
  }
  return selected.map(({ _tokens, ...game }) => game);
}

export function serveRanking({ ranking, catalogueById, seen = [], notInterested = [], filters = {} }) {
  const excluded = new Set([...seen, ...notInterested].map(String));
  const ranked = ranking
    .filter((row) => !excluded.has(String(row.item_id)))
    .map((row) => {
      const game = catalogueById.get(String(row.item_id));
      return game ? { ...game, rank: Number(row.rank) } : null;
    })
    .filter(Boolean);
  return mmrRerank(applyHardFilters(ranked, filters));
}

export function loadStudyInput(inputDir) {
  const json = (name) => JSON.parse(readFileSync(join(inputDir, name), 'utf8'));
  const csv = (name) => parseCsv(readFileSync(join(inputDir, name), 'utf8'), name);
  const manifest = json('manifest.json');
  const catalogue = json('catalogue.json');
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
  for (const [condition, filename] of Object.entries(RANKING_FILE)) rankings[condition] = csv(filename).rows;
  return { manifest, catalogue, profileCsv, profiles, seenCsv, seenByProfile, rankings };
}
