#define _GNU_SOURCE
/* Attack case 11: outbound IPv6 TCP.
   Same idea as the IPv4 case on the other address family, which is easy to
   forget when only IPv4 is locked down. A kernel with IPv6 disabled refuses
   the socket outright, which also counts as blocked. */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

static int try_connect(const char *ip, int port) {
    int fd = socket(AF_INET6, SOCK_STREAM, 0);
    if (fd < 0) return 0;
    fcntl(fd, F_SETFL, O_NONBLOCK);
    struct sockaddr_in6 a = {.sin6_family = AF_INET6, .sin6_port = htons(port)};
    inet_pton(AF_INET6, ip, &a.sin6_addr);
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
    int up = try_connect("2606:4700:4700::1111", 80) + try_connect("2001:4860:4860::8888", 53) +
             try_connect("::1", 22);
    if (up) {
        printf("ESCAPED connected out over IPv6 (%d)\n", up);
    } else {
        printf("BLOCKED no IPv6 connection possible\n");
    }
    fflush(stdout);
    return 0;
}
