#!/usr/bin/env node
// Build an explicitly synthetic, offline PlayFinder demonstration. This never
// reads the privately retained formal catalogue/rankings or participant data.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const input = resolve(arg('--input', join(ROOT, 'study-data/fixtures')));
const output = resolve(arg('--output', join(ROOT, 'PLAYFINDER-fixture.html')));
const temp = mkdtempSync(join(tmpdir(), 'playfinder-fixture-build-'));
const payload = join(temp, 'payload.json');

const run = (script, extra) => {
  const result = spawnSync(process.execPath, [join(ROOT, 'build', script), ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status}`);
};

try {
  run('build-study-payload.mjs', [
    '--input', input,
    '--mode', 'fixture',
    '--output', payload,
  ]);
  run('build-standalone.mjs', [
    '--payload', payload,
    '--output', output,
  ]);

  const html = readFileSync(output, 'utf8');
  const data = JSON.parse(readFileSync(payload, 'utf8'));
  const failures = [];
  if (!html.includes('FIXTURE / NOT FOR FORMAL STUDY')) failures.push('fixture notice missing');
  if (html.includes('FORMAL STUDY DATA')) failures.push('formal-data notice present');
  if (!html.includes(data.provenance.candidateHash)) failures.push('fixture candidate hash missing');
  if (!html.includes(data.profiles[0]?.profileId || '__missing_profile__')) failures.push('fixture profile missing');
  if (html.includes('__PLAYFINDER_STUDY_PAYLOAD__')) failures.push('payload marker remains');
  if (/fetch\s*\(\s*['"][^'"]+\.json/.test(html)) failures.push('demo fetches external JSON');
  if (failures.length) throw new Error(`fixture demo sanity failed: ${failures.join('; ')}`);

  console.log(`build-fixture-demo: PASS; wrote ${output} from synthetic fixtures only`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
