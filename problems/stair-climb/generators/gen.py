import random
rng = random.Random(1013)
def t(n, broken):
    return '%d %d\n%s\n' % (n, len(broken), ' '.join(map(str, broken)))
tests = [t(5, [3]), t(3, []), t(1, []), t(2, [1]), t(4, [1, 2, 3])]
tests.append(t(12, [4, 9]))
tests.append(t(60, rng.sample(range(1, 60), 6)))
tests.append(t(1000, rng.sample(range(1, 1000), 100)))
tests.append(t(1000000, []))                                          # large answer: needs the modulus
tests.append(t(1000000, rng.sample(range(1, 1000000), 100000)))
tests.append(t(1000000, [500000]))
tests.append(t(999999, rng.sample(range(1, 999999), 50)))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
