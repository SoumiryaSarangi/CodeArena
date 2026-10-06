// Probe program for the sandbox integration tests. argv[1] picks the behaviour.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dirent.h>
#include <fcntl.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static double cpu_now(clockid_t clk) {
  struct timespec ts;
  clock_gettime(clk, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

// Burn `secs` of CPU time on the calling thread.
static void burn(double secs) {
  double start = cpu_now(CLOCK_THREAD_CPUTIME_ID);
  volatile unsigned long x = 0;
  while (cpu_now(CLOCK_THREAD_CPUTIME_ID) - start < secs) x++;
}

static void *burn_thread(void *arg) {
  (void)arg;
  burn(0.3);
  return NULL;
}

static const char *try_connect(int type) {
  int fd = socket(AF_INET, type, 0);
  if (fd < 0) return "fail";
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(type == SOCK_STREAM ? 80 : 53)};
  inet_pton(AF_INET, "1.1.1.1", &a.sin_addr);
  if (connect(fd, (struct sockaddr *)&a, sizeof a) != 0) return "fail";
  if (type == SOCK_DGRAM && send(fd, "x", 1, 0) != 1) return "fail";
  return "ok";
}

int main(int argc, char **argv) {
  const char *m = argc > 1 ? argv[1] : "";
  if (!strcmp(m, "sum")) {
    long a, b;
    if (scanf("%ld %ld", &a, &b) != 2) return 3;
    printf("%ld\n", a + b);
  } else if (!strcmp(m, "env")) {
    for (char **e = environ; *e; e++) puts(*e);
  } else if (!strcmp(m, "net")) {
    printf("udp:%s tcp:%s\n", try_connect(SOCK_DGRAM), try_connect(SOCK_STREAM));
  } else if (!strcmp(m, "spin")) {
    for (volatile unsigned long x = 0;; x++) {
    }
  } else if (!strcmp(m, "sleep")) {
    sleep(30);
  } else if (!strcmp(m, "oom")) {
    size_t n = 512u << 20;
    char *p = malloc(n);
    if (!p) return 4;
    for (size_t i = 0; i < n; i += 4096) p[i] = 1;
    printf("%d\n", p[n - 4096]);
  } else if (!strcmp(m, "fsize")) {
    static char buf[1 << 16];
    memset(buf, 'x', sizeof buf);
    for (int i = 0; i < 64; i++) fwrite(buf, 1, sizeof buf, stdout);
  } else if (!strcmp(m, "fork")) {
    pid_t pid = fork();
    if (pid == 0) _exit(0);
    puts(pid < 0 ? "fork-failed" : "forked");
    if (pid > 0) waitpid(pid, NULL, 0);
  } else if (!strcmp(m, "threads")) {
    pthread_t t[4];
    for (int i = 0; i < 4; i++) pthread_create(&t[i], NULL, burn_thread, NULL);
    for (int i = 0; i < 4; i++) pthread_join(t[i], NULL);
  } else if (!strcmp(m, "child")) {
    pid_t pid = fork();
    if (pid < 0) return 5;
    burn(0.3);
    if (pid == 0) _exit(0);
    waitpid(pid, NULL, 0);
  } else if (!strcmp(m, "affinity")) {
    cpu_set_t s;
    CPU_ZERO(&s);
    if (sched_getaffinity(0, sizeof s, &s) != 0) return 6;
    const char *sep = "";
    for (int i = 0; i < CPU_SETSIZE; i++)
      if (CPU_ISSET(i, &s)) {
        printf("%s%d", sep, i);
        sep = ",";
      }
    puts("");
  } else if (!strcmp(m, "symlink")) {
    unlink("out.txt");
    if (symlink("/etc/passwd", "out.txt") != 0) return 7;
  } else if (!strcmp(m, "fifo")) {
    unlink("out.txt");
    if (mkfifo("out.txt", 0644) != 0) return 8;
  } else if (!strcmp(m, "dev")) {
    /* J-08: list /dev and use the devices a normal program needs. */
    DIR *d = opendir("/dev");
    if (!d) return 9;
    struct dirent *e;
    while ((e = readdir(d)))
      if (e->d_name[0] != '.') printf("entry %s\n", e->d_name);
    closedir(d);
    int fd = open("/dev/null", O_WRONLY);
    printf("null %s\n", fd >= 0 && write(fd, "x", 1) == 1 ? "ok" : "fail");
    if (fd >= 0) close(fd);
    unsigned char b[8];
    fd = open("/dev/urandom", O_RDONLY);
    printf("urandom %s\n", fd >= 0 && read(fd, b, sizeof b) == (ssize_t)sizeof b ? "ok" : "fail");
    if (fd >= 0) close(fd);
    char line[64] = {0};
    FILE *in = fopen("/dev/stdin", "r");
    printf("stdin %s\n", in && fgets(line, sizeof line, in) && !strcmp(line, "piped\n") ? "ok" : "fail");
    FILE *shm = fopen("/dev/shm/probe", "w");
    printf("shm %s\n", shm && fputs("x", shm) >= 0 && fclose(shm) == 0 ? "ok" : "fail");
  } else {
    return 2;
  }
  return 0;
}
