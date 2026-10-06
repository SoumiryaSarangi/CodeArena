# Peak Reading

A weather station logs $n$ temperature readings in the order they were taken. The station manager wants to know the highest reading and when it first happened.

Print the largest value in the log and the position of its **first** occurrence.

## Input

The first line contains $n$ ($1 \le n \le 5\cdot10^4$). The second line contains $n$ integers $a_1, \dots, a_n$ ($-10^9 \le a_i \le 10^9$).

## Output

Print two integers separated by a space: the maximum value and the smallest 1-based index $i$ with $a_i$ equal to it.

## Notes

In the first example the maximum is $9$. It appears at positions $2$ and $4$, and the first one counts.
