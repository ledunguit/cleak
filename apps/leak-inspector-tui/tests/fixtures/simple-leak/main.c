#include <stdio.h>
#include <stdlib.h>

static char *make_buffer(size_t size) {
    char *buf = malloc(size);
    if (buf == NULL) {
        return NULL;
    }
    buf[0] = '\0';
    return buf;
}

int main(void) {
    char *buf = make_buffer(64);
    if (buf == NULL) {
        return 1;
    }

    puts("demo leak");
    return 0;
}
