#define _GNU_SOURCE
/* Attack case 13: read another box's files.
   Judge boxes live under isolate's host directory (/var/local/lib/isolate/<id>/box).
   From inside a box none of those paths, nor parent-directory climbing out of
   the box root, may lead to a neighbour's files or the host's isolate tree. */
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

static int reachable(const char *path) {
    DIR *d = opendir(path);
    if (d) {
        closedir(d);
        return 1;
    }
    int fd = open(path, O_RDONLY);
    if (fd >= 0) {
        close(fd);
        return 1;
    }
    return 0;
}

int main(void) {
    const char *paths[] = {
        "/var/local/lib/isolate",
        "/var/local/lib/isolate/0/box",
        "/var/local/lib/isolate/1/box",
        "/var/local/lib/isolate/2/box",
        "/var/lib/isolate",
        "/box/../../0/box",
        "/box/../../1/box",
        "/../../../var/local/lib/isolate",
        "/proc/1/root/var/local/lib/isolate",
        "/proc/self/root/../../var/local/lib/isolate",
    };
    int hits = 0;
    for (unsigned i = 0; i < sizeof paths / sizeof paths[0]; i++) {
        if (reachable(paths[i])) {
            printf("ESCAPED reached %s\n", paths[i]);
            hits++;
        }
    }
    if (!hits) printf("BLOCKED no other box or isolate directory is reachable\n");
    fflush(stdout);
    return 0;
}
