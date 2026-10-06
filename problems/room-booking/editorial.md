Sort requests by finishing time and sweep: accept a request if it starts at or after the end of the last accepted one. Taking the request that frees the room earliest never hurts (exchange argument). $O(n\log n)$.

Sorting by start time, or taking the shortest meetings first, both have counter-examples ($[1,10],[2,3],[4,5]$ breaks the first). An $O(n^2)$ DP over all pairs is too slow.
