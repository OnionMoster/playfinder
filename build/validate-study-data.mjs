#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatValidationIssues, validateStudyData } from './study-validation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};
const input = resolve(value('--input', join(ROOT, 'study-data/incoming/final')));
const mode = value('--mode', 'formal');
const reports = resolve(value('--reports', join(ROOT, 'study-data/reports')));
const result = validateStudyData(input, { mode });
mkdirSync(reports, { recursive: true });
writeFileSync(join(reports, 'validation-report.json'), JSON.stringify({
  ok: result.ok,
  formal_ready: result.formalReady,
  validation_complete: result.validationComplete,
  scope: result.scope,
  stopped_after: result.stoppedAfter,
  executed_sections: result.executedSections,
  not_executed_sections: result.notExecutedSections,
  note: result.note,
  mode,
  input: relative(ROOT, input),
  summary: result.summary || null,
  errors: result.errors, warnings: result.warnings,
}, null, 2) + '\n');
if (result.coverageCsv) writeFileSync(join(reports, 'profile-coverage-report.csv'), result.coverageCsv);
if (result.filterCsv) writeFileSync(join(reports, 'filter-availability-report.csv'), result.filterCsv);
const issues = formatValidationIssues(result);
if (issues) console.error(issues);
if (!result.validationComplete || result.notExecutedSections?.length) {
  console.error(`Validation scope note: ${result.note}`);
  for (const section of result.notExecutedSections || []) console.error(`NOT EXECUTED: ${section}`);
}
console.log(`validate-study-data: ${result.ok ? 'PASS' : 'FAIL'} (${result.errors.length} errors, ${result.warnings.length} warnings)`);
if (!result.ok) process.exitCode = 1;
