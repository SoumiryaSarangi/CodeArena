#define _GNU_SOURCE
/* Attack case 03: CPU burn across several threads.
   Tries to start 8 busy threads (more CPU than one core's budget), then burns
   CPU on the main thread as well. The CPU-time limit must end it (TLE); if
   thread creation is refused by the process limit that is reported as BLOCKED
   and the main thread still has to be stopped. */
#include <pthread.h>
#include <stdio.h>

static void *spin(void *arg) {
    (void)arg;
    volatile unsigned long x = 0;
    for (;;) x++;
    return NULL;
}

int main(void) {
    pthread_t t;
    int started = 0;
    for (int i = 0; i < 8; i++) {
        if (pthread_create(&t, NULL, spin, NULL) != 0) {
            printf("BLOCKED thread %d refused\n", i);
            fflush(stdout);
            break;
        }
        started++;
    }
    printf("started %d threads\n", started);
    fflush(stdout);
    volatile unsigned long y = 0;
    for (;;) y++;
}
