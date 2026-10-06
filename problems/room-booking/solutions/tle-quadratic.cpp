#include <algorithm>
#include <cstdio>
#include <utility>
#include <vector>
int main() {
    int n;
    if (std::scanf("%d", &n) != 1) return 1;
    std::vector<std::pair<int, int>> v(n);   // (end, start)
    for (auto& p : v)
        if (std::scanf("%d %d", &p.second, &p.first) != 2) return 1;
    std::sort(v.begin(), v.end());
    std::vector<int> best(n, 1);
    int ans = 0;
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < i; j++)
            if (v[j].first <= v[i].second) best[i] = std::max(best[i], best[j] + 1);   // O(n^2) over all pairs
        ans = std::max(ans, best[i]);
    }
    std::printf("%d\n", ans);
}
