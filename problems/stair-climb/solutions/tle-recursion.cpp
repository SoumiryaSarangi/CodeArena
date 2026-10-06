#include <cstdio>
#include <vector>
const long long MOD = 1000000007LL;
std::vector<char> broken;
long long ways(int i) {            // no memoisation: exponential
    if (i < 0 || broken[i]) return 0;
    if (i == 0) return 1;
    return (ways(i - 1) + ways(i - 2) + ways(i - 3)) % MOD;
}
int main() {
    int n, k;
    if (std::scanf("%d %d", &n, &k) != 2) return 1;
    broken.assign(n + 1, 0);
    for (int i = 0; i < k; i++) {
        int b;
        if (std::scanf("%d", &b) != 1) return 1;
        broken[b] = 1;
    }
    std::printf("%lld\n", ways(n));
}
