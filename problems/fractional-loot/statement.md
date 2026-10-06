# Fractional Loot

A baker is given $n$ sacks of ingredients and can carry total weight at most $W$. Sack $i$ weighs $w_i$ kilograms and is worth $v_i$ coins, and it can be split: taking a fraction $x$ of a sack ($0 \le x \le 1$) gives $x \cdot w_i$ kilograms of weight and $x \cdot v_i$ coins of value.

Find the largest total value the baker can carry.

## Input

The first line contains $n$ and $W$ ($1 \le n \le 5 \cdot 10^4$, $1 \le W \le 10^9$). Each of the next $n$ lines contains $w_i$ and $v_i$ ($1 \le w_i, v_i \le 10^6$).

## Output

Print one real number: the maximum total value. An answer with absolute or relative error at most $10^{-6}$ is accepted.

## Notes

In the first example the baker takes the first two sacks completely ($60 + 100$) and $20$ of the $30$ kilograms of the third, worth $\frac{2}{3} \cdot 120 = 80$: $240$ in total.
