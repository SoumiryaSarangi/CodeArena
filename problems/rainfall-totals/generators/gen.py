import random
rng = random.Random(1003)
def t(a, qs):
    return '%d %d\n%s\n%s' % (len(a), len(qs), ' '.join(map(str, a)), ''.join('%d %d\n' % q for q in qs))
tests = [t([1, 2, 3, 4, 5], [(1, 5), (2, 3), (4, 4)]), t([-10**9], [(1, 1)])]
tests.append(t([5], [(1, 1)] * 3))
a = [rng.randint(-10, 10) for _ in range(20)]
tests.append(t(a, [(l, r) for l in range(1, 21) for r in range(l, 21)]))   # every range of a small array
tests.append(t([10**9] * 50000, [(1, 50000), (1, 1), (50000, 50000), (2, 49999)]))        # needs 64-bit
tests.append(t([-10**9] * 20000, [(1, 20000), (10000, 20000)]))
n = 50000
a = [rng.randint(0, 9) for _ in range(n)]
qs = []
for _ in range(50000):                       # wide ranges: re-scanning is hopeless
    l = rng.randint(1, 1000)
    r = rng.randint(n - 1000, n)
    qs.append((l, r))
tests.append(t(a, qs))
a = [rng.randint(-10**9, 10**9) for _ in range(5000)]
qs = [tuple(sorted((rng.randint(1, 5000), rng.randint(1, 5000)))) for _ in range(5000)]
tests.append(t(a, qs))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
