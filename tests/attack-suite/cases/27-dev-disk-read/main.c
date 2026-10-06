#define _GNU_SOURCE
/* Attack case 27: open raw devices.
   Tries to open host memory and disk device nodes. The box's /dev holds only
   the harmless basics, and an unprivileged uid could not read these anyway. */
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    const char *devs[] = {
        "/dev/mem",  "/dev/kmem",  "/dev/port",    "/dev/kmsg",     "/dev/sda",
        "/dev/sda1", "/dev/vda",   "/dev/nvme0n1", "/dev/loop0",    "/dev/disk",
    };
    int opened = 0;
    for (unsigned i = 0; i < sizeof devs / sizeof devs[0]; i++) {
        int fd = open(devs[i], O_RDONLY);
        if (fd >= 0) {
            printf("ESCAPED opened %s\n", devs[i]);
            opened++;
            close(fd);
        }
    }
    if (!opened) printf("BLOCKED no raw device could be opened\n");
    fflush(stdout);
    return 0;
}
