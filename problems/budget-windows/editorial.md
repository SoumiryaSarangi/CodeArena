All $a_i$ are positive, so for a fixed right end $r$ the affordable left ends form a suffix of the prefix, and moving $r$ right never lets the smallest affordable $l$ move left. Keep a window $[l, r]$ and its sum: add $a_r$, then advance $l$ while the sum exceeds $S$; every $l'$ from $l$ to $r$ is then affordable, so add $r - l + 1$. $O(n)$.

Checking every window is $O(n^2)$ (about $2.4\cdot10^9$ pairs here). The count needs 64 bits.
