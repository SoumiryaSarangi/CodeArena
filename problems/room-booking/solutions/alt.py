import sys
data = sys.stdin.buffer.read().split()
n = int(data[0])
# a different route: dp over requests sorted by end, with a binary search for the last compatible one
from bisect import bisect_right
iv = sorted((int(data[2 + 2 * i]), int(data[1 + 2 * i])) for i in range(n))
ends = [e for e, _ in iv]
best = [0] * (n + 1)
for i, (e, s) in enumerate(iv, 1):
    j = bisect_right(ends, s)          # requests 1..j end at or before s
    best[i] = max(best[i - 1], best[j] + 1)
print(best[n])
