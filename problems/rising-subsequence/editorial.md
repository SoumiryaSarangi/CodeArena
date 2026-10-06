Keep an array $t$ where $t[k]$ is the smallest possible last height of a strictly increasing subsequence of length $k+1$; it stays sorted. For each $h$, binary search the first $t[k] \ge h$ (`lower_bound`) and overwrite it with $h$, or append if none: the answer is the final size of $t$. $O(n\log n)$.

Using `upper_bound` allows equal heights (non-decreasing subsequence): wrong here. The textbook $dp[i] = 1 + \max_{j<i,\,h_j<h_i} dp[j]$ is $O(n^2)$.
