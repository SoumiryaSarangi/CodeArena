#define _GNU_SOURCE
/* Attack case 09: read /sys.
   /sys exposes host hardware and kernel details; the box must not mount it.
   Tries to list /sys and open a few well-known files. */
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    int leaked = 0;
    DIR *d = opendir("/sys");
    if (d) {
        struct dirent *e;
        while ((e = readdir(d)))
            if (e->d_name[0] != '.') leaked++;
        closedir(d);
    }
    const char *files[] = {
        "/sys/kernel/hostname",
        "/sys/class/net",
        "/sys/devices/system/cpu/online",
        "/sys/fs/cgroup",
        "/sys/firmware",
    };
    for (unsigned i = 0; i < sizeof files / sizeof files[0]; i++) {
        int fd = open(files[i], O_RDONLY);
        if (fd >= 0) {
            leaked++;
            close(fd);
        }
    }
    if (leaked) {
        printf("ESCAPED /sys is readable (%d entries)\n", leaked);
    } else {
        printf("BLOCKED /sys is not readable\n");
    }
    fflush(stdout);
    return 0;
}
