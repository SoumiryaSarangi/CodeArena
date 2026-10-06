import random
rng = random.Random(1017)
def t(iv):
    return '%d\n%s' % (len(iv), ''.join('%d %d\n' % p for p in iv))
tests = [t([(1, 3), (2, 5), (3, 6), (5, 7), (6, 9)]), t([(0, 1)]), t([(1, 10), (2, 3), (4, 5)]),
         t([(0, 5), (5, 10), (10, 15), (0, 15)]), t([(0, 1000000)] * 4)]
def rnd(n, lo, hi, maxlen):
    out = []
    for _ in range(n):
        s = rng.randint(lo, hi - 1)
        out.append((s, min(hi, s + rng.randint(1, maxlen))))
    return out
tests.append(t(rnd(40, 0, 100, 15)))
tests.append(t(rnd(2000, 0, 10**6, 5000)))
n = 60000
tests.append(t(rnd(n, 0, 10**6, 30)))                         # many short meetings
tests.append(t(rnd(30000, 0, 10**6, 10**6)))                  # mostly long meetings
tests.append(t([(i, i + 1) for i in range(20000)]))            # all fit
tests.append(t([(0, 10**6)] + [(i, i + 20) for i in range(19999)]))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
