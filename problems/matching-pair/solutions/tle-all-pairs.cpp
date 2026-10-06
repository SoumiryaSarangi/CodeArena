#include <cstdio>
#include <vector>
int main() {
    int n;
    long long T;
    if (std::scanf("%d %lld", &n, &T) != 2) return 1;
    std::vector<long long> a(n);
    for (auto& x : a)
        if (std::scanf("%lld", &x) != 1) return 1;
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            if (a[i] + a[j] == T) {
                std::printf("%d %d\n", i + 1, j + 1);
                return 0;
            }
    std::puts("-1");
}
