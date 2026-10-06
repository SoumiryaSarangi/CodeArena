#define _GNU_SOURCE
/* Attack case 10: outbound IPv4 TCP.
   The box has no network. Tries a public address and loopback; a connection
   that completes is an escape. Non-blocking with a short wait so a silent drop
   cannot hang the run. */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

static int try_connect(const char *ip, int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 0;
    fcntl(fd, F_SETFL, O_NONBLOCK);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(port)};
    inet_pton(AF_INET, ip, &a.sin_addr);
    int r = connect(fd, (struct sockaddr *)&a, sizeof a);
    int ok = 0;
    if (r == 0) {
        ok = 1;
    } else if (errno == EINPROGRESS) {
        struct pollfd p = {.fd = fd, .events = POLLOUT};
        if (poll(&p, 1, 300) == 1) {
            int err = 0;
            socklen_t len = sizeof err;
            getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
            ok = (err == 0);
        }
    }
    close(fd);
    return ok;
}

int main(void) {
    int up = try_connect("1.1.1.1", 80) + try_connect("8.8.8.8", 53) + try_connect("127.0.0.1", 22);
    if (up) {
        printf("ESCAPED connected out over IPv4 (%d)\n", up);
    } else {
        printf("BLOCKED no IPv4 connection possible\n");
    }
    fflush(stdout);
    return 0;
}
