import sys
data = sys.stdin.read().split()
n, W = int(data[0]), int(data[1])
# a different table: best[i][c] kept as one row, built with slices instead of an index loop
best = [0] * (W + 1)
for i in range(n):
    w, v = int(data[2 + 2 * i]), int(data[3 + 2 * i])
    if w > W:
        continue
    shifted = [x + v for x in best[:W + 1 - w]]
    best = best[:w] + [a if a > b else b for a, b in zip(best[w:], shifted)]
print(best[W])
