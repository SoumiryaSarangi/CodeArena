import sys
data = sys.stdin.read().split()
n = int(data[0])
rows = [(data[1 + 2 * i], int(data[2 + 2 * i])) for i in range(n)]
rows.sort(key=lambda r: (-r[1], r[0]))
print('\n'.join('%s %d' % r for r in rows))
