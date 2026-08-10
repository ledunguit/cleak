#!/usr/bin/env -S tsx
/**
 * Ingest the MemHint-project leak corpus into a v2 labeled corpus the eval harness
 * understands, so leak-investigator can be run on real-project CWE-401 leaks from
 * the same 8-project target set as MemHint (arXiv:2603.27224,
 * github.com/jiekeshi/MemHint).
 *
 * IMPORTANT — this is NOT a reproduction of MemHint's own 54 confirmed bugs. That
 * list is not published anywhere: the repo ships only the detection tool plus a
 * verified per-project build-command file (`proj_build_command.json`, reused below
 * for `PROJECT_BUILD_COMMANDS`), and the paper's Table I is aggregate counts only,
 * no per-bug table. `memory_safety_bugs.json`/`llm_verify_bugs.json` in the repo
 * are the TOOL's own run output, not a pre-existing ground-truth oracle.
 *
 * Source of truth: `demo/memhint/memhint_bugs.json` (committed) — an
 * INDEPENDENTLY-RECONSTRUCTED set of real leak-fix commits found via git-log
 * archaeology on each project's own upstream history (commit message pattern
 * matching + manual diff review to confirm a genuine missing-free CWE-401 fix, not
 * a refactor or a different bug class). Every entry's `github_url` is independently
 * verifiable. 19 cases across 6 of the 8 MemHint projects (Vim, tmux, Redis, curl,
 * OpenSSL, FreeRDP) — FFmpeg and linux/staging skipped (see `demo/memhint/memhint_bugs.json`'s
 * `_meta.scope`). Function-level, positive-only (no clean labels) — same scoring
 * convention as LAMeD: report RECALL + FP count, not precision/specificity/MCC.
 *
 * Usage:
 *   tsx scripts/memhint/ingest.ts                          # materialize (clones repos)
 *   tsx scripts/memhint/ingest.ts --manifest-only          # write the manifest only (no clone)
 *   tsx scripts/memhint/ingest.ts --benchmark <path> --out demo/memhint --clones /tmp/memhint-clones
 *
 * The pure mapping helpers are exported (and unit-tested in ingest.test.ts);
 * execution is guarded by an entrypoint check so importing them runs nothing.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface MemhintEntry {
  id: string;
  project: string;
  repo_url: string;
  file: string;
  function: string;
  fix_commit: string;
  parent_commit: string;
  github_url: string;
  notes: string;
}

export interface LabeledFlaw {
  file: string;
  function: string;
  cwe: string;
}

/** One flaw per entry — MemHint entries are already single-function (no LAMeD-style
 * `;`-separated multi-function signatures to parse). */
export function entryToFlaw(e: MemhintEntry): LabeledFlaw {
  return { file: e.file, function: e.function, cwe: 'CWE-401' };
}

/**
 * Per-project allocator / deallocator APIs. Each verified directly against the
 * project's own source (grep on the header/declaration, not guessed) — see the
 * ingest research notes. Conservative: only well-known owning allocators actually
 * observed near one of this corpus's leak sites or declared as the project's public
 * allocation API.
 */
export const PROJECT_ALLOCATORS: Record<string, string[]> = {
  // curl-8.19.0 (MemHint's pinned version) renamed its source-level allocator API
  // to `curlx_*` — `lib/curl_setup.h` #defines curlx_malloc/calloc/realloc/strdup
  // to Curl_cmalloc/... (or `malloc` et al in some build variants), but the MACRO
  // NAME is what appears in the source text candidateScan lexically scans, so
  // `Curl_c*` alone (LAMeD's older curl snapshot used that name directly) silently
  // misses every curlx_*-based allocation. Keep both: some files (e.g.
  // content_encoding.c, http2.c) still call Curl_cmalloc directly.
  curl: [
    'Curl_cmalloc', 'Curl_ccalloc', 'Curl_crealloc', 'Curl_cstrdup', 'Curl_memdup', 'Curl_saferealloc',
    'curlx_malloc', 'curlx_calloc', 'curlx_realloc', 'curlx_strdup', 'curlx_tcsdup',
    'curl_maprintf', 'curl_mvaprintf', 'aprintf',
  ],
  vim: ['alloc', 'alloc_id', 'alloc_clear', 'alloc_clear_id', 'lalloc', 'lalloc_clear', 'lalloc_id'],
  tmux: ['xmalloc', 'xcalloc', 'xrealloc', 'xreallocarray', 'xrecallocarray', 'xstrdup', 'xstrndup', 'xmemdup'],
  redis: ['zmalloc', 'zcalloc', 'zrealloc', 'zstrdup'],
  openssl: ['OPENSSL_malloc', 'OPENSSL_zalloc', 'OPENSSL_realloc', 'OPENSSL_strdup'],
  freerdp: ['winpr_aligned_malloc', 'winpr_aligned_calloc', 'winpr_aligned_realloc', 'winpr_aligned_recalloc', 'winpr_aligned_offset_malloc'],
};

export const PROJECT_DEALLOCATORS: Record<string, string[]> = {
  curl: ['Curl_cfree', 'Curl_safefree', 'curlx_free'],
  vim: ['vim_free'],
  // tmux frees via plain free() — no custom deallocator wrapper, default covers it.
  redis: ['zfree'],
  openssl: ['OPENSSL_free'],
  freerdp: ['winpr_aligned_free'],
};

/**
 * Per-project build recipe, adapted from MemHint's own `proj_build_command.json`
 * (author-verified `prepare_for_build[]` + `build_command`, fetched from
 * github.com/jiekeshi/MemHint). `can_error:true` prepare steps (e.g. `make clean`
 * on a fresh checkout) are wrapped `(cmd; true)` so a harmless failure doesn't abort
 * the chain. NOTE: the upstream JSON appears to assume an already-configured tree
 * for curl/openssl (no `./configure`/`./Configure` step listed) — `autoreconf -fi
 * && ./configure` / `./Configure` added here for a fresh git checkout; this is a
 * best-effort guess to be verified during the real build audit (Bước 3), same as
 * LAMeD's own build-command iteration.
 */
export const PROJECT_BUILD_COMMANDS: Record<string, string> = {
  vim: '(make clean; true) && make',
  // Only cases whose checkout still carries the portable compat/ + autoconf layer
  // (periodically synced in from the OpenBSD-native upstream in batches — some
  // historical commits between syncs lack it entirely, e.g. missing sys/tree.h)
  // can build this way; others fall back to static-only evidence, same as any
  // other per-case build failure the pipeline already tolerates.
  tmux: '(make clean; true) && sh autogen.sh && ./configure --disable-utf8proc && make',
  openssl: '(make clean; true) && ./Configure && make -k',
  redis: '(make clean; true) && make',
  curl: '(make clean; true) && autoreconf -fi && ./configure --without-ssl --disable-shared --without-libpsl --without-zlib --without-brotli --without-zstd && make',
  freerdp:
    '(rm -rf build-codeql; true) && cmake -S . -B build-codeql -DCMAKE_BUILD_TYPE=Release -DWITH_CLIENT=OFF -DWITH_SERVER=OFF -DWITH_CHANNELS=OFF -DWITH_FFMPEG=OFF -DWITH_DSP_FFMPEG=OFF -DWITH_VIDEO_FFMPEG=OFF -DWITH_SWSCALE=OFF -DWITH_CAIRO=OFF -DWITH_OPUS=OFF -DWITH_CUPS=OFF -DWITH_PCSC=OFF -DWITH_FUSE=OFF && cmake --build build-codeql',
};

// ── Side-effecting helpers (materialization) ────────────────────────────────

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
}

/** Clone a repo once (full history so any SHA resolves), cached under clonesDir. */
function ensureClone(project: string, repoUrl: string, clonesDir: string): string {
  const dir = join(clonesDir, project);
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(clonesDir, { recursive: true });
  console.log(`  cloning ${repoUrl} → ${dir}`);
  execFileSync('git', ['clone', '--filter=blob:none', repoUrl, dir], { stdio: 'inherit' });
  return dir;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function main(): void {
  const benchmarkPath = resolve(arg('benchmark', 'demo/memhint/memhint_bugs.json')!);
  const outDir = resolve(arg('out', 'demo/memhint')!);
  const clonesDir = resolve(arg('clones', join(outDir, '.clones'))!);
  const manifestOnly = has('manifest-only');
  const onlyProject = arg('project'); // materialize/emit a single project (e.g. curl)

  const raw = JSON.parse(readFileSync(benchmarkPath, 'utf-8')) as { cases: MemhintEntry[] };
  const all = raw.cases;
  const entries = onlyProject ? all.filter((e) => e.project === onlyProject) : all;
  console.log(`MemHint: ${entries.length}${onlyProject ? `/${all.length} (project=${onlyProject})` : ''} leak entries from ${benchmarkPath}`);

  const cases: any[] = [];
  let materialized = 0;
  const skipped: string[] = [];

  for (const e of entries) {
    const flaw = entryToFlaw(e);
    const caseDir = join(outDir, 'cases', e.id);

    if (!manifestOnly) {
      try {
        const clone = ensureClone(e.project, e.repo_url, clonesDir);
        git(clone, ['checkout', '--quiet', e.parent_commit]);
        rmSync(caseDir, { recursive: true, force: true });
        mkdirSync(caseDir, { recursive: true });
        // Copy the working tree (sans .git) to a stable, per-case snapshot.
        cpSync(clone, caseDir, { recursive: true, filter: (src) => !src.includes(`${clone}/.git`) });
        materialized++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        skipped.push(`${e.id} (${msg.slice(0, 80)})`);
        continue;
      }
    }

    cases.push({
      id: e.id,
      // RELATIVE to the corpus dir — the eval harness does join(corpusDir, repo_path).
      repo_path: join('cases', e.id),
      build_command: PROJECT_BUILD_COMMANDS[e.project],
      flaws: [flaw],
      clean: [],
      cwe: 'CWE-401',
      functionalVariant: e.project,
      allocators: PROJECT_ALLOCATORS[e.project],
      deallocators: PROJECT_DEALLOCATORS[e.project],
      // Provenance (not read by the scorer, but keeps the label traceable).
      _memhint: { githubUrl: e.github_url, fixCommit: e.fix_commit, parentCommit: e.parent_commit, notes: e.notes },
    });
  }

  const manifest = {
    schema_version: 'memory-leak-corpus/v2',
    name: 'memhint-independent-reconstruction',
    source: 'Independently-reconstructed real leak-fix commits, same 8-project target set as MemHint (arXiv:2603.27224) — see demo/memhint/memhint_bugs.json for methodology and per-case github_url verification links.',
    positive_only: true,
    cases,
  };
  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, 'corpus_manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nwrote ${cases.length} cases → ${manifestPath}`);
  console.log(`  flaws total       : ${cases.reduce((n, c) => n + c.flaws.length, 0)}`);
  if (!manifestOnly) console.log(`  materialized      : ${materialized}/${entries.length} case source trees`);
  else console.log(`  (manifest-only: repo_path points at cases/<id>; run without --manifest-only to clone + materialize)`);
  if (skipped.length) console.log(`  skipped           : ${skipped.length}\n    - ${skipped.slice(0, 10).join('\n    - ')}`);
  console.log('\nMemHint corpus is POSITIVE-ONLY → score RECALL + FP count (not specificity/MCC). See docs/BASELINE-COMPARISON.md.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
