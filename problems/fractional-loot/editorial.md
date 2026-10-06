Because sacks can be split, the best use of each kilogram is the sack with the highest value per kilogram $v_i / w_i$. Sort by that ratio (compare $v_i w_j$ with $v_j w_i$ in integers to avoid rounding), take whole sacks while they fit, then a fraction of the next. $O(n \log n)$.

Taking only whole sacks is the 0/1 knapsack problem, a different (harder) one. Rescanning for the best remaining ratio $n$ times is $O(n^2)$. Print with enough digits (`%.9f`); the checker accepts $10^{-6}$ relative or absolute error.
