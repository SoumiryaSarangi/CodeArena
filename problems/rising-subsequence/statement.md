# Rising Subsequence

A gardener planted $n$ flowers in a row and measured their heights. She wants to pick some of them, keeping their left-to-right order, so that each picked flower is **strictly taller** than the previous picked one.

Find the largest number of flowers she can pick.

## Input

The first line contains $n$ ($1 \le n \le 6 \cdot 10^4$). The second line contains $n$ integers $h_1, \dots, h_n$ ($1 \le h_i \le 10^9$).

## Output

Print the maximum length of a strictly increasing subsequence.

## Notes

In the first example the heights are $10, 9, 2, 5, 3, 7, 101, 18$ and one longest choice is $2, 5, 7, 101$ (length $4$). Equal heights cannot both be picked.
