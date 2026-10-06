#include <cstdio>
#include <queue>
#include <string>
#include <vector>
int main() {
    int n, m;
    if (std::scanf("%d %d", &n, &m) != 2) return 1;
    std::vector<std::string> g(n);
    int sr = 0, sc = 0, tr = 0, tc = 0;
    char buf[600];
    for (int i = 0; i < n; i++) {
        if (std::scanf("%s", buf) != 1) return 1;
        g[i] = buf;
        for (int j = 0; j < m; j++) {
            if (g[i][j] == 'S') { sr = i; sc = j; }
            if (g[i][j] == 'T') { tr = i; tc = j; }
        }
    }
    std::vector<int> dist(n * m, -1);
    std::queue<int> q;
    dist[sr * m + sc] = 0;
    q.push(sr * m + sc);
    const int dr[] = {1, -1, 0, 0}, dc[] = {0, 0, 1, -1};
    while (!q.empty()) {
        int v = q.front();
        q.pop();
        int r = v / m, c = v % m;
        for (int k = 0; k < 4; k++) {
            int nr = r + dr[k], nc = c + dc[k];
            if (nr < 0 || nr >= n || nc < 0 || nc >= m || g[nr][nc] == '#' || dist[nr * m + nc] != -1) continue;
            dist[nr * m + nc] = dist[v] + 1;
            q.push(nr * m + nc);
        }
    }
    std::printf("%d\n", dist[tr * m + tc]);
}
