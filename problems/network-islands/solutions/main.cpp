#include <algorithm>
#include <cstdio>
#include <numeric>
#include <vector>
std::vector<int> p, sz;
int find(int x) {
    while (p[x] != x) x = p[x] = p[p[x]];
    return x;
}
int main() {
    int n, m;
    if (std::scanf("%d %d", &n, &m) != 2) return 1;
    p.resize(n + 1);
    std::iota(p.begin(), p.end(), 0);
    sz.assign(n + 1, 1);
    int comps = n;
    for (int i = 0; i < m; i++) {
        int u, v;
        if (std::scanf("%d %d", &u, &v) != 2) return 1;
        u = find(u);
        v = find(v);
        if (u == v) continue;
        if (sz[u] < sz[v]) std::swap(u, v);
        p[v] = u;
        sz[u] += sz[v];
        comps--;
    }
    int best = 0;
    for (int i = 1; i <= n; i++) best = std::max(best, sz[find(i)]);
    std::printf("%d %d\n", comps, best);
}
