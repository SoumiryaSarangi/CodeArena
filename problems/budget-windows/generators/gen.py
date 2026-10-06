import random
rng = random.Random(1006)
def t(s, a):
    return '%d %d\n%s\n' % (len(a), s, ' '.join(map(str, a)))
tests = [t(7, [2, 3, 1, 4, 2]), t(1, [1]), t(5, [6]), t(10**9, [10000] * 5)]
tests.append(t(20, [rng.randint(1, 10) for _ in range(30)]))
tests.append(t(1000, [rng.randint(1, 100) for _ in range(500)]))
n = 70000
tests.append(t(10**9, [rng.randint(1, 10) for _ in range(n)]))        # every window is affordable: answer > 2^31
tests.append(t(10**9, [1] * n))
tests.append(t(30, [rng.randint(1, 10) for _ in range(n)]))           # tiny budget
tests.append(t(250000, [rng.randint(1, 10000) for _ in range(n)]))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
