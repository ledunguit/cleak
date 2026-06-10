# Memory Leak Report: scan_array_leak_mq7w4pns

## Summary
- Total candidates: 2
- Confirmed leaks: 0
- Likely leaks: 0
- False positives: 0
- Total bytes lost: 0

### Severity Breakdown
- Critical (≥80%): 0
- High (60-79%): 0
- Medium (40-59%): 0
- Low (<40%): 2

## Findings
### unknown at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:8
- **Verdict**: uncertain
- **Confidence**: 30% (Low)
- **Allocation type**: malloc
- Interprocedural leak: `unknown()` returns the allocated `arr`; ownership transfers to its caller, which must free it. The caller was not found in this file. The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:8 (`arr`) has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via malloc in unknown is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
- **Root cause**: interprocedural_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:8`
  - Missing free: `unknown @ 8`
  - `unknown()` returns the allocated `arr`; ownership transfers to its caller, which must free it. The caller was not found in this file.

```c
char **arr = malloc(count * sizeof(char*));
```

### unknown at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13
- **Verdict**: uncertain
- **Confidence**: 30% (Low)
- **Allocation type**: strdup
- Strdup leak: the duplicated string is never freed before the function exits The allocation at /Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13 has no matching free on the leaking path.
- **Suggested fix**: Ensure the object allocated via strdup in unknown is released on every exit path. Add cleanup before each return or route ownership to a caller that clearly frees it.
- **Root cause**: strdup_leak
  - Allocation site: `/Users/zed/Master/leak-investigator/demo/memory_leak_corpus/array_leak/main.c:13`
  - Missing free: `unknown @ 13`
  - the duplicated string is never freed before the function exits

```c
arr[i] = strdup(buf);
```
