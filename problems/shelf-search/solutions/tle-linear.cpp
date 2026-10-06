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
        int i = 0;
        while (i < n && a[i] < x) i++;  // O(n) per request
        std::printf("%d%c", i + 1, j + 1 < q ? ' ' : '\n');
    }
}
