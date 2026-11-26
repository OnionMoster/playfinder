import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASTES, applyHardFilters, assignProfileOnce, combinations, loadStudyInput,
  matchProfile, mmrRerank, recordImpression, sequenceFor, serveRanking,
} from '../build/study-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = loadStudyInput(join(ROOT, 'study-data/fixtures'));

test('all 560 taste combinations match a fixture profile at Jaccard >= 0.5', () => {
  const combos = combinations(TASTES, 3);
  assert.equal(combos.length, 560);
  for (const combo of combos) assert.ok(matchProfile(combo, fixture.profiles).similarity >= 0.5, combo.join('|'));
});

test('profile tie resolves to lexicographically smallest profile_id', () => {
  const profiles = [
    { profile_id: 'profile-z', tastes: ['Action', 'RPG', 'Horror'] },
    { profile_id: 'profile-a', tastes: ['Action', 'RPG', 'Cozy'] },
  ];
  assert.equal(matchProfile(['Action', 'RPG', 'Strategy'], profiles).profile.profile_id, 'profile-a');
});

test('assigned profile locks once while budget/platform remain mutable', () => {
  const initial = assignProfileOnce({ taste: ['Action', 'RPG', 'Strategy'], budget: 20, platforms: ['Windows'] }, fixture.profiles);
  const edited = assignProfileOnce({ ...initial, budget: 60, platforms: ['Linux'] }, fixture.profiles);
  assert.equal(edited.assignedProfileId, initial.assignedProfileId);
  assert.equal(edited.budget, 60);
  assert.deepEqual(edited.platforms, ['Linux']);
});

test('P01-P06 use all six counterbalance sequences', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(sequenceFor), ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA']);
  assert.equal(sequenceFor(7), 'ABC');
});

test('ranking is strict and does not append catalogue games', () => {
  const catalogueById = new Map([
    ['10', { id: '10', price: 1, platforms: ['Windows'], genres: ['Action'], tags: [] }],
    ['20', { id: '20', price: 1, platforms: ['Windows'], genres: ['Action'], tags: [] }],
  ]);
  const result = serveRanking({ ranking: [{ item_id: '20', rank: 1 }], catalogueById });
  assert.deepEqual(result.map((game) => game.id), ['20']);
});

test('seen, Not Interested, budget, platform, genre, and tag are hard filters', () => {
  const games = [
    { id: '10', price: 5, platforms: ['Windows'], genres: ['Action'], tags: ['Cozy'] },
    { id: '20', price: 50, platforms: ['Linux'], genres: ['RPG'], tags: ['Horror'] },
    { id: '30', price: null, platforms: ['Windows', 'Linux'], genres: ['Action'], tags: ['Cozy'] },
    { id: '40', price: 8, platforms: ['Linux'], genres: ['Action'], tags: ['Cozy'] },
  ];
  const catalogueById = new Map(games.map((game) => [game.id, game]));
  const ranking = games.map((game, index) => ({ item_id: game.id, rank: index + 1 }));
  assert.deepEqual(serveRanking({ ranking, catalogueById, seen: ['10'], notInterested: ['20'] }).map((g) => g.id), ['30', '40']);
  assert.deepEqual(serveRanking({ ranking, catalogueById, filters: { maxPrice: 10 } }).map((g) => g.id).sort(), ['10', '40']);
  assert.deepEqual(serveRanking({ ranking, catalogueById, filters: { platforms: ['Windows'] } }).map((g) => g.id).sort(), ['10', '30']);
  assert.deepEqual(serveRanking({ ranking, catalogueById, filters: { platforms: ['Windows', 'Linux'] } }).map((g) => g.id).sort(), ['10', '20', '30', '40']);
  assert.deepEqual(serveRanking({ ranking, catalogueById, filters: { genres: ['RPG'] } }).map((g) => g.id), ['20']);
  assert.deepEqual(serveRanking({ ranking, catalogueById, filters: { tags: ['Horror'] } }).map((g) => g.id), ['20']);
  assert.equal(applyHardFilters([games[2]], { maxPrice: 60 }).length, 0);
});

test('genre filtering never treats tags as imputed genres', () => {
  const tagOnly = { id: '50', price: 5, platforms: ['Windows'], genres: [], tags: ['Action'] };
  assert.equal(applyHardFilters([tagOnly], { genres: ['Action'] }).length, 0);
  assert.equal(applyHardFilters([tagOnly], { tags: ['Action'] }).length, 1);
});

test('MMR is deterministic and ties break by rank then numeric appid', () => {
  const input = [
    { id: '20', rank: 1, genres: ['Action'], tags: [] },
    { id: '3', rank: 1, genres: ['Action'], tags: [] },
    { id: '50', rank: 2, genres: ['Puzzle'], tags: [] },
  ];
  const one = mmrRerank(input).map((game) => game.id);
  const two = mmrRerank(input).map((game) => game.id);
  assert.deepEqual(one, two);
  assert.equal(one[0], '3');
  assert.equal(one[1], '50');
});

test('condition state stays isolated and impressions deduplicate', () => {
  const states = { A: { feedback: {} }, B: { feedback: {} }, C: { feedback: {} } };
  const changed = { ...states, A: { feedback: { 10: { wishlist: true } } } };
  assert.deepEqual(changed.B, states.B);
  assert.deepEqual(changed.C, states.C);
  const first = recordImpression({}, 'P01|A|1|10|1');
  const second = recordImpression(first.impressions, 'P01|A|1|10|1');
  assert.equal(first.added, true);
  assert.equal(second.added, false);
});
