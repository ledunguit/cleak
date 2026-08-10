import { describe, expect, test } from 'vitest';
import { entryToFlaw, PROJECT_ALLOCATORS, PROJECT_DEALLOCATORS, PROJECT_BUILD_COMMANDS, type MemhintEntry } from '../../memhint/ingest';

const entry = (over: Partial<MemhintEntry>): MemhintEntry => ({
  id: 'tmux_e6035495',
  project: 'tmux',
  repo_url: 'https://github.com/tmux/tmux.git',
  file: 'format.c',
  function: 'format_loop_sessions',
  fix_commit: 'e603549563b585966431c9dac324639113e3a30a',
  parent_commit: 'e80e0c761a82fe36a1452ad40ed54a0c09887412',
  github_url: 'https://github.com/tmux/tmux/commit/e603549563b585966431c9dac324639113e3a30a',
  notes: 'free(active)/free(all) missing at function return path.',
  ...over,
});

describe('entryToFlaw', () => {
  test('maps one entry → one CWE-401 flaw, no line', () => {
    expect(entryToFlaw(entry({}))).toEqual({ file: 'format.c', function: 'format_loop_sessions', cwe: 'CWE-401' });
  });
  test('uses the entry\'s own file/function, not hardcoded', () => {
    expect(entryToFlaw(entry({ file: 'x509_lu.c', function: 'obj_ht_foreach_object' }))).toEqual({
      file: 'x509_lu.c',
      function: 'obj_ht_foreach_object',
      cwe: 'CWE-401',
    });
  });
});

describe('per-project maps cover exactly the 6 in-scope projects', () => {
  const projects = ['curl', 'vim', 'tmux', 'redis', 'openssl', 'freerdp'];

  test('PROJECT_BUILD_COMMANDS has an entry for every project', () => {
    for (const p of projects) expect(PROJECT_BUILD_COMMANDS[p]).toBeTruthy();
  });

  test('PROJECT_ALLOCATORS has a non-empty list for every project', () => {
    for (const p of projects) expect(PROJECT_ALLOCATORS[p]?.length).toBeGreaterThan(0);
  });

  test('PROJECT_DEALLOCATORS covers every project except tmux (plain free() suffices)', () => {
    for (const p of projects) {
      if (p === 'tmux') expect(PROJECT_DEALLOCATORS[p]).toBeUndefined();
      else expect(PROJECT_DEALLOCATORS[p]?.length).toBeGreaterThan(0);
    }
  });
});
