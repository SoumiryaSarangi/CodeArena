#include <cstdio>
#include <vector>
int main() {
    const long long MOD = 1000000007LL;
    int n, k;
    if (std::scanf("%d %d", &n, &k) != 2) return 1;
    std::vector<char> broken(n + 1, 0);
    for (int i = 0; i < k; i++) {
        int b;
        if (std::scanf("%d", &b) != 1) return 1;
        broken[b] = 1;
    }
    std::vector<long long> f(n + 1, 0);
    f[0] = 1;
    for (int i = 1; i <= n; i++) {
        if (broken[i]) continue;
        long long s = f[i - 1];
        if (i >= 2) s += f[i - 2];
        if (i >= 3) s += f[i - 3];
        f[i] = s % MOD;
    }
    std::printf("%lld\n", f[n]);
}
