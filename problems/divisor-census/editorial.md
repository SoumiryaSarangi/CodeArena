All values are at most $M = 5\cdot10^5$, so precompute the divisor count of **every** number once: for each $d$ from $1$ to $M$, add $1$ to $\text{cnt}[d], \text{cnt}[2d], \text{cnt}[3d], \dots$. That is $M(1 + 1/2 + 1/3 + \dots) \approx M\ln M$ steps. Each question is then a lookup. (Factorising with a smallest-prime-factor sieve works too.)

Testing every number up to $x$ for every question is $O(qM)$. Counting only $d \le \sqrt{x}$ finds each divisor pair once and must add the partner $x/d$ (careful with perfect squares).
