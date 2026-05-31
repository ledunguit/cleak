#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Pattern: Double free — free the same pointer twice */

static char *create_item(void) {
    char *item = malloc(64);
    if (!item) return NULL;
    snprintf(item, 64, "item-%d", rand() % 1000);
    return item;
}

static void cleanup_bad(char **ptr, int count) {
    for (int i = 0; i < count; i++) {
        if (ptr[i]) {
            free(ptr[i]);  /* First free */
        }
    }
    /* BUG: frees first element again if count == 1 */
    if (count == 1 && ptr[0]) {
        free(ptr[0]);  /* DOUBLE FREE: same pointer freed again */
    }
}

int main(void) {
    char *items[3];
    items[0] = create_item();
    items[1] = create_item();
    items[2] = NULL;
    printf("%s %s\n", items[0], items[1]);
    cleanup_bad(items, 1);  /* double free on items[0] */
    free(items[1]);
    return 0;
}
