Dijkstra's algorithm: keep a priority queue of (distance, town), repeatedly settle the nearest unsettled town and relax its roads. All costs are positive, so a settled distance is final. $O((n+m)\log n)$. Distances need 64 bits.

Breadth-first search ignores costs. Repeating "relax every road" until nothing changes (Bellman-Ford) needs up to $n$ passes: $O(nm)$.
