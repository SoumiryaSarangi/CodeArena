# Two Numbers, One Total

A market stall records every day's profit as a signed whole number: positive for a gain, negative for a loss. At the end of two days the owner wants the combined result.

Given the profits $a$ and $b$ of the two days, print $a + b$.

## Input

One line with two integers $a$ and $b$ separated by a space.

$-10^{18} \le a, b \le 10^{18}$.

## Output

Print one integer: $a + b$.

## Notes

In the first example the stall gains $2$ on one day and $3$ on the other, so the total is $5$.

The answer can be as large as $2 \cdot 10^{18}$, which does not fit in a 32-bit integer but does fit in a signed 64-bit one.
