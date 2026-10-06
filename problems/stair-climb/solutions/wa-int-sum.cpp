#include <cstdio>
#include <vector>
int main() {
    const int MOD = 1000000007;
    int n, k;
    if (std::scanf("%d %d", &n, &k) != 2) return 1;
    std::vector<char> broken(n + 1, 0);
    for (int i = 0; i < k; i++) {
        int b;
        if (std::scanf("%d", &b) != 1) return 1;
        broken[b] = 1;
    }
    std::vector<int> f(n + 1, 0);
    f[0] = 1;
    for (int i = 1; i <= n; i++) {
        if (broken[i]) continue;
        int s = f[i - 1];
        if (i >= 2) s += f[i - 2];
        if (i >= 3) s += f[i - 3];   // up to 3*(10^9+7) overflows int before the %
        f[i] = s % MOD;
    }
    std::printf("%d\n", f[n]);
}
