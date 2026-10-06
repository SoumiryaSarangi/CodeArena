import heapq
import sys
data = sys.stdin.buffer.read().split()
n, m = int(data[0]), int(data[1])
adj = [[] for _ in range(n + 1)]
for i in range(m):
    u, v, w = int(data[2 + 3 * i]), int(data[3 + 3 * i]), int(data[4 + 3 * i])
    adj[u].append((v, w))
    adj[v].append((u, w))
INF = float('inf')
dist = [INF] * (n + 1)
dist[1] = 0
heap = [(0, 1)]
while heap:
    d, v = heapq.heappop(heap)
    if d > dist[v]:
        continue
    for u, w in adj[v]:
        nd = d + w
        if nd < dist[u]:
            dist[u] = nd
            heapq.heappush(heap, (nd, u))
print(-1 if dist[n] == INF else dist[n])
