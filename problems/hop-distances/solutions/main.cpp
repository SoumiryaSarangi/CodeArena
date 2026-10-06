#include <cstdio>
#include <queue>
#include <vector>
int main() {
    int n, m;
    if (std::scanf("%d %d", &n, &m) != 2) return 1;
    std::vector<std::vector<int>> adj(n + 1);
    for (int i = 0; i < m; i++) {
        int u, v;
        if (std::scanf("%d %d", &u, &v) != 2) return 1;
        adj[u].push_back(v);
        adj[v].push_back(u);
    }
    std::vector<int> dist(n + 1, -1);
    std::queue<int> q;
    dist[1] = 0;
    q.push(1);
    while (!q.empty()) {
        int v = q.front();
        q.pop();
        for (int u : adj[v])
            if (dist[u] < 0) { dist[u] = dist[v] + 1; q.push(u); }
    }
    for (int i = 1; i <= n; i++) std::printf("%d%c", dist[i], i < n ? ' ' : '\n');
}
