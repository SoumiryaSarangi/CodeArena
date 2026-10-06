Breadth-first search from computer 1 over the adjacency lists: the first time a computer is reached is by a shortest route. $O(n + m)$.

A depth-first search reaches every computer but not along shortest routes. Repeating "relax every cable" passes until nothing changes needs as many passes as the longest shortest route, up to $n$, so $O(nm)$ in the worst case.
