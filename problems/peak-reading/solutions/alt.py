import sys
data = sys.stdin.read().split()
n = int(data[0])
a = list(map(int, data[1:1 + n]))
m = max(a)
print(m, a.index(m) + 1)
