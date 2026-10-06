The shelf is sorted, so binary search for the first index with $a_i \ge x$ ($O(\log n)$ per request); the library call `lower_bound` does exactly this.

A linear scan costs $O(nq)$, up to $10^{10}$ steps. Using `upper_bound` (first $a_i > x$) is the classic off-by-one: it skips the matching book.
