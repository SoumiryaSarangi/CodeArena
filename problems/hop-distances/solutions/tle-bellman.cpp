#include <cstdio>
#include <utility>
#include <vector>
int main() {
    int n, m;
    if (std::scanf("%d %d", &n, &m) != 2) return 1;
    std::vector<std::pair<int, int>> e(m);
    for (auto& p : e)
        if (std::scanf("%d %d", &p.first, &p.second) != 2) return 1;
    const int INF = 1e9;
    std::vector<int> dist(n + 1, INF);
    dist[1] = 0;
    for (bool changed = true; changed;) {   // relax every cable until nothing improves
        changed = false;
        for (auto& [u, v] : e) {
            if (dist[u] + 1 < dist[v]) { dist[v] = dist[u] + 1; changed = true; }
            if (dist[v] + 1 < dist[u]) { dist[u] = dist[v] + 1; changed = true; }
        }
    }
    for (int i = 1; i <= n; i++) std::printf("%d%c", dist[i] >= INF ? -1 : dist[i], i < n ? ' ' : '\n');
}
