#!/usr/bin/env node
// citation-audit.mjs — cross-check in-text [N] citations in paper/chapters/*.md
// against the numbered entries defined in paper/references/bibliography.md.
//
// Report:
//   (i)  MISSING   — in-text numbers with no matching bibliography entry
//   (ii) ORPHANS   — bibliography entries never cited in any chapter
//
// Exit code: 0 iff no missing citations AND every orphan is either resolved
// (cited in text) or explicitly waived via --allow=N,N. Run from anywhere:
//   node scripts/citation-audit.mjs [--allow=14,22]

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const chaptersDir = join(repoRoot, 'paper', 'chapters');
const bibPath = join(repoRoot, 'paper', 'references', 'bibliography.md');

const allowArg = process.argv.find((a) => a.startsWith('--allow='));
const allow = new Set(
  allowArg
    ? allowArg
        .split('=')[1]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n))
    : []
);

// Fenced code blocks hold prompt excerpts / example JSON, not citations.
function stripCodeFences(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '');
}

const defined = new Map(); // N -> bib line number
const bibLines = readFileSync(bibPath, 'utf8').split('\n');
bibLines.forEach((line, i) => {
  const m = line.match(/^\[(\d+)\]/);
  if (m) defined.set(parseInt(m[1], 10), i + 1);
});

const cited = new Map(); // N -> ["file:line", ...]
for (const f of readdirSync(chaptersDir).filter((f) => f.endsWith('.md')).sort()) {
  const lines = stripCodeFences(readFileSync(join(chaptersDir, f), 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\[(\d+)\]/g)) {
      const n = parseInt(m[1], 10);
      if (!cited.has(n)) cited.set(n, []);
      cited.get(n).push(`${f}:${i + 1}`);
    }
  });
}

const missing = [...cited.keys()].filter((n) => !defined.has(n)).sort((a, b) => a - b);
const orphans = [...defined.keys()].filter((n) => !cited.has(n)).sort((a, b) => a - b);
const waived = orphans.filter((n) => allow.has(n));
const unresolved = orphans.filter((n) => !allow.has(n));

console.log('citation-audit: in-text [N] vs paper/references/bibliography.md');
console.log(`  bib entries defined : ${defined.size}`);
console.log(`  numbers cited       : ${cited.size}`);
console.log('');

if (missing.length > 0) {
  console.log(`MISSING (${missing.length}) — cited in chapters, no bib entry:`);
  for (const n of missing) {
    const locs = cited.get(n).slice(0, 5).join(', ');
    console.log(`  [${n}] at ${locs}${cited.get(n).length > 5 ? ' …' : ''}`);
  }
  console.log('');
} else {
  console.log('MISSING: none');
  console.log('');
}

if (orphans.length === 0) {
  console.log('ORPHANS: none');
} else {
  console.log(`ORPHANS (${orphans.length}) — in bibliography, never cited in chapters:`);
  for (const n of orphans) {
    const tag = allow.has(n) ? ' [WAIVED via --allow]' : ' [UNRESOLVED]';
    const bibLoc = `bibliography.md:${defined.get(n)}`;
    console.log(`  [${n}] ${bibLoc}${tag}`);
  }
}
if (waived.length > 0) console.log(`  waived count: ${waived.length} of ${orphans.length}`);

const ok = missing.length === 0 && unresolved.length === 0;
console.log('');
console.log(ok ? 'PASS: citation set is consistent.' : 'FAIL: resolve the items above (cite or delete the entry; do not renumber).');
process.exit(ok ? 0 : 1);
