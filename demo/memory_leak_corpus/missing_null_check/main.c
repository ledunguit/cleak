#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Pattern: Missing NULL check after allocation + null deref risk */

typedef struct {
    char *buffer;
    int size;
} Buffer;

static Buffer *create_buffer(int size) {
    Buffer *b = malloc(sizeof(Buffer));
    b->size = size;
    b->buffer = malloc(size);  /* No NULL check on b->buffer */
    snprintf(b->buffer, size, "buffer-%d", size);
    return b;
}

static void process_data(const char *input) {
    char *copy = malloc(strlen(input) + 1);  /* No NULL check */
    strcpy(copy, input);  /* NULL deref risk */
    printf("DATA: %s\n", copy);
    free(copy);
}

int main(void) {
    Buffer *b = create_buffer(1024);
    printf("Buffer: %s\n", b->buffer);
    process_data("hello");
    free(b->buffer);
    free(b);
    return 0;
}
