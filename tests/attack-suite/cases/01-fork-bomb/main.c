#define _GNU_SOURCE
/* Attack case 01: process flood ("fork bomb", bounded).
   Tries to create many processes. The sandbox must stop this, either by
   refusing fork() (process limit) or by killing the box. The loop is capped so
   a stray run outside the sandbox cannot take a machine down; children just
   park themselves and are reaped by the box teardown. */
#include <errno.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    int made = 0;
    for (int i = 0; i < 5000; i++) {
        pid_t p = fork();
        if (p < 0) {
            printf("BLOCKED fork failed after %d children: errno=%d\n", made, errno);
            fflush(stdout);
            return 0;
        }
        if (p == 0) {
            for (;;) pause();
        }
        made++;
    }
    printf("ESCAPED created %d processes\n", made);
    fflush(stdout);
    return 0;
}
