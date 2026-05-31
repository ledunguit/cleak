#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Pattern: Nested struct with allocated fields — outer freed, inner leaks */

typedef struct {
    char *key;
    char *value;
} Entry;

typedef struct {
    char *name;
    Entry **entries;
    int count;
} Config;

static Entry *create_entry(const char *key, const char *value) {
    Entry *e = malloc(sizeof(Entry));
    if (!e) return NULL;
    e->key = strdup(key);
    e->value = strdup(value);
    return e;
}

static Config *create_config(const char *name) {
    Config *cfg = malloc(sizeof(Config));
    if (!cfg) return NULL;
    cfg->name = strdup(name);
    cfg->entries = malloc(3 * sizeof(Entry*));
    cfg->count = 3;
    cfg->entries[0] = create_entry("host", "localhost");
    cfg->entries[1] = create_entry("port", "8080");
    cfg->entries[2] = create_entry("debug", "true");
    return cfg;
}

static void destroy_config_bad(Config *cfg) {
    if (!cfg) return;
    free(cfg->name);     /* OK */
    free(cfg->entries);  /* Only frees the array, NOT the Entry structs inside */
    /* LEAK: entries[0..2] with their key/value strdup allocations */
    free(cfg);
}

int main(void) {
    Config *cfg = create_config("myapp");
    printf("Config %s: %d entries\n", cfg->name, cfg->count);
    destroy_config_bad(cfg);  /* leaks all entries */
    return 0;
}
