import random
rng = random.Random(1020)
def w(n, alpha='abcdefghijklmnopqrstuvwxyz'):
    return ''.join(rng.choice(alpha) for _ in range(n))
def t(a, b):
    return a + '\n' + b + '\n'
N = 200000
tests = [t('abababa', 'aba'), t('aaaa', 'b'), t('a', 'a'), t('aaaa', 'aa'), t('abc', 'abcd'), t('mississippi', 'issi')]
tests.append(t(w(50, 'ab'), w(3, 'ab')))
tests.append(t(w(1000, 'ab'), 'abab'))
tests.append(t(w(N), w(2)))
tests.append(t('a' * N, 'a' * 100000))                      # overlapping everywhere
tests.append(t('a' * N, 'a' * 100000 + 'b'))                # naive scanning: about 10^10 comparisons
tests.append(t('ab' * (N // 2), 'ab' * 40000))
tests.append(t(w(N, 'ab'), w(20, 'ab')))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
