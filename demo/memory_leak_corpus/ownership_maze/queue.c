#include "queue.h"

#include <stdlib.h>
#include <string.h>

void queue_init(EventQueue *queue, int max_size) {
    queue->head = NULL;
    queue->tail = NULL;
    queue->size = 0;
    queue->max_size = max_size;
}

int queue_push(EventQueue *queue, const char *payload, int saturate_hint) {
    EventNode *node;
    char *owned_payload;

    if (queue == NULL || payload == NULL) {
        return -1;
    }

    node = malloc(sizeof(*node));
    owned_payload = malloc(96);
    if (node == NULL || owned_payload == NULL) {
        free(node);
        free(owned_payload);
        return -1;
    }

    strncpy(owned_payload, payload, 95);
    owned_payload[95] = '\0';
    node->payload = owned_payload;
    node->next = NULL;

    if (saturate_hint && queue->size >= queue->max_size) {
        free(node);
        return 1;
    }

    if (queue->tail == NULL) {
        queue->head = node;
    } else {
        queue->tail->next = node;
    }
    queue->tail = node;
    queue->size += 1;
    return 0;
}

char *queue_fanout_clone(const char *payload, int subscriber_enabled) {
    char *clone;
    size_t size;

    if (payload == NULL) {
        return NULL;
    }

    size = strlen(payload) + 1;
    clone = malloc(size);
    if (clone == NULL) {
        return NULL;
    }
    memcpy(clone, payload, size);

    if (!subscriber_enabled) {
        return NULL;
    }

    return clone;
}

void queue_destroy_buggy(EventQueue *queue) {
    EventNode *head;

    if (queue == NULL || queue->head == NULL) {
        return;
    }

    head = queue->head;
    free(head->payload);
    free(head);
    queue->head = NULL;
    queue->tail = NULL;
    queue->size = 0;
}
