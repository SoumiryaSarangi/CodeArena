/* Attack case 16: become root.
   Tries setuid/setgid/setresuid to 0. The box runs as an unprivileged uid, so
   each call must fail and the effective uid must still be non-zero. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    int r1 = setuid(0);
    int r2 = setgid(0);
    int r3 = setresuid(0, 0, 0);
    int r4 = setresgid(0, 0, 0);
    if (geteuid() == 0 || getuid() == 0 || getegid() == 0 || r1 == 0 || r3 == 0) {
        printf("ESCAPED became uid=%d euid=%d gid=%d\n", getuid(), geteuid(), getegid());
    } else {
        printf("BLOCKED setuid/setgid refused (r=%d,%d,%d,%d) still uid=%d\n", r1, r2, r3, r4, getuid());
    }
    fflush(stdout);
    return 0;
}
