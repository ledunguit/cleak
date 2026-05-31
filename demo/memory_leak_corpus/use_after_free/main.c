#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Pattern: Use-after-free */

typedef struct {
    char *name;
    int id;
} Record;

static Record *create_record(const char *name, int id) {
    Record *r = malloc(sizeof(Record));
    if (!r) return NULL;
    r->name = strdup(name);  /* LEAK if r freed without freeing r->name */
    if (!r->name) { free(r); return NULL; }
    r->id = id;
    return r;
}

static void process_record(Record *r) {
    if (!r) return;
    printf("Processing: %s (%d)\n", r->name, r->id);
    free(r);        /* Frees Record, but r->name leaks */
    /* BUG: use after free */
    if (r->id > 0) {  /* USE-AFTER-FREE: accessing freed memory */
        printf("ID was positive\n");
    }
}

int main(void) {
    Record *r = create_record("test", 42);
    process_record(r);
    return 0;
}
