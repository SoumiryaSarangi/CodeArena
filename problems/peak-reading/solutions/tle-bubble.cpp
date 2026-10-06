#include <algorithm>
#include <iostream>
#include <utility>
#include <vector>
int main() {
    int n;
    std::cin >> n;
    std::vector<std::pair<long long, int>> v(n);
    for (int i = 0; i < n; i++) { std::cin >> v[i].first; v[i].second = -(i + 1); }
    // bubble sort, largest first (ties: smaller index first)
    for (int i = 0; i < n; i++)
        for (int j = 0; j + 1 < n - i; j++)
            if (v[j] < v[j + 1]) std::swap(v[j], v[j + 1]);
    std::cout << v[0].first << " " << -v[0].second << "\n";
}
