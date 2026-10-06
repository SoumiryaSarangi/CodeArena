# Hop Distances

A network has $n$ computers numbered $1$ to $n$ and $m$ cables; each cable connects two computers and works in both directions. A message sent over one cable counts as one hop.

For every computer, find the minimum number of hops a message needs to travel from computer $1$ to it, or report that it cannot be reached.

## Input

The first line contains $n$ and $m$ ($1 \le n, m \le 5 \cdot 10^4$). Each of the next $m$ lines contains two integers $u$ and $v$ ($1 \le u, v \le n$) describing a cable. Two computers may be joined by several cables, and a cable may connect a computer to itself.

## Output

Print $n$ integers separated by spaces: for each computer $i$ from $1$ to $n$, the minimum number of hops from computer $1$, or $-1$ if it is unreachable.

## Notes

In the first example computers $2$ and $4$ are adjacent to computer $1$; computers $3$ and $5$ are two hops away; computer $6$ has no cable at all.
