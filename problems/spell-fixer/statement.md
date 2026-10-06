# Spell Fixer

A text editor suggests corrections by counting how many single-letter edits turn a typed word $a$ into a dictionary word $b$. One edit is any of:

- insert one letter anywhere,
- delete one letter,
- replace one letter with another letter.

Find the smallest number of edits that turns $a$ into $b$.

## Input

Two lines. The first contains the word $a$, the second the word $b$. Both consist of 1 to 1500 lowercase Latin letters.

## Output

Print the minimum number of edits.

## Notes

In the first example `kitten` becomes `sitting` in three edits: replace `k` by `s`, replace `e` by `i`, insert `g`.
