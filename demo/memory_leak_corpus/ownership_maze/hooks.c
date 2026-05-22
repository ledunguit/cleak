#include "hooks.h"

#include <stdio.h>
#include <stdlib.h>

typedef struct {
    char tag[32];
    int armed;
} HookContext;

int hook_accept(const char *tag) {
    return tag != NULL && tag[0] != '\0';
}

int hook_reject(const char *tag) {
    (void)tag;
    return 0;
}

int register_hook_context(const char *tag, HookValidator validator) {
    HookContext *ctx;

    if (tag == NULL || validator == NULL) {
        return -1;
    }

    ctx = malloc(sizeof(*ctx));
    if (ctx == NULL) {
        return -1;
    }

    ctx->armed = 1;
    snprintf(ctx->tag, sizeof(ctx->tag), "%s", tag);

    if (!validator(tag)) {
        return 1;
    }

    free(ctx);
    return 0;
}
