import random
rng = random.Random(1010)
def t(n, edges):
    return '%d %d\n%s' % (n, len(edges), ''.join('%d %d\n' % e for e in edges))
tests = [t(6, [(1, 2), (2, 3), (1, 4), (4, 5), (3, 5)]), t(1, [(1, 1)]), t(2, [(2, 2)]),
         t(4, [(1, 2), (1, 2), (2, 3), (3, 3), (3, 4)])]
tests.append(t(30, [(rng.randint(1, 30), rng.randint(1, 30)) for _ in range(35)]))
tests.append(t(200, [(rng.randint(1, 200), rng.randint(1, 200)) for _ in range(150)]))       # several components
n = 50000
tests.append(t(n, [(rng.randint(1, n), rng.randint(1, n)) for _ in range(50000)]))            # sparse random
tests.append(t(20000, [(1, i) for i in range(2, 20001)] + [(2, 3)]))                          # star
tests.append(t(n, [(i, i + 1) for i in range(n - 1, 0, -1)]))                                 # path, edges listed far end first
tests.append(t(n, [(1, 2)] + [(rng.randint(3, n), rng.randint(3, n)) for _ in range(49999)])) # 1 is cut off
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
