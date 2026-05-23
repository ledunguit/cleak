#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Node {
    char *name;
    struct Node *next;
} Node;

static Node *node_new(const char *name) {
    Node *n = malloc(sizeof(*n));
    if (n == NULL) return NULL;
    n->name = malloc(strlen(name) + 1);
    if (n->name == NULL) {
        free(n);
        return NULL;
    }
    strcpy(n->name, name);
    n->next = NULL;
    return n;
}

static void list_push(Node **head, const char *name) {
    Node *n = node_new(name);
    if (n == NULL) return;
    n->next = *head;
    *head = n;
}

static void list_destroy_buggy(Node *head) {
    /* Walks the list but frees only the first node.
     * LEAK: remaining nodes survive. */
    if (head == NULL) return;
    free(head->name);
    free(head);
}

int main(void) {
    Node *list = NULL;

    list_push(&list, "second");
    list_push(&list, "first");

    for (Node *cur = list; cur != NULL; cur = cur->next) {
        printf("node: %s\n", cur->name);
    }

    /* Only frees the head node — tail node leaks. */
    list_destroy_buggy(list);

    return 0;
}
