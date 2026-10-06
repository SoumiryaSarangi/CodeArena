import random
rng = random.Random(1011)
def t(n, edges):
    return '%d %d\n%s' % (n, len(edges), ''.join('%d %d\n' % e for e in edges))
tests = [t(7, [(1, 2), (2, 3), (4, 5), (6, 6), (3, 1)]), t(1, []), t(5, []), t(3, [(1, 2), (2, 1), (1, 2), (3, 3)])]
tests.append(t(30, [(rng.randint(1, 30), rng.randint(1, 30)) for _ in range(20)]))
tests.append(t(300, [(rng.randint(1, 300), rng.randint(1, 300)) for _ in range(250)]))
n = 50000
tests.append(t(n, [(rng.randint(1, n), rng.randint(1, n)) for _ in range(50000)]))          # random sparse
tests.append(t(n, [(1, 2)] * 50000))                                                        # repeated road
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
