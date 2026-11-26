import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('fixture demo builds offline without a formal standalone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-build-smoke-'));
  try {
    const htmlPath = join(dir, 'PLAYFINDER-fixture.html');
    const result = spawnSync(process.execPath, [
      'build/build-fixture-demo.mjs',
      '--output', htmlPath,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const html = readFileSync(htmlPath, 'utf8');
    const shell = readFileSync(join(ROOT, 'build/standalone-shell.html'), 'utf8');
    assert.ok(html.includes('FIXTURE / NOT FOR FORMAL STUDY'));
    assert.ok(!html.includes('FORMAL STUDY DATA'));
    assert.ok(!html.includes('__PLAYFINDER_STUDY_PAYLOAD__'));
    assert.ok(!/fetch\s*\(\s*['"][^'"]+\.json/.test(html));
    assert.ok(!shell.includes('FORMAL STUDY DATA'));
    assert.ok(!shell.includes('01b6bae167febed5b2012c3d8a348d0a3463d3460c9892e58b661653106246ed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
