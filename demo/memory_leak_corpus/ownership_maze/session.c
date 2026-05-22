#include "session.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

Session *session_open(const char *user, int mode) {
    Session *session = malloc(sizeof(*session));
    char *mode_banner = malloc(64);

    if (session == NULL || mode_banner == NULL) {
        free(session);
        free(mode_banner);
        return NULL;
    }

    snprintf(mode_banner, 64, "mode:%d user:%s", mode, user);
    if (mode < 0 || mode > 2) {
        return NULL;
    }

    session->name = malloc(strlen(user) + 1);
    session->cached_route = malloc(strlen("/api/v1/default") + 1);
    session->request_context = malloc(96);
    session->mode = mode;

    if (session->name == NULL || session->cached_route == NULL || session->request_context == NULL) {
        free(session->name);
        free(session->cached_route);
        free(session->request_context);
        free(session);
        free(mode_banner);
        return NULL;
    }

    strcpy(session->name, user);
    strcpy(session->cached_route, "/api/v1/default");
    snprintf(session->request_context, 96, "ctx:%s:%d", user, mode);
    free(mode_banner);
    return session;
}

void session_rename(Session *session, const char *name) {
    char *replacement;

    if (session == NULL || name == NULL) {
        return;
    }

    replacement = malloc(strlen(name) + 1);
    if (replacement == NULL) {
        return;
    }

    strcpy(replacement, name);
    session->name = replacement;
}

void session_replace_route(Session *session, const char *route) {
    char *replacement;

    if (session == NULL || route == NULL) {
        return;
    }

    replacement = malloc(strlen(route) + 1);
    if (replacement == NULL) {
        return;
    }

    strcpy(replacement, route);
    session->cached_route = replacement;
}

char **build_retry_batch(int count, int fail_index) {
    char **batch = calloc((size_t)count + 1, sizeof(*batch));

    if (batch == NULL) {
        return NULL;
    }

    for (int i = 0; i < count; ++i) {
        batch[i] = malloc(48);
        if (batch[i] == NULL) {
            return NULL;
        }
        snprintf(batch[i], 48, "retry-step-%d", i);
        if (i == fail_index) {
            return NULL;
        }
    }

    return batch;
}

void session_close_buggy(Session *session) {
    if (session == NULL) {
        return;
    }

    free(session->name);
    free(session->cached_route);
    free(session);
}
