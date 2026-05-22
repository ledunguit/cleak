#include "hooks.h"
#include "queue.h"
#include "session.h"

#include <stdio.h>
#include <stdlib.h>

static void consume_batch(char **batch, int count) {
    for (int i = 0; i < count; ++i) {
        if (batch == NULL || batch[i] == NULL) {
            break;
        }
        puts(batch[i]);
        free(batch[i]);
    }
    free(batch);
}

int main(int argc, char **argv) {
    EventQueue queue;
    Session *session;
    char **ok_batch;
    char *clone_a;
    char *clone_b;

    (void)argc;
    (void)argv;

    puts("== ownership maze ==");

    if (session_open("warmup", 99) == NULL) {
        puts("invalid session mode rejected");
    }

    session = session_open("operator", 1);
    if (session == NULL) {
        return 1;
    }

    session_rename(session, "alice");
    session_rename(session, "alice-admin");
    session_replace_route(session, "/api/v1/bootstrap");
    session_replace_route(session, "/api/v1/tasks");

    register_hook_context("preflight", hook_accept);
    register_hook_context("cleanup", hook_reject);

    ok_batch = build_retry_batch(3, -1);
    consume_batch(ok_batch, 3);
    build_retry_batch(5, 3);

    queue_init(&queue, 2);
    queue_push(&queue, "job-0", 0);
    queue_push(&queue, "job-1", 0);
    queue_push(&queue, "job-2", 1);

    clone_a = queue_fanout_clone("replicate-a", 1);
    clone_b = queue_fanout_clone("replicate-b", 0);
    if (clone_a != NULL) {
        puts(clone_a);
        free(clone_a);
    }
    if (clone_b == NULL) {
        puts("disabled subscriber dropped its clone");
    }

    queue_destroy_buggy(&queue);
    session_close_buggy(session);
    return 0;
}
