#include <algorithm>
#include <cstdio>
#include <unordered_map>
#include <vector>
int main() {
    int n;
    long long T;
    if (std::scanf("%d %lld", &n, &T) != 2) return 1;
    std::vector<long long> a(n + 1);
    std::unordered_map<long long, int> pos;
    for (int j = 1; j <= n; j++) {
        if (std::scanf("%lld", &a[j]) != 1) return 1;
        pos[a[j]] = j;
    }
    for (int j = 1; j <= n; j++) {
        auto it = pos.find(T - a[j]);       // may find j itself when 2*a[j] == T
        if (it != pos.end()) {
            std::printf("%d %d\n", std::min(j, it->second), std::max(j, it->second));
            return 0;
        }
    }
    std::puts("-1");
}
