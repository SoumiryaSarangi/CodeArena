Scan left to right and remember, for each value already seen, the position of an earlier banknote carrying it (a hash map). For $a_j$, look up $T - a_j$: if present, its stored position $i < j$ completes the pair. $O(n)$ expected. Sorting and walking two pointers from both ends also works in $O(n \log n)$.

Looking at every pair is $O(n^2)$. Looking up $T - a_j$ among *all* positions, including $j$ itself, wrongly pairs a banknote with itself when $2a_j = T$.

The answer is not unique, so the problem has a custom checker: it verifies $i < j$, the indices and the sum, and that `-1` is printed exactly when no pair exists.
