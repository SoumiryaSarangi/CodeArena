#include <algorithm>
#include <cstdio>
#include <vector>
int n, W;
std::vector<int> w;
std::vector<long long> v;
long long best(int i, int left) {   // try every subset: exponential
    if (i == n) return 0;
    long long r = best(i + 1, left);
    if (w[i] <= left) r = std::max(r, v[i] + best(i + 1, left - w[i]));
    return r;
}
int main() {
    if (std::scanf("%d %d", &n, &W) != 2) return 1;
    w.resize(n);
    v.resize(n);
    for (int i = 0; i < n; i++)
        if (std::scanf("%d %lld", &w[i], &v[i]) != 2) return 1;
    std::printf("%lld\n", best(0, W));
}
