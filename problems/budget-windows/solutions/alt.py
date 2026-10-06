import sys
data = sys.stdin.read().split()
n, S = int(data[0]), int(data[1])
a = list(map(int, data[2:2 + n]))
# a different route: for every left end, binary-search the farthest affordable right end
from bisect import bisect_right
p = [0]
for x in a:
    p.append(p[-1] + x)
total = 0
for l in range(n):
    r = bisect_right(p, p[l] + S) - 1   # largest r with p[r] - p[l] <= S
    total += r - l
print(total)
