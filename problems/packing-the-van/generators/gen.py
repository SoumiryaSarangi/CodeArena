import random
rng = random.Random(1014)
def t(W, items):
    return '%d %d\n%s' % (len(items), W, ''.join('%d %d\n' % it for it in items))
tests = [t(10, [(5, 10), (4, 40), (6, 30), (3, 50)]), t(5, [(6, 100)]), t(50, [(10, 60), (20, 100), (30, 120)]),
         t(7, [(7, 1)]), t(1, [(1, 10**9)] * 3)]
tests.append(t(30, [(rng.randint(1, 15), rng.randint(1, 100)) for _ in range(12)]))
tests.append(t(100, [(rng.randint(1, 40), rng.randint(1, 1000)) for _ in range(25)]))
tests.append(t(1000, [(rng.randint(1, 300), rng.randint(1, 10**6)) for _ in range(200)]))
tests.append(t(5000, [(rng.randint(1, 100), rng.randint(10**8, 10**9)) for _ in range(500)]))   # big sums: 64 bits
tests.append(t(5000, [(rng.randint(2000, 5000), rng.randint(1, 10**9)) for _ in range(500)]))
tests.append(t(4999, [(rng.randint(1, 5000), rng.randint(1, 10**9)) for _ in range(500)]))
tests.append(t(5000, [(1, 1)] * 400 + [(5000, 10**9)] * 100))                                    # many tiny vs one huge
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
