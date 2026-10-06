# Cheapest Route

A delivery company works in a country with $n$ towns and $m$ two-way roads. Using the road between towns $u$ and $v$ costs $w$ coins in fuel.

Find the smallest total fuel cost of a trip from town $1$ to town $n$, or report that the trip is impossible.

## Input

The first line contains $n$ and $m$ ($2 \le n \le 5 \cdot 10^4$, $1 \le m \le 5 \cdot 10^4$). Each of the next $m$ lines contains $u$, $v$ and $w$ ($1 \le u, v \le n$, $1 \le w \le 10^6$): a road between $u$ and $v$ with cost $w$. Roads may repeat.

## Output

Print the minimum total cost of a route from town $1$ to town $n$, or $-1$ if no route exists.

## Notes

In the first example the cheapest route is $1 \to 3 \to 2 \to 4 \to 5$ with costs $1 + 2 + 5 + 3 = 11$; going $3 \to 4$ directly costs $8$ instead of $2 + 5 = 7$ and loses.

A route can cost up to about $5 \cdot 10^{10}$, more than a 32-bit integer holds.
