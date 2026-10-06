# Matching Pair

A cashier has $n$ banknotes lying in a row, each with a value, and needs to hand a customer exactly $T$ using **two different** banknotes.

Find two positions $i < j$ with $a_i + a_j = T$, or report that there is no such pair. If several pairs exist, print any of them.

## Input

The first line contains $n$ and $T$ ($2 \le n \le 6 \cdot 10^4$, $-2 \cdot 10^9 \le T \le 2 \cdot 10^9$). The second line contains $n$ integers $a_1, \dots, a_n$ ($-10^9 \le a_i \le 10^9$).

## Output

Print two integers $i$ and $j$ ($1 \le i < j \le n$) with $a_i + a_j = T$, or print `-1` if no such pair exists.

## Notes

In the first example only the first two banknotes work: $2 + 7 = 9$.

Any valid pair is accepted, so your answer may differ from the sample output. A banknote cannot be used twice: with $a = [5, 1]$ and $T = 10$ the answer is $-1$.
