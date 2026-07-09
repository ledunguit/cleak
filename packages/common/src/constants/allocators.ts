/**
 * Canonical allocator / deallocator function names for C/C++ leak analysis.
 *
 * Single source of truth consumed by:
 *   - apps/static-analyzer  (c-parser.service, ast-scan.service)
 *   - packages/common       (heuristic-leak-analysis)
 */

/** Standard + kernel + glib allocation functions. */
export const ALLOCATION_FUNCTIONS: Set<string> = new Set([
  // ISO / POSIX
  'malloc',
  'calloc',
  'realloc',
  'reallocarray',
  'strdup',
  'strndup',
  'aligned_alloc',
  'valloc',
  'memalign',
  'posix_memalign',
  // x* wrappers (glibc, BSD)
  'xmalloc',
  'xcalloc',
  'xrealloc',
  'xstrdup',
  // Linux kernel
  'kmalloc',
  'kcalloc',
  'kzalloc',
  'vmalloc',
  // GLib
  'g_malloc',
  'g_malloc0',
  'g_strdup',
  // Misc
  'asprintf',
]);

/** Standard + kernel deallocation functions. */
export const DEALLOCATION_FUNCTIONS: Set<string> = new Set([
  'free',
  'xfree',
  'kfree',
  'vfree',
]);

/**
 * Pipe-delimited pattern of all allocation function names, suitable for use
 * inside a `RegExp` alternation: `\\b(ALLOCATION_FN_PATTERN)\\b`.
 */
export const ALLOCATION_FN_PATTERN: string = [...ALLOCATION_FUNCTIONS].join('|');
