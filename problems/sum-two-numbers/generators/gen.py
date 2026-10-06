import random
rng = random.Random(1001)
M = 10**18
tests = ['2 3\n', '-7 4\n', '0 0\n', '%d %d\n' % (M, M), '%d %d\n' % (-M, -M), '2147483647 1\n',
         '-2147483648 -1\n', '%d %d\n' % (M, -M), '3000000000 4000000000\n']
for _ in range(3):
    tests.append('%d %d\n' % (rng.randint(-M, M), rng.randint(-M, M)))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
