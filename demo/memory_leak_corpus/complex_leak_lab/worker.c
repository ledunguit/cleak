#include "worker.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void overwrite_buffer_leak(void) {
    char *buffer = malloc(32);
    if (buffer == NULL) {
        return;
    }
    strcpy(buffer, "seed");

    buffer = malloc(96);
    if (buffer == NULL) {
        return;
    }
    snprintf(buffer, 96, "second buffer with %s", "new ownership");
    puts(buffer);
    free(buffer);
}

void accumulate_partial_leaks(int count) {
    for (int i = 0; i < count; ++i) {
        char *entry = malloc(48);
        if (entry == NULL) {
            return;
        }
        snprintf(entry, 48, "entry-%d", i);
        if ((i % 2) == 0) {
            continue;
        }
        puts(entry);
        free(entry);
    }
}
