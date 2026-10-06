Let $f(i)$ be the number of ways to stand on step $i$: $f(0) = 1$, $f(i) = 0$ if step $i$ is broken, otherwise $f(i) = f(i-1) + f(i-2) + f(i-3)$ (terms with negative index are $0$), all modulo $10^9+7$. The answer is $f(n)$. $O(n)$.

The sum of three residues below $10^9+7$ reaches $3\cdot10^9$, which overflows a 32-bit `int` before the `%`: use 64 bits or reduce after each addition. Plain recursion without memoisation is exponential.
