import random
rng = random.Random(1016)
def w(n, alpha='abcdefghijklmnopqrstuvwxyz'):
    return ''.join(rng.choice(alpha) for _ in range(n))
def t(a, b):
    return a + '\n' + b + '\n'
tests = [t('kitten', 'sitting'), t('flaw', 'lawn'), t('a', 'a'), t('a', 'b'), t('abc', 'abc'), t('intention', 'execution')]
tests.append(t(w(12), w(9)))
tests.append(t(w(200, 'ab'), w(180, 'ab')))
tests.append(t(w(1500), w(1500)))
tests.append(t(w(1500, 'ab'), w(1500, 'ab')))
x = w(1500)
tests.append(t(x, x))
tests.append(t('a' * 1500, 'b' * 1500))
tests.append(t(x, w(1500)[:700]))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
