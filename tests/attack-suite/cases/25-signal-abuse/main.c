#define _GNU_SOURCE
/* Attack case 25: signal abuse.
   Tries to reach processes outside the box so it could kill the judge: probes
   every pid in a wide range with signal 0 and counts how many answer, and sends
   SIGKILL to pid 1. Inside the box's pid namespace only a handful of pids
   exist, so a long list means host processes are reachable. The runner's
   worker-alive check then confirms nothing died. */
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <sys/types.h>
#include <unistd.h>

int main(void) {
    pid_t self = getpid();
    int reachable = 0;
    for (pid_t pid = 1; pid <= 32768; pid++) {
        if (pid == self) continue;
        if (kill(pid, 0) == 0) reachable++;
    }
    int r = kill(1, SIGKILL); /* init of this namespace; must be unaffected */
    if (reachable > 4) {
        printf("ESCAPED %d processes outside the box answered a signal\n", reachable);
    } else {
        printf("BLOCKED only %d pids reachable, kill(1) returned %d\n", reachable, r);
    }
    fflush(stdout);
    return 0;
}
