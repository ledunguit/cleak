#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NUM_ROUNDS 5

int main(void) {
    /* Each iteration overwrites the pointer without freeing the
     * previous allocation.  LEAK 1–5: one per loop iteration. */
    for (int i = 0; i < NUM_ROUNDS; ++i) {
        char *record = malloc(64);
        if (record == NULL) return 1;
        snprintf(record, 64, "round-%d", i);
        /* record goes out of scope — previous round's allocation
         * is unreachable. */
    }

    /* This allocation is freed — not a leak, included as control. */
    char *epilogue = malloc(32);
    if (epilogue == NULL) return 1;
    strcpy(epilogue, "done");
    puts(epilogue);
    free(epilogue);

    return 0;
}
