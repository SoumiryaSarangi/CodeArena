import random
rng = random.Random(1005)
def t(a, xs):
    return '%d %d\n%s\n%s\n' % (len(a), len(xs), ' '.join(map(str, a)), ' '.join(map(str, xs)))
tests = [t([2, 4, 4, 7], [4, 5, 8]), t([1], [1, 2, 10**9])]
tests.append(t([5] * 10, [1, 5, 6]))
a = sorted(rng.randint(1, 30) for _ in range(40))
tests.append(t(a, list(range(1, 33))))
a = sorted(rng.randint(1, 10**9) for _ in range(1000))
tests.append(t(a, [rng.choice(a) for _ in range(500)] + [rng.randint(1, 10**9) for _ in range(500)]))
tests.append(t([10**9] * 100, [10**9, 1, 10**9]))
n = 50000
a = sorted(rng.randint(1, 10**6) for _ in range(n))
tests.append(t(a, [a[-1 - rng.randint(0, 50)] for _ in range(50000)]))           # answers near the end
a = list(range(1, n + 1))
tests.append(t(a, [rng.randint(n - 500, n + 1) for _ in range(50000)]))
a = sorted(rng.randint(1, 1000) for _ in range(n))
tests.append(t(a, [rng.randint(900, 1000) for _ in range(50000)]))              # many duplicates
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
