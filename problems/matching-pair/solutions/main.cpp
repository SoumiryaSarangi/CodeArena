#include <cstdio>
#include <unordered_map>
#include <vector>
int main() {
    int n;
    long long T;
    if (std::scanf("%d %lld", &n, &T) != 2) return 1;
    std::unordered_map<long long, int> first;
    first.reserve(n * 2);
    for (int j = 1; j <= n; j++) {
        long long x;
        if (std::scanf("%lld", &x) != 1) return 1;
        auto it = first.find(T - x);
        if (it != first.end()) {
            std::printf("%d %d\n", it->second, j);
            return 0;
        }
        first.emplace(x, j);
    }
    std::puts("-1");
}
