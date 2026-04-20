#include "parser.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

char *build_message(const char *user, int fail_fast) {
    char *message = malloc(128);
    if (message == NULL) {
        return NULL;
    }
    snprintf(message, 128, "hello %s, welcome to the leak lab", user);
    if (fail_fast) {
        return NULL;
    }
    return message;
}

int parse_optional_header(const char *input) {
    char *scratch = malloc(64);
    if (scratch == NULL) {
        return -2;
    }
    strcpy(scratch, "header:");
    if (input == NULL || input[0] == '#') {
        return -1;
    }
    strncat(scratch, input, 64 - strlen(scratch) - 1);
    free(scratch);
    return 0;
}
