import random
rng = random.Random(1018)
def t(W, items):
    return '%d %d\n%s' % (len(items), W, ''.join('%d %d\n' % it for it in items))
tests = [t(50, [(10, 60), (20, 100), (30, 120)]), t(3, [(6, 10)]), t(100, [(5, 7)]), t(1, [(1, 1)] * 3),
         t(10, [(7, 21), (7, 20)])]
tests.append(t(40, [(rng.randint(1, 20), rng.randint(1, 100)) for _ in range(15)]))
tests.append(t(10**5, [(rng.randint(1, 10**4), rng.randint(1, 10**6)) for _ in range(300)]))
n = 50000
tests.append(t(10**9, [(rng.randint(1, 10**6), rng.randint(1, 10**6)) for _ in range(n)]))   # everything fits: sum is large
tests.append(t(2 * 10**7, [(rng.randint(5 * 10**5, 10**6), rng.randint(1, 10**6)) for _ in range(20000)]))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
