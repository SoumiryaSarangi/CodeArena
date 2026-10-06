import random
rng = random.Random(1012)
def t(n, edges):
    return '%d %d\n%s' % (n, len(edges), ''.join('%d %d %d\n' % e for e in edges))
tests = [t(5, [(1, 2, 4), (1, 3, 1), (3, 2, 2), (2, 4, 5), (3, 4, 8), (4, 5, 3)]), t(3, [(1, 2, 5)]),
         t(2, [(1, 2, 7), (2, 1, 3)]), t(2, [(1, 1, 1)])]
tests.append(t(40, [(rng.randint(1, 40), rng.randint(1, 40), rng.randint(1, 20)) for _ in range(90)]))
tests.append(t(500, [(rng.randint(1, 500), rng.randint(1, 500), rng.randint(1, 10**6)) for _ in range(1200)]))
n = 50000
tests.append(t(n, [(i, i + 1, 10**6) for i in range(n - 1, 0, -1)]))               # same, edges listed from the far end
tests.append(t(n, [(rng.randint(1, n), rng.randint(1, n), rng.randint(1, 10**6)) for _ in range(30000)]))
tests.append(t(20000, [(rng.randint(1, 19999), rng.randint(1, 19999), rng.randint(1, 100)) for _ in range(20000)]))  # n unreachable
tests.append(t(25000, [(1, i, 10**6 - i) for i in range(2, 25001)] + [(i, i + 1, 1) for i in range(2, 25000)]))   # shortcuts everywhere
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
