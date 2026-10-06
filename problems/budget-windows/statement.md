# Budget Windows

A small shop spends a positive amount of money each day for $n$ days. The owner calls a stretch of consecutive days a *window*, and a window is *affordable* if the total spent over its days is at most the budget $S$.

Count the affordable windows. Two windows are different if they start or end on different days, and a window contains at least one day.

## Input

The first line contains $n$ and $S$ ($1 \le n \le 7 \cdot 10^4$, $1 \le S \le 10^9$). The second line contains $n$ integers $a_1, \dots, a_n$ ($1 \le a_i \le 10^4$), the daily spending.

## Output

Print the number of pairs $(l, r)$ with $1 \le l \le r \le n$ and $a_l + \dots + a_r \le S$.

## Notes

In the first example the spending is $2, 3, 1, 4, 2$ and $S = 7$. All five single days are affordable, four of the five windows of length two, two of the three of length three ($2+3+1 = 6$ and $1+4+2 = 7$) and none longer: $5 + 4 + 2 = 11$.

With $n = 7\cdot10^4$ the answer can reach about $2.4\cdot10^9$, more than a 32-bit integer holds ($2^{31} \approx 2.1\cdot10^9$).
