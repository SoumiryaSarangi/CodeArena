# Hall of Fame

A programming club publishes its leaderboard. Each member has a name and a score. The board lists members from the highest score to the lowest; members with the same score are listed in alphabetical order of their names.

Print the board.

## Input

The first line contains $n$ ($1 \le n \le 4 \cdot 10^4$). Each of the next $n$ lines contains a name (1 to 10 lowercase Latin letters) and a score (an integer from $0$ to $10^6$) separated by a space. Several members may share a name and score.

## Output

Print $n$ lines in leaderboard order, each as `name score`.

## Notes

In the first example `bea` and `ada` both have $90$ points, so `ada` comes first; `cy` has $120$ and leads the board.

Compare names by ordinary alphabetical (lexicographic) order.
