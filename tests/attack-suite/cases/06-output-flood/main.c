#define _GNU_SOURCE
/* Attack case 06: output flood.
   Writes up to 4 GB to stdout. The output limit (64 KB) must stop it, either
   as OLE or by killing the program when the output file hits its size cap. */
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    static char buf[4096];
    memset(buf, 'A', sizeof buf);
    buf[sizeof buf - 1] = '\n';
    long long total = 0;
    for (int i = 0; i < 1024 * 1024; i++) {
        ssize_t n = write(1, buf, sizeof buf);
        if (n < 0) return 0;
        total += n;
    }
    fprintf(stderr, "ESCAPED wrote %lld MB to stdout\n", total >> 20);
    return 0;
}
