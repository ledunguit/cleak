# Memory Leak Report: scan_ownership_maze_mq8b7ykk

## Summary
- Total candidates: 12
- Confirmed leaks: 9
- Likely leaks: 2
- False positives: 1
- Total bytes lost: 0

### Severity Breakdown
- Critical (≥80%): 10
- High (60-79%): 2
- Medium (40-59%): 0
- Low (<40%): 0

## Findings
### session_open at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:8
- **Verdict**: false_positive
- **Confidence**: 90% (Critical)
- **Allocation type**: malloc
- The allocation for session is explicitly freed in the error path (when session or mode_banner is NULL), and in the success path, the pointer is returned to the caller, transferring ownership. Therefore, it is not leaked within session_open(). The static context's 'ownership: malloc_without_free' likely indicates that the malloc does not have a corresponding free in this function but ownership is transferred to the caller, consistent with typical memory management patterns.

```c
Session *session = malloc(sizeof(*session));
```

### session_open at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:9
- **Verdict**: likely_leak
- **Confidence**: 70% (High)
- **Allocation type**: malloc
- Static analysis context indicates 4 leaky exit paths and ownership classified as malloc_without_free, suggesting the session allocation may not be freed in all paths. While the shown error-handling path correctly frees the allocation, other paths through the function are not visible and may leak memory when returning without cleanup.
- **Suggested fix**: `mode_banner` is freed on some paths but may not be released before every exit of session_open().
- **Root cause**: early_return
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:9`
  - Missing free: `session_open @ 40`
  - `mode_banner` is freed on some paths but may not be released before every exit of session_open().

- **Fix diff** (`/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c` @ line 40):
  Free `mode_banner` before the exit at line 40 so every path releases the allocation.
```diff
-     return session;
+     free(mode_banner);
+     return session;
```

```c
char *mode_banner = malloc(64);
```

### session_open at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:22
- **Verdict**: confirmed_leak
- **Confidence**: 95% (Critical)
- **Allocation type**: malloc
- Early return: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `name` is freed. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:22 (`name`) has no matching free on the leaking path.
- **Suggested fix**: Review conditional branches around /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:22. At least one feasible path reaches function exit without hitting the observed free sites (free at line 12, free at line 13, free at line 28, free at line 29, free at line 30, free at line 31, free at line 32, free at line 39). Move cleanup into a shared epilogue or use a single-exit cleanup label.
- **Root cause**: early_return
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:22`
  - Missing free: `session_open @ 33`
  - The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `name` is freed.

- **Fix diff** (`/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c` @ line 33):
  Free `name` before the exit at line 33 so every path releases the allocation.
```diff
-         return NULL;
+         free(name);
+         return NULL;
```

```c
session->name = malloc(strlen(user) + 1);
```

### session_open at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:23
- **Verdict**: confirmed_leak
- **Confidence**: 95% (Critical)
- **Allocation type**: malloc
- Early return: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `cached_route` is freed. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:23 (`cached_route`) has no matching free on the leaking path.
- **Suggested fix**: Review conditional branches around /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:23. At least one feasible path reaches function exit without hitting the observed free sites (free at line 12, free at line 13, free at line 28, free at line 29, free at line 30, free at line 31, free at line 32, free at line 39). Move cleanup into a shared epilogue or use a single-exit cleanup label.
- **Root cause**: early_return
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:23`
  - Missing free: `session_open @ 33`
  - The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `cached_route` is freed.

- **Fix diff** (`/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c` @ line 33):
  Free `cached_route` before the exit at line 33 so every path releases the allocation.
```diff
-         return NULL;
+         free(cached_route);
+         return NULL;
```

```c
session->cached_route = malloc(strlen("/api/v1/default") + 1);
```

### session_open at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:24
- **Verdict**: confirmed_leak
- **Confidence**: 95% (Critical)
- **Allocation type**: malloc
- Early return: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `request_context` is freed. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:24 (`request_context`) has no matching free on the leaking path.
- **Suggested fix**: Review conditional branches around /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:24. At least one feasible path reaches function exit without hitting the observed free sites (free at line 12, free at line 13, free at line 28, free at line 29, free at line 30, free at line 31, free at line 32, free at line 39). Move cleanup into a shared epilogue or use a single-exit cleanup label.
- **Root cause**: early_return
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:24`
  - Missing free: `session_open @ 33`
  - The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `request_context` is freed.

- **Fix diff** (`/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c` @ line 33):
  Free `request_context` before the exit at line 33 so every path releases the allocation.
```diff
-         return NULL;
+         free(request_context);
+         return NULL;
```

```c
session->request_context = malloc(96);
```

### session_rename at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:50
- **Verdict**: confirmed_leak
- **Confidence**: 100% (Critical)
- **Allocation type**: malloc
- Early return: `replacement` allocated at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:50 is never freed before session_rename() returns. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:50 (`replacement`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in session_rename is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
- **Root cause**: early_return
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:50`
  - Missing free: `session_rename @ 52`
  - `replacement` allocated at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:50 is never freed before session_rename() returns.

- **Fix diff** (`/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c` @ line 52):
  Free `replacement` before the exit at line 52 so every path releases the allocation.
```diff
-         return;
+         free(replacement);
+         return;
```

```c
replacement = malloc(strlen(name) + 1);
```

### session_replace_route at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:66
- **Verdict**: confirmed_leak
- **Confidence**: 100% (Critical)
- **Allocation type**: malloc
- Early return: `replacement` allocated at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:66 is never freed before session_replace_route() returns. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:66 (`replacement`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in session_replace_route is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
- **Root cause**: early_return
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:66`
  - Missing free: `session_replace_route @ 68`
  - `replacement` allocated at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:66 is never freed before session_replace_route() returns.

- **Fix diff** (`/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c` @ line 68):
  Free `replacement` before the exit at line 68 so every path releases the allocation.
```diff
-         return;
+         free(replacement);
+         return;
```

```c
replacement = malloc(strlen(route) + 1);
```

### session_replace_route at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:76
- **Verdict**: confirmed_leak
- **Confidence**: 95% (Critical)
- **Allocation type**: calloc
- Interprocedural leak: `session_replace_route()` returns the allocated `batch`; ownership transfers to its caller, which must free it. The caller was not found in this file. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:76 (`batch`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via calloc in session_replace_route is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
- **Root cause**: interprocedural_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:76`
  - Missing free: `session_replace_route @ 76`
  - `session_replace_route()` returns the allocated `batch`; ownership transfers to its caller, which must free it. The caller was not found in this file.

```c
char **batch = calloc((size_t)count + 1, sizeof(*batch));
```

### unknown at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:83
- **Verdict**: likely_leak
- **Confidence**: 70% (High)
- **Allocation type**: malloc
- The allocation occurs in a loop where an early return on malloc failure (line 83 or later) does not free memory allocated in previous iterations, creating a path where allocated memory is not freed before function exit.
- **Suggested fix**: an early return leaves the function before the allocated memory is freed
- **Root cause**: early_return
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:83`
  - Missing free: `unknown @ 83`
  - an early return leaves the function before the allocated memory is freed

```c
batch[i] = malloc(48);
```

### queue_push at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/queue.c:21
- **Verdict**: confirmed_leak
- **Confidence**: 85% (Critical)
- **Allocation type**: malloc
- Static analysis indicates 3 leaky exit paths and ownership described as malloc_without_free. The code only frees the allocation on malloc failure, not on other exit paths, confirming at least one path where the allocation is not freed.
- **Suggested fix**: `node` is freed on some paths but may not be released before every exit of queue_push().
- **Root cause**: early_return
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/queue.c:21`
  - Missing free: `queue_push @ 46`
  - `node` is freed on some paths but may not be released before every exit of queue_push().

- **Fix diff** (`/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/queue.c` @ line 46):
  Free `node` before the exit at line 46 so every path releases the allocation.
```diff
-     return 0;
+     free(node);
+     return 0;
```

```c
node = malloc(sizeof(*node));
```

### queue_fanout_clone at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/queue.c:58
- **Verdict**: confirmed_leak
- **Confidence**: 95% (Critical)
- **Allocation type**: malloc
- Interprocedural leak: `queue_fanout_clone()` returns the allocated `clone`; ownership transfers to its caller, which must free it. The caller was not found in this file. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/queue.c:58 (`clone`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in queue_fanout_clone is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
- **Root cause**: interprocedural_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/queue.c:58`
  - Missing free: `queue_fanout_clone @ 58`
  - `queue_fanout_clone()` returns the allocated `clone`; ownership transfers to its caller, which must free it. The caller was not found in this file.

```c
clone = malloc(size);
```

### register_hook_context at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c:27
- **Verdict**: confirmed_leak
- **Confidence**: 95% (Critical)
- **Allocation type**: malloc
- Early return: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c:36 returns before `ctx` is freed. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c:27 (`ctx`) has no matching free on the leaking path.
- **Suggested fix**: Review conditional branches around /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c:27. At least one feasible path reaches function exit without hitting the observed free sites (free at line 39). Move cleanup into a shared epilogue or use a single-exit cleanup label.
- **Root cause**: early_return
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c:27`
  - Missing free: `register_hook_context @ 36`
  - The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c:36 returns before `ctx` is freed.

- **Fix diff** (`/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c` @ line 36):
  Free `ctx` before the exit at line 36 so every path releases the allocation.
```diff
-         return 1;
+         free(ctx);
+         return 1;
```

```c
ctx = malloc(sizeof(*ctx));
```
