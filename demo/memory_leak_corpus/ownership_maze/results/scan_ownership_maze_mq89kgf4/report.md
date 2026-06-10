# Memory Leak Report: scan_ownership_maze_mq89kgf4

## Summary
- Total candidates: 12
- Confirmed leaks: 7
- Likely leaks: 3
- False positives: 0
- Total bytes lost: 0

### Severity Breakdown
- Critical (≥80%): 7
- High (60-79%): 2
- Medium (40-59%): 1
- Low (<40%): 2

## Findings
### session_open at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:8
- **Verdict**: confirmed_leak
- **Confidence**: 90% (Critical)
- **Allocation type**: malloc
- In session_open(), line 8 allocates session = malloc(sizeof(*session)). If mode < 0 || mode > 2 (line 18), the function returns NULL at line 19 without freeing session or mode_banner. This is a clear memory leak on that error path.
- **Suggested fix**: `session_open()` returns the allocated `session`; ownership transfers to its caller, which must free it. The caller was not found in this file.
- **Root cause**: interprocedural_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:8`
  - Missing free: `session_open @ 8`
  - `session_open()` returns the allocated `session`; ownership transfers to its caller, which must free it. The caller was not found in this file.

```c
Session *session = malloc(sizeof(*session));
```

### session_open at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:9
- **Verdict**: confirmed_leak
- **Confidence**: 90% (Critical)
- **Allocation type**: malloc
- In session_open(), line 9 allocates mode_banner = malloc(64). If mode < 0 || mode > 2 (line 18), the function returns NULL at line 19 without freeing session or mode_banner. This is a clear memory leak on that error path.
- **Suggested fix**: `mode_banner` is freed on some paths but may not be released before every exit of session_open().
- **Root cause**: unknown
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
- **Verdict**: likely_leak
- **Confidence**: 75% (High)
- **Allocation type**: malloc
- In session_open(), line 22 allocates session->name. Within session_open, the NULL-check error path properly frees it. However, session_rename() (line 50) overwrites session->name without freeing the old value, so the original allocation can be leaked if session_rename is ever called. session_close_buggy does free session->name, so if session_rename is never called, it is properly freed. This is a likely leak due to the overwrite pattern in session_rename.
- **Suggested fix**: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `name` is freed.
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
- **Verdict**: likely_leak
- **Confidence**: 75% (High)
- **Allocation type**: malloc
- In session_open(), line 23 allocates session->cached_route. Within session_open, the NULL-check error path properly frees it. However, session_replace_route() (line 66) overwrites session->cached_route without freeing the old value, so the original allocation can be leaked if session_replace_route is ever called. session_close_buggy does free session->cached_route, so if session_replace_route is never called, it is properly freed. This is a likely leak due to the overwrite pattern in session_replace_route.
- **Suggested fix**: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `cached_route` is freed.
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
- In session_open(), line 24 allocates session->request_context = malloc(96). The session_close_buggy() function (line 83) frees session->name, session->cached_route, and session, but does NOT free session->request_context. This is a confirmed memory leak whenever a session is closed.
- **Suggested fix**: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `request_context` is freed.
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
- **Confidence**: 95% (Critical)
- **Allocation type**: malloc
- In session_rename(), line 50 allocates replacement = malloc(strlen(name) + 1). After copying the new name, line 58 assigns session->name = replacement without freeing the old session->name. The old name string is leaked every time session_rename() is called.
- **Suggested fix**: `replacement` allocated at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:50 is never freed before session_rename() returns.
- **Root cause**: unknown
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
- **Confidence**: 95% (Critical)
- **Allocation type**: malloc
- In session_replace_route(), line 66 allocates replacement = malloc(strlen(route) + 1). After copying the new route, line 74 assigns session->cached_route = replacement without freeing the old session->cached_route. The old cached_route string is leaked every time session_replace_route() is called.
- **Suggested fix**: `replacement` allocated at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:66 is never freed before session_replace_route() returns.
- **Root cause**: unknown
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
- In build_retry_batch() (line 76), batch = calloc(count + 1, sizeof(*batch)). Two leak paths: (1) If any batch[i] = malloc(48) fails (line 83), the function returns NULL without freeing the already-allocated batch array and any previously allocated batch[i] entries. (2) If i == fail_index (line 88), the function returns NULL without freeing batch or any batch[i] entries. Both paths leak the calloc'd batch array and all previously allocated string entries.
- **Suggested fix**: `session_replace_route()` returns the allocated `batch`; ownership transfers to its caller, which must free it. The caller was not found in this file.
- **Root cause**: interprocedural_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:76`
  - Missing free: `session_replace_route @ 76`
  - `session_replace_route()` returns the allocated `batch`; ownership transfers to its caller, which must free it. The caller was not found in this file.

```c
char **batch = calloc((size_t)count + 1, sizeof(*batch));
```

### unknown at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:83
- **Verdict**: confirmed_leak
- **Confidence**: 95% (Critical)
- **Allocation type**: malloc
- In build_retry_batch() (line 83), batch[i] = malloc(48). Two leak paths: (1) If any subsequent batch[j] allocation fails, the function returns NULL without freeing the current batch[i] or any previously allocated entries. (2) If i == fail_index (line 88), the function returns NULL immediately without freeing batch[i] or any previously allocated entries. Each batch[i] entry leaks on these error paths.
- **Suggested fix**: memory is allocated but no matching free is reached on at least one exit path
- **Root cause**: unknown
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:83`
  - Missing free: `unknown @ 83`
  - memory is allocated but no matching free is reached on at least one exit path

```c
batch[i] = malloc(48);
```

### queue_push at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/queue.c:21
- **Verdict**: uncertain
- **Confidence**: 30% (Low)
- **Allocation type**: malloc
- Unknown: `node` is freed on some paths but may not be released before every exit of queue_push(). The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/queue.c:21 (`node`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in queue_push is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
- **Root cause**: unknown
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
- **Verdict**: uncertain
- **Confidence**: 30% (Low)
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
- **Verdict**: likely_leak
- **Confidence**: 50% (Medium)
- **Allocation type**: malloc
- Early return: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c:36 returns before `ctx` is freed. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c:27 (`ctx`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in register_hook_context is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
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
