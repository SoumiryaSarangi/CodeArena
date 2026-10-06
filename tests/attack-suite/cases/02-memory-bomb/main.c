#define _GNU_SOURCE
/* Attack case 02: memory bomb.
   Allocates and touches far more memory than the box allows (limit 256 MB).
   The cgroup must kill it (MLE) or the allocation must fail. Capped at 1 GB so
   a stray run outside the sandbox stays survivable. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
    const size_t chunk = 1 << 20;
    size_t total = 0;
    for (int i = 0; i < 1024; i++) {
        char *p = malloc(chunk);
        if (!p) {
            printf("BLOCKED allocation refused at %zu MB\n", total >> 20);
            fflush(stdout);
            return 0;
        }
        memset(p, 0xA5, chunk); /* touch every page so it is really resident */
        total += chunk;
    }
    printf("ESCAPED touched %zu MB\n", total >> 20);
    fflush(stdout);
    return 0;
}
