#include <cstdio>
#include <vector>
int main() {
    int n, S;
    if (std::scanf("%d %d", &n, &S) != 2) return 1;
    std::vector<int> a(n);
    for (auto& x : a)
        if (std::scanf("%d", &x) != 1) return 1;
    int sum = 0, cnt = 0;  // the count overflows 32 bits
    int l = 0;
    for (int r = 0; r < n; r++) {
        sum += a[r];
        while (sum > S) sum -= a[l++];
        cnt += r - l + 1;
    }
    std::printf("%d\n", cnt);
}
