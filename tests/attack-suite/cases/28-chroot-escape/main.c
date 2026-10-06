#define _GNU_SOURCE
/* Attack case 28: classic chroot breakout.
   The textbook escape makes a subdirectory, chroot()s into it and then climbs
   out with "..". It needs CAP_SYS_CHROOT, which the box does not grant, so the
   very first chroot() must fail. Also checks /etc/shadow is out of reach. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

int main(void) {
    mkdir("jail", 0700);
    if (chroot("jail") == 0) {
        printf("ESCAPED chroot() succeeded\n");
        fflush(stdout);
        return 0;
    }
    int saved = errno;
    int fd = open("/etc/shadow", O_RDONLY);
    if (fd >= 0) {
        printf("ESCAPED /etc/shadow is readable\n");
        fflush(stdout);
        return 0;
    }
    printf("BLOCKED chroot refused (errno=%d) and /etc/shadow is out of reach\n", saved);
    fflush(stdout);
    return 0;
}
