#include <cstdio>
#include <vector>
int main() {
    int n;
    long long S;
    if (std::scanf("%d %lld", &n, &S) != 2) return 1;
    std::vector<long long> a(n);
    for (auto& x : a)
        if (std::scanf("%lld", &x) != 1) return 1;
    long long cnt = 0;
    for (int l = 0; l < n; l++) {
        long long sum = 0;
        for (int r = l; r < n; r++) {
            sum += a[r];
            if (sum > S) break;
            cnt++;  // every window is visited one by one
        }
    }
    std::printf("%lld\n", cnt);
}
