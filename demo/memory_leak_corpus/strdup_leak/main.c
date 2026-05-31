#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Pattern: strdup() results never freed */

static char *get_message(int id) {
    char buf[128];
    snprintf(buf, sizeof(buf), "msg-%d", id);
    char *msg = strdup(buf);  /* LEAK: strdup allocates via malloc */
    if (!msg) return NULL;
    return msg;  /* caller must free */
}

static void process_msg(const char *input) {
    char *copy = strdup(input);  /* LEAK: never freed */
    if (!copy) return;
    printf("Processing: %s\n", copy);
    /* copy leaks */
}

int main(void) {
    char *msg = get_message(42);
    printf("MSG: %s\n", msg);
    process_msg("hello world");
    free(msg);
    return 0;
}
