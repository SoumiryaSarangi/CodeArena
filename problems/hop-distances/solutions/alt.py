import sys
data = sys.stdin.buffer.read().split()
n, m = int(data[0]), int(data[1])
adj = [[] for _ in range(n + 1)]
for i in range(m):
    u, v = int(data[2 + 2 * i]), int(data[3 + 2 * i])
    adj[u].append(v)
    adj[v].append(u)
dist = [-1] * (n + 1)
dist[1] = 0
frontier = [1]
while frontier:                      # level by level instead of a queue
    nxt = []
    for v in frontier:
        for u in adj[v]:
            if dist[u] < 0:
                dist[u] = dist[v] + 1
                nxt.append(u)
    frontier = nxt
print(' '.join(map(str, dist[1:])))
