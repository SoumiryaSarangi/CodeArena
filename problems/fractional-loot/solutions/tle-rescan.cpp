#include <cstdio>
#include <vector>
int main() {
    int n;
    long long W;
    if (std::scanf("%d %lld", &n, &W) != 2) return 1;
    std::vector<double> w(n), v(n);
    std::vector<char> used(n, 0);
    for (int i = 0; i < n; i++)
        if (std::scanf("%lf %lf", &w[i], &v[i]) != 2) return 1;
    double left = W, total = 0;
    for (int step = 0; step < n && left > 0; step++) {   // find the best remaining ratio by scanning: O(n^2)
        int best = -1;
        for (int i = 0; i < n; i++)
            if (!used[i] && (best < 0 || v[i] / w[i] > v[best] / w[best])) best = i;
        used[best] = 1;
        double take = left < w[best] ? left : w[best];
        total += v[best] * take / w[best];
        left -= take;
    }
    std::printf("%.9f\n", total);
}
