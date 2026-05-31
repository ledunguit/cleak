#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Pattern: Array of allocated pointers — only some freed */

static char **create_strings(int count) {
    char **arr = malloc(count * sizeof(char*));
    if (!arr) return NULL;
    for (int i = 0; i < count; i++) {
        char buf[32];
        snprintf(buf, sizeof(buf), "str-%d", i);
        arr[i] = strdup(buf);
        if (!arr[i]) {
            /* Partial cleanup on failure — some entries leak */
            for (int j = 0; j < i; j++) free(arr[j]);
            free(arr);
            return NULL;
        }
    }
    return arr;
}

static void cleanup_partial(char **arr, int count) {
    /* BUG: only frees even-indexed elements */
    for (int i = 0; i < count; i += 2) {
        if (arr[i]) {
            free(arr[i]);       /* Frees arr[0], arr[2], ... */
            arr[i] = NULL;
        }
    }
    /* arr[1], arr[3], ... LEAK */
    free(arr);
}

int main(void) {
    char **strings = create_strings(5);
    if (!strings) return 1;
    for (int i = 0; i < 5; i++) printf("%s\n", strings[i]);
    cleanup_partial(strings, 5);  /* 3 of 5 entries leak */
    return 0;
}
