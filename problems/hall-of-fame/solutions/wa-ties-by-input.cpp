#include <algorithm>
#include <iostream>
#include <string>
#include <vector>
int main() {
    int n;
    std::cin >> n;
    std::vector<std::pair<std::string, int>> v(n);
    for (auto& p : v) std::cin >> p.first >> p.second;
    // stable by score only: ties stay in input order instead of alphabetical order
    std::stable_sort(v.begin(), v.end(), [](const auto& x, const auto& y) { return x.second > y.second; });
    for (auto& p : v) std::cout << p.first << " " << p.second << "\n";
}
