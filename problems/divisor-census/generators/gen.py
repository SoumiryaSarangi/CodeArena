import random
rng = random.Random(1019)
def t(xs):
    return '%d\n%s\n' % (len(xs), ' '.join(map(str, xs)))
tests = [t([12, 7, 1]), t([1]), t([500000]), t([499979, 499973]), t([36, 49, 64, 100, 144, 225])]
tests.append(t(list(range(1, 51))))
tests.append(t([rng.randint(1, 1000) for _ in range(500)]))
tests.append(t([rng.randint(1, 500000) for _ in range(5000)]))
tests.append(t([rng.randint(490000, 500000) for _ in range(50000)]))               # all large: trial division is hopeless
tests.append(t([i * i for i in range(1, 708)] + [498960] * 200))                   # perfect squares and a highly composite number
tests.append(t([1] * 50000))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
