Use a disjoint-set union (union-find) with path compression and union by size. Start with $n$ sets; each road merges two sets (or does nothing if the towns are already together). The number of islands is the number of sets left and the largest island is the largest set size. Almost $O((n+m)\alpha(n))$.

Computing "$n - m$" is wrong as soon as roads repeat or form cycles. Flooding from every town without remembering what was already explored is $O(n(n+m))$.
