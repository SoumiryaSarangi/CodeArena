#include <cstdio>
#include <vector>
int main() {
    int n;
    long long S;
    if (std::scanf("%d %lld", &n, &S) != 2) return 1;
    std::vector<long long> a(n);
    for (auto& x : a)
        if (std::scanf("%lld", &x) != 1) return 1;
    long long sum = 0, cnt = 0;
    int l = 0;
    for (int r = 0; r < n; r++) {
        sum += a[r];
        while (sum > S) sum -= a[l++];
        cnt += r - l + 1;
    }
    std::printf("%lld\n", cnt);
}
