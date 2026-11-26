#!/usr/bin/env node
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { formatValidationIssues, validateStudyData } from './study-validation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const input = resolve(arg('--input', join(ROOT, 'study-data/incoming/final')));
const mode = arg('--mode', 'formal');
const reports = join(ROOT, 'study-data/reports');
const generated = join(ROOT, 'study-data/generated/playfinder-study-payload.json');
const run = (script, extra) => {
  const result = spawnSync(process.execPath, [join(ROOT, 'build', script), ...extra], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status}`);
};

const validation = validateStudyData(input, { mode });
if (!validation.ok) {
  console.error(formatValidationIssues(validation));
  console.error('build-study: validation failed; existing PLAYFINDER.html files were not changed');
  process.exit(1);
}
run('validate-study-data.mjs', ['--input', input, '--mode', mode, '--reports', reports]);
run('build-study-payload.mjs', ['--input', input, '--mode', mode, '--output', generated]);

const temp = mkdtempSync(join(tmpdir(), 'playfinder-study-build-'));
const stagedHtml = join(temp, 'PLAYFINDER.html');
run('build-standalone.mjs', ['--payload', generated, '--output', stagedHtml]);
const html = readFileSync(stagedHtml, 'utf8');
const payload = JSON.parse(readFileSync(generated, 'utf8'));
const sanityErrors = [];
if (html.includes('__PLAYFINDER_STUDY_PAYLOAD__')) sanityErrors.push('payload marker remains');
if (html.includes('MOCK_RANKINGS')) sanityErrors.push('MOCK_RANKINGS remains');
if (!html.includes(payload.provenance.candidateHash)) sanityErrors.push('candidate hash absent from standalone');
if (!html.includes(payload.profiles[0]?.profileId || '__missing_profile__')) sanityErrors.push('profile payload absent from standalone');
if (/fetch\s*\(\s*['"][^'"]+\.json/.test(html)) sanityErrors.push('standalone fetches external JSON');
if (sanityErrors.length) {
  console.error(`build-study: standalone sanity failed: ${sanityErrors.join('; ')}`);
  console.error('build-study: existing PLAYFINDER.html files were not changed');
  process.exit(1);
}

run('benchmark-serving.mjs', ['--payload', generated]);
copyFileSync(stagedHtml, join(ROOT, 'PLAYFINDER.html'));
copyFileSync(stagedHtml, join(ROOT, 'playfinder-game-discovery-prototype/project/PLAYFINDER.html'));
writeFileSync(join(reports, 'standalone-sanity.json'), JSON.stringify({
  ok: true, mode, candidateHash: payload.provenance.candidateHash,
  profileCount: payload.profiles.length, outputBytes: Buffer.byteLength(html),
}, null, 2) + '\n');
console.log('build-study: PASS; validated standalone promoted to both PLAYFINDER.html outputs');
