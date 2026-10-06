One pass, keep the best value and its index, and replace them only when a reading is **strictly** greater: that keeps the first occurrence. $O(n)$.

Sorting with indices also works but is wasteful; a quadratic sort times out at $n=5\cdot10^4$.
