import sys
data = sys.stdin.read().split()
n, T = int(data[0]), int(data[1])
a = list(map(int, data[2:2 + n]))
# a different route: sort positions by value and walk two pointers from both ends
order = sorted(range(n), key=lambda i: a[i])
lo, hi = 0, n - 1
while lo < hi:
    s = a[order[lo]] + a[order[hi]]
    if s == T:
        i, j = sorted((order[lo] + 1, order[hi] + 1))
        print(i, j)
        break
    if s < T:
        lo += 1
    else:
        hi -= 1
else:
    print(-1)
