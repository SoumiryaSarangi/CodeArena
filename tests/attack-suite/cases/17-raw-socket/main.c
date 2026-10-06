#define _GNU_SOURCE
/* Attack case 17: raw and packet sockets.
   Raw IP and AF_PACKET sockets need CAP_NET_RAW. The box drops all
   capabilities, so every attempt must fail. */
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
    int opened = 0;
    int fds[3];
    fds[0] = socket(AF_INET, SOCK_RAW, IPPROTO_ICMP);
    fds[1] = socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
    fds[2] = socket(AF_PACKET, SOCK_RAW, 0);
    for (int i = 0; i < 3; i++) {
        if (fds[i] >= 0) {
            opened++;
            close(fds[i]);
        }
    }
    if (opened) {
        printf("ESCAPED opened %d raw sockets\n", opened);
    } else {
        printf("BLOCKED raw and packet sockets refused\n");
    }
    fflush(stdout);
    return 0;
}
