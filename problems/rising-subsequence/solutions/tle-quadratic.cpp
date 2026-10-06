#include <algorithm>
#include <cstdio>
#include <vector>
int main() {
    int n;
    if (std::scanf("%d", &n) != 1) return 1;
    std::vector<int> h(n), dp(n, 1);
    for (int& x : h)
        if (std::scanf("%d", &x) != 1) return 1;
    int best = 0;
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < i; j++)
            if (h[j] < h[i]) dp[i] = std::max(dp[i], dp[j] + 1);   // O(n^2)
        best = std::max(best, dp[i]);
    }
    std::printf("%d\n", best);
}
