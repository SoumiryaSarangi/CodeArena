Precompute $p_i = a_1 + \dots + a_i$ with $p_0 = 0$; the answer to $(l, r)$ is $p_r - p_{l-1}$. $O(n + q)$.

Re-adding the range for every question is $O(nq)$, up to $10^{10}$ steps. Prefix sums must be 64-bit: they reach $10^{14}$.
