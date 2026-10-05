// Package sandbox drives isolate 2.x boxes for the judge (SD-§8.1, §8.2).
//
// Safety rules, and why:
//
//   - Every run uses cgroup mode (--cg) so CPU time and memory are counted for
//     the whole process tree (FR-JUDGE-04), and the network is never shared:
//     RunSpec has no field that could emit --share-net or an extra --env, so
//     the sandbox environment is exactly PATH (plus isolate's own built-in
//     LIBC_FATAL_STDERR_=1, which only routes glibc fatal messages to stderr).
//   - The host never follows a path inside a box (FR-JUDGE-08, the Judge0
//     CVE-2024-28185 class). The submission owns the box directory while it
//     runs, so any name in it may have been replaced by a symlink, FIFO, device
//     or hard link. ReadFile opens the box directory itself with O_NOFOLLOW,
//     then the file with openat(O_NOFOLLOW|O_NONBLOCK) relative to that
//     directory fd, and only reads it if fstat says it is a regular file with a
//     single link. O_NONBLOCK stops a FIFO from hanging the worker; the link
//     count check refuses hard links to files outside the box. Reads are capped.
//   - The host only writes into a fresh box, with O_CREAT|O_EXCL|O_NOFOLLOW, so
//     it can never write through something the submission left behind.
//   - Box paths above box/ (/var/local/lib/isolate/<id>) are root-owned and
//     cannot be replaced from inside the sandbox, so the directory path itself
//     is trusted; only names inside box/ are not.
//   - Every isolate call is wrapped in `taskset -c <core>` so a box always runs
//     on its slot's core (FR-JUDGE-13, SD-§8.7).
package sandbox
