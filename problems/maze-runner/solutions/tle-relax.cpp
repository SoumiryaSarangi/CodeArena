#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>
int main() {
    int n, m;
    if (std::scanf("%d %d", &n, &m) != 2) return 1;
    std::vector<std::string> g(n);
    int s = 0, t = 0;
    char buf[600];
    for (int i = 0; i < n; i++) {
        if (std::scanf("%s", buf) != 1) return 1;
        g[i] = buf;
        for (int j = 0; j < m; j++) {
            if (g[i][j] == 'S') s = i * m + j;
            if (g[i][j] == 'T') t = i * m + j;
        }
    }
    const int INF = 1e9;
    std::vector<int> d(n * m, INF), nd;
    d[s] = 0;
    for (bool changed = true; changed;) {   // level-by-level relaxation of the whole grid
        changed = false;
        nd = d;
        for (int r = 0; r < n; r++)
            for (int c = 0; c < m; c++) {
                if (g[r][c] == '#') continue;
                int best = d[r * m + c];
                if (r > 0) best = std::min(best, d[(r - 1) * m + c] + 1);
                if (r + 1 < n) best = std::min(best, d[(r + 1) * m + c] + 1);
                if (c > 0) best = std::min(best, d[r * m + c - 1] + 1);
                if (c + 1 < m) best = std::min(best, d[r * m + c + 1] + 1);
                if (best < nd[r * m + c]) { nd[r * m + c] = best; changed = true; }
            }
        d.swap(nd);
    }
    std::printf("%d\n", d[t] >= INF ? -1 : d[t]);
}
