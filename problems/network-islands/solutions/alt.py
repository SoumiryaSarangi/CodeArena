import sys
sys.setrecursionlimit(1 << 20)
data = sys.stdin.buffer.read().split()
n, m = int(data[0]), int(data[1])
adj = [[] for _ in range(n + 1)]
for i in range(m):
    u, v = int(data[2 + 2 * i]), int(data[3 + 2 * i])
    adj[u].append(v)
    adj[v].append(u)
seen = [False] * (n + 1)
comps = best = 0
for s in range(1, n + 1):          # flood fill each island once, with an explicit stack
    if seen[s]:
        continue
    comps += 1
    seen[s] = True
    stack, size = [s], 0
    while stack:
        v = stack.pop()
        size += 1
        for u in adj[v]:
            if not seen[u]:
                seen[u] = True
                stack.append(u)
    best = max(best, size)
print(comps, best)
