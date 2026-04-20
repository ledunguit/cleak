#ifndef COMPLEX_LEAK_LAB_LIST_H
#define COMPLEX_LEAK_LAB_LIST_H

typedef struct LeakNode {
    char *name;
    struct LeakNode *next;
} LeakNode;

LeakNode *build_demo_list(int count);
void destroy_list_buggy(LeakNode *head);

#endif
