#include <cstdio>
#include <vector>
std::vector<std::vector<int>> adj;
std::vector<int> dist;
int main() {
    int n, m;
    if (std::scanf("%d %d", &n, &m) != 2) return 1;
    adj.assign(n + 1, {});
    for (int i = 0; i < m; i++) {
        int u, v;
        if (std::scanf("%d %d", &u, &v) != 2) return 1;
        adj[u].push_back(v);
        adj[v].push_back(u);
    }
    dist.assign(n + 1, -1);
    // iterative DFS: the depth at which a vertex is first found is not its shortest distance
    std::vector<int> st = {1};
    dist[1] = 0;
    while (!st.empty()) {
        int v = st.back();
        st.pop_back();
        for (int u : adj[v])
            if (dist[u] < 0) { dist[u] = dist[v] + 1; st.push_back(u); }
    }
    for (int i = 1; i <= n; i++) std::printf("%d%c", dist[i], i < n ? ' ' : '\n');
}
