import sys
data = sys.stdin.read().split()
q = int(data[0])
xs = list(map(int, data[1:1 + q]))
M = max(xs)
spf = list(range(M + 1))            # smallest prime factor, then factorise each question
for i in range(2, int(M ** 0.5) + 1):
    if spf[i] == i:
        for j in range(i * i, M + 1, i):
            if spf[j] == j:
                spf[j] = i
out = []
for x in xs:
    r = 1
    while x > 1:
        p, e = spf[x], 0
        while x % p == 0:
            x //= p
            e += 1
        r *= e + 1
    out.append(r)
print(' '.join(map(str, out)))
