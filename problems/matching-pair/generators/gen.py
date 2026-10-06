import random
rng = random.Random(1008)
def t(T, a):
    return '%d %d\n%s\n' % (len(a), T, ' '.join(map(str, a)))
tests = [t(9, [2, 7, 11, 15, 1]), t(100, [1, 2, 3]), t(10, [5, 1]), t(10, [5, 5]), t(0, [-3, 3]),
         t(-7, [4, -9, 0, 2, -5, 2])]
a = [rng.randint(-50, 50) for _ in range(40)]
tests.append(t(101, a))                                   # impossible: too large
a = [rng.randint(-10**9, 10**9) for _ in range(2000)]
tests.append(t(a[3] + a[1500], a))
n = 60000
tests.append(t(2 * 10**9, [10**9] * 2000))                # pair of equal values, many candidates
a = [rng.randint(1, 10**9) for _ in range(n)]
tests.append(t(-1, a))                                    # no pair: forces a full scan
tests.append(t(10**9, [5 * 10**8] + [rng.randint(-10**9, 10**9) for _ in range(n - 2)] + [5 * 10**8]))  # a doubled value at the ends
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
