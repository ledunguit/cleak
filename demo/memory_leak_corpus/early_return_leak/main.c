#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *duplicate_or_die(const char *src) {
    char *copy = malloc(strlen(src) + 1);
    if (copy == NULL) {
        return NULL;
    }
    strcpy(copy, src);
    return copy;
}

static char *build_label(int id) {
    char buf[64];
    snprintf(buf, sizeof(buf), "label-%d", id);
    char *label = malloc(strlen(buf) + 1);
    if (label == NULL) {
        return NULL;
    }
    strcpy(label, buf);
    return label;
}

static char *process(int flag) {
    char *data = malloc(128);
    if (data == NULL) return NULL;

    if (flag < 0) {
        return NULL;              /* LEAK 1: early return without freeing data */
    }

    if (flag > 100) {
        free(data);
        return NULL;
    }

    snprintf(data, 128, "processed-%d", flag);
    return data;
}

int main(void) {
    char *a = duplicate_or_die("hello"); /* allocated, freed → OK */
    char *b = build_label(42);           /* LEAK 1: never freed */
    char *c = process(-5);              /* LEAK 2: early return leaks data */

    puts(a ? a : "null");
    puts(b ? b : "null");
    puts(c ? c : "null");

    free(a);
    free(c);

    return 0;
}
