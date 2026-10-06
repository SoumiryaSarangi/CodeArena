import sys
from itertools import accumulate
data = sys.stdin.buffer.read().split()
n, q = int(data[0]), int(data[1])
p = [0] + list(accumulate(map(int, data[2:2 + n])))
out = []
pos = 2 + n
for _ in range(q):
    l, r = int(data[pos]), int(data[pos + 1])
    pos += 2
    out.append(p[r] - p[l - 1])
print('\n'.join(map(str, out)))
