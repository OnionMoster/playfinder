#!/usr/bin/env node
// Regenerate the participant-facing standalone PLAYFINDER.html from the
// maintainable Design Component source.
//
//   node build/build-standalone.mjs
//
// The handoff bundle shipped no build step, so this script reuses a data-free
// shell (bundler loader, gzip+base64 asset manifest with React, ReactDOM,
// support.js and the nine woff2 subsets) and replaces only the
// `__bundler/template` payload with a freshly transformed copy of the source.
// Everything the browser executes therefore comes from PLAYFINDER.dc.html, and
// no asset is re-downloaded, so the output stays fully offline-capable.
//
// Transforms applied to the source, matching what the original bundler did:
//   1. <script src="./support.js">      -> the bundled support.js asset uuid
//   2. Google Fonts <link>              -> the bundled @font-face <style> block
//   3. <template id="__bundler_thumbnail"> removed (the shell carries its own)
//   4. camelCase attributes            -> sc-camel-* (dc-runtime encodeCase)
// The script is idempotent: running it twice produces the same bytes.

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'playfinder-game-discovery-prototype/project/PLAYFINDER.dc.html');
const DIST = join(ROOT, 'PLAYFINDER.html');
const DIST_COPY = join(ROOT, 'playfinder-game-discovery-prototype/project/PLAYFINDER.html');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const SHELL = arg('--shell', join(ROOT, 'build/standalone-shell.html'));
const PAYLOAD = arg('--payload', join(ROOT, 'study-data/generated/playfinder-study-payload.json'));
const OUTPUT = arg('--output', DIST);
const MIRROR = arg('--mirror', OUTPUT === DIST ? DIST_COPY : null);

const TEMPLATE_OPEN = '<script type="__bundler/template">';

const die = (msg) => { console.error('build-standalone: ' + msg); process.exit(1); };
const once = (haystack, needle, what) => {
  const n = haystack.split(needle).length - 1;
  if (n !== 1) die(`expected exactly one ${what}, found ${n}`);
};

// ---- read the data-free shell and split off its placeholder template ----
const dist = readFileSync(SHELL, 'utf8');
const openAt = dist.indexOf(TEMPLATE_OPEN);
if (openAt < 0) die('no __bundler/template block in ' + SHELL);
const payloadStart = openAt + TEMPLATE_OPEN.length;
const payloadEnd = dist.indexOf('</script>', payloadStart);
if (payloadEnd < 0) die('unterminated __bundler/template block');

let oldTemplate;
try {
  oldTemplate = JSON.parse(dist.slice(payloadStart, payloadEnd));
} catch (e) {
  die('embedded template is not a JSON string: ' + e.message);
}

// ---- recover the two bundled assets the source references by URL ----
const supportUuid = (oldTemplate.match(
  /<script src="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"><\/script>/,
) || [])[1];
if (!supportUuid) die('could not find the bundled support.js asset uuid');

const fontStyle = (oldTemplate.match(/<style>[\s\S]*?<\/style>/g) || [])
  .find((block) => block.includes('@font-face'));
if (!fontStyle) die('could not find the bundled @font-face style block');

// ---- transform the source ----
let src = readFileSync(SRC, 'utf8');

let studyPayload;
try {
  studyPayload = JSON.parse(readFileSync(PAYLOAD, 'utf8'));
} catch (e) {
  die('could not read validated study payload ' + PAYLOAD + ': ' + e.message);
}
const payloadMarker = '{"__PLAYFINDER_STUDY_PAYLOAD__":true}';
once(src, payloadMarker, 'study payload marker');
src = src.replace(payloadMarker, JSON.stringify(studyPayload));

once(src, '<script src="./support.js"></script>', 'support.js script tag');
src = src.replace(
  '<script src="./support.js"></script>',
  `<script src="${supportUuid}"></script>`,
);

const fontsLink = (src.match(/^[ \t]*<link href="https:\/\/fonts\.googleapis\.com\/css2[^>]*>\n/m) || [])[0];
if (!fontsLink) die('could not find the Google Fonts <link> in the source');
once(src, fontsLink, 'Google Fonts link');
src = src.replace(fontsLink, fontStyle + '\n');

const thumb = (src.match(/<template id="__bundler_thumbnail"[\s\S]*?<\/template>\n/) || [])[0];
if (!thumb) die('could not find the __bundler_thumbnail template in the source');
src = src.replace(thumb, '');

// dc-runtime encodeCamelAttrs, applied to the markup region only so the logic
// script body is never rewritten (this mirrors the original bundler output).
const xdcOpen = src.indexOf('<x-dc>');
const xdcClose = src.indexOf('</x-dc>');
if (xdcOpen < 0 || xdcClose < xdcOpen) die('could not locate the <x-dc> markup region');
const encodeCamelAttrs = (html) =>
  html.replace(/(\s)([a-z]+[A-Z][A-Za-z0-9]*)(\s*=)/g, (_, sp, name, eq) =>
    sp + 'sc-camel-' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + eq);
src = src.slice(0, xdcOpen) + encodeCamelAttrs(src.slice(xdcOpen, xdcClose)) + src.slice(xdcClose);

// ---- sanity checks before writing ----
if (src.includes('./support.js')) die('support.js reference survived the transform');
if (src.includes('fonts.googleapis.com/css2')) die('Google Fonts link survived the transform');
if (src.includes('__bundler_thumbnail')) die('thumbnail template survived the transform');
if (!src.includes('sc-camel-on-click')) die('camelCase attribute encoding did not apply');
if (!/<head[^>]*>/i.test(src)) die('no <head> for the shell to inject __resources into');
if (src.includes('__PLAYFINDER_STUDY_PAYLOAD__')) die('study payload marker survived the transform');
if (!src.includes(`"candidateHash":"${studyPayload.provenance?.candidateHash}"`)) die('study payload was not embedded');
if (studyPayload.mode === 'formal' && src.includes('MOCK_RANKINGS')) die('formal build still references MOCK_RANKINGS');
if (studyPayload.mode === 'formal' && /ranked\.push\s*\(/.test(src)) die('formal build appears to append a catalogue fallback');
const referenced = [supportUuid, ...[...fontStyle.matchAll(/url\("([0-9a-f-]{36})"\)/g)].map((m) => m[1])];
for (const uuid of new Set(referenced)) {
  if (!dist.includes(`"${uuid}":{`)) die(`asset ${uuid} is not in the manifest`);
}

// The payload sits inside a <script>, so no "</" may appear literally.
const payload = JSON.stringify(src).replace(/<\//g, '<\\u002F');
if (payload.includes('</')) die('payload still contains a literal "</"');

const out = dist.slice(0, payloadStart) + '\n' + payload + '\n  ' + dist.slice(payloadEnd);
writeFileSync(OUTPUT, out);
if (MIRROR) copyFileSync(OUTPUT, MIRROR);

console.log(
  `build-standalone: wrote ${OUTPUT} (${out.length} bytes)\n` +
  `  shell: ${SHELL}\n` +
  `  template: ${src.length} chars from PLAYFINDER.dc.html\n` +
  `  support.js asset: ${supportUuid}\n` +
  (MIRROR ? `  mirrored to ${MIRROR}` : '  no mirror requested'),
);
