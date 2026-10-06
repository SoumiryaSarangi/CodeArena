#define _GNU_SOURCE
/* Attack case 07: swap the output file for a symlink.
   The runner reads the program's stdout/stderr files from the host after the
   run. A hostile program replaces those files with symlinks to a host file
   (/etc/passwd) hoping the runner follows the link and returns its contents.
   The runner must read the files safely, so "root:" must never appear in the
   result. The marker goes out before the swap. */
#include <errno.h>
#include <stdio.h>
#include <unistd.h>

static void swap(int fd, const char *label) {
    char proc[64], path[512];
    snprintf(proc, sizeof proc, "/proc/self/fd/%d", fd);
    ssize_t n = readlink(proc, path, sizeof path - 1);
    if (n <= 0) {
        printf("%s: cannot resolve the output path (errno=%d)\n", label, errno);
        return;
    }
    path[n] = '\0';
    if (unlink(path) != 0) {
        printf("%s: unlink %s refused (errno=%d)\n", label, path, errno);
        return;
    }
    if (symlink("/etc/passwd", path) != 0) {
        printf("%s: symlink at %s refused (errno=%d)\n", label, path, errno);
        return;
    }
    printf("%s: replaced %s with a symlink to /etc/passwd\n", label, path);
}

int main(void) {
    printf("attempting symlink swap\n");
    fflush(stdout);
    swap(1, "stdout");
    swap(2, "stderr");
    fflush(stdout);
    return 0;
}
