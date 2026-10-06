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
    int taken = 0, free_at = 0;
    for (auto& [e, s] : v)
        if (s >= free_at) { taken++; free_at = e; }
    std::printf("%d\n", taken);
}
