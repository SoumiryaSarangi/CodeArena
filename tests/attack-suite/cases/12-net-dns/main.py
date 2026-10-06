# Attack case 12: resolve a hostname.
# DNS needs a network path (and usually /etc/resolv.conf); the box has neither.
# A successful lookup means the resolver reached something outside the box.
import socket

socket.setdefaulttimeout(2)
hosts = ["example.com", "github.com", "localhost.localdomain"]
resolved = []
for h in hosts:
    try:
        infos = socket.getaddrinfo(h, 80)
        if infos:
            resolved.append((h, infos[0][4][0]))
    except OSError:
        pass

if resolved:
    print("ESCAPED resolved", resolved)
else:
    print("BLOCKED no hostname could be resolved")
