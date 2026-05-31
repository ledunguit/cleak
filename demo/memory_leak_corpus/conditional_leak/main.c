#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *conditional_process(int flag) {
    char *data = NULL;

    if (flag > 0) {
        data = malloc(512);
        if (!data) return NULL;
        snprintf(data, 512, "positive-%d", flag);
        free(data);
        return strdup("ok");
    } else if (flag < 0) {
        data = malloc(512);
        if (!data) return NULL;
        snprintf(data, 512, "negative-%d", flag);
        return data;  /* LEAK: allocated but returned, caller must free */
    }
    return strdup("zero");
}

int main(void) {
    char *r1 = conditional_process(42);
    char *r2 = conditional_process(-5);  /* r2 leaks */
    char *r3 = conditional_process(0);
    printf("%s %s %s\n", r1 ? r1 : "n", r2 ? r2 : "n", r3 ? r3 : "n");
    free(r1);
    free(r3);
    return 0;
}
