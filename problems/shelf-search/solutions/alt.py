import sys
from bisect import bisect_left
data = sys.stdin.read().split()
n, q = int(data[0]), int(data[1])
a = list(map(int, data[2:2 + n]))
print(' '.join(str(bisect_left(a, int(x)) + 1) for x in data[2 + n:2 + n + q]))
