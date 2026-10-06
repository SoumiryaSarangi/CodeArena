#define _GNU_SOURCE
/* Attack case 26: mount filesystems.
   mount(2) needs CAP_SYS_ADMIN, which the box does not have. Tries a tmpfs
   mount, a bind mount of / over /tmp, and a remount; every call must fail. */
#include <errno.h>
#include <stdio.h>
#include <sys/mount.h>

int main(void) {
    int ok = 0;
    if (mount("tmpfs", "/tmp", "tmpfs", 0, NULL) == 0) ok++;
    if (mount("/", "/tmp", NULL, MS_BIND, NULL) == 0) ok++;
    if (mount(NULL, "/", NULL, MS_REMOUNT, NULL) == 0) ok++;
    if (ok) {
        printf("ESCAPED %d mount calls succeeded\n", ok);
    } else {
        printf("BLOCKED mount refused (errno=%d)\n", errno);
    }
    fflush(stdout);
    return 0;
}
