import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'playfinder-game-discovery-prototype/project/PLAYFINDER.dc.html'), 'utf8');
const QUESTIONNAIRE = readFileSync(join(ROOT, 'study/questionnaire.md'), 'utf8');
const LIKERT_TEMPLATE = readFileSync(join(ROOT, 'study/templates/likert-responses.csv'), 'utf8').trim().split(/\r?\n/)[0];
const OPEN_TEMPLATE = readFileSync(join(ROOT, 'study/templates/open-responses.csv'), 'utf8').trim().split(/\r?\n/)[0];

const LIKERT_KEYS = [
  'q1_relevance', 'q2_consider_playing', 'q3_variety', 'q4_discovery', 'q5_confidence',
  'q6_budget_fit', 'q7_platform_fit', 'q8_ease', 'q9_transparency', 'q10_satisfaction',
];

test('ten Likert items are defined in the page and match questionnaire.md wording', () => {
  for (const key of LIKERT_KEYS) assert.ok(SOURCE.includes(`key:'${key}'`), key);
  const items = [...SOURCE.matchAll(/\{key:'q\d+_[a-z_]+',\s*text:'([^']+)'\}/g)].map((m) => m[1]);
  assert.equal(items.length, 10);
  for (const text of items) {
    // questionnaire.md is the source of truth for participant-facing wording
    assert.ok(QUESTIONNAIRE.includes(text.replace(/\\'/g, "'")), text);
  }
});

test('the 1-7 response scale matches the documented labels', () => {
  const scale = [...SOURCE.matchAll(/\{value:(\d),label:'([^']+)'\}/g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(scale.map((s) => s[0]), [1, 2, 3, 4, 5, 6, 7]);
  for (const [, label] of scale) assert.ok(QUESTIONNAIRE.includes(label), label);
});

test('two open questions match questionnaire.md', () => {
  assert.ok(SOURCE.includes("key:'choice_factors'"));
  assert.ok(SOURCE.includes("key:'preferred_round_reason_and_improvement'"));
  const opens = [...SOURCE.matchAll(/\{key:'(?:choice_factors|preferred_round_reason_and_improvement)',\s*text:'([^']+)'\}/g)]
    .map((m) => m[1]);
  assert.equal(opens.length, 2);
  for (const text of opens) assert.ok(QUESTIONNAIRE.includes(text), text);
});

test('the questionnaire is administered after the round and gates progression', () => {
  // "finished here?" opens the survey instead of a confirm dialog
  assert.match(SOURCE, /askContinue\(\)\{[\s\S]*?surveyOpen:true/);
  assert.match(SOURCE, /v\.continueLabel = 'ANSWER THE TEN QUESTIONS →'/);
  // submit is blocked until all ten integers are present
  assert.match(SOURCE, /surveyComplete\(draft\)\{ return this\.LIKERT_ITEMS\.every\(i=>Number\.isInteger\(draft\[i\.key\]\)\); \}/);
  assert.match(SOURCE, /submitSurvey\(\)\{[\s\S]*?if\(!this\.surveyComplete\(draft\)\) return;/);
  // only after submitting does the round advance or the study complete
  assert.match(SOURCE, /if\(last\) this\.completeStudy\(\);\s*\n\s*else this\.advanceRound\(\);/);
  // round/finish confirm dialogs are gone; destructive actions keep theirs
  assert.doesNotMatch(SOURCE, /confirmKind==='round'/);
  assert.doesNotMatch(SOURCE, /confirmKind==='finish'/);
  assert.match(SOURCE, /if\(kind==='clear'\) this\.clearData\(\)/);
});

test('submission time is captured at submit and stored per condition', () => {
  assert.match(SOURCE, /survey\.submittedAt=new Date\(\)\.toISOString\(\);/);
  assert.match(SOURCE, /this\.patchCS\(\{survey\}, this\.activeCondition\(\)/);
  assert.match(SOURCE, /this\.log\('round_survey_submitted'/);
  // freshCond carries the field so each condition starts with no survey
  assert.match(SOURCE, /roundStarted:false, survey:null\}/);
});

test('stored surveys are validated to ten integers inside 1-7', () => {
  assert.match(SOURCE, /if\(!Number\.isInteger\(v\) \|\| v<1 \|\| v>7\) return null;/);
  assert.match(SOURCE, /survey: this\.validSurvey\(s\.survey\)/);
});

test('questionnaire CSV exports reuse the study template headers verbatim', () => {
  const likertCols = SOURCE.match(/const likertCols=\[([^\]]+)\]/)?.[1];
  assert.ok(likertCols);
  assert.ok(likertCols.includes("'participant_id','round','condition'"));
  assert.ok(likertCols.includes("'submitted_at'"));
  assert.equal(LIKERT_TEMPLATE, `participant_id,round,condition,${LIKERT_KEYS.join(',')},submitted_at`);

  const openCols = SOURCE.match(/const openCols=\[([^\]]+)\]/)?.[1];
  assert.ok(openCols);
  assert.ok(openCols.includes("'participant_id','preferred_round','preferred_condition'"));
  assert.equal(
    OPEN_TEMPLATE,
    'participant_id,preferred_round,preferred_condition,choice_factors,preferred_round_reason_and_improvement,submitted_at',
  );
});

test('join keys come from study state, never from typed input', () => {
  // condition and preferred_condition are derived from the assigned sequence
  assert.match(SOURCE, /const cond=seq\[round-1\]; if\(!cond\) continue;/);
  assert.match(SOURCE, /preferred_condition:seq\[o\.preferredRound-1\]\|\|''/);
  assert.match(SOURCE, /participant_id:this\.state\.participantId\|\|''/);
});

test('the questionnaire never reveals the condition or model to the participant', () => {
  const markup = SOURCE.slice(SOURCE.indexOf('<x-dc>'), SOURCE.indexOf('</x-dc>'));
  const survey = markup.slice(markup.indexOf('PER-ROUND QUESTIONNAIRE'), markup.indexOf('============ MAIN'));
  assert.ok(survey.length > 0);
  for (const term of ['BPR', 'Popularity', 'popularity', 'Hybrid', 'hybrid', 'bpr']) {
    assert.ok(!survey.includes(term), `${term} must not appear in the questionnaire markup`);
  }
  assert.match(survey, /\{\{ surveyRoundLabel \}\}/);
  assert.match(SOURCE, /v\.surveyRoundLabel='ROUND '\+st\.round\+' OF 3'/);
});

test('a new participant clears every questionnaire trace', () => {
  assert.match(SOURCE, /openResponses:'playfinder\.study\.v2\.openResponses'/);
  assert.match(SOURCE, /this\.del\(this\.LS\.openResponses\);/);
  assert.match(SOURCE, /this\.LS\.completed,this\.LS\.openResponses\]\.forEach\(k=>this\.del\(k\)\)/);
  const resets = SOURCE.match(/surveyOpen:false, surveyDraft:\{\}, openOpen:false, openDraft:\{preferredRound:null\}, openResponses:null/g);
  assert.equal(resets?.length, 2, 'startStudy and resetStudyState must both clear questionnaire state');
});

test('accessibility: Likert options are a labelled radio group', () => {
  const markup = SOURCE.slice(SOURCE.indexOf('<x-dc>'), SOURCE.indexOf('</x-dc>'));
  assert.match(markup, /<fieldset role="radiogroup"/);
  assert.match(markup, /role="radio" aria-checked="\{\{ opt\.checked \}\}"/);
  assert.match(SOURCE, /ariaLabel:`\$\{step\.value\} of 7, \$\{step\.label\}`/);
});
