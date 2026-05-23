#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    char *name;
    char *description;
    char *tag;
} Record;

static Record *record_new(const char *name, const char *desc, const char *tag) {
    Record *r = malloc(sizeof(*r));
    if (r == NULL) return NULL;

    r->name = malloc(strlen(name) + 1);
    r->description = malloc(strlen(desc) + 1);
    r->tag = malloc(strlen(tag) + 1);
    if (r->name == NULL || r->description == NULL || r->tag == NULL) {
        free(r->name);
        free(r->description);
        free(r->tag);
        free(r);
        return NULL;
    }

    strcpy(r->name, name);
    strcpy(r->description, desc);
    strcpy(r->tag, tag);
    return r;
}

static void record_free_buggy(Record *r) {
    if (r == NULL) return;
    free(r->name);
    free(r->description);
    /* LEAK 1: r->tag is never freed */
    /* LEAK 2: r itself is never freed */
}

int main(void) {
    Record *r = record_new("test", "a long description string", "important");
    Record *s = record_new("second", "another description", "minor");

    if (r == NULL || s == NULL) return 1;

    printf("Record: %s — %s [%s]\n", r->name, r->description, r->tag);
    printf("Record: %s — %s [%s]\n", s->name, s->description, s->tag);

    record_free_buggy(r);          /* partial free: tag + struct leak */
    free(s->name);
    free(s->description);
    free(s->tag);
    free(s);                       /* proper free for s */

    return 0;
}
