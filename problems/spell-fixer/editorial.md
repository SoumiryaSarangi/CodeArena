Let $d[i][j]$ be the distance between the first $i$ letters of $a$ and the first $j$ of $b$. $d[i][0] = i$, $d[0][j] = j$, and
$d[i][j] = \min(d[i-1][j] + 1,\; d[i][j-1] + 1,\; d[i-1][j-1] + [a_i \ne b_j])$. The answer is $d[|a|][|b|]$. $O(|a||b|)$ time, and two rows of memory are enough.

Charging $2$ for a replacement (a deletion plus an insertion) computes a different distance. The same recurrence written as plain recursion repeats subproblems exponentially.
