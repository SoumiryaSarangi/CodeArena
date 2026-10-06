Classic 0/1 knapsack. Let $dp[c]$ be the best value using weight at most $c$ over the parcels seen so far. For each parcel iterate $c$ from $W$ **down** to $w_i$ and set $dp[c] = \max(dp[c], dp[c - w_i] + v_i)$; going downwards guarantees every parcel is used at most once. $O(nW)$, 64-bit values.

Iterating $c$ upwards lets a parcel be reused (unbounded knapsack). Picking by value-per-weight ratio is a greedy heuristic that fails, e.g. $W=50$ with $(10,60), (20,100), (30,120)$: greedy gets $160$, the optimum is $220$. Trying every subset is $O(2^n)$.
