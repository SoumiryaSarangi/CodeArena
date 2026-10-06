# Stair Climb

Nora stands at the bottom of a staircase with $n$ steps, numbered $1$ to $n$ (she starts on the floor, step $0$). In one move she climbs $1$, $2$ or $3$ steps. Exactly $k$ of the steps are broken and she must never stand on them. The floor and the top step are never broken.

Count the different sequences of moves that take her from the floor to step $n$. Two sequences are different if they differ in at least one move. Print the count modulo $10^9 + 7$.

## Input

The first line contains $n$ and $k$ ($1 \le n \le 10^6$, $0 \le k \le \min(n - 1, 10^5)$). The second line contains $k$ distinct integers, the numbers of the broken steps, each from $1$ to $n - 1$, in any order (the line is empty when $k = 0$).

## Output

Print the number of ways modulo $10^9 + 7$.

## Notes

In the first example step $3$ is broken. The five ways are $1+1+2+1$, $1+1+3$, $1+3+1$, $2+2+1$ and $2+3$.

In the second example nothing is broken and the sequences of $3$ are $1+1+1$, $1+2$, $2+1$, $3$: $4$ ways.
