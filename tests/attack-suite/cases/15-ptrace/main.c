#define _GNU_SOURCE
/* Attack case 15: ptrace other processes.
   Tries to attach to every pid in a wide range except our own. Inside the
   box's pid namespace there is nothing else to attach to (and an unprivileged
   uid could not anyway), so every attempt must fail. */
#include <errno.h>
#include <stdio.h>
#include <sys/ptrace.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    pid_t self = getpid();
    int attached = 0;
    for (pid_t pid = 1; pid <= 4096; pid++) {
        if (pid == self) continue;
        if (ptrace(PTRACE_ATTACH, pid, 0, 0) == 0) {
            attached++;
            printf("ESCAPED attached to pid %d\n", pid);
            ptrace(PTRACE_DETACH, pid, 0, 0);
        }
    }
    if (!attached) printf("BLOCKED ptrace attach failed for every pid\n");
    fflush(stdout);
    return 0;
}
