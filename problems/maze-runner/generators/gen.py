import random
rng = random.Random(1009)
def t(rows):
    return '%d %d\n%s' % (len(rows), len(rows[0]), ''.join(r + '\n' for r in rows))
def put(grid, r, c, ch):
    grid[r][c] = ch
def render(grid):
    return [''.join(row) for row in grid]
tests = [t(['S..#.', '.#...', '.#.#.', '...#T']), t(['S#T', '.#.']), t(['ST']), t(['S', '#', 'T']), t(['S.T'])]
def random_maze(n, m, p):
    g = [['#' if rng.random() < p else '.' for _ in range(m)] for _ in range(n)]
    put(g, 0, 0, 'S')
    put(g, n - 1, m - 1, 'T')
    return g
tests.append(t(render(random_maze(8, 10, 0.3))))
tests.append(t(render(random_maze(40, 40, 0.35))))
tests.append(t(render(random_maze(500, 500, 0.28))))                 # big, mostly open
g = random_maze(500, 500, 0.5)                                        # big, dense: usually unreachable
tests.append(t(render(g)))
n = m = 499                                                           # one long snake: shortest path ~ n*m/2
g = [['.'] * m for _ in range(n)]
for r in range(1, n, 2):
    for c in range(m):
        g[r][c] = '#'
    g[r][m - 1 if (r // 2) % 2 == 0 else 0] = '.'
put(g, 0, 0, 'S')
put(g, n - 1, m - 1, 'T')
tests.append(t(render(g)))
g = [['.'] * 500 for _ in range(500)]                                 # wide open
put(g, 0, 0, 'S')
put(g, 499, 499, 'T')
tests.append(t(render(g)))
for i, t in enumerate(tests, 1):
  with open('tests/%02d.in' % i, 'w') as f:
      f.write(t)
