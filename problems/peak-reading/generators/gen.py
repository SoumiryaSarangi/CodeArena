import random
rng = random.Random(1002)
def t(a):
    return '%d\n%s\n' % (len(a), ' '.join(map(str, a)))
tests = [t([3, 9, 2, 9, 1]), t([-5]), t([7] * 10), t(list(range(1, 1001))), t(list(range(1000, 0, -1))),
         t([rng.randint(-100, -1) for _ in range(50)]), t([rng.randint(-10**9, 10**9) for _ in range(1000)])]
big = list(range(1, 50001))                      # maximum at the very end
tests.append(t(big))
a = [rng.randint(-10**9, 10**9 - 1) for _ in range(50000)]
for p in (0, 37, 30000, 49999):
    a[p] = 10**9                                  # the maximum repeats
tests.append(t(a))
tests.append(t([rng.randint(-10**9, 10**9) for _ in range(10000)]))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
