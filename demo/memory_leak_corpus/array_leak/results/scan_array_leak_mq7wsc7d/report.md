# Memory Leak Report: scan_array_leak_mq7wsc7d

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
- The malloc at line 8 allocates the array container `char **arr`. This container is freed on all paths: (1) on the strdup-failure error path, `free(arr)` is called at line 17 before returning NULL; (2) on the success path, ownership is transferred to the caller via `return arr` at line 21, and the caller (`main`) invokes `cleanup_partial()` which frees `arr` at line 33. The real leak is in the strdup'd elements stored inside the array (odd indices), not the array container itself.

```c
char **arr = malloc(count * sizeof(char*));
```

### unknown at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13
- **Verdict**: confirmed_leak
- **Confidence**: 97% (Critical)
- **Allocation type**: strdup
- The strdup at line 13 allocates strings stored in `arr[i]`. On the success path, `create_strings` returns the array to `main()`, which calls `cleanup_partial()`. However, `cleanup_partial` has a bug: its loop increments by 2 (`i += 2`), so it only frees even-indexed elements (arr[0], arr[2], arr[4]). Odd-indexed elements (arr[1], arr[3]) are never freed, causing a memory leak of 2 out of 5 strdup'd strings. The function comment explicitly states this: "BUG: only frees even-indexed elements". For count=5, this leaks the strings at indices 1 and 3.
- **Suggested fix**: the duplicated string is never freed before the function exits
- **Root cause**: strdup_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13`
  - Missing free: `unknown @ 13`
  - the duplicated string is never freed before the function exits

```c
arr[i] = strdup(buf);
```
