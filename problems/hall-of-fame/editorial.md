Sort with a comparator: larger score first, and for equal scores the smaller name first. $O(n \log n)$.

Sorting by score alone is not enough: library sorts are not stable by default, and even a stable sort would only keep the *input* order of ties, not the alphabetical one. An insertion or bubble sort is $O(n^2)$, too slow at $4\cdot10^4$.
