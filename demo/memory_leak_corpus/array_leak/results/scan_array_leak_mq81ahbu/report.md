# Memory Leak Report: scan_array_leak_mq81ahbu

## Summary
- Total candidates: 2
- Confirmed leaks: 1
- Likely leaks: 0
- False positives: 1
- Total bytes lost: 20

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
- The malloc at line 8 allocates the pointer array container. This container IS freed on all paths: (1) Normal path — cleanup_partial() calls free(arr) as its last statement. (2) Error path in create_strings — if strdup fails, the error handler frees all previously allocated entries then calls free(arr). The malloc'd container itself is not leaked; only the strdup'd string elements at odd indices leak (covered by the other candidate).
- **Evidence (1)**:
  - lsan: unknown (0 bytes lost)

```c
char **arr = malloc(count * sizeof(char*));
```

### unknown at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13
- **Verdict**: confirmed_leak
- **Confidence**: 100% (Critical)
- **Allocation type**: strdup
- The strdup at line 13 in create_strings() allocates strings stored in arr[i]. These are passed to cleanup_partial() in main(), which only frees even-indexed elements (loop uses i += 2). Odd-indexed elements (arr[1], arr[3]) are never freed — their pointers are lost when free(arr) destroys the container. With count=5, this leaks 2 of 5 strdup'd strings on every normal execution path. Confirmed by LeakSanitizer.
- **Suggested fix**: the duplicated string is never freed before the function exits
- **Root cause**: strdup_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13`
  - Missing free: `unknown @ 13`
  - the duplicated string is never freed before the function exits
- **Evidence (1)**:
  - lsan: unknown (20 bytes lost)

```c
arr[i] = strdup(buf);
```
