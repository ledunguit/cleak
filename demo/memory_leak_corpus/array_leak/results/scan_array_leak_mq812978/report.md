# Memory Leak Report: scan_array_leak_mq812978

## Summary
- Total candidates: 2
- Confirmed leaks: 1
- Likely leaks: 0
- False positives: 1
- Total bytes lost: 0

### Severity Breakdown
- Critical (≥80%): 2
- High (60-79%): 0
- Medium (40-59%): 0
- Low (<40%): 0

## Findings
### unknown at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:8
- **Verdict**: false_positive
- **Confidence**: 95% (Critical)
- **Allocation type**: malloc
- The malloc at line 8 allocates the outer pointer array `char **arr`. On the error path (strdup failure), `free(arr)` is called at line 17. On the success path, ownership transfers to the caller `main()`, which passes it to `cleanup_partial()`, which calls `free(arr)` at line 33. The array itself is freed on all reachable paths. The leaky allocations are the strdup'd strings inside the array, not the array container.

```c
char **arr = malloc(count * sizeof(char*));
```

### unknown at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13
- **Verdict**: confirmed_leak
- **Confidence**: 98% (Critical)
- **Allocation type**: strdup
- The strdup at line 13 allocates strings into arr[i] in a loop within create_strings(). On the success path, ownership transfers to main(), which calls cleanup_partial(). The cleanup_partial function at line 27 has a bug: its loop increments by 2 (i += 2), so it only frees even-indexed entries (arr[0], arr[2], arr[4]). Odd-indexed entries (arr[1], arr[3]) are never freed, causing a leak of 2 out of 5 strdup'd strings. The code comments explicitly confirm this: "BUG: only frees even-indexed elements" and "arr[1], arr[3], ... LEAK".
- **Suggested fix**: the duplicated string is never freed before the function exits
- **Root cause**: strdup_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13`
  - Missing free: `unknown @ 13`
  - the duplicated string is never freed before the function exits

```c
arr[i] = strdup(buf);
```
