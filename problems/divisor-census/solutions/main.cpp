#include <cstdio>
#include <vector>
int main() {
    const int M = 500000;
    std::vector<int> cnt(M + 1, 0);
    for (int d = 1; d <= M; d++)
        for (int m = d; m <= M; m += d) cnt[m]++;
    int q;
    if (std::scanf("%d", &q) != 1) return 1;
    for (int i = 0; i < q; i++) {
        int x;
        if (std::scanf("%d", &x) != 1) return 1;
        std::printf("%d%c", cnt[x], i + 1 < q ? ' ' : '\n');
    }
}
