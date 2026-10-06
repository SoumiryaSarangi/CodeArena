import sys
from fractions import Fraction
data = sys.stdin.read().split()
n, W = int(data[0]), int(data[1])
items = [(int(data[2 + 2 * i]), int(data[3 + 2 * i])) for i in range(n)]
items.sort(key=lambda p: Fraction(-p[1], p[0]))   # exact ratios
total = Fraction(0)
for w, v in items:
    if W <= 0:
        break
    take = min(W, w)
    total += Fraction(v * take, w)
    W -= take
print('%.9f' % float(total))
