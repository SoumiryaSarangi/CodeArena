#include <cstdio>
#include <queue>
#include <utility>
#include <vector>
int main() {
    int n, m;
    if (std::scanf("%d %d", &n, &m) != 2) return 1;
    std::vector<std::vector<std::pair<int, int>>> adj(n + 1);
    for (int i = 0; i < m; i++) {
        int u, v, w;
        if (std::scanf("%d %d %d", &u, &v, &w) != 3) return 1;
        adj[u].push_back({v, w});
        adj[v].push_back({u, w});
    }
    const long long INF = 4e18;
    std::vector<long long> dist(n + 1, INF);
    std::priority_queue<std::pair<long long, int>, std::vector<std::pair<long long, int>>, std::greater<>> pq;
    dist[1] = 0;
    pq.push({0, 1});
    while (!pq.empty()) {
        auto [d, v] = pq.top();
        pq.pop();
        if (d > dist[v]) continue;
        for (auto [u, w] : adj[v])
            if (d + w < dist[u]) { dist[u] = d + w; pq.push({dist[u], u}); }
    }
    std::printf("%lld\n", dist[n] == INF ? -1 : dist[n]);
}
