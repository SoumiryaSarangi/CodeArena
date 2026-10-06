#include <algorithm>
#include <cstdio>
#include <vector>
int main() {
    int n;
    if (std::scanf("%d", &n) != 1) return 1;
    std::vector<int> t;
    for (int i = 0; i < n; i++) {
        int h;
        if (std::scanf("%d", &h) != 1) return 1;
        auto it = std::upper_bound(t.begin(), t.end(), h);   // lets equal heights chain together
        if (it == t.end()) t.push_back(h);
        else *it = h;
    }
    std::printf("%zu\n", t.size());
}
