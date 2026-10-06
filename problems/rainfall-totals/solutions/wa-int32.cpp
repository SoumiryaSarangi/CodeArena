#include <cstdio>
#include <vector>
int main() {
    int n, q;
    std::scanf("%d %d", &n, &q);
    std::vector<int> p(n + 1, 0);  // prefix sums overflow 32 bits
    for (int i = 1; i <= n; i++) {
        int x;
        std::scanf("%d", &x);
        p[i] = p[i - 1] + x;
    }
    while (q--) {
        int l, r;
        std::scanf("%d %d", &l, &r);
        std::printf("%d\n", p[r] - p[l - 1]);
    }
}
