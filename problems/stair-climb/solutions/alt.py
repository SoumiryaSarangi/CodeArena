import sys
data = sys.stdin.read().split()
n, k = int(data[0]), int(data[1])
MOD = 10**9 + 7
broken = set(map(int, data[2:2 + k]))
a, b, c = 0, 0, 1          # f(i-3), f(i-2), f(i-1), rolling: only three numbers are ever needed
for i in range(1, n + 1):
    cur = 0 if i in broken else (a + b + c) % MOD
    a, b, c = b, c, cur
print(c % MOD)
