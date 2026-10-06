#include <iostream>
#include <string>
#include <vector>
int main() {
    int n;
    std::cin >> n;
    std::vector<std::pair<int, std::string>> v(n);
    for (auto& p : v) {
        std::cin >> p.second >> p.first;
        p.first = -p.first;
    }
    for (int i = 1; i < n; i++)            // insertion sort: O(n^2)
        for (int j = i; j > 0 && v[j] < v[j - 1]; j--) std::swap(v[j], v[j - 1]);
    for (auto& p : v) std::cout << p.second << " " << -p.first << "\n";
}
