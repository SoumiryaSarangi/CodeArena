#include <cstdio>
#include <vector>
struct E { int u, v, w; };
int main() {
    int n, m;
    if (std::scanf("%d %d", &n, &m) != 2) return 1;
    std::vector<E> e(m);
    for (auto& x : e)
        if (std::scanf("%d %d %d", &x.u, &x.v, &x.w) != 3) return 1;
    const long long INF = 4e18;
    std::vector<long long> dist(n + 1, INF);
    dist[1] = 0;
    for (bool changed = true; changed;) {   // relax every road until nothing improves
        changed = false;
        for (auto& x : e) {
            if (dist[x.u] < INF && dist[x.u] + x.w < dist[x.v]) { dist[x.v] = dist[x.u] + x.w; changed = true; }
            if (dist[x.v] < INF && dist[x.v] + x.w < dist[x.u]) { dist[x.u] = dist[x.v] + x.w; changed = true; }
        }
    }
    std::printf("%lld\n", dist[n] == INF ? -1 : dist[n]);
}
