# Rainfall Totals

A village measures the rainfall of $n$ consecutive days. The council keeps asking questions of the form "how much rain fell from day $l$ to day $r$, inclusive?".

Answer every question.

## Input

The first line contains $n$ and $q$ ($1 \le n, q \le 5\cdot10^4$). The second line contains $n$ integers $a_1, \dots, a_n$ ($-10^9 \le a_i \le 10^9$), the rainfall (an instrument fault can make a day negative). Each of the next $q$ lines contains two integers $l$ and $r$ ($1 \le l \le r \le n$).

## Output

For each question print $a_l + a_{l+1} + \dots + a_r$ on its own line.

## Notes

In the first example the three questions ask for days $1$ to $5$, $2$ to $3$ and day $4$ alone: $15$, $5$ and $4$.

A single answer can be as large as $10^{14}$ in absolute value.
