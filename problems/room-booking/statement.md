# Room Booking

A single meeting room receives $n$ booking requests. Request $i$ asks for the room from time $s_i$ until time $e_i$. Two accepted meetings must not overlap, but one may start at the very moment another ends.

Accept as many requests as possible. Print how many.

## Input

The first line contains $n$ ($1 \le n \le 6 \cdot 10^4$). Each of the next $n$ lines contains $s_i$ and $e_i$ ($0 \le s_i < e_i \le 10^6$).

## Output

Print the maximum number of requests that can be accepted together.

## Notes

In the first example the requests are $[1,3]$, $[2,5]$, $[3,6]$, $[5,7]$, $[6,9]$. Accepting $[1,3]$, $[3,6]$ and $[6,9]$ gives $3$; no choice gives $4$.
