#define _GNU_SOURCE
/* Attack case 14: dump the environment.
   Prints our own environment and the environment of every pid visible in
   /proc. The runner keeps a secret canary in its own environment; it must
   never show up here. The runner checks the output for it (env-clean); the
   program also flags it so a leak fails loudly. */
#include <ctype.h>
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

int main(void) {
    int vars = 0, leaked = 0;
    for (char **e = environ; *e; e++) {
        printf("env: %s\n", *e);
        vars++;
        if (strstr(*e, "CODEARENA")) leaked = 1;
    }

    DIR *d = opendir("/proc");
    if (d) {
        struct dirent *de;
        while ((de = readdir(d))) {
            if (!isdigit((unsigned char)de->d_name[0])) continue;
            char path[300];
            snprintf(path, sizeof path, "/proc/%s/environ", de->d_name);
            int fd = open(path, O_RDONLY);
            if (fd < 0) continue;
            static char buf[65536];
            ssize_t n = read(fd, buf, sizeof buf - 1);
            close(fd);
            if (n <= 0) continue;
            buf[n] = '\0';
            for (char *p = buf; p < buf + n; p += strlen(p) + 1) {
                printf("pid %s env: %s\n", de->d_name, p);
                vars++;
                if (strstr(p, "CODEARENA")) leaked = 1;
            }
        }
        closedir(d);
    }

    printf("dumped %d variables\n", vars);
    if (leaked) printf("ESCAPED runner secret visible in the environment\n");
    fflush(stdout);
    return 0;
}
