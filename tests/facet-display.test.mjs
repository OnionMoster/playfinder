import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyHardFilters, facetCounts, facetEntries, loadStudyInput, serveRanking,
  visibleFacetEntries,
} from '../build/study-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'playfinder-game-discovery-prototype/project/PLAYFINDER.dc.html'), 'utf8');

// ---------- pure facet logic ----------

test('facet entries hide zero-count values, keep selected ones, and sort selected/count/name', () => {
  const pool = [
    { genres: ['Action', 'RPG'], tags: [] },
    { genres: ['Action'], tags: [] },
    { genres: ['Indie'], tags: [] },
  ];
  assert.deepEqual(facetEntries({ pool, dimension: 'genres', selected: ['Horror'] }), [
    { name: 'Horror', count: 0, selected: true },
    { name: 'Action', count: 2, selected: false },
    { name: 'Indie', count: 1, selected: false },
    { name: 'RPG', count: 1, selected: false },
  ]);
  const unselectedOnly = facetEntries({ pool, dimension: 'genres', selected: [] });
  assert.equal(unselectedOnly.some((entry) => entry.count === 0), false);
});

test('facet counting reads only the explicit dimension and never treats tags as genres', () => {
  const pool = [{ genres: [], tags: ['Action'] }];
  assert.deepEqual(facetCounts(pool, 'genres'), {});
  assert.deepEqual(facetCounts(pool, 'tags'), { Action: 1 });
  assert.equal(facetEntries({ pool, dimension: 'genres', selected: [] }).length, 0);
});

test('default tag visibility targets 16 entries and never hides selected tags', () => {
  const available = Array.from({ length: 30 }, (_, i) => (
    { name: `tag-${String(i).padStart(2, '0')}`, count: 30 - i, selected: false }
  ));
  assert.equal(visibleFacetEntries(available, 16).length, 16);

  const threeSelected = [
    { name: 'sel-a', count: 0, selected: true },
    { name: 'sel-b', count: 4, selected: true },
    { name: 'sel-c', count: 2, selected: true },
    ...available,
  ];
  const mixed = visibleFacetEntries(threeSelected, 16);
  assert.equal(mixed.length, 16);
  assert.equal(mixed.filter((entry) => entry.selected).length, 3);

  const manySelected = [
    ...Array.from({ length: 18 }, (_, i) => ({ name: `sel-${i}`, count: 0, selected: true })),
    ...available,
  ];
  const overLimit = visibleFacetEntries(manySelected, 16);
  assert.equal(overLimit.length, 18);
  assert.ok(overLimit.every((entry) => entry.selected));
});

test('facet counts agree with single-facet hard filtering over the served fixture pool', () => {
  const fixture = loadStudyInput(join(ROOT, 'study-data/fixtures'));
  const catalogueById = new Map(fixture.catalogue.map((game) => [String(game.item_id), {
    ...game, id: String(game.item_id),
    genres: game.genres || [], tags: game.tags || [], platforms: game.platforms || [],
  }]));
  const profile = fixture.profiles[0];
  const ranking = fixture.rankings.A.filter((row) => row.profile_id === profile.profile_id);
  const seen = fixture.seenByProfile.get(profile.profile_id) || [];
  for (const dimension of ['genres', 'tags']) {
    const pool = serveRanking({ ranking, catalogueById, seen, filters: {} });
    const counts = facetCounts(pool, dimension);
    assert.ok(Object.keys(counts).length > 0);
    for (const [name, count] of Object.entries(counts)) {
      assert.equal(applyHardFilters(pool, { [dimension]: [name] }).length, count, `${dimension}:${name}`);
    }
  }
});

// ---------- frontend source contract ----------

test('main genre/tag filter words no longer come from the whole catalogue vocabulary', () => {
  assert.doesNotMatch(SOURCE, /words:this\.genreOptions\(\)/);
  assert.doesNotMatch(SOURCE, /words:this\.tagOptions\(\)/);
  assert.match(SOURCE, /this\.facetEntries\('genres'\)/);
  assert.match(SOURCE, /this\.facetEntries\('tags'\)/);
  assert.match(SOURCE, /this\.facetCounts\(this\.poolExcept\(dim\),dim\)/);
});

test('zero-count facets are hidden unless selected, and selected facets stay removable', () => {
  assert.match(SOURCE, /Object\.keys\(counts\)\.filter\(x=>counts\[x\]>0\)/);
  assert.match(SOURCE, /selected\.forEach\(x=>\{ if\(!names\.includes\(x\)\) names\.push\(x\); \}\);/);
  assert.match(SOURCE, /, selected\. Click to remove\./);
  // rendered facet words are never disabled: selected entries keep their toggle handler
  assert.match(SOURCE, /onClick: dim==='genres'\? \(\)=>this\.toggleGenre\(e\.name\) : \(\)=>this\.toggleTag\(e\.name\)/);
  assert.match(SOURCE, /style:this\.filterWord\(e\.selected,false\)/);
});

test('tag list defaults to a 16-entry target with SHOW ALL / SHOW FEWER controls', () => {
  assert.match(SOURCE, /TAG_DEFAULT_LIMIT=16;/);
  assert.match(SOURCE, /defaultVisibleTagEntries\(entries\)\{ return entries\.filter\(\(e,i\)=>e\.selected \|\| i<this\.TAG_DEFAULT_LIMIT\); \}/);
  assert.match(SOURCE, /'SHOW ALL AVAILABLE TAGS \('\+tagAvailable\+'\)'/);
  assert.match(SOURCE, /'SHOW FEWER TAGS'/);
  assert.match(SOURCE, /aria-expanded="\{\{ tagsExpanded \}\}"/);
});

test('tag expand/collapse is pure UI state and never logs or touches condition state', () => {
  assert.match(SOURCE, /toggleTagsExpanded\(\)\{ this\.setState\(\{tagsExpanded:!this\.state\.tagsExpanded\}\); \}/);
});

test('facet availability notes are computed from live counts, not hardcoded', () => {
  assert.match(SOURCE, /avail\+' AVAILABLE · '\+Math\.max\(0,vocabTotal-entries\.length\)\+' UNAVAILABLE HIDDEN'/);
  assert.doesNotMatch(SOURCE, /\d+ AVAILABLE · \d+ UNAVAILABLE/);
});

test('active-study taste lock is preserved and explained in the interface', () => {
  assert.match(SOURCE, /if\(this\.inStudy\(\)\) return;/);
  assert.match(SOURCE, /v\.tasteLockActive=inStudy/);
  assert.match(SOURCE, /Taste is locked during an active study to keep all three rounds comparable\. Start a new participant to choose a different taste profile\./);
});
