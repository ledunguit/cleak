# Memory Leak Report: scan_ownership_maze_mq8aehiw

## Summary
- Total candidates: 12
- Confirmed leaks: 12
- Likely leaks: 0
- False positives: 0
- Total bytes lost: 0

### Severity Breakdown
- Critical (≥80%): 12
- High (60-79%): 0
- Medium (40-59%): 0
- Low (<40%): 0

## Findings
### session_open at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:8
- **Verdict**: confirmed_leak
- **Confidence**: 90% (Critical)
- **Allocation type**: malloc
- In session_open(), session is allocated at line 8. When mode < 0 || mode > 2 (line 18-19), the function returns NULL without freeing session or mode_banner. In main.c, session_open("warmup", 99) triggers this path, leaking the session struct.
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
- In session_open(), mode_banner is allocated at line 9. When mode < 0 || mode > 2 (line 18-19), the function returns NULL without freeing session or mode_banner. In main.c, session_open("warmup", 99) triggers this path, leaking mode_banner.
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
- **Verdict**: confirmed_leak
- **Confidence**: 85% (Critical)
- **Allocation type**: malloc
- session->name is allocated at line 22. session_rename() overwrites session->name with a new allocation without freeing the old one. In main.c, session_rename is called twice ("alice", then "alice-admin"), leaking both the original name from session_open and the intermediate "alice" allocation. session_close_buggy only frees the final value.
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
- **Verdict**: confirmed_leak
- **Confidence**: 85% (Critical)
- **Allocation type**: malloc
- session->cached_route is allocated at line 23. session_replace_route() overwrites session->cached_route with a new allocation without freeing the old one. In main.c, session_replace_route is called twice, leaking the original "/api/v1/default" and the intermediate "/api/v1/bootstrap". session_close_buggy only frees the final value.
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
- session->request_context is allocated at line 24. session_close_buggy() frees session->name, session->cached_route, and session itself, but NEVER frees session->request_context. This is a definite leak on every successful session_open path.
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
- **Confidence**: 90% (Critical)
- **Allocation type**: malloc
- In session_rename(), a new string is malloc'd at line 50 and assigned to session->name without freeing the previous session->name. This is a classic pointer-overwrite leak. Called twice in main.c ("alice" then "alice-admin"), each call leaks the previous name.
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
- **Confidence**: 90% (Critical)
- **Allocation type**: malloc
- In session_replace_route(), a new string is malloc'd at line 66 and assigned to session->cached_route without freeing the previous value. This is a classic pointer-overwrite leak. Called twice in main.c, each call leaks the previous route string.
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
- **Confidence**: 90% (Critical)
- **Allocation type**: calloc
- In build_retry_batch(), the batch array is calloc'd at line 76. On early-return paths (batch[i]==NULL or i==fail_index), the function returns NULL without freeing the batch array or any previously allocated batch[i] entries. In main.c, build_retry_batch(5, 3) leaks the batch array and batch[0..2].
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
- **Confidence**: 90% (Critical)
- **Allocation type**: malloc
- In build_retry_batch(), each batch[i] is malloc'd at line 83. When i==fail_index, the function returns NULL without freeing any batch[i] entries already allocated. In main.c, build_retry_batch(5, 3) leaks batch[0], batch[1], and batch[2] (3 allocations of 48 bytes each).
- **Suggested fix**: memory is allocated but no matching free is reached on at least one exit path
- **Root cause**: unknown
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/session.c:83`
  - Missing free: `unknown @ 83`
  - memory is allocated but no matching free is reached on at least one exit path

```c
batch[i] = malloc(48);
```

### queue_push at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/queue.c:21
- **Verdict**: confirmed_leak
- **Confidence**: 85% (Critical)
- **Allocation type**: malloc
- In queue_push(), node is malloc'd at line 21 and owned_payload at line 22. On the saturation path (saturate_hint && size >= max_size), node is freed at line 35 but owned_payload is NOT freed — leak. Additionally, queue_destroy_buggy() only frees the head node, so the second node (job-1) and its payload are also leaked. Both the node and payload allocations at lines 21-22 have leak instances.
- **Suggested fix**: `node` is freed on some paths but may not be released before every exit of queue_push().
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
- **Verdict**: confirmed_leak
- **Confidence**: 90% (Critical)
- **Allocation type**: malloc
- In queue_fanout_clone(), clone is malloc'd at line 58. When subscriber_enabled is 0 (falsy), the function returns NULL at line 64 without freeing clone. In main.c, queue_fanout_clone("replicate-b", 0) triggers this path, leaking the clone allocation.
- **Suggested fix**: `queue_fanout_clone()` returns the allocated `clone`; ownership transfers to its caller, which must free it. The caller was not found in this file.
- **Root cause**: interprocedural_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/queue.c:58`
  - Missing free: `queue_fanout_clone @ 58`
  - `queue_fanout_clone()` returns the allocated `clone`; ownership transfers to its caller, which must free it. The caller was not found in this file.

```c
clone = malloc(size);
```

### register_hook_context at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c:27
- **Verdict**: confirmed_leak
- **Confidence**: 90% (Critical)
- **Allocation type**: malloc
- In register_hook_context(), ctx is malloc'd at line 27. When the validator returns 0 (falsy), the function returns 1 at line 38 without freeing ctx. hook_reject always returns 0. In main.c, register_hook_context("cleanup", hook_reject) leaks ctx.
- **Suggested fix**: The early exit at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/ownership_maze/hooks.c:36 returns before `ctx` is freed.
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
