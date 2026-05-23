#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Functions that transfer ownership to the caller.
 * The caller is responsible for freeing the result. */

static char *load_config_value(const char *key) {
    char *value = malloc(64);
    if (value == NULL) return NULL;
    snprintf(value, 64, "value-for-%s", key);
    return value; /* ownership transferred */
}

static char *flatten_path(const char *base, const char *suffix) {
    size_t len = strlen(base) + strlen(suffix) + 2;
    char *result = malloc(len);
    if (result == NULL) return NULL;
    snprintf(result, len, "%s/%s", base, suffix);
    return result; /* ownership transferred */
}

int main(void) {
    /* LEAK 1: config_value returned but never freed */
    char *config_value = load_config_value("timeout");
    printf("config: %s\n", config_value);

    /* LEAK 2: path returned but never freed */
    char *path = flatten_path("/var/log", "app.log");
    printf("path: %s\n", path);

    /* Control: this one IS freed */
    char *ctrl = load_config_value("debug");
    if (ctrl) {
        printf("debug: %s\n", ctrl);
        free(ctrl);
    }

    return 0;
}
