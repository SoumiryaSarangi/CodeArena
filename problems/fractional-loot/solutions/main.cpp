#include <algorithm>
#include <cstdio>
#include <utility>
#include <vector>
int main() {
    int n;
    long long W;
    if (std::scanf("%d %lld", &n, &W) != 2) return 1;
    std::vector<std::pair<long long, long long>> s(n);   // (weight, value)
    for (auto& p : s)
        if (std::scanf("%lld %lld", &p.first, &p.second) != 2) return 1;
    std::sort(s.begin(), s.end(), [](const auto& a, const auto& b) { return a.second * b.first > b.second * a.first; });
    double total = 0;
    for (auto& [w, v] : s) {
        if (W <= 0) break;
        long long take = std::min(W, w);
        total += (double)v * take / w;
        W -= take;
    }
    std::printf("%.9f\n", total);
}
