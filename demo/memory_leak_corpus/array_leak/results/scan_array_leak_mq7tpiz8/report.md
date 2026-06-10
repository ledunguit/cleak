# Memory Leak Report: scan_array_leak_mq7tpiz8

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
- The malloc at line 8 allocates the array of pointers (char **arr). This array is always freed: in error paths (lines 16-17) and in the normal path via free(arr) in cleanup_partial (line 33). The array pointer itself is not leaked. The leak in this code is in the strdup'd strings stored inside the array, not the array container.

```c
char **arr = malloc(count * sizeof(char*));
```

### unknown at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13
- **Verdict**: confirmed_leak
- **Confidence**: 98% (Critical)
- **Allocation type**: strdup
- The strdup at line 13 allocates strings stored in arr[i]. The cleanup function cleanup_partial has a bug: the loop uses i+=2 (line 27), so it only frees even-indexed elements (arr[0], arr[2], arr[4]). Odd-indexed elements (arr[1], arr[3]) are never freed and leak. With count=5, 2 of 5 strdup'd strings leak. The bug is in cleanup_partial's loop stride, not in create_strings itself.
- **Suggested fix**: the duplicated string is never freed before the function exits
- **Root cause**: strdup_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13`
  - Missing free: `unknown @ 13`
  - the duplicated string is never freed before the function exits

```c
arr[i] = strdup(buf);
```
