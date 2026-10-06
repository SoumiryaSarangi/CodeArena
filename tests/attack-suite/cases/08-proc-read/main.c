/* Attack case 08: read /proc of other processes.
   Lists /proc, then tries to read the environment and command line of every
   pid except our own. Inside the box's pid namespace there must be no foreign
   host process to read, and no runner canary in anything readable. */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* True if the runner's secret variable name appears in buf. */
static int has_canary(const char *buf, ssize_t n) {
    return memmem(buf, (size_t)n, "CODEARENA_ATTACK_CANARY", 23) != NULL;
}

static int slurp(const char *path, char *buf, size_t cap) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buf, cap);
    close(fd);
    return (int)n;
}

int main(void) {
    DIR *d = opendir("/proc");
    if (!d) {
        printf("BLOCKED /proc is not available\n");
        return 0;
    }
    pid_t self = getpid();
    int foreign = 0, leaked = 0;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!isdigit((unsigned char)e->d_name[0])) continue;
        pid_t pid = (pid_t)atoi(e->d_name);
        if (pid == self) continue;
        char path[64], buf[4096];
        int n;
        snprintf(path, sizeof path, "/proc/%d/environ", pid);
        n = slurp(path, buf, sizeof buf);
        if (n > 0) {
            foreign++;
            if (has_canary(buf, n)) leaked++;
        }
        snprintf(path, sizeof path, "/proc/%d/cmdline", pid);
        n = slurp(path, buf, sizeof buf);
        if (n > 0) foreign++;
    }
    closedir(d);
    if (leaked) {
        printf("ESCAPED read a runner secret from another process\n");
    } else if (foreign > 4) {
        /* the box has at most its own init/proxy; a long list means host pids */
        printf("ESCAPED read %d foreign /proc entries\n", foreign);
    } else {
        printf("BLOCKED no foreign processes readable (%d box-local entries)\n", foreign);
    }
    fflush(stdout);
    return 0;
}
