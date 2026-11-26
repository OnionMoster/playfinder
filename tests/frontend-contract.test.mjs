import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'playfinder-game-discovery-prototype/project/PLAYFINDER.dc.html'), 'utf8');

test('frontend component script parses', () => {
  const body = SOURCE.match(/<script type="text\/x-dc"[\s\S]*?>\n([\s\S]*?)<\/script>\n<\/body>/)?.[1];
  assert.ok(body);
  assert.doesNotThrow(() => new Function(body));
});

test('frontend keeps one assigned profile across A/B/C and locks taste in study', () => {
  assert.match(SOURCE, /rankingFor\(cond\)\{\s*const profile=this\.assignedProfile\(\)/);
  assert.match(SOURCE, /if\(this\.inStudy\(\)\) return;/);
  assert.match(SOURCE, /this\.state\.prefs\.assignedProfileId \|\|/);
  assert.doesNotMatch(SOURCE, /this\.MOCK_RANKINGS/);
  assert.doesNotMatch(SOURCE, /ranked\.push\s*\(/);
});

test('preferences snapshot includes assignedProfileId and CSV remains 15 columns', () => {
  assert.match(SOURCE, /preferencesSnapshot:v?\.assignedProfileId|assignedProfileId:v\.assignedProfileId/);
  const columns = SOURCE.match(/const cols=\[([^\]]+)\]/)?.[1].match(/'[^']+'/g);
  assert.equal(columns?.length, 15);
  assert.equal(columns?.at(-1), "'preferencesSnapshot'");
});

test('new participant reset clears profile and creates a new session', () => {
  assert.match(SOURCE, /const s=this\.newSession\(\)/);
  assert.match(SOURCE, /assignedProfileId:null/);
  assert.match(SOURCE, /startNewParticipant\(\)\{ this\.resetStudyState\('newParticipant'\)/);
});

test('fixture warning and exact-three onboarding are present', () => {
  assert.match(SOURCE, /FIXTURE \/ NOT FOR FORMAL STUDY/);
  assert.match(SOURCE, /d\.taste\.length!==3/);
  assert.match(SOURCE, /!on&&d\.taste\.length>=3/);
});

test('opening the build source directly redirects to the generated standalone', () => {
  assert.match(SOURCE, /const sourceMarkerKey='__PLAYFINDER_'\+'STUDY_PAYLOAD__'/);
  assert.match(SOURCE, /this\.STUDY_PAYLOAD\[sourceMarkerKey\]===true/);
  assert.match(SOURCE, /\/\\\.dc\\\.html\$\/i\.test\(window\.location\.pathname\)/);
  assert.match(SOURCE, /new URL\('PLAYFINDER\.html',window\.location\.href\)/);
  assert.match(SOURCE, /window\.location\.replace\(standalone\.href\)/);
});

test('provisional V2 policy is explicitly gated and implements all six disabled-third mappings', () => {
  assert.match(SOURCE, /PROVISIONAL PROFILE POLICY \/ NOT FORMAL STUDY/);
  assert.match(SOURCE, /raw\.id!==this\.PREPARED_TASTE_POLICY\.id/);
  assert.match(SOURCE, /raw\.formal===true && this\.STUDY_PAYLOAD\.mode==='formal'/);
  assert.equal((SOURCE.match(/\{prefix:\[/g) || []).length, 6);
  for (const mapping of [
    "{prefix:['Roguelike','Cozy'],disabledThirdTaste:'Open World'}",
    "{prefix:['Roguelike','Open World'],disabledThirdTaste:'Cozy'}",
    "{prefix:['Cozy','Open World'],disabledThirdTaste:'Roguelike'}",
    "{prefix:['Cozy','Survival'],disabledThirdTaste:'Turn-Based'}",
    "{prefix:['Cozy','Turn-Based'],disabledThirdTaste:'Survival'}",
    "{prefix:['Survival','Turn-Based'],disabledThirdTaste:'Cozy'}",
  ]) assert.ok(SOURCE.includes(mapping), mapping);
  assert.match(SOURCE, /this\.tastePolicyBlock\(t,d\.taste\)/);
  assert.match(SOURCE, /reason=on\?'':this\.tastePolicyBlock\(t,d\.taste\)/);
  assert.match(SOURCE, /approved study policy supports 558 evidence-backed three-taste combinations/);
  assert.match(SOURCE, /policy\.formal\?'approved':'provisional'/);
});

test('participant-facing data wording distinguishes reviewed interactions, ownership, genres, and tags', () => {
  assert.match(SOURCE, /reviewed or interacted with during the training period are excluded; this is not ownership data/i);
  assert.match(SOURCE, /Genre filters match only explicit source genres/i);
  assert.match(SOURCE, /Tags may support taste matching, but are never treated as genres/i);
});
