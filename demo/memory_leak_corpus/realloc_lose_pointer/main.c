#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* realloc() can return NULL.  When it does, the original pointer
 * is still live — assigning p = realloc(p, ...) without a temp
 * variable leaks the original allocation. */

static char *grow_buffer(char *old, size_t old_sz, size_t new_sz) {
    /* LEAK 1: direct reassign realloc without NULL check:
     * if realloc fails, old pointer is lost. */
    old = realloc(old, new_sz);
    if (old == NULL) {
        return NULL;
    }
    memset(old + old_sz, 0, new_sz - old_sz);
    return old;
}

int main(void) {
    char *buf = malloc(16);
    if (buf == NULL) return 1;
    strcpy(buf, "hello");

    buf = grow_buffer(buf, 16, 1024 * 1024);
    if (buf == NULL) return 1;

    puts(buf);
    free(buf);
    return 0;
}
