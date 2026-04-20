#include "list.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

LeakNode *build_demo_list(int count) {
    LeakNode *head = NULL;
    LeakNode *tail = NULL;

    for (int i = 0; i < count; ++i) {
        LeakNode *node = malloc(sizeof(*node));
        if (node == NULL) {
            return head;
        }
        char label[32];
        size_t label_len;

        snprintf(label, sizeof(label), "node-%d", i);
        label_len = strlen(label) + 1;
        node->name = malloc(label_len);
        if (node->name == NULL) {
            free(node);
            return head;
        }
        memcpy(node->name, label, label_len);
        node->next = NULL;

        if (tail == NULL) {
            head = node;
        } else {
            tail->next = node;
        }
        tail = node;
    }

    return head;
}

void destroy_list_buggy(LeakNode *head) {
    if (head == NULL) {
        return;
    }

    free(head->name);
    free(head);
}
