import random
rng = random.Random(1004)
def t(a):
    return '%d\n%s\n' % (len(a), ' '.join(map(str, a)))
tests = [t([5, 3, 5, 5, 3, 8]), t([1000000]), t([7] * 30), t(list(range(1, 31))),
         t([rng.randint(1, 5) for _ in range(40)]), t([rng.randint(1, 10**6) for _ in range(1000)]),
         t([rng.randint(1, 100) for _ in range(5000)])]
tests.append(t(list(range(1, 80001))))                              # all different
tests.append(t([rng.randint(1, 40000) for _ in range(80000)]))
tests.append(t([1] * 80000))                                        # all equal
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
