#!/usr/bin/env node
// Extract the reusable offline runtime/assets from a previously generated
// standalone while discarding its application template and embedded study
// payload. The output is safe to commit because it contains no catalogue,
// rankings, profiles, or participant data.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const input = resolve(arg('--input', join(ROOT, 'PLAYFINDER.html')));
const output = resolve(arg('--output', join(ROOT, 'build/standalone-shell.html')));
const open = '<script type="__bundler/template">';
const source = readFileSync(input, 'utf8');
const openAt = source.indexOf(open);
const payloadStart = openAt + open.length;
const payloadEnd = source.indexOf('</script>', payloadStart);
if (openAt < 0 || payloadEnd < 0) throw new Error(`invalid standalone template in ${input}`);

const template = JSON.parse(source.slice(payloadStart, payloadEnd));
const supportUuid = (template.match(
  /<script src="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"><\/script>/,
) || [])[1];
const fontStyle = (template.match(/<style>[\s\S]*?<\/style>/g) || [])
  .find((block) => block.includes('@font-face'));
if (!supportUuid || !fontStyle) throw new Error('standalone is missing reusable support/font assets');

const cleanTemplate = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>PlayFinder clean build shell</title>
<script src="${supportUuid}"></script>
${fontStyle}
</head>
<body><p>Build shell only. No study payload is stored here.</p></body>
</html>`;
const cleanPayload = JSON.stringify(cleanTemplate).replace(/<\//g, '<\\u002F');
const shell = source.slice(0, payloadStart) + '\n' + cleanPayload + '\n  ' + source.slice(payloadEnd);

for (const forbidden of [
  'FORMAL STUDY DATA',
  '__PLAYFINDER_STUDY_PAYLOAD__',
  '01b6bae167febed5b2012c3d8a348d0a3463d3460c9892e58b661653106246ed',
]) {
  if (shell.includes(forbidden)) throw new Error(`clean shell retained forbidden marker: ${forbidden}`);
}
if (!shell.includes(`"${supportUuid}":{`)) throw new Error('support asset missing from clean shell');

writeFileSync(output, shell);
console.log(`create-standalone-shell: wrote ${output} (${Buffer.byteLength(shell)} bytes)`);
