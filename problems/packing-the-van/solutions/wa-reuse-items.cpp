#include <algorithm>
#include <cstdio>
#include <vector>
int main() {
    int n, W;
    if (std::scanf("%d %d", &n, &W) != 2) return 1;
    std::vector<long long> dp(W + 1, 0);
    for (int i = 0; i < n; i++) {
        int w;
        long long v;
        if (std::scanf("%d %lld", &w, &v) != 2) return 1;
        for (int c = w; c <= W; c++) dp[c] = std::max(dp[c], dp[c - w] + v);  // upwards: a parcel can be taken again
    }
    std::printf("%lld\n", dp[W]);
}
