# Maze Runner

A robot stands on square `S` of a rectangular maze and has to reach square `T`. Each square is either free (`.`) or a wall (`#`); `S` and `T` are free squares. In one move the robot steps to a free square sharing a side with its current one (up, down, left or right). It cannot leave the maze.

Find the smallest number of moves needed, or report that `T` cannot be reached.

## Input

The first line contains $n$ and $m$ ($1 \le n, m \le 500$, and $n \cdot m \ge 2$). Each of the next $n$ lines contains $m$ characters from `.`, `#`, `S`, `T`. The characters `S` and `T` each appear exactly once.

## Output

Print the minimum number of moves, or $-1$ if there is no route.

## Notes

In the first example the shortest route goes right along the top row, down through the middle and into the corner: $7$ moves. Going around the walls on the left needs $11$.
