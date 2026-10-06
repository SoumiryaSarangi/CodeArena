# Needle in Text

A search tool looks for a word $p$ (the *needle*) inside a long text $t$. An occurrence is a position where $p$ appears as a contiguous piece of $t$. Occurrences may overlap.

Count the occurrences.

## Input

Two lines. The first contains the text $t$, the second the needle $p$. Both consist of lowercase Latin letters and have length between $1$ and $2 \cdot 10^5$.

## Output

Print the number of positions $i$ such that $t_i t_{i+1} \dots t_{i+|p|-1} = p$.

## Notes

In the first example `aba` occurs in `abababa` at positions $1$, $3$ and $5$; the occurrences share letters.
