#include <algorithm>
#include <cstdio>
#include <vector>
int main() {
    int n, W;
    if (std::scanf("%d %d", &n, &W) != 2) return 1;
    std::vector<std::pair<int, long long>> it(n);
    for (auto& p : it)
        if (std::scanf("%d %lld", &p.first, &p.second) != 2) return 1;
    // best value per unit of weight first: a heuristic, not the optimum
    std::sort(it.begin(), it.end(), [](const auto& a, const auto& b) { return a.second * b.first > b.second * a.first; });
    long long total = 0;
    for (auto& [w, v] : it)
        if (w <= W) { W -= w; total += v; }
    std::printf("%lld\n", total);
}
