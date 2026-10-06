import sys
t, p = sys.stdin.read().split()
# a different route: Z-function of p + '#' + t
s = p + '#' + t
n, m = len(s), len(p)
z = [0] * n
l = r = 0
count = 0
for i in range(1, n):
    if i < r:
        z[i] = min(r - i, z[i - l])
    while i + z[i] < n and s[z[i]] == s[i + z[i]]:
        z[i] += 1
    if i + z[i] > r:
        l, r = i, i + z[i]
    if i > m and z[i] >= m:
        count += 1
print(count)
