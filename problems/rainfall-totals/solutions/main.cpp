#include <cstdio>
#include <vector>
int main() {
    int n, q;
    std::scanf("%d %d", &n, &q);
    std::vector<long long> p(n + 1, 0);
    for (int i = 1; i <= n; i++) {
        long long x;
        std::scanf("%lld", &x);
        p[i] = p[i - 1] + x;
    }
    while (q--) {
        int l, r;
        std::scanf("%d %d", &l, &r);
        std::printf("%lld\n", p[r] - p[l - 1]);
    }
}
