# Memory Leak Report: scan_ownership_maze_mq86cqp1

## Summary
- Total candidates: 12
- Confirmed leaks: 0
- Likely leaks: 6
- False positives: 0
- Total bytes lost: 0

### Severity Breakdown
- Critical (≥80%): 0
- High (60-79%): 0
- Medium (40-59%): 6
- Low (<40%): 6

## Findings
### session_open at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:8
- **Verdict**: uncertain
- **Confidence**: 30% (Low)
- **Allocation type**: malloc
- Interprocedural leak: `session_open()` returns the allocated `session`; ownership transfers to its caller, which must free it. The caller was not found in this file. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:8 (`session`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in session_open is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
- **Root cause**: interprocedural_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:8`
  - Missing free: `session_open @ 8`
  - `session_open()` returns the allocated `session`; ownership transfers to its caller, which must free it. The caller was not found in this file.

```c
Session *session = malloc(sizeof(*session));
```

### session_open at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:9
- **Verdict**: uncertain
- **Confidence**: 30% (Low)
- **Allocation type**: malloc
- Unknown: `mode_banner` is freed on some paths but may not be released before every exit of session_open(). The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:9 (`mode_banner`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in session_open is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
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
- **Confidence**: 50% (Medium)
- **Allocation type**: malloc
- Early return: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `name` is freed. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:22 (`name`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in session_open is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
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
- **Confidence**: 50% (Medium)
- **Allocation type**: malloc
- Early return: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `cached_route` is freed. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:23 (`cached_route`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in session_open is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
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
- **Verdict**: likely_leak
- **Confidence**: 50% (Medium)
- **Allocation type**: malloc
- Early return: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:33 returns before `request_context` is freed. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:24 (`request_context`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in session_open is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
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
- **Verdict**: likely_leak
- **Confidence**: 50% (Medium)
- **Allocation type**: malloc
- Unknown: `replacement` allocated at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:50 is never freed before session_rename() returns. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:50 (`replacement`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in session_rename is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
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
- **Verdict**: likely_leak
- **Confidence**: 50% (Medium)
- **Allocation type**: malloc
- Unknown: `replacement` allocated at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:66 is never freed before session_replace_route() returns. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:66 (`replacement`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in session_replace_route is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
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
- **Verdict**: uncertain
- **Confidence**: 30% (Low)
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
- **Verdict**: uncertain
- **Confidence**: 30% (Low)
- **Allocation type**: malloc
- Unknown: memory is allocated but no matching free is reached on at least one exit path The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:83 has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in unknown is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
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
