import random
rng = random.Random(1015)
def t(a):
    return '%d\n%s\n' % (len(a), ' '.join(map(str, a)))
tests = [t([10, 9, 2, 5, 3, 7, 101, 18]), t([7]), t([5, 5, 5, 5]), t([1, 2, 2, 3, 3, 4]), t([4, 3, 2, 1])]
tests.append(t([rng.randint(1, 10) for _ in range(40)]))
tests.append(t([rng.randint(1, 10**9) for _ in range(1000)]))
n = 60000
tests.append(t(list(range(1, n + 1))))                                   # already increasing
tests.append(t([rng.randint(1, 10**6) for _ in range(n)]))
tests.append(t([rng.randint(1, 300) for _ in range(n)]))                 # many equal values
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
