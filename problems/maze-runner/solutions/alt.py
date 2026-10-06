import sys
from collections import deque
data = sys.stdin.read().split()
n, m = int(data[0]), int(data[1])
g = data[2:2 + n]
flat = ''.join(g)
s, t = flat.index('S'), flat.index('T')
dist = [-1] * (n * m)
dist[s] = 0
dq = deque([s])
while dq and dist[t] < 0:
    v = dq.popleft()
    r, c = divmod(v, m)
    for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
        if 0 <= nr < n and 0 <= nc < m:
            u = nr * m + nc
            if flat[u] != '#' and dist[u] < 0:
                dist[u] = dist[v] + 1
                dq.append(u)
print(dist[t])
