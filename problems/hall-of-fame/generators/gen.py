import random
rng = random.Random(1007)
L = 'abcdefghijklmnopqrstuvwxyz'
def name(k=None):
    return ''.join(rng.choice(L) for _ in range(k or rng.randint(1, 10)))
def t(rows):
    return '%d\n%s' % (len(rows), ''.join('%s %d\n' % r for r in rows))
tests = [t([('bea', 90), ('ada', 90), ('cy', 120), ('dan', 5)]), t([('solo', 0)])]
tests.append(t([('zed', 7)] * 6))
tests.append(t([(name(3), rng.randint(0, 3)) for _ in range(60)]))                  # lots of ties
tests.append(t([(name(), rng.randint(0, 10**6)) for _ in range(2000)]))
tests.append(t([(name(1), 1000000) for _ in range(500)]))
n = 40000
tests.append(t([(name(), rng.randint(0, 10**6)) for _ in range(n)]))
tests.append(t([(name(), rng.randint(0, 20)) for _ in range(n)]))                   # heavy ties
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
