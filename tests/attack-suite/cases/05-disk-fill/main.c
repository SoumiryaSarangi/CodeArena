#define _GNU_SOURCE
/* Attack case 05: fill the disk.
   Writes a huge file in the box directory, then in /tmp. SIGXFSZ is ignored so
   the file-size limit shows up as a failed write (EFBIG) rather than a kill;
   either outcome counts as contained. Capped at 512 MB per location so a
   stray run outside the sandbox stays survivable. */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static long long fill(const char *path) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        printf("BLOCKED cannot create %s: errno=%d\n", path, errno);
        return 0;
    }
    static char buf[1 << 20];
    memset(buf, 'D', sizeof buf);
    long long total = 0;
    for (int i = 0; i < 512; i++) {
        ssize_t n = write(fd, buf, sizeof buf);
        if (n < 0) {
            printf("BLOCKED write to %s stopped at %lld KB: errno=%d\n", path, total >> 10, errno);
            close(fd);
            return total;
        }
        total += n;
    }
    close(fd);
    return total;
}

int main(void) {
    signal(SIGXFSZ, SIG_IGN);
    long long a = fill("fill.bin");
    long long b = fill("/tmp/fill.bin");
    fflush(stdout);
    if (a >= (512LL << 20) || b >= (512LL << 20)) {
        printf("ESCAPED wrote %lld MB and %lld MB\n", a >> 20, b >> 20);
        fflush(stdout);
    }
    return 0;
}
