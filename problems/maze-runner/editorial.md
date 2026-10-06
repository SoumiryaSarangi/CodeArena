Every move costs the same, so breadth-first search from `S` finds shortest distances: process squares in order of distance with a queue, mark each square once. $O(nm)$.

Counting squares on the route instead of moves is off by one. Repeating a relaxation sweep over the whole grid until nothing changes needs as many sweeps as the longest shortest path, which is about $nm/2$ in a snake-shaped maze: far too slow.
