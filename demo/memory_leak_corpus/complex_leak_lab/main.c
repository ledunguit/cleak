#include "common.h"
#include "list.h"
#include "parser.h"
#include "worker.h"

#include <stdio.h>
#include <stdlib.h>

int main(void) {
    print_banner("complex leak lab");

    char *ok_message = build_message("alice", 0);
    if (ok_message == NULL) {
        return 1;
    }
    puts(ok_message);
    free(ok_message);

    if (parse_optional_header("#ignored-header") != 0) {
        puts("optional header skipped");
    }

    if (build_message("bob", 1) == NULL) {
        puts("fast-fail branch triggered");
    }

    overwrite_buffer_leak();
    accumulate_partial_leaks(6);

    LeakNode *list = build_demo_list(4);
    destroy_list_buggy(list);

    return 0;
}
