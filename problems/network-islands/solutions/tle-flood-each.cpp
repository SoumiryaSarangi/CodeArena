#include <algorithm>
#include <cstdio>
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
    int comps = 0, best = 0;
    std::vector<int> mark(n + 1, 0), st;
    for (int s = 1; s <= n; s++) {          // flood from EVERY town, forgetting earlier floods
        int smallest = s, size = 0;
        st.assign(1, s);
        mark[s] = s;
        while (!st.empty()) {
            int v = st.back();
            st.pop_back();
            size++;
            smallest = std::min(smallest, v);
            for (int u : adj[v])
                if (mark[u] != s) { mark[u] = s; st.push_back(u); }
        }
        if (smallest == s) comps++;
        best = std::max(best, size);
    }
    std::printf("%d %d\n", comps, best);
}
