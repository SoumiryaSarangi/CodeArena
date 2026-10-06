Sort a copy and count positions where the value differs from its predecessor, or insert everything into a hash set. $O(n \log n)$ or $O(n)$ expected.

Comparing every pair is $O(n^2)$. Counting only *adjacent* differences in the unsorted list is wrong: $5,3,5$ has two distinct values, not three.
