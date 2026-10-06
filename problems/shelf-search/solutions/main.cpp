#include <algorithm>
#include <cstdio>
#include <vector>
int main() {
    int n, q;
    std::scanf("%d %d", &n, &q);
    std::vector<int> a(n);
    for (int& x : a) std::scanf("%d", &x);
    for (int j = 0; j < q; j++) {
        int x;
        std::scanf("%d", &x);
        std::printf("%d%c", int(std::lower_bound(a.begin(), a.end(), x) - a.begin()) + 1, j + 1 < q ? ' ' : '\n');
    }
}
