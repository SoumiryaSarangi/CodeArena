Knuth-Morris-Pratt: compute the prefix function of $p$ (for each prefix, the length of its longest proper border), then scan $t$ keeping the length of the longest prefix of $p$ that ends at the current letter; each time it reaches $|p|$ count an occurrence and fall back along the border. $O(|t| + |p|)$. The Z-function or hashing also work.

Comparing $p$ against every position letter by letter is $O(|t||p|)$, hopeless on `aaa…a` against `aaa…ab`. Jumping $|p|$ letters after a match skips overlapping occurrences.
