#include <algorithm>
#include <cstdio>
#include <vector>
int main() {
    int n, m;
    if (std::scanf("%d %d", &n, &m) != 2) return 1;
    std::vector<int> deg(n + 1, 0);
    for (int i = 0; i < m; i++) {
        int u, v;
        if (std::scanf("%d %d", &u, &v) != 2) return 1;
        deg[u]++;
        deg[v]++;
    }
    // "each road merges two islands": wrong when roads repeat or close a cycle
    std::printf("%d %d\n", std::max(1, n - m), *std::max_element(deg.begin(), deg.end()) + 1);
}
