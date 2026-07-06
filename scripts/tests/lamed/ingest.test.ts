import { describe, expect, test } from 'bun:test';
import {
  parseGithubRef,
  bareFunctionName,
  splitTopLevelSemicolons,
  functionsOf,
  entryToFlaws,
  type LamedEntry,
} from '../../lamed/ingest';

describe('parseGithubRef', () => {
  test('parses tree + commit URLs → {repoUrl, sha}', () => {
    expect(parseGithubRef('https://github.com/libsdl-org/libtiff/tree/04118f8a42')).toEqual({
      repoUrl: 'https://github.com/libsdl-org/libtiff.git',
      sha: '04118f8a42',
    });
    expect(parseGithubRef('https://github.com/DaveGamble/cJSON/commit/abc123')!.sha).toBe('abc123');
  });
  test('non-github / malformed → null', () => {
    expect(parseGithubRef('https://example.com/x')).toBeNull();
    expect(parseGithubRef('')).toBeNull();
  });
});

describe('bareFunctionName — handles LAMeD signature quirks', () => {
  test('plain definition → the function name', () => {
    expect(bareFunctionName('static void map_colortable(void)')).toBe('map_colortable');
    expect(bareFunctionName('static cJSON *merge_patch(cJSON *target')).toBe('merge_patch');
  });
  test('skips an ALL-CAPS return-type macro and takes the real function', () => {
    expect(bareFunctionName('CJSON_PUBLIC(char *) cJSONUtils_FindPointerFromObjectTo(const cJSON')).toBe(
      'cJSONUtils_FindPointerFromObjectTo',
    );
  });
  test('a bare name with no parens → itself', () => {
    expect(bareFunctionName('main')).toBe('main');
  });
});

describe('splitTopLevelSemicolons — `;` is overloaded in LAMeD', () => {
  test('top-level `;` separates functions', () => {
    expect(splitTopLevelSemicolons('main; static void f(void)')).toEqual(['main', ' static void f(void)']);
  });
  test('`;` inside parens (LAMeD param separator) does NOT split, even when truncated', () => {
    // truncated mid-params: the `(` is never closed, so depth stays > 0 throughout
    expect(splitTopLevelSemicolons('merge_patch(cJSON *target; const cJSON * const patch; const cJSON_')).toEqual([
      'merge_patch(cJSON *target; const cJSON * const patch; const cJSON_',
    ]);
  });
});

describe('functionsOf', () => {
  test('multi-function entry → both bare names', () => {
    expect(functionsOf('main; static void map_colortable(void)')).toEqual(['main', 'map_colortable']);
  });
  test('single truncated signature with `;` params → ONE function', () => {
    expect(functionsOf('static cJSON *merge_patch(cJSON *target; const cJSON * const patch; const cJSON_')).toEqual([
      'merge_patch',
    ]);
  });
  test('empty target_function → []', () => {
    expect(functionsOf('')).toEqual([]);
    expect(functionsOf('   ')).toEqual([]);
  });
  test('de-duplicates repeated names', () => {
    expect(functionsOf('foo; foo(int x)')).toEqual(['foo']);
  });
});

describe('entryToFlaws', () => {
  const entry = (over: Partial<LamedEntry>): LamedEntry => ({
    project: 'cjson',
    bug_repo_link: 'https://github.com/DaveGamble/cJSON/tree/abc',
    file: 'cJSON_Utils.c',
    target_function: 'static cJSON *merge_patch(cJSON *target',
    commit: 'https://github.com/DaveGamble/cJSON/commit/def',
    fixed_repo_link: '',
    id: 'cjson_abc',
    ...over,
  });

  test('a function entry → one flaw per function, cwe CWE-401, no line', () => {
    const { flaws, fileLevelOnly } = entryToFlaws(entry({}));
    expect(fileLevelOnly).toBe(false);
    expect(flaws).toEqual([{ file: 'cJSON_Utils.c', function: 'merge_patch', cwe: 'CWE-401' }]);
  });

  test('an empty target_function → a single file-level flaw, flagged', () => {
    const { flaws, fileLevelOnly } = entryToFlaws(entry({ target_function: '' }));
    expect(fileLevelOnly).toBe(true);
    expect(flaws).toEqual([{ file: 'cJSON_Utils.c', function: '', cwe: 'CWE-401' }]);
  });
});
