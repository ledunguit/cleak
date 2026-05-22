#ifndef OWNERSHIP_MAZE_QUEUE_H
#define OWNERSHIP_MAZE_QUEUE_H

typedef struct EventNode {
    char *payload;
    struct EventNode *next;
} EventNode;

typedef struct {
    EventNode *head;
    EventNode *tail;
    int size;
    int max_size;
} EventQueue;

void queue_init(EventQueue *queue, int max_size);
int queue_push(EventQueue *queue, const char *payload, int saturate_hint);
char *queue_fanout_clone(const char *payload, int subscriber_enabled);
void queue_destroy_buggy(EventQueue *queue);

#endif
