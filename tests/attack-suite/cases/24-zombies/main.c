#define _GNU_SOURCE
/* Attack case 24: zombie factory.
   Forks children that exit at once and never reaps them, so they pile up as
   zombies. The process limit must refuse the forks (BLOCKED); whatever does get
   created must be gone once the box is torn down. Capped so a stray run
   outside the sandbox stays survivable. */
#include <errno.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    int made = 0;
    for (int i = 0; i < 5000; i++) {
        pid_t p = fork();
        if (p < 0) {
            printf("BLOCKED fork failed after %d zombies: errno=%d\n", made, errno);
            fflush(stdout);
            return 0;
        }
        if (p == 0) _exit(0);
        made++;
    }
    usleep(200000); /* let them linger unreaped */
    printf("ESCAPED created %d unreaped children\n", made);
    fflush(stdout);
    return 0;
}
