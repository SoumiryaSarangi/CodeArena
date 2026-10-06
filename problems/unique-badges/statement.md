# Unique Badges

At a conference every attendee scans a badge at the door, and the scanner records the badge number. Some people leave and come back, so a number can appear several times.

Count how many **different** badge numbers were scanned.

## Input

The first line contains $n$ ($1 \le n \le 8\cdot10^4$), the number of scans. The second line contains $n$ integers $b_1, \dots, b_n$ ($1 \le b_i \le 10^6$).

## Output

Print one integer: the number of distinct values among $b_1, \dots, b_n$.

## Notes

In the first example the scans are $5, 3, 5, 5, 3, 8$, so there are three different badges: $3$, $5$ and $8$.
