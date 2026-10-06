import sys
from bisect import bisect_left
data = sys.stdin.read().split()
n = int(data[0])
tails = []
for x in map(int, data[1:1 + n]):
    i = bisect_left(tails, x)
    if i == len(tails):
        tails.append(x)
    else:
        tails[i] = x
print(len(tails))
