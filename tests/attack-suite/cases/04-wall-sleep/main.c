#define _GNU_SOURCE
/* Attack case 04: sleep far past the limit.
   Uses no CPU, so only the wall-clock limit can stop it (TLE). If sleep()
   ever returns, the wall limit did not apply. */
#include <stdio.h>
#include <unistd.h>

int main(void) {
    printf("sleeping\n");
    fflush(stdout);
    sleep(1000);
    printf("ESCAPED woke up after the wall limit\n");
    fflush(stdout);
    return 0;
}
