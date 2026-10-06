#include <algorithm>
#include <cstdio>
#include <utility>
#include <vector>
int main() {
    int n;
    if (std::scanf("%d", &n) != 1) return 1;
    std::vector<std::pair<int, int>> v(n);   // (start, end)
    for (auto& p : v)
        if (std::scanf("%d %d", &p.first, &p.second) != 2) return 1;
    std::sort(v.begin(), v.end());           // by start time: a long early meeting blocks everything
    int taken = 0, free_at = 0;
    for (auto& [s, e] : v)
        if (s >= free_at) { taken++; free_at = e; }
    std::printf("%d\n", taken);
}
